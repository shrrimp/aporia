import { createEmptyCard, fsrs, generatorParameters, Rating, type Card, type FSRS } from 'ts-fsrs';
import { DEFAULT_PARAMS, type Params } from './params.ts';

export type ReviewGrade = 'again' | 'hard' | 'good' | 'easy';

/** Map an item outcome to an FSRS grade. Hints or doubt never earn "easy". */
export function gradeFromOutcome(
  outcome: number,
  hintLevel: number,
  confidence?: 'sure' | 'think' | 'guess',
): ReviewGrade {
  if (outcome < 0.5) return 'again';
  if (outcome < 0.8 || hintLevel >= 2) return 'hard';
  if (outcome === 1 && hintLevel === 0 && confidence === 'sure') return 'easy';
  return 'good';
}

const RATING: Record<ReviewGrade, Rating.Again | Rating.Hard | Rating.Good | Rating.Easy> = {
  again: Rating.Again,
  hard: Rating.Hard,
  good: Rating.Good,
  easy: Rating.Easy,
};

/** Thin, deterministic wrapper over FSRS (no fuzz, so schedules are reproducible). */
export class MemoryModel {
  readonly #f: FSRS;

  constructor(params: Params = DEFAULT_PARAMS) {
    this.#f = fsrs(generatorParameters({ enable_fuzz: false, request_retention: params.desiredRetention.value }));
  }

  newCard(at: Date): Card {
    return createEmptyCard(at);
  }

  review(card: Card, at: Date, grade: ReviewGrade): Card {
    return this.#f.next(card, at, RATING[grade]).card;
  }

  /** Probability of recall at `at`; 0 for a card never reviewed. */
  retrievability(card: Card, at: Date): number {
    if (card.reps === 0) return 0;
    return this.#f.get_retrievability(card, at, false);
  }
}

export type { Card };
