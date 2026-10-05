import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { AgentHost, genericAgent } from '@app/agent-host';
import { ManualClock } from '@app/core';
import { AppService, buildAskPrompt, serve, type Served } from '../src/index.ts';
import type { Method, Params, Results, ServerEvents, ServerMessage } from '../src/protocol.ts';
import { fakeTeacherAgent, type FakeLog } from './fake-teacher-agent.ts';

let root: string;
let app: AppService;
let served: Served;
let log: FakeLog;

class TestClient {
  readonly ws: WebSocket;
  #next = 1;
  readonly #pending = new Map<number, (m: ServerMessage) => void>();
  readonly events: { event: keyof ServerEvents; data: unknown }[] = [];
  readonly opened: Promise<void>;
  constructor(url: string, origin?: string) {
    this.ws = new WebSocket(url, origin ? { origin } : {});
    this.opened = new Promise((resolve, reject) => {
      this.ws.once('open', () => resolve());
      this.ws.once('error', reject);
      this.ws.once('unexpected-response', (_req, res) => reject(new Error(`HTTP ${res.statusCode}`)));
    });
    this.ws.on('message', (raw) => {
      const m = JSON.parse(raw.toString()) as ServerMessage;
      if ('event' in m) this.events.push(m);
      else this.#pending.get(m.id)?.(m);
    });
  }
  async call<M extends Method>(method: M, params?: Params<M>): Promise<Results[M]> {
    const m = await this.raw(method, params);
    if ('error' in m) throw Object.assign(new Error(m.error.message), { code: m.error.code, data: m.error.data });
    return (m as { result: Results[M] }).result;
  }
  raw(method: string, params?: unknown): Promise<ServerMessage> {
    const id = this.#next++;
    return new Promise((resolve) => {
      this.#pending.set(id, resolve);
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  async waitFor(pred: (e: { event: string; data: any }) => boolean, ms = 3000): Promise<{ event: string; data: any }> {
    const start = Date.now();
    for (;;) {
      const hit = this.events.find(pred);
      if (hit) return hit;
      if (Date.now() - start > ms) throw new Error('timed out waiting for event');
      await new Promise((r) => setTimeout(r, 10));
    }
  }
}

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'server-'));
  log = { prompts: [], sessions: 0 };
  app = new AppService({
    dataRoot: root,
    clock: new ManualClock('2026-10-05T10:00:00.000Z'),
    agent: genericAgent('fake', 'Fake Tutor', { command: 'unused', args: [] }),
    hostFactory: (spec) => AgentHost.inProcess(fakeTeacherAgent(log), spec),
  });
  served = await serve({ app, token: 't0ken', allowedOrigins: ['http://localhost:5173'] });
});

afterEach(async () => {
  await served.close();
  await app.close();
  await rm(root, { recursive: true, force: true });
});

async function client(): Promise<TestClient> {
  const c = new TestClient(`${served.url.replace('http', 'ws')}/rpc?token=t0ken`);
  await c.opened;
  return c;
}

async function withProject(c: TestClient) {
  const p = await c.call('profiles.create', { displayName: 'Jules' });
  await c.call('profiles.open', { profileId: p.id });
  const project = await c.call('projects.create', { title: 'Heavy Metal Physics', goal: 'Learn Featherstone', why: 'my engine' });
  return { p, project };
}

describe('transport security', () => {
  it('rejects a wrong token, a foreign origin, and other paths', async () => {
    await expect(new TestClient(`${served.url.replace('http', 'ws')}/rpc?token=nope`).opened).rejects.toThrow(/403/);
    await expect(new TestClient(`${served.url.replace('http', 'ws')}/rpc?token=t0ken`, 'https://evil.example').opened).rejects.toThrow(/403/);
    await expect(new TestClient(`${served.url.replace('http', 'ws')}/other?token=t0ken`).opened).rejects.toThrow(/403/);
    const ok = new TestClient(`${served.url.replace('http', 'ws')}/rpc?token=t0ken`, 'http://localhost:5173');
    await ok.opened;
    ok.ws.close();
  });

  it('answers unknown methods, ignores junk, and validates params', async () => {
    const c = await client();
    c.ws.send('not json');
    c.ws.send(JSON.stringify({ nope: true }));
    expect(await c.raw('nope.method')).toMatchObject({ error: { code: 'unknown_method' } });
    expect(await c.raw('profiles.create', { displayName: '' })).toMatchObject({ error: { code: 'invalid_params' } });
    expect(await c.raw('projects.list')).toMatchObject({ error: { code: 'no_profile' } });
    expect(await c.call('app.info')).toMatchObject({ agent: 'Fake Tutor' });
    await expect(app.call('nope' as Method, {})).rejects.toMatchObject({ code: 'unknown_method' });
  });

  it('serves no static files without a UI directory', async () => {
    expect((await fetch(`${served.url}/index.html`)).status).toBe(404);
  });
});

describe('profiles, projects, lessons, learner', () => {
  it('creates and opens profiles and projects; settings persist', async () => {
    const c = await client();
    const { p, project } = await withProject(c);
    expect(await c.call('profiles.list')).toHaveLength(1);
    expect(await c.call('profiles.open', { profileId: p.id })).toMatchObject({ id: p.id });
    expect(project.id).toMatch(/^heavy-metal-physics-[0-9a-f]{6}$/);
    expect(await c.call('projects.list')).toEqual([project]);
    const s = await c.call('profiles.updateSettings', { changeMode: 'auto', sessionMode: 'interaction' });
    expect(s.settings).toMatchObject({ changeMode: 'auto', sessionMode: 'interaction' });
    expect(c.events.some((e) => e.event === 'changed')).toBe(true);
    await expect(c.call('profiles.open', { profileId: 'prof_nope' })).rejects.toMatchObject({ code: 'not_found' });
  });

  it('switches profiles, releasing the previous one', async () => {
    const c = await client();
    const a = await c.call('profiles.create', { displayName: 'A' });
    const b = await c.call('profiles.create', { displayName: 'B' });
    await c.call('profiles.open', { profileId: a.id });
    await c.call('projects.create', { title: 'Only A', goal: 'g' });
    await c.call('profiles.open', { profileId: b.id });
    expect(await c.call('projects.list')).toEqual([]);
    await c.call('profiles.open', { profileId: a.id });
    expect((await c.call('projects.list')).map((p) => p.title)).toEqual(['Only A']);
  });

  it('records deterministic answers and summarises the learner', async () => {
    const c = await client();
    await withProject(c);
    await c.call('projects.create', { title: 'Second', goal: 'g' });
    expect((await c.call('projects.list')).map((p) => p.title)).toEqual(['Heavy Metal Physics', 'Second']);
    await c.call('answers.record', {
      projectId: 'x-1', lessonId: 'l1', itemId: 'w0', kcs: ['spatial.motion'], difficulty: 2, evidenceType: 'production', outcome: 0,
    });
    await c.call('answers.record', {
      projectId: 'x-1', lessonId: 'l1', itemId: 'w1', kcs: ['quaternion.unit'], difficulty: 3, evidenceType: 'recognition', outcome: 1, confidence: 'sure',
    });
    const s = await c.call('learner.summary');
    expect(s.kcs.map((k) => k.kc)).toEqual(['quaternion.unit', 'spatial.motion']);
    expect(s.kcs[0]).toMatchObject({ kc: 'quaternion.unit', mastery: 'practising' });
    expect(s.recentSuccess).toEqual({ correct: 1, total: 2 });
    const h = await c.call('history.list', {});
    expect(h[0]).toMatchObject({ kind: 'observation', author: { kind: 'system' }, status: 'active' });
  });
});

describe('asking the agent', () => {
  it('streams an answer and builds the prompt with context', async () => {
    const c = await client();
    const { project } = await withProject(c);
    const { askId } = await c.call('ask', { projectId: project.id, lessonId: 'l1', anchor: 'side/0', selection: 'exp(ω dt)', question: 'why right?' });
    await c.waitFor((e) => e.event === 'ask.done' && e.data.askId === askId);
    const text = c.events.filter((e) => e.event === 'ask.event').map((e: any) => (e.data.event.kind === 'text' ? e.data.event.text : '')).join('');
    expect(text).toBe('You asked: why right?');
    expect(log.prompts[0]).toMatch(/Lesson: l1 \(at side\/0\)[\s\S]*exp\(ω dt\)/);
    expect(buildAskPrompt({ question: 'q' })).not.toMatch(/<context>/);
  });

  it('lets the agent draft lessons through the teaching tools; review mode needs acceptance; undo/redo work', async () => {
    const c = await client();
    const { project } = await withProject(c);
    const { askId } = await c.call('ask', { projectId: project.id, question: 'lesson please' });
    await c.waitFor((e) => e.event === 'ask.done' && e.data.askId === askId);
    expect(await c.call('lessons.list', { projectId: project.id })).toEqual([]);
    const pending = (await c.call('history.list', {})).find((h) => h.status === 'proposed')!;
    expect(pending).toMatchObject({ kind: 'change', author: { kind: 'agent', agent: 'fake' } });
    await c.call('history.accept', { id: pending.id });
    const lessons = await c.call('lessons.list', { projectId: project.id });
    expect(lessons).toEqual([{ id: 'hmp-09-four-numbers', title: 'Four Numbers, Three Speeds', kind: 'build', estimateMin: 120 }]);
    expect(await c.call('lessons.get', { projectId: project.id, lessonId: 'hmp-09-four-numbers' })).toMatchObject({ id: 'hmp-09-four-numbers' });
    await c.call('history.undo', { id: pending.id });
    expect(await c.call('lessons.list', { projectId: project.id })).toEqual([]);
    await expect(c.call('lessons.get', { projectId: project.id, lessonId: 'hmp-09-four-numbers' })).rejects.toMatchObject({ code: 'not_found' });
    await c.call('history.redo', { id: pending.id });
    expect(await c.call('lessons.list', { projectId: project.id })).toHaveLength(1);
    await expect(c.call('history.redo', { id: pending.id })).rejects.toMatchObject({ code: 'conflict' });
  });

  it('auto mode applies immediately; reject and bulk undo by agent', async () => {
    const c = await client();
    const { project } = await withProject(c);
    await c.call('profiles.updateSettings', { changeMode: 'auto' });
    let r = await c.call('ask', { projectId: project.id, question: 'lesson please' });
    await c.waitFor((e) => e.event === 'ask.done' && e.data.askId === r.askId);
    expect(await c.call('lessons.list', { projectId: project.id })).toHaveLength(1);
    r = await c.call('ask', { projectId: project.id, question: 'evidence' });
    await c.waitFor((e) => e.event === 'ask.done' && e.data.askId === r.askId);
    expect((await c.call('learner.summary')).kcs).toHaveLength(1);
    const { undone } = await c.call('history.undoWhere', { filter: { agent: 'fake' } });
    expect(undone).toHaveLength(2);
    expect(await c.call('lessons.list', { projectId: project.id })).toEqual([]);
    expect((await c.call('learner.summary')).kcs).toEqual([]);
    const evidence = (await c.call('history.list', { filter: { authorKind: 'agent' } })).find((h) => h.kind === 'observation')!;
    expect(evidence.status).toBe('revoked');
    await c.call('history.redo', { id: evidence.id });
    await c.call('history.undo', { id: evidence.id });

    await c.call('profiles.updateSettings', { changeMode: 'review' });
    r = await c.call('ask', { projectId: project.id, question: 'lesson please' });
    await c.waitFor((e) => e.event === 'ask.done' && e.data.askId === r.askId);
    const pending = (await c.call('history.list', {})).find((h) => h.status === 'proposed')!;
    await c.call('history.reject', { id: pending.id });
    await expect(c.call('history.accept', { id: pending.id })).rejects.toMatchObject({ code: 'conflict' });
  });

  it('summarises every kind of observation in the history and the learner model', async () => {
    const c = await client();
    const { project } = await withProject(c);
    const r = await c.call('ask', { projectId: project.id, question: 'observe' });
    await c.waitFor((e) => e.event === 'ask.done' && e.data.askId === r.askId);
    const summaries = (await c.call('history.list', {})).map((h) => h.summary);
    expect(summaries).toEqual(
      expect.arrayContaining([
        'Taught quaternion.unit',
        'New insight: Likes the maths first',
        expect.stringMatching(/^Contradicted insight ins_/),
        expect.stringMatching(/^Supported insight ins_/),
        'Evidence on quaternion.unit: 50% with hint L2 (production)',
      ]),
    );
    const s = await c.call('learner.summary');
    expect(s.insights[0]).toMatchObject({ text: 'Likes the maths first', scope: 'global' });
  });

  it('reports dependants when undoing a change that later changes build on', async () => {
    const c = await client();
    const { project } = await withProject(c);
    await c.call('profiles.updateSettings', { changeMode: 'auto' });
    for (let i = 0; i < 2; i++) {
      const r = await c.call('ask', { projectId: project.id, question: 'lesson please' });
      await c.waitFor((e) => e.event === 'ask.done' && e.data.askId === r.askId);
    }
    const [newer, older] = (await c.call('history.list', { filter: { authorKind: 'agent' } })).filter((h) => h.kind === 'change');
    await expect(c.call('history.undo', { id: older!.id })).rejects.toMatchObject({ code: 'dependants', data: { dependants: [newer!.id] } });
    expect((await c.call('history.undo', { id: older!.id, withDependants: true })).undone).toEqual([newer!.id, older!.id]);
  });

  it('reuses sessions per lesson, opens fresh ones per interaction', async () => {
    const c = await client();
    const { project } = await withProject(c);
    const ask = async (lessonId?: string) => {
      const r = await c.call('ask', { projectId: project.id, question: 'hi', ...(lessonId ? { lessonId } : {}) });
      await c.waitFor((e) => e.event === 'ask.done' && e.data.askId === r.askId);
    };
    await ask('l1');
    await ask('l1');
    await ask('l2');
    expect(log.sessions).toBe(2);
    await c.call('profiles.updateSettings', { sessionMode: 'permanent' });
    await ask('l1');
    await ask('l3');
    expect(log.sessions).toBe(3);
    await c.call('profiles.updateSettings', { sessionMode: 'interaction' });
    await ask();
    await ask();
    expect(log.sessions).toBe(5);
  });

  it('cancels a running question and reports agent errors', async () => {
    const c = await client();
    const { project } = await withProject(c);
    const r = await c.call('ask', { projectId: project.id, question: 'slow' });
    await new Promise((res) => setTimeout(res, 30));
    await c.call('ask.cancel', { askId: r.askId });
    const done = await c.waitFor((e) => e.event === 'ask.done' && e.data.askId === r.askId);
    expect(done.data.stopReason).toBe('cancelled');
    await expect(c.call('ask.cancel', { askId: r.askId })).rejects.toMatchObject({ code: 'not_found' });
    const crash = await c.call('ask', { projectId: project.id, question: 'crash' });
    await c.waitFor((e) => e.event === 'ask.error' && e.data.askId === crash.askId);
    await expect(c.call('ask', { projectId: 'nope-1', question: 'x' })).rejects.toMatchObject({ code: 'not_found' });
  });

  it('closes cleanly while the agent is still starting and then fails', async () => {
    const app3 = new AppService({
      dataRoot: path.join(root, 'other'),
      agent: genericAgent('fake', 'Fake', { command: 'unused', args: [] }),
      hostFactory: () => new Promise((_, reject) => setTimeout(() => reject(new Error('late failure')), 20)),
    });
    const p = await app3.call('profiles.create', { displayName: 'Q' });
    await app3.call('profiles.open', { profileId: p.id });
    const project = await app3.call('projects.create', { title: 'T', goal: 'g' });
    await app3.call('ask', { projectId: project.id, question: 'hi' });
    await app3.close();
  });

  it('surfaces agent start-up failures and retries on the next question', async () => {
    let fail = true;
    const app2 = new AppService({
      dataRoot: root,
      agent: genericAgent('fake', 'Fake', { command: 'unused', args: [] }),
      hostFactory: async (spec) => {
        if (fail) {
          fail = false;
          throw new Error('agent not installed');
        }
        return AgentHost.inProcess(fakeTeacherAgent(log), spec);
      },
    });
    const events: string[] = [];
    app2.subscribe((event, data) => events.push(`${event}:${JSON.stringify(data)}`));
    await served.close();
    await app.close();
    const p = await app2.call('profiles.create', { displayName: 'Z' });
    await app2.call('profiles.open', { profileId: p.id });
    const project = await app2.call('projects.create', { title: 'T', goal: 'g', workspace: path.join(root, 'ws') });
    await app2.call('ask', { projectId: project.id, question: 'hi' });
    await new Promise((r) => setTimeout(r, 50));
    expect(events.some((e) => e.startsWith('ask.error') && e.includes('agent not installed'))).toBe(true);
    await app2.call('ask', { projectId: project.id, question: 'hi' });
    await new Promise((r) => setTimeout(r, 50));
    expect(events.some((e) => e.startsWith('ask.done'))).toBe(true);
    await app2.close();
    served = await serve({ app: (app = new AppService({ dataRoot: root })) });
  });
});

describe('static UI serving', () => {
  it('serves files with a strict CSP, falls back to index.html, and refuses traversal', async () => {
    const { mkdir, writeFile } = await import('node:fs/promises');
    const ui = path.join(root, 'ui');
    await mkdir(path.join(ui, 'assets'), { recursive: true });
    await writeFile(path.join(ui, 'index.html'), '<!doctype html><title>x</title>');
    await writeFile(path.join(ui, 'assets', 'app.js'), 'console.log(1)');
    await writeFile(path.join(ui, 'data.bin'), 'x');
    const s = await serve({ app, staticDir: ui });
    try {
      const index = await fetch(`${s.url}/`);
      expect(index.status).toBe(200);
      expect(index.headers.get('content-security-policy')).toMatch(/default-src 'self'/);
      expect((await fetch(`${s.url}/assets/app.js`)).headers.get('content-type')).toBe('text/javascript');
      expect((await fetch(`${s.url}/data.bin`)).headers.get('content-type')).toBe('application/octet-stream');
      expect(await (await fetch(`${s.url}/some/route`)).text()).toMatch(/<title>x/);
      const { request } = await import('node:http');
      const u = new URL(s.url);
      const raw = (p: string) =>
        new Promise<number>((resolve) => request({ host: u.hostname, port: u.port, path: p }, (res) => resolve(res.statusCode!)).end());
      expect(await raw('/..%2f..%2fetc%2fpasswd')).toBe(403);
      expect((await fetch(`${s.url}/`, { method: 'POST' })).status).toBe(404);
      const empty = await serve({ app, staticDir: path.join(root, 'nothing') });
      expect((await fetch(`${empty.url}/x`)).status).toBe(404);
      await empty.close();
    } finally {
      await s.close();
    }
  });
});

describe('error translation', () => {
  it('maps core errors to protocol codes', async () => {
    const c = await client();
    const { p } = await withProject(c);
    await expect(c.call('history.undo', { id: 'ev_nope' })).rejects.toMatchObject({ code: 'not_found' });
    await expect(c.call('history.accept', { id: 'chg_nope' })).rejects.toMatchObject({ code: 'conflict' });
    const other = new AppService({ dataRoot: root });
    await expect(other.call('profiles.open', { profileId: p.id })).rejects.toMatchObject({ code: 'conflict' });
    await other.close();
    await expect(c.call('lessons.list', { projectId: 'BAD ID' as never })).rejects.toMatchObject({ code: 'invalid_params' });
  });
});
