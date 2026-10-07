import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AgentHost, genericAgent } from '@app/agent-host';
import { fourNumbers } from '../../catalog/fixtures/four-numbers.ts';
import { AppService } from '../src/index.ts';
import { fakeTeacherAgent, type FakeLog } from './fake-teacher-agent.ts';

let root: string;
let app: AppService;
let log: FakeLog;
const events: string[] = [];

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'hints-'));
  log = { prompts: [], sessions: 0 };
  app = new AppService({
    dataRoot: root,
    agent: genericAgent('fake', 'Fake Tutor', { command: 'unused', args: [] }),
    hostFactory: (spec) => AgentHost.inProcess(fakeTeacherAgent(log), spec),
  });
  events.length = 0;
  app.subscribe((e, d) => e === 'changed' && events.push((d as { what: string }).what));
});

afterEach(async () => {
  await app.close();
  await rm(root, { recursive: true, force: true });
});

async function ask(projectId: string, question: string): Promise<string> {
  let text = '';
  const done = new Promise<void>((resolve) =>
    app.subscribe((e, d) => {
      if (e === 'ask.event' && (d as { event: { kind: string } }).event.kind === 'text') text += (d as { event: { text: string } }).event.text;
      if (e === 'ask.done') resolve();
    }),
  );
  await app.call('ask', { projectId, question, thread: 'chat' });
  await done;
  return text;
}

describe('hints', () => {
  it('shows the levels given per task, and what the next one needs', async () => {
    const p = await app.call('profiles.create', { displayName: 'Ada' });
    await app.call('profiles.open', { profileId: p.id });
    await app.call('profiles.updateSettings', { changeMode: 'auto' });
    const { id: projectId } = await app.call('projects.create', { title: 'HMP', goal: 'g' });
    await ask(projectId, 'lesson please');
    expect(await app.call('hints.get', { projectId, lessonId: fourNumbers.id })).toEqual({});

    for (const level of [1, 2, 3]) expect(await ask(projectId, `hint me ${level}`)).toMatch(/recorded/);
    expect(events).toContain('hints');
    let h = await app.call('hints.get', { projectId, lessonId: fourNumbers.id });
    expect(h['step-2']).toMatchObject({ max: 3, attemptSince: false, nextNeedsAttempt: true });
    expect(h['step-2']!.levels.map((l) => [l.level, l.summary])).toEqual([[1, 'which side'], [2, 'which side'], [3, 'which side']]);
    expect(await ask(projectId, 'hint me 4')).toMatch(/Not at L4/);

    // The learner writes what they tried: the next level opens.
    await app.call('hints.attempt', { projectId, lessonId: fourNumbers.id, taskId: 'step-2', text: 'I swapped the product' });
    h = await app.call('hints.get', { projectId, lessonId: fourNumbers.id });
    expect(h['step-2']).toMatchObject({ attemptSince: true, nextNeedsAttempt: false });
    expect(await ask(projectId, 'hint me 4')).toMatch(/^L4 \(Structure\) recorded/);

    await expect(app.call('hints.get', { projectId: 'nope', lessonId: 'x' })).rejects.toMatchObject({ code: 'not_found' });
    await expect(app.call('hints.attempt', { projectId, lessonId: 'x', taskId: 'y', text: '  ' })).rejects.toMatchObject({ code: 'invalid_params' });
  });
});
