import { describe, expect, it } from 'vitest';
import { DAY_MS, Journal, ManualClock, Observations, answeredItems, reviewQueue, skillMemories, type Author } from '../src/index.ts';
import { learner, tempDir } from './helpers.ts';

const system: Author = { kind: 'system' };

async function setup() {
  const clock = new ManualClock('2026-10-06T10:00:00.000Z');
  const journal = await Journal.open(await tempDir(), clock);
  const obs = new Observations(journal);
  const answer = (itemId: string, outcome: number, extra: Record<string, unknown> = {}) =>
    obs.recordEvidence({ author: system, itemId, projectId: 'p', kcs: [{ kc: 'quaternion.unit', weight: 1 }], difficulty: 0, evidenceType: 'recognition', outcome, ...extra });
  const on = (...kcs: string[]) => ({ kcs: kcs.map((kc) => ({ kc, weight: 1 })) });
  return { clock, journal, obs, answer, on };
}

describe('skillMemories', () => {
  it('schedules each skill answered, sooner when it was missed', async () => {
    const { journal, answer, on } = await setup();
    await answer('l/right', 1, { confidence: 'sure', ...on('right') });
    await answer('l/wrong', 0, on('wrong'));
    await answer('l/hinted', 1, { hintLevel: 3, ...on('hinted') });
    const m = skillMemories(journal.events, 'p');
    expect([...m.keys()]).toEqual(['right', 'wrong', 'hinted']);
    expect(m.get('wrong')!.card.due.getTime()).toBeLessThan(m.get('hinted')!.card.due.getTime());
    expect(m.get('hinted')!.card.due.getTime()).toBeLessThan(m.get('right')!.card.due.getTime());
    expect(m.get('right')).toMatchObject({ kc: 'right', reviews: 1, lastAt: '2026-10-06T10:00:00.000Z' });
  });

  it('counts every question on a skill as a review of it, and an answer on two skills as a review of both', async () => {
    const { journal, answer, on } = await setup();
    await answer('l/a', 1, on('k'));
    await answer('~reviews/r1', 1, on('k', 'j'));
    const m = skillMemories(journal.events, 'p');
    expect(m.get('k')!.reviews).toBe(2);
    expect(m.get('j')!.reviews).toBe(1);
  });

  it('skips other projects, self-ratings, judged explanations and revoked answers; keeps legacy evidence', async () => {
    const { journal, obs, answer, on } = await setup();
    await answer('l/a', 1, { projectId: 'other', ...on('a') });
    await answer('l/b', 1, { evidenceType: 'self-rating', ...on('b') });
    await answer('l/c', 1, { evidenceType: 'explain-back', agreement: 1, ...on('c') });
    const revoked = await answer('l/d', 1, on('d'));
    await obs.revoke([revoked.id], learner);
    await obs.recordEvidence({ author: system, itemId: 'l/legacy', kcs: [{ kc: 'k', weight: 1 }], difficulty: 0, evidenceType: 'production', outcome: 1 });
    expect([...skillMemories(journal.events, 'p').keys()]).toEqual(['k']);
    expect([...answeredItems(journal.events, 'p').keys()]).toEqual(['l/legacy']);
  });
});

describe('answeredItems', () => {
  it('says which questions were answered, how often and when last', async () => {
    const { clock, journal, answer } = await setup();
    await answer('l/a', 0);
    clock.advance(DAY_MS);
    await answer('l/a', 1);
    await answer('~reviews/r1', 1);
    expect(Object.fromEntries(answeredItems(journal.events, 'p'))).toEqual({
      'l/a': { count: 2, lastAt: '2026-10-07T10:00:00.000Z' },
      '~reviews/r1': { count: 1, lastAt: '2026-10-07T10:00:00.000Z' },
    });
  });
});

describe('reviewQueue', () => {
  it('lists due skills, most at risk first, capped, with when the next one is due', async () => {
    const { clock, journal, answer, on } = await setup();
    await answer('l/a', 1, { confidence: 'sure', ...on('a') });
    await answer('l/b', 0, on('b'));
    await answer('l/c', 1, on('c'));
    clock.advance(30 * DAY_MS);
    await answer('l/fresh', 1, { confidence: 'sure', ...on('fresh') });
    const m = skillMemories(journal.events, 'p');
    const q = reviewQueue(m, clock.now());
    expect(q.dueCount).toBe(3);
    expect(q.due.map((d) => d.kc)).toEqual(['b', 'c', 'a']);
    expect(q.due[0]!.retrievability).toBeLessThanOrEqual(q.due[1]!.retrievability);
    expect(q.nextDue).toBe(m.get('fresh')!.card.due.toISOString());
    expect(reviewQueue(m, clock.now(), 2)).toMatchObject({ dueCount: 3, due: [{ kc: 'b' }, { kc: 'c' }] });
    expect(reviewQueue(new Map(), clock.now())).toEqual({ due: [], dueCount: 0 });
  });

  it('reschedules after a review: a good answer, on any question, pushes the skill out', async () => {
    const { clock, journal, answer } = await setup();
    await answer('l/a', 1);
    clock.advance(10 * DAY_MS);
    expect(reviewQueue(skillMemories(journal.events, 'p'), clock.now()).dueCount).toBe(1);
    await answer('~reviews/new-question', 1, { confidence: 'sure' });
    const q = reviewQueue(skillMemories(journal.events, 'p'), clock.now());
    expect(q.dueCount).toBe(0);
    expect(Date.parse(q.nextDue!)).toBeGreaterThan(clock.now().getTime() + 10 * DAY_MS);
  });
});
