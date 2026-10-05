import { DEFAULT_PARAMS, type Params } from './params.ts';
import type { EvidenceEvent } from '../store/schemas.ts';

export interface KcRating {
  /** Ability on the logit scale. */
  readonly theta: number;
  /** Amount of evidence absorbed so far (drives the step size). */
  readonly n: number;
}

export const INITIAL_RATING: KcRating = { theta: -1, n: 0 };

export const sigmoid = (x: number): number => 1 / (1 + Math.exp(-x));

export function expectedSuccess(theta: number, difficulty: number): number {
  return sigmoid(theta - difficulty);
}

/** Credit actually earned: raw outcome reduced by hints and, for LLM-judged items, disagreement. */
export function effectiveOutcome(e: Pick<EvidenceEvent, 'outcome' | 'hintLevel'>, params: Params = DEFAULT_PARAMS): number {
  return e.outcome * params.hintCredit.value[e.hintLevel]!;
}

export function evidenceWeight(
  e: Pick<EvidenceEvent, 'evidenceType' | 'agreement'>,
  params: Params = DEFAULT_PARAMS,
): number {
  const w = params.evidenceWeight.value[e.evidenceType];
  return e.evidenceType === 'explain-back' ? w * (e.agreement ?? 0.5) : w;
}

/**
 * Uncertainty-weighted Elo update (Pelánek 2016): θ ← θ + K(n)·w·(outcome − P).
 * `share` splits one item's evidence across several KCs.
 */
export function updateRating(
  r: KcRating,
  difficulty: number,
  outcome: number,
  weight: number,
  share = 1,
  params: Params = DEFAULT_PARAMS,
): KcRating {
  const k = params.k0.value / (1 + params.kDecay.value * r.n);
  const p = expectedSuccess(r.theta, difficulty);
  const theta = r.theta + k * weight * share * (outcome - p);
  return { theta: Math.max(-6, Math.min(6, theta)), n: r.n + weight * share };
}

/** Plain-language band for the open learner model. */
export function band(theta: number): 'new' | 'emerging' | 'developing' | 'solid' | 'strong' {
  if (theta < -1.5) return 'new';
  if (theta < -0.5) return 'emerging';
  if (theta < 0.5) return 'developing';
  if (theta < 1.5) return 'solid';
  return 'strong';
}

/** Confidence in a rating from the amount of evidence: n/(n+3), 0 with no evidence. */
export function ratingConfidence(r: KcRating): number {
  return r.n / (r.n + 3);
}
