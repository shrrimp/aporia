import { describe, expect, it } from 'vitest';
import { Journal, ManualClock, Progress, lessonProgress, projectProgress } from '../src/index.ts';
import { learner, tempDir } from './helpers.ts';

async function setup(dir?: string) {
  const d = dir ?? (await tempDir());
  const journal = await Journal.open(d, new ManualClock('2026-10-06T10:00:00.000Z'));
  return { dir: d, journal, progress: new Progress(journal) };
}

describe('Progress', () => {
  it('keeps the latest value per key, per lesson, and survives reopening the journal', async () => {
    const { dir, journal, progress } = await setup();
    await progress.set(learner, 'p', 'l1', 'item:a', { result: 0 });
    await progress.set(learner, 'p', 'l1', 'item:a', { result: 1 });
    await progress.set(learner, 'p', 'l1', 'task:t', { done: true });
    await progress.set(learner, 'p', 'l1', 'task:t', null);
    await progress.set(learner, 'p', 'l2', 'position', 'warmup');
    await progress.set(learner, 'other', 'l1', 'item:a', { result: 0 });
    expect(lessonProgress(journal.events, 'p', 'l1')).toEqual({ 'item:a': { result: 1 }, 'task:t': null });
    expect(projectProgress(journal.events, 'p')).toEqual({ l1: { 'item:a': { result: 1 }, 'task:t': null }, l2: { position: 'warmup' } });
    const again = await setup(dir);
    expect(lessonProgress(again.journal.events, 'p', 'l1')).toEqual({ 'item:a': { result: 1 }, 'task:t': null });
  });

  it('does not write a value identical to the current one', async () => {
    const { journal, progress } = await setup();
    expect(await progress.set(learner, 'p', 'l', 'position', 'a')).toMatchObject({ type: 'progress', key: 'position' });
    expect(await progress.set(learner, 'p', 'l', 'position', 'a')).toBeUndefined();
    expect(journal.events.filter((e) => e.type === 'progress')).toHaveLength(1);
  });

  it('rejects oversized values and bad ids', async () => {
    const { journal, progress } = await setup();
    await expect(progress.set(learner, 'p', 'l', 'k', 'x'.repeat(30_000))).rejects.toThrow(/too large/);
    await expect(progress.set(learner, 'P!', 'l', 'k', 1)).rejects.toThrow();
  });
});
