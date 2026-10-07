import { describe, expect, it } from 'vitest';
import { DAY_MS, Journal, ManualClock, Observations, itemMemories, reviewQueue, type Author } from '../src/index.ts';
import { learner, tempDir } from './helpers.ts';

const system: Author = { kind: 'system' };

async function setup() {
  const clock = new ManualClock('2026-10-06T10:00:00.000Z');
  const journal = await Journal.open(await tempDir(), clock);
  const obs = new Observations(journal);
  const answer = (itemId: string, outcome: number, extra: Record<string, unknown> = {}) =>
    obs.recordEvidence({ author: system, itemId, projectId: 'p', kcs: [{ kc: 'quaternion.unit', weight: 1 }], difficulty: 0, evidenceType: 'recognition', outcome, ...extra });
  return { clock, journal, obs, answer };
}

describe('itemMemories', () => {
  it('schedules each answered item, sooner when it was missed', async () => {
    const { journal, answer } = await setup();
    await answer('l/right', 1, { confidence: 'sure' });
    await answer('l/wrong', 0);
    await answer('l/hinted', 1, { hintLevel: 3 });
    const m = itemMemories(journal.events, 'p');
    expect([...m.keys()]).toEqual(['l/right', 'l/wrong', 'l/hinted']);
    expect(m.get('l/wrong')!.card.due.getTime()).toBeLessThan(m.get('l/hinted')!.card.due.getTime());
    expect(m.get('l/hinted')!.card.due.getTime()).toBeLessThan(m.get('l/right')!.card.due.getTime());
    expect(m.get('l/right')).toMatchObject({ reviews: 1, lastAt: '2026-10-06T10:00:00.000Z' });
  });

  it('skips other projects, self-ratings, judged explanations and revoked answers; keeps legacy evidence', async () => {
    const { journal, obs, answer } = await setup();
    await answer('l/a', 1, { projectId: 'other' });
    await answer('l/b', 1, { evidenceType: 'self-rating' });
    await answer('l/c', 1, { evidenceType: 'explain-back', agreement: 1 });
    const revoked = await answer('l/d', 1);
    await obs.revoke([revoked.id], learner);
    await obs.recordEvidence({ author: system, itemId: 'l/legacy', kcs: [{ kc: 'k', weight: 1 }], difficulty: 0, evidenceType: 'production', outcome: 1 });
    expect([...itemMemories(journal.events, 'p').keys()]).toEqual(['l/legacy']);
  });
});

describe('reviewQueue', () => {
  it('lists due items, most at risk first, capped, with when the next one is due', async () => {
    const { clock, journal, answer } = await setup();
    await answer('l/a', 1, { confidence: 'sure' });
    await answer('l/b', 0);
    await answer('l/c', 1);
    clock.advance(30 * DAY_MS);
    await answer('l/fresh', 1, { confidence: 'sure' });
    const m = itemMemories(journal.events, 'p');
    const q = reviewQueue(m, ['l/a', 'l/b', 'l/c', 'l/fresh', 'l/new', 'l/a'], clock.now());
    expect(q.dueCount).toBe(3);
    expect(q.due.map((d) => d.itemId)).toEqual(['l/b', 'l/c', 'l/a']);
    expect(q.due[0]!.retrievability).toBeLessThanOrEqual(q.due[1]!.retrievability);
    expect(q.nextDue).toBe(m.get('l/fresh')!.card.due.toISOString());
    expect(reviewQueue(m, ['l/a', 'l/b', 'l/c'], clock.now(), 2)).toMatchObject({ dueCount: 3, due: [{ itemId: 'l/b' }, { itemId: 'l/c' }] });
    expect(reviewQueue(m, [], clock.now())).toEqual({ due: [], dueCount: 0 });
  });

  it('reschedules after a review: a good answer pushes the item out', async () => {
    const { clock, journal, answer } = await setup();
    await answer('l/a', 1);
    clock.advance(10 * DAY_MS);
    expect(reviewQueue(itemMemories(journal.events, 'p'), ['l/a'], clock.now()).dueCount).toBe(1);
    await answer('l/a', 1, { confidence: 'sure' });
    const q = reviewQueue(itemMemories(journal.events, 'p'), ['l/a'], clock.now());
    expect(q.dueCount).toBe(0);
    expect(Date.parse(q.nextDue!)).toBeGreaterThan(clock.now().getTime() + 10 * DAY_MS);
  });
});
