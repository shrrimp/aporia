/**
 * Every pedagogical number lives here, with the evidence grade behind it
 * (docs/pedagogy-model.md §14). Grades map to confidence: A .9, B .75, C .6, D .4.
 */
export type Grade = 'A' | 'B' | 'C' | 'D';

export const GRADE_CONFIDENCE: Readonly<Record<Grade, number>> = { A: 0.9, B: 0.75, C: 0.6, D: 0.4 };

export interface Param<T> {
  readonly value: T;
  readonly grade: Grade;
  /** Evidence ids from docs/learning-science.md. */
  readonly sources: readonly string[];
}

const p = <T>(value: T, grade: Grade, ...sources: string[]): Param<T> => ({ value, grade, sources });

export const DEFAULT_PARAMS = {
  /** Elo step: K(n) = k0 / (1 + kDecay · n). */
  k0: p(0.4, 'C', 'T3'),
  kDecay: p(0.05, 'C', 'T3'),
  /** P(success) on a standard item at which a KC is provisionally mastered. */
  masteryThreshold: p(0.85, 'C', 'T5'),
  /** Difficulty (logits) of the "standard" item used for the mastery test. */
  standardDifficulty: p(0, 'D'),
  /** Minimum gap between instruction and a retrieval that proves durability. */
  durableDelayDays: p(1, 'B', 'R3', 'R7'),
  /** Credit kept after using hint level L0…L5. */
  hintCredit: p([1, 1, 0.8, 0.6, 0.4, 0.2] as const, 'D', 'W4'),
  evidenceWeight: p(
    {
      probe: 0.8,
      checkpoint: 1,
      production: 1,
      prediction: 0.7,
      recognition: 0.5,
      'explain-back': 0.6,
      'self-rating': 0.2,
    } as const,
    'C',
    'R1',
    'R2',
    'G3',
    'AI8',
    'M2',
  ),
  /** Retrievability below which a returning learner is re-probed. */
  reprobeRetrievability: p(0.7, 'D', 'R3'),
  /** FSRS desired retention. */
  desiredRetention: p(0.9, 'B', 'R4'),
  /** Target first-attempt success band. */
  successBand: p([0.7, 0.85] as const, 'C', 'T5'),
  successWindow: p(12, 'D'),
  /** Items to wait after a difficulty adjustment before adjusting again. */
  adjustmentHysteresis: p(4, 'D'),
  /** Half-life (days) of an observation's weight in insight trust. */
  insightHalfLifeDays: p(90, 'D'),
} as const;

export type Params = typeof DEFAULT_PARAMS;

/** 1–5 authoring difficulty → logits (3 is standard). */
export function difficultyFromLevel(level: number): number {
  if (!Number.isInteger(level) || level < 1 || level > 5) throw new RangeError(`difficulty level must be 1..5: ${level}`);
  return level - 3;
}
