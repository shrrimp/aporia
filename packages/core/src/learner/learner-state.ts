import { DEFAULT_PARAMS, type Params } from './params.ts';
import { INITIAL_RATING, effectiveOutcome, evidenceWeight, updateRating, type KcRating } from './rating.ts';
import { masteryState, type KcHistory, type MasteryState } from './mastery.ts';
import { deriveInsights, type Insight } from './insights.ts';
import { activeObservations } from '../store/observations.ts';
import type { EvidenceEvent, InsightObservation, LogEvent } from '../store/schemas.ts';

export interface KcState {
  readonly kc: string;
  readonly rating: KcRating;
  readonly mastery: MasteryState;
  readonly history: KcHistory;
}

export interface LearnerState {
  readonly kcs: ReadonlyMap<string, KcState>;
  readonly insights: readonly Insight[];
  /** First-attempt success sequence (hint level 0, non self-rating), oldest first. */
  readonly firstAttempts: readonly boolean[];
}

/**
 * Pure fold of the journal into learner state. Same events + params ⇒ same state, whatever
 * model produced the events. Revoked observations are ignored, so undo is just a refold.
 */
export function deriveLearnerState(events: readonly LogEvent[], now: Date, params: Params = DEFAULT_PARAMS): LearnerState {
  const ratings = new Map<string, KcRating>();
  const histories = new Map<string, { instructedAt: string[]; evidence: EvidenceEvent[] }>();
  const insightObs: InsightObservation[] = [];
  const firstAttempts: boolean[] = [];
  const seenItems = new Set<string>();
  const hist = (kc: string) => {
    let h = histories.get(kc);
    if (!h) histories.set(kc, (h = { instructedAt: [], evidence: [] }));
    return h;
  };

  for (const o of activeObservations(events)) {
    if (o.type === 'instruction') {
      o.kcs.forEach((kc) => hist(kc).instructedAt.push(o.at));
    } else if (o.type === 'insight') {
      insightObs.push(o);
    } else {
      const outcome = effectiveOutcome(o, params);
      const weight = evidenceWeight(o, params);
      const total = o.kcs.reduce((s, k) => s + k.weight, 0);
      for (const { kc, weight: w } of o.kcs) {
        ratings.set(kc, updateRating(ratings.get(kc) ?? INITIAL_RATING, o.difficulty, outcome, weight, w / total, params));
        hist(kc).evidence.push(o);
      }
      if (o.evidenceType !== 'self-rating' && !seenItems.has(o.itemId)) {
        seenItems.add(o.itemId);
        firstAttempts.push(o.hintLevel === 0 && o.outcome >= 0.8);
      }
    }
  }

  const kcs = new Map<string, KcState>();
  for (const [kc, history] of histories) {
    const rating = ratings.get(kc) ?? INITIAL_RATING;
    kcs.set(kc, { kc, rating, history, mastery: masteryState(rating, history, params) });
  }
  return { kcs, insights: deriveInsights(insightObs, now, params), firstAttempts };
}
