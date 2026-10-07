import { DEFAULT_PARAMS, type Params } from '../learner/params.ts';
import { effectiveOutcome } from '../learner/rating.ts';
import type { KcState } from '../learner/learner-state.ts';
import type { MasteryState } from '../learner/mastery.ts';

/** Where a skill stands on a project's path (ux §1.4): computed, never stored. */
export type PathState = 'mastered' | 'in-progress' | 'available' | 'locked';

const MASTERED: ReadonlySet<MasteryState> = new Set(['provisional', 'durable']);

export const isMastered = (m: MasteryState | undefined) => m !== undefined && MASTERED.has(m);

/**
 * A skill is mastered, in progress (taught or practised), available (every prerequisite
 * mastered, at least provisionally: D14 lets provisional mastery unlock with more scaffolding),
 * or locked, with the prerequisites it still needs.
 */
export function pathState(mastery: MasteryState | undefined, prereqs: readonly string[], masteryOf: (kc: string) => MasteryState | undefined): { state: PathState; needs: string[] } {
  if (isMastered(mastery)) return { state: 'mastered', needs: [] };
  if (mastery === 'introduced' || mastery === 'practising') return { state: 'in-progress', needs: [] };
  const needs = prereqs.filter((p) => !isMastered(masteryOf(p)));
  return needs.length === 0 ? { state: 'available', needs } : { state: 'locked', needs };
}

/** How many of the latest scored answers decide whether a skill is a struggle. */
const RECENT = 4;

/**
 * Signs that a skill needs attention, in plain words, from evidence only: recent answers mostly
 * missed, or a skill that was mastered now failing. Self-ratings are not evidence of a struggle.
 */
export function struggleReasons(kc: KcState | undefined, params: Params = DEFAULT_PARAMS): string[] {
  if (!kc) return [];
  const scored = kc.history.evidence.filter((e) => e.evidenceType !== 'self-rating');
  if (scored.length < 2) return [];
  const reasons: string[] = [];
  const recent = scored.slice(-RECENT);
  const mean = recent.reduce((s, e) => s + effectiveOutcome(e, params), 0) / recent.length;
  if (mean < 0.5) reasons.push(`${recent.filter((e) => effectiveOutcome(e, params) < 0.5).length} of the last ${recent.length} answers missed`);
  const last = scored.at(-1)!;
  const earlierSuccess = scored.slice(0, -1).some((e) => effectiveOutcome(e, params) >= 0.8);
  if (effectiveOutcome(last, params) < 0.5 && earlierSuccess && mean >= 0.5) reasons.push('the latest answer was missed after earlier successes');
  return reasons;
}
