import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import {
  DAY_MS,
  DEFAULT_PARAMS,
  INITIAL_RATING,
  MemoryModel,
  band,
  deriveInsights,
  deriveLearnerState,
  difficultyAdjustment,
  difficultyFromLevel,
  effectiveOutcome,
  evidenceWeight,
  expectedSuccess,
  gradeFromOutcome,
  masteryState,
  newId,
  ratingConfidence,
  recencyWeight,
  resolve,
  trust,
  updateRating,
  type EvidenceEvent,
  type InsightObservation,
  type LogEvent,
} from '../src/index.ts';
import { agent, learner } from './helpers.ts';

const T0 = Date.parse('2026-10-01T10:00:00.000Z');
const iso = (dayOffset: number) => new Date(T0 + dayOffset * DAY_MS).toISOString();

function ev(over: Partial<EvidenceEvent> & { day?: number } = {}): EvidenceEvent {
  const { day = 0, ...rest } = over;
  return {
    type: 'evidence',
    id: newId('ev'),
    at: iso(day),
    author: agent,
    itemId: newId('it').replace('it_', 'item-'),
    kcs: [{ kc: 'kc.a', weight: 1 }],
    difficulty: 0,
    evidenceType: 'production',
    outcome: 1,
    hintLevel: 0,
    transfer: false,
    ...rest,
  };
}

describe('rating', () => {
  it('moves up on success, down on failure, with shrinking steps', () => {
    const up = updateRating(INITIAL_RATING, 0, 1, 1);
    const down = updateRating(INITIAL_RATING, 0, 0, 1);
    expect(up.theta).toBeGreaterThan(INITIAL_RATING.theta);
    expect(down.theta).toBeLessThan(INITIAL_RATING.theta);
    const experienced = { theta: -1, n: 50 };
    expect(updateRating(experienced, 0, 1, 1).theta - -1).toBeLessThan(up.theta - -1);
  });

  it('a hard success counts more than an easy one', () => {
    expect(updateRating(INITIAL_RATING, 2, 1, 1).theta).toBeGreaterThan(updateRating(INITIAL_RATING, -2, 1, 1).theta);
  });

  it('stays bounded and finite (property)', () => {
    fc.assert(
      fc.property(
        fc.array(fc.tuple(fc.double({ min: -6, max: 6, noNaN: true }), fc.double({ min: 0, max: 1, noNaN: true }), fc.double({ min: 0.01, max: 1, noNaN: true })), { maxLength: 200 }),
        (steps) => {
          let r = INITIAL_RATING;
          for (const [d, o, w] of steps) r = updateRating(r, d, o, w);
          expect(Math.abs(r.theta)).toBeLessThanOrEqual(6);
          expect(Number.isFinite(r.theta)).toBe(true);
        },
      ),
    );
  });

  it('effective outcome and weights', () => {
    expect(effectiveOutcome({ outcome: 1, hintLevel: 4 })).toBeCloseTo(0.4);
    expect(evidenceWeight({ evidenceType: 'checkpoint' })).toBe(1);
    expect(evidenceWeight({ evidenceType: 'explain-back', agreement: 1 })).toBeCloseTo(0.6);
    expect(evidenceWeight({ evidenceType: 'explain-back' })).toBeCloseTo(0.3);
    expect(expectedSuccess(0, 0)).toBe(0.5);
  });

  it.each([
    [-2, 'new'],
    [-1, 'emerging'],
    [0, 'developing'],
    [1, 'solid'],
    [2, 'strong'],
  ] as const)('band(%s) = %s', (theta, b) => {
    expect(band(theta)).toBe(b);
  });

  it('confidence grows with evidence', () => {
    expect(ratingConfidence({ theta: 0, n: 0 })).toBe(0);
    expect(ratingConfidence({ theta: 0, n: 3 })).toBe(0.5);
  });

  it('difficulty levels', () => {
    expect([1, 2, 3, 4, 5].map(difficultyFromLevel)).toEqual([-2, -1, 0, 1, 2]);
    expect(() => difficultyFromLevel(0)).toThrow(RangeError);
    expect(() => difficultyFromLevel(2.5)).toThrow(RangeError);
  });
});

describe('mastery', () => {
  const strong = { theta: 3, n: 10 };

  it('unseen → introduced → practising', () => {
    expect(masteryState(INITIAL_RATING, { instructedAt: [], evidence: [] })).toBe('unseen');
    expect(masteryState(INITIAL_RATING, { instructedAt: [iso(0)], evidence: [] })).toBe('introduced');
    expect(masteryState(INITIAL_RATING, { instructedAt: [iso(0)], evidence: [ev()] })).toBe('practising');
  });

  it('same-session success is only provisional', () => {
    const h = { instructedAt: [iso(0)], evidence: [ev({ evidenceType: 'checkpoint' }), ev({ transfer: true })] };
    expect(masteryState(strong, h)).toBe('provisional');
  });

  it('durable needs delayed retrieval, transfer and two evidence types', () => {
    const base = [ev({ evidenceType: 'checkpoint' }), ev({ transfer: true })];
    const delayed = ev({ day: 2 });
    expect(masteryState(strong, { instructedAt: [iso(0)], evidence: [...base, delayed] })).toBe('durable');
    // only one evidence type
    expect(masteryState(strong, { instructedAt: [iso(0)], evidence: [ev({ transfer: true }), ev({ day: 2 })] })).toBe('provisional');
    // no transfer
    expect(masteryState(strong, { instructedAt: [iso(0)], evidence: [ev({ evidenceType: 'checkpoint' }), ev({ day: 2 })] })).toBe('provisional');
    // latest delayed retrieval failed → demoted
    expect(masteryState(strong, { instructedAt: [iso(0)], evidence: [...base, delayed, ev({ day: 5, outcome: 0 })] })).toBe('provisional');
    // re-taught later: the old delayed success no longer counts
    expect(masteryState(strong, { instructedAt: [iso(0), iso(2)], evidence: [...base, delayed] })).toBe('provisional');
    // heavy hints are not a success
    expect(masteryState(strong, { instructedAt: [iso(0)], evidence: [...base, ev({ day: 2, hintLevel: 5 })] })).toBe('provisional');
  });

  it('never-taught KCs use the first evidence as reference; self-ratings never count', () => {
    const evidence = [ev({ evidenceType: 'probe', transfer: true }), ev({ day: 3 }), ev({ day: 3, evidenceType: 'self-rating' })];
    expect(masteryState(strong, { instructedAt: [], evidence })).toBe('durable');
  });
});

describe('memory (FSRS)', () => {
  it.each([
    [0.2, 0, undefined, 'again'],
    [0.6, 0, undefined, 'hard'],
    [1, 2, 'sure', 'hard'],
    [1, 0, 'sure', 'easy'],
    [1, 0, 'think', 'good'],
    [0.9, 0, 'sure', 'good'],
  ] as const)('grade(%s, hint %s, %s) = %s', (o, h, c, g) => {
    expect(gradeFromOutcome(o, h, c)).toBe(g);
  });

  it('retrievability decays over time and is 0 before any review', () => {
    const m = new MemoryModel();
    const start = new Date(T0);
    const card = m.newCard(start);
    expect(m.retrievability(card, start)).toBe(0);
    const reviewed = m.review(card, start, 'good');
    const soon = m.retrievability(reviewed, new Date(T0 + DAY_MS));
    const later = m.retrievability(reviewed, new Date(T0 + 30 * DAY_MS));
    expect(soon).toBeGreaterThan(later);
    expect(later).toBeGreaterThan(0);
  });
});

describe('insights', () => {
  const now = new Date(T0);
  const obs = (stance: InsightObservation['stance'], dayOffset = 0, extra: Partial<InsightObservation> = {}): InsightObservation => ({
    type: 'insight',
    id: newId('ev'),
    at: iso(dayOffset),
    author: agent,
    insightId: 'ins_01234567-89ab-7cde-8f01-23456789abcd',
    stance,
    evidence: [],
    ...(stance === 'propose' ? { text: 'prefers maths first', scope: 'global' as const } : {}),
    ...extra,
  });

  it('trust follows the documented formula', () => {
    expect(trust(0, 0)).toBe(0.5);
    expect(trust(1, 0)).toBeCloseTo(2 / 3);
    expect(trust(5, 0)).toBeCloseTo(6 / 7);
    expect(trust(3, 3)).toBe(0.5);
  });

  it('repetition strengthens, contradiction weakens, age fades', () => {
    const once = deriveInsights([obs('propose')], now)[0]!;
    const repeated = deriveInsights([obs('propose'), obs('support'), obs('support')], now)[0]!;
    const contradicted = deriveInsights([obs('propose'), obs('contradict'), obs('contradict')], now)[0]!;
    expect(repeated.trust).toBeGreaterThan(once.trust);
    expect(contradicted.trust).toBeLessThan(once.trust);
    expect(recencyWeight(iso(-90), now)).toBeCloseTo(0.5);
    expect(recencyWeight(iso(1), now)).toBe(1);
  });

  it('ignores orphans, defaults scope and sorts by trust', () => {
    const other = 'ins_01234567-89ab-7cde-8f01-23456789abce';
    const list = deriveInsights(
      [obs('support', 0, { insightId: 'ins_01234567-89ab-7cde-8f01-23456789abcf' }), obs('propose', 0, { insightId: other, scope: undefined }), obs('propose'), obs('support')],
      now,
    );
    expect(list.map((i) => i.id)).toEqual(['ins_01234567-89ab-7cde-8f01-23456789abcd', other]);
    expect(list[1]!.scope).toBe('global');
  });
});

describe('difficulty controller', () => {
  const n = DEFAULT_PARAMS.successWindow.value;
  it('waits for a full window and for hysteresis', () => {
    expect(difficultyAdjustment(Array(n - 1).fill(true), 99)).toBe(0);
    expect(difficultyAdjustment(Array(n).fill(true), 1)).toBe(0);
  });
  it('raises, lowers or holds', () => {
    expect(difficultyAdjustment(Array(n).fill(true), 99)).toBe(1);
    expect(difficultyAdjustment(Array(n).fill(false), 99)).toBe(-1);
    expect(difficultyAdjustment([...Array(3).fill(false), ...Array(n - 3).fill(true)], 99)).toBe(0);
  });
});

describe('precedence', () => {
  const research = DEFAULT_PARAMS.masteryThreshold; // grade C → 0.6
  it('research wins ties and weaker learner evidence', () => {
    expect(resolve(research).winner.source).toBe('research');
    expect(resolve(research, { value: 0.7, confidence: 0.6 }).value).toBe(0.85);
    expect(resolve(research, { value: 0.7, confidence: 0.5 }).overruled).toHaveLength(1);
  });
  it('stronger learner evidence wins; manual always wins', () => {
    expect(resolve(research, { value: 0.7, confidence: 0.86 }).value).toBe(0.7);
    const r = resolve(research, { value: 0.7, confidence: 0.99 }, 0.95);
    expect(r.value).toBe(0.95);
    expect(r.winner.source).toBe('manual');
    expect(r.overruled).toHaveLength(2);
  });
});

describe('deriveLearnerState', () => {
  it('folds evidence, instruction and insights; revocation is a refold', () => {
    const e1 = ev({ itemId: 'i1', kcs: [{ kc: 'kc.a', weight: 1 }, { kc: 'kc.b', weight: 1 }] });
    const e2 = ev({ itemId: 'i1', outcome: 0 }); // retry of the same item: not a first attempt
    const e3 = ev({ itemId: 'i2', evidenceType: 'self-rating' });
    const events: LogEvent[] = [
      { type: 'instruction', id: newId('ev'), at: iso(0), author: agent, kcs: ['kc.c'] },
      e1,
      e2,
      e3,
      { type: 'insight', id: newId('ev'), at: iso(0), author: agent, insightId: 'ins_01234567-89ab-7cde-8f01-23456789abcd', stance: 'propose', text: 't', evidence: [] },
    ];
    const s = deriveLearnerState(events, new Date(T0));
    expect([...s.kcs.keys()].sort()).toEqual(['kc.a', 'kc.b', 'kc.c']);
    expect(s.kcs.get('kc.c')!.mastery).toBe('introduced');
    expect(s.kcs.get('kc.c')!.rating).toEqual(INITIAL_RATING);
    expect(s.firstAttempts).toEqual([true]);
    expect(s.insights).toHaveLength(1);

    const revoked = deriveLearnerState([...events, { type: 'revoke', id: newId('ev'), at: iso(1), author: learner, targets: [e1.id] }], new Date(T0));
    expect(revoked.kcs.has('kc.b')).toBe(false);
    expect(revoked.kcs.get('kc.a')!.rating.theta).toBeLessThan(s.kcs.get('kc.a')!.rating.theta);
  });

  it('is deterministic (property)', () => {
    fc.assert(
      fc.property(fc.array(fc.tuple(fc.double({ min: 0, max: 1, noNaN: true }), fc.integer({ min: 0, max: 5 })), { maxLength: 30 }), (xs) => {
        const events = xs.map(([o, h], i) => ev({ itemId: `i${i}`, outcome: o, hintLevel: h }));
        const a = deriveLearnerState(events, new Date(T0));
        const b = deriveLearnerState(events, new Date(T0));
        expect([...a.kcs.values()].map((k) => k.rating)).toEqual([...b.kcs.values()].map((k) => k.rating));
      }),
    );
  });
});
