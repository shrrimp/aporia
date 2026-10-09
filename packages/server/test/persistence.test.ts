import { appendFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentHost, genericAgent } from '@app/agent-host';
import { ManualClock } from '@app/core';
import { itemKey, lesson as lessonSchema, lessonUnits } from '@app/catalog';
import { fourNumbers } from '../../catalog/fixtures/four-numbers.ts';
import { AppService } from '../src/index.ts';
import { recap, Transcripts } from '../src/transcripts.ts';
import type { TranscriptEntry } from '../src/protocol.ts';
import { fakeTeacherAgent, type FakeLog } from './fake-teacher-agent.ts';

let root: string;
let log: FakeLog;
const apps: AppService[] = [];

function start(): AppService {
  const app = new AppService({
    dataRoot: root,
    clock: new ManualClock('2026-10-06T10:00:00.000Z'),
    agent: genericAgent('fake', 'Fake Tutor', { command: 'unused', args: [] }),
    hostFactory: (spec) => AgentHost.inProcess(fakeTeacherAgent(log), spec),
  });
  apps.push(app);
  return app;
}

/** Ask and wait for the turn to end; returns the askId. */
async function ask(app: AppService, params: Parameters<AppService['call']>[1] & object): Promise<string> {
  const ended = new Promise<string>((resolve) => {
    const off = app.subscribe((event, data) => {
      const d = data as { askId: string };
      if ((event === 'ask.done' || event === 'ask.error') && d.askId === askId) {
        off();
        resolve(d.askId);
      }
    });
  });
  const { askId } = await app.call('ask', params as never);
  return ended;
}

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'persist-'));
  log = { prompts: [], sessions: 0 };
});

afterEach(async () => {
  await Promise.all(apps.splice(0).map((a) => a.close()));
  await rm(root, { recursive: true, force: true });
});

async function withLesson(app: AppService) {
  const p = await app.call('profiles.create', { displayName: 'Ada' });
  await app.call('profiles.open', { profileId: p.id });
  const project = await app.call('projects.create', { title: 'Quaternions', goal: 'Rotate things.' });
  await ask(app, { projectId: project.id, question: 'lesson please', thread: 'session' });
  const pending = (await app.call('history.list', {})).find((h) => h.status === 'proposed');
  if (pending) await app.call('history.accept', { id: pending.id });
  return { profileId: p.id, projectId: project.id };
}

describe('lesson progress', () => {
  it('saves, counts and survives a restart', async () => {
    const app = start();
    const { profileId, projectId } = await withLesson(app);
    const lessonId = fourNumbers.id;
    const [first] = lessonUnits(lessonSchema.parse(fourNumbers));
    expect(await app.call('progress.set', { projectId, lessonId, key: first!, value: { result: 1 } })).toEqual({ saved: true });
    expect(await app.call('progress.set', { projectId, lessonId, key: first!, value: { result: 1 } })).toEqual({ saved: false });
    await app.call('progress.set', { projectId, lessonId, key: 'position', value: 'idea' });
    expect((await app.call('lessons.list', { projectId }))[0]!.progress).toEqual({ done: 1, total: lessonUnits(lessonSchema.parse(fourNumbers)).length });
    await app.close();

    const again = start();
    await again.call('profiles.open', { profileId });
    expect(await again.call('progress.get', { projectId, lessonId })).toEqual({ [first!]: { result: 1 }, position: 'idea' });
    expect((await again.call('lessons.list', { projectId }))[0]!.progress.done).toBe(1);
  });

  it('refuses oversized progress values', async () => {
    const app = start();
    const { projectId } = await withLesson(app);
    await expect(app.call('progress.set', { projectId, lessonId: fourNumbers.id, key: itemKey('x'), value: 'x'.repeat(30_000) })).rejects.toThrow(/too large/);
  });
});

describe('saved conversations', () => {
  it('keeps both threads across a restart, with forms, answers and gathered text, and reminds a fresh agent', async () => {
    const app = start();
    const p = await app.call('profiles.create', { displayName: 'Ada' });
    await app.call('profiles.open', { profileId: p.id });
    const project = await app.call('projects.create', { title: 'Quaternions', goal: 'Rotate things.' });
    const interview = await ask(app, { projectId: project.id, question: 'Interview me briefly to find out what I already know', thread: 'session' });
    await ask(app, {
      projectId: project.id,
      question: 'Answers to the form "Where you are starting from":\n- [bg] ...',
      thread: 'session',
      answers: { askId: interview, form: 0, title: 'Where you are starting from', values: { bg: { choice: 'Matrices' } } },
    });
    await ask(app, { projectId: project.id, question: 'quick one', thread: 'chat', selection: 'some passage', shown: { kind: 'message', text: 'quick', files: ['a.pdf'] } });
    // The card is for the learner: the tutor gets the question as it was.
    expect(log.prompts.at(-1)).toContain('The learner asks:\nquick one');
    expect(log.prompts.at(-1)).not.toContain('a.pdf');
    expect(log.prompts.filter((x) => x.includes('<earlier-conversation>'))).toEqual([]); // same run: the agent remembers
    await app.close();

    const again = start();
    await again.call('profiles.open', { profileId: p.id });
    const session = await again.call('conversations.get', { projectId: project.id, thread: 'session' });
    const asks = session.filter((e) => e.t === 'ask');
    expect(asks.map((e) => e.question)).toEqual(['Interview me briefly to find out what I already know', expect.stringMatching(/^Answers to the form/)]);
    expect(asks[1]).toMatchObject({ answersTo: 'Where you are starting from' });
    expect(session).toContainEqual({ t: 'submitted', askId: interview, form: 0, answers: { bg: { choice: 'Matrices' } } });
    expect(session.some((e) => e.t === 'event' && e.event.kind === 'form')).toBe(true);
    expect(session.filter((e) => e.t === 'end').map((e) => e.t === 'end' && e.state)).toEqual(['done', 'done']);
    // Text is gathered between other events instead of saved chunk by chunk.
    const texts = session.filter((e): e is Extract<TranscriptEntry, { t: 'event' }> => e.t === 'event' && e.event.kind === 'text' && e.askId === interview);
    expect(texts.length).toBeLessThanOrEqual(2);
    const chat = await again.call('conversations.get', { projectId: project.id, thread: 'chat' });
    expect(chat[0]).toMatchObject({ t: 'ask', question: 'quick one', selection: 'some passage', shown: { kind: 'message', text: 'quick', files: ['a.pdf'] } });

    await ask(again, { projectId: project.id, question: 'where were we?', thread: 'session' });
    const resumed = log.prompts.at(-1)!;
    expect(resumed).toContain('<earlier-conversation>');
    expect(resumed).toContain('Interview me briefly');
    expect(resumed).toContain('[showed the form "Where you are starting from"]');
    await ask(again, { projectId: project.id, question: 'and now?', thread: 'session' });
    expect(log.prompts.at(-1)).not.toContain('<earlier-conversation>');
  });

  it('saves failed and cancelled turns as such', async () => {
    const app = start();
    const p = await app.call('profiles.create', { displayName: 'Ada' });
    await app.call('profiles.open', { profileId: p.id });
    const project = await app.call('projects.create', { title: 'Q', goal: 'g' });
    const ended = new Promise<void>((resolve) => app.subscribe((event) => event === 'ask.done' && resolve()));
    const { askId } = await app.call('ask', { projectId: project.id, question: 'slow please', thread: 'chat' });
    await new Promise((r) => setTimeout(r, 50));
    await app.call('ask.cancel', { askId });
    await ended;
    const entries = await app.call('conversations.get', { projectId: project.id, thread: 'chat' });
    expect(entries.at(-1)).toEqual({ t: 'end', askId, state: 'cancelled' });
  });
});

describe('when the conversation cannot be saved', () => {
  it('still answers, and says so on stderr', async () => {
    const app = start();
    const p = await app.call('profiles.create', { displayName: 'Ada' });
    await app.call('profiles.open', { profileId: p.id });
    const project = await app.call('projects.create', { title: 'Q', goal: 'g' });
    const projectDir = path.join(root, 'profiles', p.id, 'projects', project.id);
    await mkdir(projectDir, { recursive: true });
    await writeFile(path.join(projectDir, 'conversations'), 'not a folder');
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      await ask(app, { projectId: project.id, question: 'hello', thread: 'chat' });
      expect(errors).toHaveBeenCalledWith(expect.stringMatching(/^could not save the conversation/));
      await expect(app.call('conversations.get', { projectId: project.id, thread: 'chat' })).rejects.toThrow();
    } finally {
      errors.mockRestore();
    }
  });
});

describe('transcripts', () => {
  it('reads nothing when nothing was saved, and skips a torn last line', async () => {
    const t = new Transcripts(root);
    expect(await t.read('p', 'chat')).toEqual([]);
    await t.append('p', 'chat', [{ t: 'end', askId: 'a', state: 'done' }]);
    await appendFile(path.join(root, 'projects', 'p', 'conversations', 'chat.jsonl'), '{"t":"ask","askId":', 'utf8');
    expect(await t.read('p', 'chat')).toEqual([{ t: 'end', askId: 'a', state: 'done' }]);
    await expect(new Transcripts(root).read('../../../../etc', 'chat')).rejects.toThrow();
  });

  it('recaps the latest exchanges within a budget', () => {
    expect(recap([])).toBeUndefined();
    const entries: TranscriptEntry[] = [];
    for (let i = 0; i < 10; i++) {
      entries.push({ t: 'ask', askId: `a${i}`, at: '', question: `question ${i} ${'x'.repeat(2000)}` });
      entries.push({ t: 'event', askId: `a${i}`, event: { kind: 'text', text: `answer ${i}` } });
    }
    entries.push({ t: 'ask', askId: 'z', at: '', question: 'last', answersTo: 'Form' });
    entries.push({ t: 'event', askId: 'nope', event: { kind: 'text', text: 'orphan' } });
    entries.push({ t: 'event', askId: 'nope', event: { kind: 'form', form: { title: 'x', questions: [] } as never } });
    const r = recap(entries, 3000)!;
    expect(r).toContain('(answered the form "Form") last');
    expect(r).toContain('You: (no reply)');
    expect(r).toContain('question 9');
    expect(r).not.toContain('question 0');
    expect(r).toMatch(/\(\d+ earlier exchanges not shown\)/);
    expect(r).not.toContain('orphan');
    const one = recap(entries.slice(0, 2).concat(entries.slice(-3, -2)), 600)!;
    expect(one).toContain('(1 earlier exchange not shown)');
  });
});
