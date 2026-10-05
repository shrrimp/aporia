import type { DrillItem } from '@app/catalog';

export type Response =
  | { kind: 'mcq'; choice: number }
  | { kind: 'numeric'; value: number }
  | { kind: 'order'; lines: readonly string[] };

/** Deterministic scoring, 0–1. Short answers are not scored here: the tutor judges them. */
export function score(item: DrillItem, r: Response): number {
  if (item.kind === 'mcq' && r.kind === 'mcq') return r.choice === item.answer ? 1 : 0;
  if (item.kind === 'numeric' && r.kind === 'numeric') return Math.abs(r.value - item.answer) <= item.tolerance ? 1 : 0;
  if (item.kind === 'order' && r.kind === 'order') {
    if (r.lines.length !== item.lines.length) return 0;
    if (r.lines.every((l, i) => l === item.lines[i])) return 1;
    // Partial credit: share of adjacent pairs in the right relative order.
    const pos = new Map(item.lines.map((l, i) => [l, i]));
    let good = 0;
    for (let i = 1; i < r.lines.length; i++) if (pos.get(r.lines[i - 1]!)! < pos.get(r.lines[i]!)!) good++;
    return good / (r.lines.length - 1);
  }
  throw new Error(`response kind ${r.kind} does not match item kind ${item.kind}`);
}

/** Deterministic shuffle (seeded by the item id) so the order is stable across renders. */
export function shuffled<T>(xs: readonly T[], seed: string): T[] {
  let h = 2166136261;
  for (const ch of seed) h = Math.imul(h ^ ch.charCodeAt(0), 16777619);
  const out = [...xs];
  for (let i = out.length - 1; i > 0; i--) {
    h = Math.imul(h ^ (h >>> 15), 2246822507) >>> 0;
    const j = h % (i + 1);
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  if (out.length > 1 && out.every((x, i) => x === xs[i])) out.push(out.shift()!);
  return out;
}
