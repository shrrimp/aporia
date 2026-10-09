import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { ManualClock, ProfileStore, assessmentTarget, curriculumTarget, deriveLearnerState, type Author, type ChangeMode, type OpenProfile } from '@app/core';
import { fourNumbers } from '../../catalog/fixtures/four-numbers.ts';
import {
  TeacherHttpServer,
  checkpointSummary,
  learnerSummary,
  lessonTarget,
  projectLessons,
  projectReviews,
  reviewSummary,
  reviewableItems,
  registerValidators,
  scaffoldFor,
  systemPrompt,
  describeSkillMap,
  readSkillMap,
  readSources,
  sourceDir,
  sourceText,
  sourcesSummary,
  sourcesTarget,
  validateSources,
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
  registerValidators(profile.changes);
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
      'add_to_lesson',
      'ask_learner',
      'draft_lesson',
      'get_component_catalog',
      'get_lesson',
      'get_skill_map',
      'get_teaching_context',
      'list_lessons',
      'list_sources',
      'read_source',
      'record_evidence',
      'record_hint',
      'record_insight',
      'record_instruction',
      'revise_lesson',
      'run_command',
      'run_tests',
      'save_assessment',
      'search_sources',
      'set_curriculum',
      'update_roadmap',
      'update_skill_map',
      'write_file',
      'write_review_questions',
]);
    expect(reg.acpServer).toMatchObject({ type: 'http', url: server.url });
  });

  it('gives the rules, project, and a code-computed learner summary', async () => {
    const t = text(await call('get_teaching_context'));
    expect(t).toMatch(/Never give the solution/);
    expect(t).toMatch(/Practice goes in the lesson, not in the chat/);
    expect(t).toMatch(/project details not set/);
    expect(t).toMatch(/No evidence yet/);
    expect(t).toMatch(/"auto" mode/);
    expect(t).toMatch(/No checkpoint runs yet/);
    expect(text(await call('get_component_catalog'))).toMatch(/There is NO solution kind[\s\S]*Functions: abs/);
    expect(systemPrompt()).toMatch(/get_teaching_context/);
  });

  it('tells the tutor what the learner\'s tests said, latest task first', async () => {
    const run = (taskId: string, over: Record<string, unknown> = {}) => ({
      projectId: 'hmp', lessonId: 'l', taskId, suite: 's', expect: { passed: 10, of: 12 }, reached: false, exitCode: 1, timedOut: false, durationMs: 5, failures: [], ...over,
    });
    const system: Author = { kind: 'system' };
    await profile.checkpoints.record(system, run('a', { counts: { passed: 4, failed: 8, total: 12, format: 'ctest' }, failures: ['t1', 't2', 't3', 't4', 't5', 't6'] }), []);
    await profile.checkpoints.record(system, run('a', { counts: { passed: 10, failed: 2, total: 12, format: 'ctest' }, reached: true, failures: ['t1'] }), []);
    await profile.checkpoints.record(system, run('b', { timedOut: true, exitCode: null }), []);
    await profile.checkpoints.record(system, run('c'), []);
    await profile.checkpoints.record(system, { ...run('d'), projectId: 'other' }, []);
    const t = text(await call('get_teaching_context'));
    expect(t).toContain('- l/a: 2 run(s), last 10/12 passing (expects 10/12), reached; failing: t1');
    expect(t).toContain('- l/b: 1 run(s), last timed out');
    expect(t).toContain('- l/c: 1 run(s), last no readable summary');
    expect(t).not.toContain('l/d');
    expect(checkpointSummary(profile.journal.events, 'hmp', 1).split('\n')).toHaveLength(1);
    await profile.checkpoints.record(system, run('a', { failures: ['t1', 't2', 't3', 't4', 't5', 't6'] }), []);
    expect(checkpointSummary(profile.journal.events, 'hmp')).toContain('failing: t1, t2, t3, t4, t5, …');
  });

  it('lists the skills due for review, so the next warm-up asks them again with new questions', async () => {
    const lesson = structuredClone(fourNumbers) as unknown as { id: string; sections: { id: string; blocks: Record<string, unknown>[] }[] };
    lesson.sections[0]!.blocks.push({
      type: 'drill',
      items: [
        { id: 'n1', kind: 'numeric', prompt: 'How many numbers in a unit quaternion?', kcs: ['quaternion.unit'], difficulty: 1, why: 'w, x, y, z', answer: 4 },
        { id: 's1', kind: 'short', prompt: 'Why?', kcs: ['quaternion.unit'], difficulty: 3, why: 'because', answer: 'a reason' },
      ],
    });
    await profile.changes.propose({ author: agent, target: lessonTarget('hmp', lesson.id), patch: [{ op: 'add', path: '', value: lesson as never }], reason: 'l' }, 'auto');
    const lessons = await projectLessons(profile, 'hmp');
    expect([...reviewableItems(lessons).keys()]).toEqual([`${lesson.id}/w1`, `${lesson.id}/n1`]); // short answers need the tutor
    expect(text(await call('get_teaching_context'))).toMatch(/Nothing answered yet, so nothing to review/);

    const system: Author = { kind: 'system' };
    for (const itemId of ['w1', 'n1']) {
      await profile.observations.recordEvidence({ author: system, itemId: `${lesson.id}/${itemId}`, projectId: 'hmp', kcs: [{ kc: 'quaternion.unit', weight: 1 }], difficulty: 0, evidenceType: 'production', outcome: 0 });
    }
    expect(text(await call('get_teaching_context'))).toMatch(/Nothing due\. Next skill due 2026-10-05/);
    const due = await projectReviews(profile, 'hmp', new Date('2026-11-01T00:00:00.000Z'));
    expect(due.dueCount).toBe(1); // two items, one skill
    const summary = reviewSummary(due, 1);
    expect(summary).toMatch(/^1 skill\(s\) due\. The app schedules skills, not questions/);
    expect(summary).toContain('- quaternion.unit (quaternion.unit, recall ≈');
    expect(summary.split('\n')).toHaveLength(2);

    // A lesson that no longer matches the catalog is left out, not shown broken.
    const second = { ...structuredClone(fourNumbers), id: 'second' };
    await profile.changes.propose({ author: agent, target: lessonTarget('hmp', 'second'), patch: [{ op: 'add', path: '', value: second as never }], reason: 'x' }, 'auto');
    expect((await projectLessons(profile, 'hmp')).map((l) => l.id)).toEqual([lesson.id, 'second']);
    await writeFile(path.join(profile.dir, 'projects', 'hmp', 'lessons', 'second.json'), '{"id":"second"}');
    expect((await projectLessons(profile, 'hmp')).map((l) => l.id)).toEqual([lesson.id]);
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

  it('adds practice to a section and returns the link that leads to it', async () => {
    await call('draft_lesson', { lesson: fourNumbers });
    const drill = { type: 'drill', items: [{ id: 'extra-1', kind: 'numeric', prompt: '$|q|$ after normalising?', answer: 1, tolerance: 0, why: 'Normalising divides by the length.', kcs: ['quaternion.unit'], difficulty: 2 }] };
    const r = await call('add_to_lesson', { lessonId: 'hmp-09-four-numbers', sectionId: 'side', blocks: [drill], reason: 'more practice on unit length' });
    const sideBlocks = fourNumbers.sections.find((x) => x.id === 'side')!.blocks.length;
    expect(text(r)).toMatch(/Revision applied/);
    expect(text(r)).toContain(`#lesson:hmp-09-four-numbers/side/${sideBlocks}`);
    let stored = JSON.parse(text(await call('get_lesson', { lessonId: 'hmp-09-four-numbers' })));
    expect(stored.sections.find((x: { id: string }) => x.id === 'side').blocks.at(-1).items[0].id).toBe('extra-1');

    // Before a block, and never past the end.
    const first = await call('add_to_lesson', { lessonId: 'hmp-09-four-numbers', sectionId: 'warmup', before: 0, blocks: [{ ...drill, items: [{ ...drill.items[0], id: 'extra-2' }] }], reason: 'x' });
    expect(text(first)).toContain('#lesson:hmp-09-four-numbers/warmup/0');
    stored = JSON.parse(text(await call('get_lesson', { lessonId: 'hmp-09-four-numbers' })));
    expect(stored.sections[0].blocks[0].items[0].id).toBe('extra-2');
    const far = await call('add_to_lesson', { lessonId: 'hmp-09-four-numbers', sectionId: 'exit', before: 99, blocks: [{ ...drill, items: [{ ...drill.items[0], id: 'extra-3' }] }], reason: 'x' });
    expect(text(far)).toMatch(/#lesson:hmp-09-four-numbers\/exit\/\d+/);

    expect(text(await call('add_to_lesson', { lessonId: 'hmp-09-four-numbers', sectionId: 'nope', blocks: [drill], reason: 'x' }))).toMatch(/No section "nope".*Its sections: warmup, why-not-derivative/);
    expect((await call('add_to_lesson', { lessonId: 'missing', sectionId: 'side', blocks: [drill], reason: 'x' })).isError).toBe(true);
    // Validated like any revision.
    expect((await call('add_to_lesson', { lessonId: 'hmp-09-four-numbers', sectionId: 'side', blocks: [{ type: 'nonsense' }], reason: 'x' })).isError).toBe(true);
  });

  it('adds practice to a draft waiting for review, and says it must be accepted first', async () => {
    mode = 'review';
    await call('draft_lesson', { lesson: fourNumbers });
    const r = await call('add_to_lesson', {
      lessonId: 'hmp-09-four-numbers',
      sectionId: 'exit',
      blocks: [{ type: 'drill', items: [{ id: 'extra-1', kind: 'numeric', prompt: 'p', answer: 1, tolerance: 0, why: 'Normalising divides by the length.', kcs: ['quaternion.unit'], difficulty: 2 }] }],
      reason: 'more practice',
    });
    expect(text(r)).toMatch(/draft waiting for review now includes this revision/);
    expect(text(r)).toMatch(/tell them to accept it first/);
    expect(profile.changes.list({ status: 'proposed' })).toHaveLength(1);
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

describe('skill map, curriculum and assessment tools', () => {
  const skills = [
    { id: 'linalg.vectors', title: 'Vectors', group: 'linalg' },
    { id: 'rot.quaternion', title: 'Quaternions', group: 'rotations', summary: 'Unit quaternions as rotations' },
    { id: 'rot.exp-map', title: 'The exponential map', group: 'rotations' },
  ];
  const groups = [
    { id: 'linalg', title: 'Linear algebra' },
    { id: 'rotations', title: 'Rotations' },
  ];
  const edges = [
    { from: 'linalg.vectors', to: 'rot.quaternion', kind: 'prereq' },
    { from: 'rot.quaternion', to: 'rot.exp-map', kind: 'prereq' },
  ];

  it('describes the map, keeping fields and refusing what would break it', async () => {
    expect(text(await call('get_skill_map'))).toMatch(/skill map is empty/);
    expect(text(await call('update_skill_map', { groups, skills, edges, reason: 'interview' }))).toMatch(/^Skill map updated/);
    // A partial update keeps the fields it leaves out; a suggestion carries its reason.
    await call('update_skill_map', {
      skills: [{ id: 'rot.quaternion', title: 'Unit quaternions' }, { id: 'dyn.featherstone', title: 'Articulated bodies', suggested: true, why: 'You know the rotations it needs' }],
      edges: [{ from: 'rot.exp-map', to: 'dyn.featherstone', kind: 'prereq' }, { from: 'rot.quaternion', to: 'rot.exp-map', kind: 'confusable' }],
      reason: 'suggest',
    });
    const map = await readSkillMap(profile.changes);
    expect(map.skills['rot.quaternion']).toEqual({ title: 'Unit quaternions', group: 'rotations', summary: 'Unit quaternions as rotations' });
    expect(Object.keys(map.edges)).toHaveLength(4);
    await profile.observations.recordEvidence({ author: agent, itemId: 'p', kcs: [{ kc: 'rot.quaternion', weight: 1 }], difficulty: 0, evidenceType: 'probe', outcome: 1 });
    const read = text(await call('get_skill_map'));
    expect(read).toMatch(/- linalg: Linear algebra/);
    expect(read).toMatch(/- rot\.quaternion: Unit quaternions \[rotations\] \(\w+, practising, confidence 0\.\d\d\)/);
    expect(read).toMatch(/dyn\.featherstone: Articulated bodies \(suggestion, not met yet\)\. Suggested because: You know the rotations it needs/);
    expect(read).toMatch(/- linalg\.vectors: Vectors \[linalg\] \(no evidence yet\)/);
    expect(read).toMatch(/- prereq: linalg\.vectors → rot\.quaternion/);

    // A loop, a dangling group, a nameless new skill, and unknown removals are refused.
    expect(text(await call('update_skill_map', { edges: [{ from: 'rot.exp-map', to: 'linalg.vectors', kind: 'prereq' }], reason: 'x' }))).toMatch(/loop/);
    expect(text(await call('update_skill_map', { skills: [{ id: 'x.y', title: 'X', group: 'nope' }], reason: 'x' }))).toMatch(/group "nope"/);
    expect(text(await call('update_skill_map', { skills: [{ id: 'x.y' }], reason: 'x' }))).toMatch(/needs a title/);
    expect(text(await call('update_skill_map', { removeSkills: ['nope'], removeEdges: [{ from: 'a', to: 'b', kind: 'related' }], reason: 'x' }))).toMatch(/no related link[\s\S]*no skill "nope"/);
    expect(text(await call('update_skill_map', { reason: 'x' }))).toBe('Nothing to change.');

    // Removing a skill removes its links too.
    await call('update_skill_map', { removeSkills: ['rot.exp-map'], removeEdges: [{ from: 'linalg.vectors', to: 'rot.quaternion', kind: 'prereq' }], reason: 'merge' });
    const after = await readSkillMap(profile.changes);
    expect(Object.keys(after.skills).sort()).toEqual(['dyn.featherstone', 'linalg.vectors', 'rot.quaternion']);
    expect(after.edges).toEqual({});
    expect(describeSkillMap(after, deriveLearnerState([], new Date()), 1)).toMatch(/… and 2 more/);
  });

  it('nests groups into a tree, and shows the tree to the tutor', async () => {
    await call('update_skill_map', { groups, skills, edges, reason: 'interview' });
    // Flat groups get a parent later, without repeating their titles.
    expect(
      text(await call('update_skill_map', { groups: [{ id: 'maths', title: 'Mathematics' }, { id: 'linalg', parent: 'maths' }, { id: 'rotations', parent: 'maths' }], reason: 'organise' })),
    ).toMatch(/^Skill map updated/);
    const map = await readSkillMap(profile.changes);
    expect(map.groups['linalg']).toEqual({ title: 'Linear algebra', parent: 'maths' });
    expect(text(await call('get_skill_map'))).toMatch(/## Groups \(nested[^\n]*\n- maths: Mathematics\n  - linalg: Linear algebra\n  - rotations: Rotations/);
    expect(text(await call('update_skill_map', { groups: [{ id: 'shaders', parent: 'graphics' }], reason: 'x' }))).toMatch(/group "shaders" is new, so it needs a title/);
    expect(text(await call('update_skill_map', { groups: [{ id: 'maths', parent: 'linalg' }], reason: 'x' }))).toMatch(/nested in a loop/);
  });

  it('brings in parent groups that are still waiting for review', async () => {
    mode = 'review';
    await call('update_skill_map', { groups: [{ id: 'graphics', title: 'Graphics programming' }], reason: 'a' });
    await call('update_skill_map', { groups: [{ id: 'vulkan', title: 'Vulkan', parent: 'graphics' }], reason: 'b' });
    expect(text(await call('update_skill_map', { skills: [{ id: 'vk.sync', title: 'Synchronisation', group: 'vulkan' }], reason: 'c' }))).toMatch(/proposed/);
    // Accepting only the last one applies on its own: it carries the groups it needs.
    const last = profile.changes.list({ status: 'proposed' }).at(-1)!;
    await profile.changes.accept(last.changeId, { kind: 'learner' });
    const map = await readSkillMap(profile.changes);
    expect(map.groups).toEqual({ graphics: { title: 'Graphics programming' }, vulkan: { title: 'Vulkan', parent: 'graphics' } });
  });

  it('in review mode, proposals wait, and links may use skills that are still waiting', async () => {
    mode = 'review';
    expect(text(await call('update_skill_map', { groups, skills: skills.slice(0, 2), reason: 'a' }))).toMatch(/proposed for the learner's review/);
    expect(text(await call('update_skill_map', { skills: [skills[2]], edges, reason: 'b' }))).toMatch(/proposed/);
    expect(text(await call('set_curriculum', { goals: ['rot.exp-map'], plan: [{ id: 'p1', title: 'Quaternions', kcs: ['rot.quaternion'] }], reason: 'plan' }))).toMatch(/proposed/);
    // Accepting in order applies cleanly.
    for (const c of profile.changes.list({ status: 'proposed' })) await profile.changes.accept(c.changeId, { kind: 'learner' });
    const map = await readSkillMap(profile.changes);
    expect(Object.keys(map.skills).sort()).toEqual(['linalg.vectors', 'rot.exp-map', 'rot.quaternion']);
    expect(Object.keys(map.edges)).toHaveLength(2);
    expect(await profile.changes.read(curriculumTarget('hmp'))).toMatchObject({ goals: ['rot.exp-map'] });
  });

  it('sets the curriculum and saves the assessment, superseding earlier drafts, and shows both in the context', async () => {
    await call('update_skill_map', { groups, skills, edges, reason: 'interview' });
    expect(text(await call('get_teaching_context'))).toMatch(/Interview: not done yet[\s\S]*No curriculum yet/);
    expect(text(await call('set_curriculum', { goals: ['rot.exp-map', 'nope.x'], plan: [], reason: 'x' }))).toMatch(/not in the skill map yet[^\n]*nope\.x/);
    expect(text(await call('set_curriculum', { goals: ['rot.exp-map'], plan: [{ id: 'a', title: 'A', kcs: ['rot.quaternion'] }, { id: 'a', title: 'B', kcs: ['rot.quaternion'] }], reason: 'x' }))).toMatch(/used twice/);
    const plan = [
      { id: 'quat', title: 'Four Numbers', kcs: ['rot.quaternion'], lessonId: fourNumbers.id, capability: 'your joints rotate' },
      { id: 'exp', title: 'The exponential map', kcs: ['rot.exp-map'] },
      { id: 'later', title: 'Later', kcs: ['rot.exp-map'] },
    ];
    expect(text(await call('set_curriculum', { goals: ['rot.exp-map'], plan, reason: 'first plan' }))).toMatch(/^Curriculum saved/);
    expect(text(await call('save_assessment', { summary: 'Strong on vectors; shaky on frames.', gaps: [{ text: 'frames', kcs: ['rot.quaternion'] }] }))).toMatch(/^Assessment saved/);
    await call('draft_lesson', { lesson: fourNumbers });
    const t = text(await call('get_teaching_context'));
    expect(t).toMatch(/Skill map: 3 skill\(s\) in 2 group\(s\), 0 suggestion\(s\)/);
    expect(t).toMatch(/Interview: done/);
    expect(t).toMatch(/1\. \[written as hmp-09-four-numbers\] Four Numbers \(rot\.quaternion\): your joints rotate/);
    expect(t).toMatch(/2\. \[NEXT\] The exponential map/);
    expect(t).toMatch(/3\. \[later\] Later/);

    mode = 'review';
    await call('save_assessment', { summary: 'Draft one' });
    await call('save_assessment', { summary: 'Draft two' });
    const pending = profile.changes.list({ target: assessmentTarget('hmp') });
    expect(pending.map((c) => c.status)).toEqual(['applied', 'rejected', 'proposed']);
    expect(text(await call('save_assessment', { summary: '' }))).toMatch(/summary/);
  });
});

describe('imported files', () => {
  async function addSource(id: string, name: string, text: string, extra: Record<string, unknown> = {}) {
    const dir = sourceDir(profile.dir, 'hmp', id);
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, 'text.txt'), text);
    const entry = { name, kind: 'pdf', size: 10, sha256: 'a'.repeat(64), addedAt: `2026-10-0${Object.keys(await readSources(profile, 'hmp')).length + 1}T00:00:00.000Z`, chars: text.length, ...extra };
    const exists = (await profile.changes.read(sourcesTarget('hmp'))) !== null;
    await profile.changes.propose(
      {
        author: { kind: 'learner' },
        target: sourcesTarget('hmp'),
        patch: exists ? [{ op: 'add', path: `/sources/${id}`, value: entry as never }] : [{ op: 'add', path: '', value: { schemaVersion: 1, sources: { [id]: entry } } as never }],
        reason: 'add',
      },
      'auto',
    );
  }

  it('lists, reads page by page and searches what the learner imported', async () => {
    expect(text(await call('list_sources'))).toBe('No imported files yet.');
    expect(text(await call('get_teaching_context'))).toMatch(/# Imported files[^\n]*\nNone\./);
    const paper = `[page 1]\nIntro.\n\n[page 2]\nThe articulated-body inertia is ${'x'.repeat(300)} articulated again.`;
    await addSource('src_1', 'featherstone.pdf', paper, { pages: 2 });
    await addSource('src_2', 'photo.png', '', { kind: 'image', note: 'An image.' });
    expect(text(await call('list_sources'))).toBe(
      `- src_1: "featherstone.pdf" (pdf, 2 pages, ${paper.length} characters of text, added 2026-10-01)\n- src_2: "photo.png" (image, 0 characters of text, added 2026-10-02) An image.`,
    );
    expect(text(await call('get_teaching_context'))).toMatch(/- src_1: "featherstone\.pdf" \(pdf, 2 pages\)\n- src_2: "photo\.png" \(image\)/);

    const first = text(await call('read_source', { sourceId: 'src_1', length: 100 }));
    expect(first).toMatch(/^\[page 1\]\nIntro\./);
    expect(first).toMatch(/\[characters 0–100 of \d+; continue with offset 100\]$/);
    expect(text(await call('read_source', { sourceId: 'src_1', offset: 100 }))).toMatch(/articulated again\.\n\n\[characters 100–\d+ of \d+; end of file\]$/);
    expect(text(await call('read_source', { sourceId: 'src_2' }))).toMatch(/no text/);
    const missing = await call('read_source', { sourceId: 'src_9' });
    expect(missing.isError).toBe(true);
    expect(text(await call('read_source', { sourceId: '../../etc' }))).toMatch(/No imported file/);

    const found = text(await call('search_sources', { query: 'ARTICULATED' }));
    expect(found.split('\n')).toHaveLength(2);
    expect(found).toMatch(/^- src_1 "featherstone\.pdf" at \d+ \(page 2\): …/);
    expect(text(await call('search_sources', { query: 'articulated', maxResults: 1 })).split('\n')).toHaveLength(1);
    expect(text(await call('search_sources', { query: 'Intro' }))).toMatch(/at 9 \(page 1\)/);
    expect(text(await call('search_sources', { query: 'quaternion' }))).toBe('"quaternion" does not appear in the imported files.');
    expect(sourcesSummary({}, 1)).toBe('None.');
    expect(validateSources({ schemaVersion: 1, sources: { nope: {} } })[0]).toMatch(/^sources/);
    expect(validateSources(null)[0]).toMatch(/^\(sources\)/);
    expect(sourcesSummary(await readSources(profile, 'hmp'), 1)).toMatch(/^\(1 older files not listed; see list_sources\)\n- src_2/);
    // A text file that went missing reads as empty rather than failing.
    await rm(path.join(sourceDir(profile.dir, 'hmp', 'src_1'), 'text.txt'));
    expect(await sourceText(profile, 'hmp', 'src_1')).toBe('');
  });
});
