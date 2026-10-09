import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AgentHost, genericAgent } from '@app/agent-host';
import { AppService } from '../src/index.ts';
import { cutOff, Transcripts } from '../src/transcripts.ts';
import { fakeTeacherAgent, type FakeLog } from './fake-teacher-agent.ts';

let root: string;
let log: FakeLog;
const apps: AppService[] = [];

/** A run of the app on the same data folder; several runs in a row are restarts. */
function start(opts: { resume?: boolean } = {}): AppService {
  const app = new AppService({
    dataRoot: root,
    agent: genericAgent('fake', 'Fake Tutor', { command: 'unused', args: [] }),
    hostFactory: (spec) => AgentHost.inProcess(fakeTeacherAgent(log, opts), spec),
  });
  apps.push(app);
  return app;
}

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'restart-'));
  log = { prompts: [], sessions: 0 };
});

afterEach(async () => {
  for (const a of apps.splice(0)) await a.close();
  await rm(root, { recursive: true, force: true });
});

async function setup(app: AppService) {
  const p = await app.call('profiles.create', { displayName: 'Ada' });
  await app.call('profiles.open', { profileId: p.id });
  const project = await app.call('projects.create', { title: 'HMP', goal: 'g' });
  return { profileId: p.id, projectId: project.id };
}

function ask(app: AppService, projectId: string, question: string) {
  const done = new Promise<void>((resolve) => app.subscribe((e) => e === 'ask.done' && resolve()));
  return app.call('ask', { projectId, question, thread: 'session' }).then(async (r) => (await done, r));
}

describe('the place in the app', () => {
  it('is merged, cleared key by key, and kept across restarts', async () => {
    const app = start();
    expect(await app.call('place.get', {})).toEqual({});
    await app.call('place.set', { profileId: 'prof_1', projectId: 'hmp', view: 'lesson', lessonId: 'l1', editor: true, file: 'physics/Joint.cpp' });
    expect(await app.call('place.set', { view: 'path', lessonId: null })).toEqual({ profileId: 'prof_1', projectId: 'hmp', view: 'path', editor: true, file: 'physics/Joint.cpp' });
    await expect(app.call('place.set', { view: 'nowhere' })).rejects.toMatchObject({ code: 'invalid_params' });
    // The workspace layout is kept with it, and replaced whole.
    await app.call('place.set', { layout: { contents: 260, margin: 420, folded: true } });
    await app.call('place.set', { layout: { margin: 400 } });
    await expect(app.call('place.set', { layout: { margin: -1 } })).rejects.toMatchObject({ code: 'invalid_params' });
    expect(await start().call('place.get', {})).toMatchObject({ view: 'path', file: 'physics/Joint.cpp', layout: { margin: 400 } });
  });

  it('is empty when its file is unreadable', async () => {
    await writeFile(path.join(root, 'place.json'), '{ torn');
    expect(await start().call('place.get', {})).toEqual({});
    await writeFile(path.join(root, 'place.json'), JSON.stringify({ view: 42 }));
    expect(await start().call('place.get', {})).toEqual({});
  });
});

describe('editor drafts', () => {
  it('keeps unsaved text per file until it is saved or discarded', async () => {
    const app = start();
    const { projectId } = await setup(app);
    expect(await app.call('drafts.list', { projectId })).toEqual([]);
    await app.call('drafts.set', { projectId, path: 'physics/Joint.cpp', content: 'void f() {}', baseVersion: 'v1' });
    await app.call('drafts.set', { projectId, path: 'notes.md', content: '# new file' });
    const list = await app.call('drafts.list', { projectId });
    expect(list.map((d) => [d.path, d.content, d.baseVersion])).toEqual([
      ['notes.md', '# new file', undefined],
      ['physics/Joint.cpp', 'void f() {}', 'v1'],
    ]);
    await app.call('drafts.set', { projectId, path: 'notes.md', content: null });
    expect((await app.call('drafts.list', { projectId })).map((d) => d.path)).toEqual(['physics/Joint.cpp']);
    await expect(app.call('drafts.list', { projectId: 'nope' })).rejects.toMatchObject({ code: 'not_found' });
    await expect(app.call('drafts.set', { projectId: 'nope', path: 'a', content: 'x' })).rejects.toMatchObject({ code: 'not_found' });
  });

  it('skips a draft it cannot read', async () => {
    const app = start();
    const { profileId, projectId } = await setup(app);
    await app.call('drafts.set', { projectId, path: 'a.cpp', content: 'a' });
    const dir = path.join(root, 'profiles', profileId, 'projects', projectId, 'editor-drafts');
    await writeFile(path.join(dir, 'torn.json'), '{');
    await writeFile(path.join(dir, 'wrong.json'), JSON.stringify({ path: 1 }));
    await writeFile(path.join(dir, 'README'), 'not a draft');
    expect((await app.call('drafts.list', { projectId })).map((d) => d.path)).toEqual(['a.cpp']);
  });
});

describe('a turn in progress', () => {
  it('is listed as running, and its streamed text is saved as it comes', async () => {
    const app = start();
    const { projectId } = await setup(app);
    const text = new Promise<void>((resolve) => app.subscribe((e, d) => e === 'ask.event' && (d as { event: { kind: string } }).event.kind === 'text' && resolve()));
    const done = new Promise<void>((resolve) => app.subscribe((e) => e === 'ask.done' && resolve()));
    const { askId } = await app.call('ask', { projectId, question: 'long answer', thread: 'session' });
    await text;
    expect(await app.call('conversations.running', { projectId, thread: 'session' })).toEqual([askId]);
    expect(await app.call('conversations.running', { projectId, thread: 'chat' })).toEqual([]);
    const saved = await app.call('conversations.get', { projectId, thread: 'session' });
    expect(saved.some((e) => e.t === 'event' && e.askId === askId && e.event.kind === 'text' && e.event.text.length === 5000)).toBe(true);
    await done;
    expect(await app.call('conversations.running', { projectId, thread: 'session' })).toEqual([]);
  });

  it('cut off by a restart is pointed out to the tutor once, with the steps it had taken', async () => {
    const app = start();
    const { profileId, projectId } = await setup(app);
    await new Transcripts(path.join(root, 'profiles', profileId)).append(projectId, 'session', [
      { t: 'ask', askId: 'old', at: '', question: 'Write the next lesson' },
      { t: 'event', askId: 'old', event: { kind: 'tool', id: '1', title: 'mcp__aporia__get_teaching_context', status: 'completed' } },
      { t: 'event', askId: 'old', event: { kind: 'tool', id: '1', status: 'completed' } },
      { t: 'event', askId: 'old', event: { kind: 'tool', id: '2', title: 'mcp__aporia__draft_lesson' } },
    ]);
    await ask(app, projectId, 'hello');
    expect(log.prompts.at(-1)).toContain('<interrupted-turn>');
    expect(log.prompts.at(-1)).toContain('"Write the next lesson"');
    expect(log.prompts.at(-1)).toContain('Steps you had taken: mcp__aporia__get_teaching_context; mcp__aporia__draft_lesson.');
    await ask(app, projectId, 'hello again');
    expect(log.prompts.at(-1)).not.toContain('<interrupted-turn>');
  });
});

describe('cutOff', () => {
  it('says nothing for a finished, running or missing turn, and notes a turn with no steps', () => {
    const ask = { t: 'ask' as const, askId: 'a', at: '', question: 'q' };
    expect(cutOff([], new Set())).toBeUndefined();
    expect(cutOff([ask, { t: 'end', askId: 'a', state: 'done' }], new Set())).toBeUndefined();
    expect(cutOff([ask], new Set(['a']))).toBeUndefined();
    expect(cutOff([ask], new Set())).toContain('You had not taken any step yet.');
  });
});

describe('agent sessions across restarts', () => {
  it('are resumed with their memory when the agent can, so no recap is sent', async () => {
    const first = start({ resume: true });
    const { profileId, projectId } = await setup(first);
    await ask(first, projectId, 'hello');
    expect(log.sessions).toBe(1);
    await first.close();

    const second = start({ resume: true });
    await second.call('profiles.open', { profileId });
    await ask(second, projectId, 'hello again');
    expect(log.resumed).toEqual(['s1']);
    expect(log.sessions).toBe(1);
    expect(log.prompts.at(-1)).not.toContain('<earlier-conversation>');
    // The resumed session can still use the teaching tools.
    await ask(second, projectId, 'lesson please');
    expect(log.prompts).toHaveLength(3);
  });

  it('start over with a recap when the agent cannot resume, or no longer has the session', async () => {
    const first = start();
    const { profileId, projectId } = await setup(first);
    await ask(first, projectId, 'hello');
    await first.close();

    const second = start();
    await second.call('profiles.open', { profileId });
    await ask(second, projectId, 'hello again');
    expect(log.resumed).toBeUndefined();
    expect(log.sessions).toBe(2);
    expect(log.prompts.at(-1)).toContain('<earlier-conversation>');
    await second.close();

    // The agent forgot it (the remembered id is unknown to it).
    const file = path.join(root, 'profiles', profileId, 'agent-sessions.json');
    const saved = JSON.parse(await readFile(file, 'utf8')) as Record<string, { sessionId: string }>;
    for (const s of Object.values(saved)) s.sessionId = 'forgotten';
    await writeFile(file, JSON.stringify(saved));
    const third = start({ resume: true });
    await third.call('profiles.open', { profileId });
    await ask(third, projectId, 'still there?');
    expect(log.sessions).toBe(3);
    expect(log.prompts.at(-1)).toContain('<earlier-conversation>');
  });

  it('ignore an unreadable record of sessions', async () => {
    const first = start({ resume: true });
    const { profileId, projectId } = await setup(first);
    await mkdir(path.join(root, 'profiles', profileId), { recursive: true });
    await writeFile(path.join(root, 'profiles', profileId, 'agent-sessions.json'), '{ torn');
    await ask(first, projectId, 'hello');
    expect(log.sessions).toBe(1);
    expect(JSON.parse(await readFile(path.join(root, 'profiles', profileId, 'agent-sessions.json'), 'utf8'))).toMatchObject({
      [`${projectId}/~session`]: { sessionId: 's1', agent: 'fake' },
    });
  });
});
