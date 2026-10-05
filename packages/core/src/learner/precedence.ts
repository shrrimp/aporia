import { GRADE_CONFIDENCE, type Param } from './params.ts';

export interface Candidate<T> {
  readonly value: T;
  readonly confidence: number;
  readonly source: 'research' | 'learner-evidence' | 'manual';
}

export interface Resolved<T> {
  readonly value: T;
  readonly winner: Candidate<T>;
  /** The losing candidates, still shown to the agent as context. */
  readonly overruled: readonly Candidate<T>[];
}

/**
 * docs/pedagogy-model.md §14: a manual override always wins; otherwise the candidate with
 * higher confidence wins, and ties go to research.
 */
export function resolve<T>(
  research: Param<T>,
  learner?: { value: T; confidence: number },
  manual?: T,
): Resolved<T> {
  const r: Candidate<T> = { value: research.value, confidence: GRADE_CONFIDENCE[research.grade], source: 'research' };
  const candidates: Candidate<T>[] = [r];
  if (learner) candidates.push({ ...learner, source: 'learner-evidence' });
  let winner: Candidate<T>;
  if (manual !== undefined) {
    winner = { value: manual, confidence: 1, source: 'manual' };
  } else {
    winner = candidates.reduce((best, c) => (c.confidence > best.confidence ? c : best), r);
  }
  return { value: winner.value, winner, overruled: candidates.filter((c) => c !== winner) };
}
