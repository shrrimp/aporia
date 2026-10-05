import { DEFAULT_PARAMS, type Params } from './params.ts';

export type Adjustment = -1 | 0 | 1;

/**
 * Keeps first-attempt success inside the target band (T5). Returns +1 (make harder),
 * -1 (make easier) or 0, with hysteresis after each adjustment.
 * `history`: first-attempt successes (true/false), oldest first.
 * `itemsSinceAdjustment`: items answered since the previous non-zero adjustment.
 */
export function difficultyAdjustment(
  history: readonly boolean[],
  itemsSinceAdjustment: number,
  params: Params = DEFAULT_PARAMS,
): Adjustment {
  const n = params.successWindow.value;
  if (history.length < n || itemsSinceAdjustment < params.adjustmentHysteresis.value) return 0;
  const window = history.slice(-n);
  const rate = window.filter(Boolean).length / n;
  const [low, high] = params.successBand.value;
  if (rate > high) return 1;
  if (rate < low) return -1;
  return 0;
}
