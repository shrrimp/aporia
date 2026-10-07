import type { SimLink, SimNode } from './layout.ts';
import type { GroupTree } from './tree.ts';

/**
 * Level of detail for the brain view. Zoomed out, a group whose skills would crowd into a few
 * pixels is drawn as one node (Vulkan, then Graphics programming); zooming in opens it again.
 * The layout never changes, only what is drawn: a folded group sits where its skills are.
 */

/** A group folds when its skills spread over less than this, on screen… */
export const FOLD_PX = 55;
/** …and they are crowded: less than this much room each (so a few skills far enough apart stay). */
export const CROWDED_PX = 25;

export interface Folded {
  readonly id: string;
  readonly x: number;
  readonly y: number;
  /** How far its skills spread around its centre, in map units (a typical distance, so one stray skill does not inflate it). */
  readonly spread: number;
  /** The farthest of its skills from the centre: where its name goes. */
  readonly extent: number;
  /** Indexes of its skills in the simulation. */
  readonly members: readonly number[];
}

export interface Visible {
  /** Skills drawn one by one (indexes in the simulation). */
  readonly skills: readonly number[];
  readonly folded: readonly Folded[];
  /** Groups drawn open, outermost first. */
  readonly open: readonly string[];
  /** What stands for each skill on screen: "s:<index>" for itself, "g:<group>" for a folded group. */
  readonly rep: readonly string[];
}

/** Each group's skills (nested ones included), centre and spread, from the current positions. */
export function groupStats(nodes: readonly SimNode[], tree: GroupTree): Map<string, Folded> {
  const members = new Map<string, number[]>();
  nodes.forEach((n, i) => {
    for (let g: string | undefined = tree.groupOf.get(n.id), guard = 0; g !== undefined && guard < 64; g = tree.parent.get(g), guard++) {
      const m = members.get(g);
      if (m) m.push(i);
      else members.set(g, [i]);
    }
  });
  const out = new Map<string, Folded>();
  for (const [id, m] of members) {
    const x = m.reduce((t, i) => t + nodes[i]!.x, 0) / m.length;
    const y = m.reduce((t, i) => t + nodes[i]!.y, 0) / m.length;
    const rms = Math.sqrt(m.reduce((t, i) => t + (nodes[i]!.x - x) ** 2 + (nodes[i]!.y - y) ** 2, 0) / m.length);
    const spread = rms * 1.4;
    const extent = Math.max(...m.map((i) => Math.hypot(nodes[i]!.x - x, nodes[i]!.y - y)));
    out.set(id, { id, x, y, spread, extent, members: m });
  }
  return out;
}

/**
 * What to draw at `scale` (screen pixels per map unit): from the top of the tree down, a group
 * of two or more skills folds when its spread on screen is under FOLD_PX and its skills are
 * crowded; otherwise it opens and its own skills and subgroups are considered. Small areas fold
 * before the domain around them, so zooming out goes skill → area → domain. With `fold` off,
 * every skill is drawn.
 */
export function visible(nodes: readonly SimNode[], tree: GroupTree, scale: number, fold = true, stats = groupStats(nodes, tree)): Visible {
  const rep = nodes.map((_, i) => `s:${i}`);
  const skills: number[] = [];
  const folded: Folded[] = [];
  const open: string[] = [];
  const direct = new Map<string, number[]>();
  nodes.forEach((n, i) => {
    const g = tree.groupOf.get(n.id);
    if (g === undefined) skills.push(i);
    else if (direct.has(g)) direct.get(g)!.push(i);
    else direct.set(g, [i]);
  });
  const visit = (g: string) => {
    const s = stats.get(g);
    if (!s) return;
    const onScreen = s.spread * scale;
    if (fold && s.members.length >= 2 && onScreen < FOLD_PX && onScreen / Math.sqrt(s.members.length) < CROWDED_PX) {
      folded.push(s);
      for (const i of s.members) rep[i] = `g:${g}`;
      return;
    }
    open.push(g);
    skills.push(...(direct.get(g) ?? []));
    for (const k of tree.children.get(g) ?? []) visit(k);
  };
  for (const g of tree.children.get(undefined) ?? []) visit(g);
  return { skills, folded, open, rep };
}

export interface VisibleLink {
  readonly key: string;
  readonly a: string;
  readonly b: string;
  /** The link's own kind between two skills; undefined for links merged into a folded group. */
  readonly kind?: SimLink['kind'];
  /** How many links it stands for. */
  readonly count: number;
}

/**
 * Links between what is drawn: a link inside a folded group disappears into it; links into a
 * folded group merge into one, with their count.
 */
export function visibleLinks(links: readonly SimLink[], rep: readonly string[]): VisibleLink[] {
  const out = new Map<string, VisibleLink>();
  for (const l of links) {
    const a = rep[l.source]!;
    const b = rep[l.target]!;
    if (a === b) continue;
    if (a.startsWith('s:') && b.startsWith('s:')) {
      const key = `${l.kind}:${a}>${b}`;
      out.set(key, { key, a, b, kind: l.kind, count: 1 });
      continue;
    }
    const [x, y] = [a, b].sort() as [string, string];
    const key = `merged:${x}|${y}`;
    out.set(key, { key, a: x, b: y, count: (out.get(key)?.count ?? 0) + 1 });
  }
  return [...out.values()];
}
