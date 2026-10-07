import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AgentHost, genericAgent } from '@app/agent-host';
import { DAY_MS, ManualClock } from '@app/core';
import { fourNumbers } from '../../catalog/fixtures/four-numbers.ts';
import { AppService } from '../src/index.ts';
import { fakeTeacherAgent, type FakeLog } from './fake-teacher-agent.ts';

let root: string;
let app: AppService;
let clock: ManualClock;
let log: FakeLog;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'reviews-'));
  clock = new ManualClock('2026-10-06T10:00:00.000Z');
  log = { prompts: [], sessions: 0 };
  app = new AppService({
    dataRoot: root,
    clock,
    agent: genericAgent('fake', 'Fake Tutor', { command: 'unused', args: [] }),
    hostFactory: (spec) => AgentHost.inProcess(fakeTeacherAgent(log), spec),
  });
});

afterEach(async () => {
  await app.close();
  await rm(root, { recursive: true, force: true });
});

async function ask(projectId: string, question: string) {
  const done = new Promise<void>((resolve) => app.subscribe((e) => e === 'ask.done' && resolve()));
  await app.call('ask', { projectId, question, thread: 'session' });
  await done;
}

describe('reviews', () => {
  it('schedules answered items, lists them when due, and reschedules on review', async () => {
    const p = await app.call('profiles.create', { displayName: 'Ada' });
    await app.call('profiles.open', { profileId: p.id });
    await app.call('profiles.updateSettings', { changeMode: 'auto' });
    const { id: projectId } = await app.call('projects.create', { title: 'HMP', goal: 'g' });
    const other = await app.call('projects.create', { title: 'Other', goal: 'g' });
    await ask(projectId, 'lesson please');

    expect(await app.call('reviews.queue', { projectId })).toEqual({ items: [], dueCount: 0 });
    const answer = () =>
      app.call('answers.record', { projectId, lessonId: fourNumbers.id, itemId: 'w1', kcs: ['quaternion.unit'], difficulty: 2, evidenceType: 'recognition', outcome: 1, confidence: 'sure' });
    await answer();
    const scheduled = await app.call('reviews.queue', { projectId });
    expect(scheduled.dueCount).toBe(0);
    expect(Date.parse(scheduled.nextDue!)).toBeGreaterThan(clock.now().getTime());

    clock.advance(40 * DAY_MS);
    const due = await app.call('reviews.queue', { projectId });
    expect(due.dueCount).toBe(1);
    expect(due.items[0]).toMatchObject({ itemId: `${fourNumbers.id}/w1`, lessonId: fourNumbers.id, lessonTitle: fourNumbers.title, reviews: 1, item: { id: 'w1', kind: 'mcq' } });
    expect(due.items[0]!.retrievability).toBeGreaterThan(0);
    expect(due.items[0]!.retrievability).toBeLessThan(1);
    expect(await app.call('reviews.summary', {})).toEqual({ [projectId]: { due: 1 }, [other.id]: { due: 0 } });

    await answer();
    expect((await app.call('reviews.queue', { projectId })).dueCount).toBe(0);
    await expect(app.call('reviews.queue', { projectId: 'nope' })).rejects.toMatchObject({ code: 'not_found' });
  });
});
