import { DEFAULT_PARAMS, type Params } from './params.ts';
import { gradeFromOutcome, MemoryModel, type Card } from './memory.ts';
import { activeObservations } from '../store/observations.ts';
import type { EvidenceEvent, LogEvent } from '../store/schemas.ts';

/** Evidence that says something about remembering an item (not self-ratings, not tutor-judged explanations). */
const REVIEWABLE = new Set<EvidenceEvent['evidenceType']>(['production', 'recognition', 'prediction']);

export interface ItemMemory {
  readonly itemId: string;
  readonly card: Card;
  readonly reviews: number;
  readonly lastAt: string;
}

/**
 * The memory state of every item answered so far: each answer is one FSRS review, graded from
 * its outcome, hints and confidence (pedagogy-model §2.4, §7). A pure fold of the journal, so
 * undoing an answer reschedules as if it never happened. Evidence of other projects is skipped.
 */
export function itemMemories(events: readonly LogEvent[], projectId: string, params: Params = DEFAULT_PARAMS): Map<string, ItemMemory> {
  const model = new MemoryModel(params);
  const out = new Map<string, ItemMemory>();
  for (const e of activeObservations(events)) {
    if (e.type !== 'evidence' || !REVIEWABLE.has(e.evidenceType)) continue;
    if (e.projectId !== undefined && e.projectId !== projectId) continue;
    const at = new Date(e.at);
    const prev = out.get(e.itemId);
    const card = model.review(prev?.card ?? model.newCard(at), at, gradeFromOutcome(e.outcome, e.hintLevel, e.confidence));
    out.set(e.itemId, { itemId: e.itemId, card, reviews: (prev?.reviews ?? 0) + 1, lastAt: e.at });
  }
  return out;
}

export interface DueItem extends ItemMemory {
  /** Probability of recall now: the lower, the more urgent. */
  readonly retrievability: number;
}

export interface ReviewQueue {
  /** Due items, most at risk first, at most `cap`. */
  readonly due: readonly DueItem[];
  /** All due items, including those over the cap. */
  readonly dueCount: number;
  /** When the next item not yet due becomes due (absent when nothing is scheduled). */
  readonly nextDue?: string;
}

/** Daily review cap (pedagogy-model §7): over it, the items most at risk come first. */
export const REVIEW_CAP = 20;

/** Which of `itemIds` are due at `now`. Items never answered are new, not due: the lesson introduces them. */
export function reviewQueue(memories: ReadonlyMap<string, ItemMemory>, itemIds: Iterable<string>, now: Date, cap = REVIEW_CAP, params: Params = DEFAULT_PARAMS): ReviewQueue {
  const model = new MemoryModel(params);
  const due: DueItem[] = [];
  let next: number | undefined;
  for (const id of new Set(itemIds)) {
    const m = memories.get(id);
    if (!m) continue;
    const dueAt = m.card.due.getTime();
    if (dueAt <= now.getTime()) due.push({ ...m, retrievability: model.retrievability(m.card, now) });
    else next = Math.min(next ?? dueAt, dueAt);
  }
  due.sort((a, b) => a.retrievability - b.retrievability || a.itemId.localeCompare(b.itemId));
  return { due: due.slice(0, cap), dueCount: due.length, ...(next === undefined ? {} : { nextDue: new Date(next).toISOString() }) };
}
