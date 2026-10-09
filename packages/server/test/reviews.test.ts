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
    reviewWriter: { debounceMs: 5, retryMs: 0 },
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

/** A profile with the golden lesson, in the given review setting. */
async function setup(reviewQuestions: 'pool' | 'when-due' | 'numbers' = 'pool') {
  const p = await app.call('profiles.create', { displayName: 'Ada' });
  await app.call('profiles.open', { profileId: p.id });
  await app.call('profiles.updateSettings', { changeMode: 'auto', reviewQuestions });
  const { id: projectId } = await app.call('projects.create', { title: 'HMP', goal: 'g' });
  await ask(projectId, 'lesson please');
  const answerInLesson = () =>
    app.call('answers.record', { projectId, lessonId: fourNumbers.id, itemId: 'w1', kcs: ['quaternion.unit'], difficulty: 2, evidenceType: 'recognition', outcome: 1, confidence: 'sure' });
  const jobs = () => log.prompts.filter((t) => t.startsWith('<review-questions>')).length;
  return { projectId, answerInLesson, jobs };
}

describe('reviews', () => {
  it('schedules the skill, asks a new question on it each time, and keeps the bank stocked', async () => {
    const { projectId, answerInLesson, jobs } = await setup();
    const other = await app.call('projects.create', { title: 'Other', goal: 'g' });
    expect(await app.call('reviews.queue', { projectId })).toEqual({ slots: [], dueCount: 0, writing: false });

    // Answering in the lesson schedules the skill, and the tutor writes its review questions.
    await answerInLesson();
    await app.idle();
    expect(jobs()).toBe(1);
    expect(log.prompts.at(-1)).toMatch(/## quaternion\.unit[\s\S]*How the lesson tested it/);
    const scheduled = await app.call('reviews.queue', { projectId });
    expect(scheduled).toMatchObject({ slots: [], dueCount: 0, writing: false });
    expect(Date.parse(scheduled.nextDue!)).toBeGreaterThan(clock.now().getTime());

    clock.advance(40 * DAY_MS);
    const due = await app.call('reviews.queue', { projectId });
    expect(due.dueCount).toBe(1);
    const first = due.slots[0]!;
    expect(first).toMatchObject({ kc: 'quaternion.unit', reviews: 1, question: { seen: 'new' } });
    expect(first.retrievability).toBeGreaterThan(0);
    expect(first.retrievability).toBeLessThan(1);
    expect(first.question!.id).toMatch(/^~reviews\/r-/); // a review question, never the lesson's own item
    expect(await app.call('reviews.summary', {})).toEqual({ [projectId]: { due: 1 }, [other.id]: { due: 0 } });

    // Any answer on the skill reschedules it; the next time, the other question comes.
    const { id } = await app.call('reviews.answer', { projectId, questionId: first.question!.id, evidenceType: 'production', outcome: 1, confidence: 'sure' });
    expect(id).toMatch(/^ev_/);
    expect((await app.call('reviews.queue', { projectId })).dueCount).toBe(0);
    await app.idle();
    clock.advance(200 * DAY_MS);
    const next = (await app.call('reviews.queue', { projectId })).slots[0]!;
    expect(next.question).toMatchObject({ seen: 'new' });
    expect(next.question!.id).not.toBe(first.question!.id);
  });

  it('retires a question that makes no sense without its lesson, and withdraws the answer given to it', async () => {
    const { projectId, answerInLesson } = await setup('when-due');
    await answerInLesson();
    clock.advance(40 * DAY_MS);
    // Nothing new on the skill yet: "when due" writes now, and the page says so.
    const waiting = await app.call('reviews.queue', { projectId });
    expect(waiting.slots[0]!.question).toMatchObject({ id: `${fourNumbers.id}/w1`, seen: 'again', from: fourNumbers.title });
    expect(waiting.writing).toBe(true);
    await app.idle();
    const q = (await app.call('reviews.queue', { projectId })).slots[0]!.question!;
    expect(q.seen).toBe('new');
    expect(q.context ?? q.item.prompt).toBeTruthy();

    const { id: evidenceId } = await app.call('reviews.answer', { projectId, questionId: q.id, evidenceType: 'recognition', outcome: 0 });
    await app.call('reviews.flag', { projectId, questionId: q.id, evidenceId });
    // The answer is gone from the learner model; the question is never asked again.
    const learner = await app.call('learner.summary', {});
    expect(learner.recentSuccess.total).toBe(1);
    await expect(app.call('reviews.answer', { projectId, questionId: q.id, evidenceType: 'recognition', outcome: 1 })).rejects.toMatchObject({ code: 'not_found' });
    await app.idle();
    expect((await app.call('reviews.queue', { projectId })).slots[0]!.question!.id).not.toBe(q.id);

    // A lesson's own item can be retired from review too (the bank exists by now).
    await app.call('reviews.flag', { projectId, questionId: `${fourNumbers.id}/w1` });
    await expect(app.call('reviews.answer', { projectId, questionId: `${fourNumbers.id}/w1`, evidenceType: 'recognition', outcome: 1 })).rejects.toMatchObject({ code: 'not_found' });
    await expect(app.call('reviews.flag', { projectId, questionId: '~reviews/nope' })).rejects.toMatchObject({ code: 'not_found' });
    await expect(app.call('reviews.queue', { projectId: 'nope' })).rejects.toMatchObject({ code: 'not_found' });
  });

  it('retires a lesson item before any review question exists', async () => {
    const { projectId, answerInLesson } = await setup('when-due');
    await answerInLesson();
    await app.call('reviews.flag', { projectId, questionId: `${fourNumbers.id}/w1` });
    await app.idle();
    clock.advance(40 * DAY_MS);
    const slot = (await app.call('reviews.queue', { projectId })).slots[0]!;
    expect(slot.question?.id).not.toBe(`${fourNumbers.id}/w1`);
  });

  it('with "numbers only", writes a skill’s questions once, then gives templates new numbers', async () => {
    const { projectId, answerInLesson, jobs } = await setup('numbers');
    await answerInLesson();
    await app.idle();
    expect(jobs()).toBe(1);
    expect(log.prompts.at(-1)).toContain('make each a template');
    // Answer both questions: nothing new is written, the template comes back with new numbers.
    const untilDue = async () => clock.advance(Date.parse((await app.call('reviews.queue', { projectId })).nextDue!) - clock.now().getTime());
    for (let i = 0; i < 2; i++) {
      await untilDue();
      const q = (await app.call('reviews.queue', { projectId })).slots[0]!.question!;
      expect(q.seen).toBe('new');
      await app.call('reviews.answer', { projectId, questionId: q.id, evidenceType: 'production', outcome: 1 });
    }
    await app.idle();
    await untilDue();
    const again = (await app.call('reviews.queue', { projectId })).slots[0]!.question!;
    expect(again.seen).toBe('new-numbers');
    expect(again.item.kind).toBe('numeric');
    await app.idle();
    expect(jobs()).toBe(1);
  });

  it('does not write ahead when questions are written when due', async () => {
    const { answerInLesson, jobs } = await setup('when-due');
    await answerInLesson();
    await app.idle();
    expect(jobs()).toBe(0);
  });
});
