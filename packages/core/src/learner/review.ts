import { DEFAULT_PARAMS, type Params } from './params.ts';
import { gradeFromOutcome, MemoryModel, type Card } from './memory.ts';
import { activeObservations } from '../store/observations.ts';
import type { EvidenceEvent, LogEvent } from '../store/schemas.ts';

/** Evidence that says something about remembering (not self-ratings, not tutor-judged explanations). */
const REVIEWABLE = new Set<EvidenceEvent['evidenceType']>(['production', 'recognition', 'prediction']);

function reviewable(events: readonly LogEvent[], projectId: string): EvidenceEvent[] {
  return activeObservations(events).filter(
    (e): e is EvidenceEvent => e.type === 'evidence' && REVIEWABLE.has(e.evidenceType) && (e.projectId === undefined || e.projectId === projectId),
  );
}

export interface SkillMemory {
  readonly kc: string;
  readonly card: Card;
  readonly reviews: number;
  readonly lastAt: string;
}

/**
 * The memory state of every skill answered so far (roadmap 1.10). What is scheduled is the
 * skill, not a question: every answer that tests a skill (a drill, a warm-up, a prediction, a
 * review) is one FSRS review of it, graded from its outcome, hints and confidence
 * (pedagogy-model §2.4, §7). So a review can ask any question on the skill, and should ask a new
 * one. A pure fold of the journal: undoing an answer reschedules as if it never happened.
 * Evidence of other projects is skipped.
 */
export function skillMemories(events: readonly LogEvent[], projectId: string, params: Params = DEFAULT_PARAMS): Map<string, SkillMemory> {
  const model = new MemoryModel(params);
  const out = new Map<string, SkillMemory>();
  for (const e of reviewable(events, projectId)) {
    const at = new Date(e.at);
    const grade = gradeFromOutcome(e.outcome, e.hintLevel, e.confidence);
    for (const { kc } of e.kcs) {
      const prev = out.get(kc);
      out.set(kc, { kc, card: model.review(prev?.card ?? model.newCard(at), at, grade), reviews: (prev?.reviews ?? 0) + 1, lastAt: e.at });
    }
  }
  return out;
}

export interface Answered {
  readonly count: number;
  readonly lastAt: string;
}

/** Every question or item answered in the project (by evidence id: `lesson/item`, `~reviews/<id>`), how often and when last. */
export function answeredItems(events: readonly LogEvent[], projectId: string): Map<string, Answered> {
  const out = new Map<string, Answered>();
  for (const e of reviewable(events, projectId)) out.set(e.itemId, { count: (out.get(e.itemId)?.count ?? 0) + 1, lastAt: e.at });
  return out;
}

export interface DueSkill extends SkillMemory {
  /** Probability of recall now: the lower, the more urgent. */
  readonly retrievability: number;
}

export interface ReviewQueue {
  /** Due skills, most at risk first, at most `cap`. */
  readonly due: readonly DueSkill[];
  /** All due skills, including those over the cap. */
  readonly dueCount: number;
  /** When the next skill not yet due becomes due (absent when nothing is scheduled). */
  readonly nextDue?: string;
}

/** Daily review cap (pedagogy-model §7): over it, the skills most at risk come first. */
export const REVIEW_CAP = 20;

/** Which skills are due at `now`. Skills never answered are new, not due: a lesson introduces them. */
export function reviewQueue(memories: ReadonlyMap<string, SkillMemory>, now: Date, cap = REVIEW_CAP, params: Params = DEFAULT_PARAMS): ReviewQueue {
  const model = new MemoryModel(params);
  const due: DueSkill[] = [];
  let next: number | undefined;
  for (const m of memories.values()) {
    const dueAt = m.card.due.getTime();
    if (dueAt <= now.getTime()) due.push({ ...m, retrievability: model.retrievability(m.card, now) });
    else next = Math.min(next ?? dueAt, dueAt);
  }
  due.sort((a, b) => a.retrievability - b.retrievability || a.kc.localeCompare(b.kc));
  return { due: due.slice(0, cap), dueCount: due.length, ...(next === undefined ? {} : { nextDue: new Date(next).toISOString() }) };
}
