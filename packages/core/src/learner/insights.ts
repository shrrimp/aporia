import { DAY_MS } from '../clock.ts';
import { DEFAULT_PARAMS, type Params } from './params.ts';
import type { InsightObservation } from '../store/schemas.ts';

export interface Insight {
  readonly id: string;
  readonly text: string;
  readonly scope: string;
  readonly support: readonly InsightObservation[];
  readonly contradict: readonly InsightObservation[];
  /** Computed by code only: (s + 1) / (s + c + 2) with recency-weighted counts. */
  readonly trust: number;
}

export function recencyWeight(at: string, now: Date, params: Params = DEFAULT_PARAMS): number {
  const ageDays = Math.max(0, (now.getTime() - Date.parse(at)) / DAY_MS);
  return 0.5 ** (ageDays / params.insightHalfLifeDays.value);
}

export function trust(support: number, contradict: number): number {
  return (support + 1) / (support + contradict + 2);
}

/** Fold insight observations (already filtered for revocation) into insights, highest trust first. */
export function deriveInsights(
  observations: readonly InsightObservation[],
  now: Date,
  params: Params = DEFAULT_PARAMS,
): Insight[] {
  type Entry = { text: string | undefined; scope: string | undefined; support: InsightObservation[]; contradict: InsightObservation[] };
  const byId = new Map<string, Entry>();
  for (const o of observations) {
    const entry: Entry = byId.get(o.insightId) ?? { text: undefined, scope: undefined, support: [], contradict: [] };
    if (o.stance === 'propose') {
      entry.text ??= o.text;
      entry.scope ??= o.scope;
      entry.support.push(o);
    } else if (o.stance === 'support') entry.support.push(o);
    else entry.contradict.push(o);
    byId.set(o.insightId, entry);
  }
  const out: Insight[] = [];
  for (const [id, e] of byId) {
    if (e.text === undefined) continue; // support/contradict for an insight whose proposal was revoked
    const w = (xs: InsightObservation[]) => xs.reduce((sum, x) => sum + recencyWeight(x.at, now, params), 0);
    out.push({
      id,
      text: e.text,
      scope: e.scope ?? 'global',
      support: e.support,
      contradict: e.contradict,
      trust: trust(w(e.support), w(e.contradict)),
    });
  }
  return out.sort((a, b) => b.trust - a.trust);
}
