import { DAY_MS } from '../clock.ts';
import { DEFAULT_PARAMS, type Params } from './params.ts';
import { effectiveOutcome, expectedSuccess, type KcRating } from './rating.ts';
import type { EvidenceEvent } from '../store/schemas.ts';

export type MasteryState = 'unseen' | 'introduced' | 'practising' | 'provisional' | 'durable';

export interface KcHistory {
  /** Times this KC was taught (instruction events). */
  readonly instructedAt: readonly string[];
  /** Evidence touching this KC, in log order. */
  readonly evidence: readonly EvidenceEvent[];
}

const SUCCESS = 0.8;

/**
 * Mastery is a pure function of rating + history (docs/pedagogy-model.md §2.3):
 * durable needs P ≥ threshold, ≥ 2 evidence types, a successful transfer item, and the most
 * recent *delayed* retrieval (≥ Δ after the last instruction) to be a success.
 */
export function masteryState(rating: KcRating, h: KcHistory, params: Params = DEFAULT_PARAMS): MasteryState {
  if (h.evidence.length === 0) return h.instructedAt.length > 0 ? 'introduced' : 'unseen';
  const p = expectedSuccess(rating.theta, params.standardDifficulty.value);
  if (p < params.masteryThreshold.value) return 'practising';

  const success = (e: EvidenceEvent) => effectiveOutcome(e, params) >= SUCCESS;
  const scored = h.evidence.filter((e) => e.evidenceType !== 'self-rating');
  const types = new Set(scored.map((e) => e.evidenceType));
  const transferOk = scored.some((e) => e.transfer && success(e));

  // Reference point: the last time it was taught, or when it was first seen if never taught.
  const lastInstruction =
    h.instructedAt.length > 0
      ? h.instructedAt.reduce((m, at) => Math.max(m, Date.parse(at)), -Infinity)
      : Date.parse(h.evidence[0]!.at);
  const delayMs = params.durableDelayDays.value * DAY_MS;
  const delayed = scored.filter((e) => Date.parse(e.at) - lastInstruction >= delayMs);
  const lastDelayed = delayed.at(-1);

  if (types.size >= 2 && transferOk && lastDelayed !== undefined && success(lastDelayed)) return 'durable';
  return 'provisional';
}
