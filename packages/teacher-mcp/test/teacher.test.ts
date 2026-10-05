import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { ManualClock, ProfileStore, deriveLearnerState, type Author, type ChangeMode, type OpenProfile } from '@app/core';
import { fourNumbers } from '../../catalog/fixtures/four-numbers.ts';
import {
  TeacherHttpServer,
  learnerSummary,
  registerLessonValidator,
  scaffoldFor,
  systemPrompt,
  type Registration,
  type TeacherContext,
} from '../src/index.ts';

const agent: Author = { kind: 'agent', agent: 'claude-code', model: 'claude-opus-5-5', session: 'sess-1' };

let root: string;
let profile: OpenProfile;
let server: TeacherHttpServer;
let mode: ChangeMode;
let reg: Registration;
let client: Client;

async function connect(token: string): Promise<Client> {
  const c = new Client({ name: 'test', version: '0' });
  await c.connect(
    new StreamableHTTPClientTransport(new URL(server.url), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }) as unknown as Parameters<Client["connect"]>[0],
  );
  return c;
}

const text = (r: unknown) => ((r as { content: { text: string }[] }).content[0]!.text);
const call = async (name: string, args: Record<string, unknown> = {}) => client.callTool({ name, arguments: args });

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'teacher-'));
  const store = new ProfileStore(root, new ManualClock('2026-10-05T10:00:00.000Z'));
  const p = await store.create('Jules');
  profile = await store.open(p.id);
  registerLessonValidator(profile.changes);
  mode = 'auto';
  const ctx: TeacherContext = { profile, projectId: 'hmp', agent, changeMode: () => mode };
  server = await TeacherHttpServer.start();
  reg = server.register(ctx);
  client = await connect(reg.token);
});

afterEach(async () => {
  await client.close();
  await server.close();
  await profile.close();
  await rm(root, { recursive: true, force: true });
});

describe('teacher MCP server', () => {
  it('exposes the teaching tools with an ACP server descriptor', async () => {
    const tools = (await client.listTools()).tools.map((t) => t.name).sort();
    expect(tools).toEqual([
      'ask_learner',
      'draft_lesson',
      'get_component_catalog',
      'get_lesson',
      'get_teaching_context',
      'list_lessons',
      'record_evidence',
      'record_insight',
      'record_instruction',
      'revise_lesson',
    ]);
    expect(reg.acpServer).toMatchObject({ type: 'http', url: server.url });
  });

  it('gives the rules, project, and a code-computed learner summary', async () => {
    const t = text(await call('get_teaching_context'));
    expect(t).toMatch(/Never give the solution/);
    expect(t).toMatch(/project details not set/);
    expect(t).toMatch(/No evidence yet/);
    expect(t).toMatch(/"auto" mode/);
    expect(text(await call('get_component_catalog'))).toMatch(/There is NO solution kind[\s\S]*Functions: abs/);
    expect(systemPrompt()).toMatch(/get_teaching_context/);
  });

  it('records evidence, instruction and insights stamped with the agent identity', async () => {
    await call('record_instruction', { kcs: ['quaternion.unit'], lessonId: 'hmp-09' });
    expect(text(await call('record_evidence', {
      itemId: 'w1', kcs: [{ kc: 'quaternion.unit' }], difficulty: 3, evidenceType: 'production', outcome: 1, confidence: 'sure',
    }))).toMatch(/^Recorded ev_/);
    const proposed = text(await call('record_insight', { stance: 'propose', text: 'Prefers the maths first', scope: 'global' }));
    const insightId = /insight (ins_\S+)\./.exec(proposed)![1]!;
    await call('record_insight', { stance: 'support', insightId });
    const events = profile.journal.events;
    expect(events.every((e) => e.author.model === 'claude-opus-5-5' && e.author.session === 'sess-1')).toBe(true);
    const state = deriveLearnerState(events, profile.journal.now());
    expect(state.kcs.get('quaternion.unit')!.rating.theta).toBeGreaterThan(-1);
    expect(state.insights[0]!.support).toHaveLength(2);
    await call('record_evidence', { itemId: 'w2', kcs: [{ kc: 'joint.nq-nv' }], difficulty: 2, evidenceType: 'recognition', outcome: 0 });
    const t = text(await call('get_teaching_context'));
    expect(t).toMatch(/quaternion\.unit: \w+, practising/);
    expect(t).toMatch(/Prefers the maths first \(id ins_/);
    expect(t).toMatch(/First-attempt success: 1\/2/);
    expect(t.indexOf('joint.nq-nv')).toBeLessThan(t.indexOf('quaternion.unit:'));
  });

  it('shows forms to the learner through the attached interface', async () => {
    const shown: unknown[] = [];
    const reg2 = server.register({ profile, projectId: 'hmp', agent, changeMode: () => mode, present: (f) => shown.push(f) });
    const c2 = await connect(reg2.token);
    const form = { title: 'Start', questions: [{ id: 'q1', kind: 'single', prompt: 'Which?', options: ['a', 'b'] }] };
    const r = await c2.callTool({ name: 'ask_learner', arguments: form });
    expect(text(r)).toMatch(/now in front of the learner. End your turn/);
    expect(shown).toEqual([expect.objectContaining({ title: 'Start' })]);
    const dup = await c2.callTool({ name: 'ask_learner', arguments: { ...form, questions: [form.questions[0], form.questions[0]] } });
    expect(dup.isError).toBe(true);
    expect(text(dup)).toMatch(/duplicate question id/);
    await c2.close();
    // The default context has no interface attached.
    const none = await call('ask_learner', form);
    expect(none.isError).toBe(true);
    expect(text(none)).toMatch(/No learner interface/);
  });

  it('rejects bad input clearly', async () => {
    expect((await call('record_insight', { stance: 'propose' })).isError).toBe(true);
    expect((await call('record_insight', { stance: 'support' })).isError).toBe(true);
    const bad = await call('record_evidence', { itemId: 'x', kcs: [{ kc: 'Not A KC' }], difficulty: 9, evidenceType: 'probe', outcome: 2 });
    expect(bad.isError).toBe(true);
  });

  it('drafts, lists, reads and revises lessons, with validation on every change', async () => {
    expect(text(await call('list_lessons'))).toBe('No lessons yet.');
    const saved = text(await call('draft_lesson', { lesson: fourNumbers }));
    expect(saved).toMatch(/Lesson "hmp-09-four-numbers" saved/);
    expect(text(await call('list_lessons'))).toBe('hmp-09-four-numbers');
    expect(JSON.parse(text(await call('get_lesson', { lessonId: 'hmp-09-four-numbers' }))).title).toBe('Four Numbers, Three Speeds');
    expect(text(await call('draft_lesson', { lesson: { ...fourNumbers, title: 'Again' } }))).toMatch(/saved/);

    const leak = await call('revise_lesson', {
      lessonId: 'hmp-09-four-numbers',
      reason: 'show the answer',
      patch: [{ op: 'replace', path: '/sections/3/blocks/1/source', value: 'void f() {\n  q = normalize(q * dq);\n}' }],
    });
    expect(leak.isError).toBe(true);
    expect(text(leak)).toMatch(/stub contains implementation/);

    const fine = await call('revise_lesson', {
      lessonId: 'hmp-09-four-numbers',
      reason: 'clearer title',
      patch: [{ op: 'replace', path: '/title', value: 'Four Numbers, Three Speeds (rev)' }],
    });
    expect(text(fine)).toMatch(/Revision applied/);
    const conflict = await call('revise_lesson', { lessonId: 'hmp-09-four-numbers', reason: 'x', patch: [{ op: 'remove', path: '/nope' }] });
    expect(text(conflict)).toMatch(/cannot apply/);
    expect((await call('revise_lesson', { lessonId: 'missing', reason: 'x', patch: [{ op: 'remove', path: '/x' }] })).isError).toBe(true);
    expect((await call('get_lesson', { lessonId: 'missing' })).isError).toBe(true);
    expect((await call('get_lesson', { lessonId: '../../profile' })).isError).toBe(true);
  });

  it('shows the project and existing lessons in the teaching context', async () => {
    await profile.changes.propose(
      { author: { kind: 'learner' }, target: 'projects/hmp/project.json', patch: [{ op: 'add', path: '', value: { title: 'HMP', goal: 'Featherstone' } }], reason: 'p' },
      'auto',
    );
    await call('draft_lesson', { lesson: fourNumbers });
    const t = text(await call('get_teaching_context'));
    expect(t).toMatch(/"goal": "Featherstone"/);
    expect(t).toMatch(/# Lessons so far\n- hmp-09-four-numbers/);
  });

  it('returns validation errors and composition advice to the agent', async () => {
    const r = await call('draft_lesson', { lesson: { ...fourNumbers, sections: [] } });
    expect(r.isError).toBe(true);
    expect(text(r)).toMatch(/Rejected; fix these/);
    const noWarmup = { ...fourNumbers, sections: fourNumbers.sections.filter((s) => s.role !== 'warmup') };
    expect(text(await call('draft_lesson', { lesson: noWarmup }))).toMatch(/Composition advice:[\s\S]*no warm-up/);
  });

  it('stores lessons normalized even when the agent mixes up "type" and "kind"', async () => {
    const lesson = structuredClone(fourNumbers) as unknown as { sections: { blocks: Record<string, unknown>[] }[] };
    const first = lesson.sections[0]!.blocks[0]!;
    lesson.sections[0]!.blocks[0] = { kind: first['type'], ...Object.fromEntries(Object.entries(first).filter(([k]) => k !== 'type')) };
    expect(text(await call('draft_lesson', { lesson }))).toMatch(/saved/);
    const stored = JSON.parse(text(await call('get_lesson', { lessonId: 'hmp-09-four-numbers' })));
    expect(stored.sections[0].blocks[0]).toMatchObject({ type: 'drill' });
    expect(stored.sections[0].blocks[0]).not.toHaveProperty('kind');
  });

  it('folds a revision of a draft waiting for review into that same proposal (regression)', async () => {
    mode = 'review';
    await call('draft_lesson', { lesson: fourNumbers });
    const [first] = profile.changes.list({ status: 'proposed' });
    const r = await call('revise_lesson', {
      lessonId: 'hmp-09-four-numbers',
      reason: 'clearer title',
      patch: [{ op: 'replace', path: '/title', value: 'Four Numbers, Three Speeds (rev)' }],
    });
    expect(text(r)).toMatch(/draft waiting for review now includes this revision/);
    const pending = profile.changes.list({ status: 'proposed' });
    expect(pending).toHaveLength(1);
    expect(pending[0]!.reason).toBe('new lesson; clearer title');
    expect(profile.changes.get(first!.changeId)!.status).toBe('rejected');
    await profile.changes.accept(pending[0]!.changeId, { kind: 'learner' });
    expect(JSON.parse(text(await call('get_lesson', { lessonId: 'hmp-09-four-numbers' }))).title).toBe('Four Numbers, Three Speeds (rev)');
  });

  it('refuses revisions that do not fit the pending draft, keeping it intact', async () => {
    mode = 'review';
    await call('draft_lesson', { lesson: fourNumbers });
    const bad = await call('revise_lesson', { lessonId: 'hmp-09-four-numbers', reason: 'x', patch: [{ op: 'remove', path: '/nope' }] });
    expect(text(bad)).toMatch(/cannot apply to the draft/);
    const leak = await call('revise_lesson', {
      lessonId: 'hmp-09-four-numbers',
      reason: 'x',
      patch: [{ op: 'replace', path: '/sections/3/blocks/1/source', value: 'void f() {\n  q = normalize(q * dq);\n}' }],
    });
    expect(leak.isError).toBe(true);
    expect(profile.changes.list({ status: 'proposed' })).toHaveLength(1);
  });

  it('in review mode, drafts wait for the learner', async () => {
    mode = 'review';
    expect(text(await call('draft_lesson', { lesson: fourNumbers }))).toMatch(/proposed for the learner's review/);
    expect(text(await call('list_lessons'))).toBe('No lessons yet.');
    expect(text(await call('get_teaching_context'))).toMatch(/wait for their approval/);
  });

  it('refuses requests without a valid token, from browsers, or for other paths', async () => {
    await expect(connect('0'.repeat(64))).rejects.toThrow();
    reg.revoke();
    await expect(connect(reg.token)).rejects.toThrow();
    const post = (headers: Record<string, string>, url = server.url, body = '{}') =>
      fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body });
    expect((await post({})).status).toBe(401);
    expect((await post({ origin: 'https://evil.example' })).status).toBe(403);
    expect((await post({}, server.url.replace('/mcp', '/other'))).status).toBe(404);
  });

  it('rejects oversized and malformed bodies', async () => {
    const reg2 = server.register({ profile, projectId: 'hmp', agent, changeMode: () => mode });
    const headers = { 'content-type': 'application/json', authorization: `Bearer ${reg2.token}`, accept: 'application/json, text/event-stream' };
    expect((await fetch(server.url, { method: 'POST', headers, body: '{bad' })).status).toBe(400);
    expect((await fetch(server.url, { method: 'POST', headers, body: 'x'.repeat(5 * 1024 * 1024) })).status).toBe(413);
  });

  it('rejects requests with a foreign Host header (DNS rebinding)', async () => {
    const { request } = await import('node:http');
    const u = new URL(server.url);
    const status = await new Promise<number>((resolve) => {
      const r = request({ host: u.hostname, port: u.port, path: u.pathname, method: 'POST', headers: { host: 'evil.example' } }, (res) => resolve(res.statusCode!));
      r.end('{}');
    });
    expect(status).toBe(403);
  });
});

describe('summary helpers', () => {
  it('maps bands to scaffold levels', () => {
    expect([-2, -1, 0, 1, 2].map(scaffoldFor)).toEqual([4, 3, 3, 2, 1]);
  });
  it('suggests easier or harder tasks from the success window', () => {
    const base = { kcs: new Map(), insights: [] };
    expect(learnerSummary({ ...base, firstAttempts: Array(12).fill(true) })).toMatch(/harder/);
    expect(learnerSummary({ ...base, firstAttempts: Array(12).fill(false) })).toMatch(/easier/);
    expect(learnerSummary({ ...base, firstAttempts: [true, false] })).toMatch(/Keep the current/);
  });
});
