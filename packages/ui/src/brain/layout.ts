/**
 * A small force layout for the brain view: groups get regions (nested ones inside their parent,
 * related ones side by side), skills repel each other, links pull like springs, and each skill
 * gathers in its group's region.
 * Deterministic (positions seeded from ids, no Math.random), so the same map always settles the
 * same way. Pure functions over plain arrays: the view owns the animation loop.
 */
export interface SimNode {
  readonly id: string;
  readonly group: string | undefined;
  /** Bigger nodes push a little harder. */
  readonly weight: number;
  x: number;
  y: number;
  vx: number;
  vy: number;
  /** Held by the learner's pointer: forces do not move it. */
  pinned?: boolean;
}

export interface SimLink {
  readonly source: number;
  readonly target: number;
  /** Rest length and stiffness depend on the kind of link. */
  readonly kind: 'prereq' | 'confusable' | 'related';
  /** Between two groups: pulls gently, so a bridge sits at the border instead of inside the other area. */
  readonly across?: boolean;
}

/** A group's place on the map: its centre and the room it takes (nested groups inside it). */
export interface Region {
  readonly x: number;
  readonly y: number;
  readonly r: number;
}

export interface Sim {
  readonly nodes: SimNode[];
  readonly links: readonly SimLink[];
  /** Where each group's skills gather (the centre of its region). */
  readonly groups: ReadonlyMap<string, { x: number; y: number }>;
  readonly regions: ReadonlyMap<string, Region>;
  /** Temperature: 1 when (re)started, cools towards 0; forces scale with it. */
  alpha: number;
}

const REST: Record<SimLink['kind'], number> = { prereq: 70, confusable: 90, related: 110 };
const STIFF: Record<SimLink['kind'], number> = { prereq: 0.08, confusable: 0.04, related: 0.03 };
const REPULSION = 2600;
const REPULSION_RANGE = 420;
const GROUP_PULL = 0.025;
const CONTAIN = 0.12;
const CENTRE_PULL = 0.004;
const DAMPING = 0.82;
const COOLING = 0.985;
export const SETTLED = 0.02;

/** FNV-1a: a stable number per id, for initial positions. */
export function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

/** The nesting of groups, as the layout needs it (see tree.ts). */
export interface Nesting {
  readonly children: ReadonlyMap<string | undefined, readonly string[]>;
  readonly groupOf: ReadonlyMap<string, string>;
  readonly parent: ReadonlyMap<string, string | undefined>;
}

/** Room for `n` skills placed directly in a group. */
const coreRadius = (n: number) => (n === 0 ? 0 : 28 + 24 * Math.sqrt(n));

/**
 * Place circles of the given radii around (0, 0): linked ones close (`gaps.linked` apart), the
 * others well apart (`gaps.apart`), all drawn to the centre. A pinned item stays at the centre.
 * Deterministic: starts on a circle in the given order.
 */
export function pack(
  items: readonly { id: string; r: number; pinned?: boolean }[],
  affinity: (a: string, b: string) => number,
  gaps: { linked: number; apart: number },
): Map<string, { x: number; y: number }> {
  const ring = Math.max(0, ...items.map((i) => i.r)) + items.reduce((t, i) => t + i.r, 0) / Math.PI;
  const free = items.filter((i) => !i.pinned);
  const p = items.map((it) => {
    const k = free.indexOf(it);
    const a = (2 * Math.PI * k) / Math.max(1, free.length);
    return it.pinned ? { x: 0, y: 0 } : { x: ring * Math.cos(a), y: ring * Math.sin(a) };
  });
  for (let t = 0; t < 400; t++) {
    const heat = 1 - t / 400;
    for (let i = 0; i < items.length; i++) {
      for (let j = i + 1; j < items.length; j++) {
        const a = items[i]!;
        const b = items[j]!;
        let dx = p[j]!.x - p[i]!.x;
        let dy = p[j]!.y - p[i]!.y;
        let d = Math.hypot(dx, dy);
        if (d < 1e-6) {
          const angle = ((hash(a.id + b.id) % 360) * Math.PI) / 180;
          dx = Math.cos(angle);
          dy = Math.sin(angle);
          d = 1;
        }
        const linked = affinity(a.id, b.id) > 0;
        const want = a.r + b.r + (linked ? gaps.linked : gaps.apart);
        let move = 0;
        if (d < want) move = -(want - d) * 0.5;
        else if (linked) move = (d - want) * 0.08 * heat * Math.min(1, Math.log2(1 + affinity(a.id, b.id)) / 2);
        const share = a.pinned && b.pinned ? [0, 0] : a.pinned ? [0, 1] : b.pinned ? [1, 0] : [0.5, 0.5];
        p[i]!.x += (dx / d) * move * 2 * share[0]!;
        p[i]!.y += (dy / d) * move * 2 * share[0]!;
        p[j]!.x -= (dx / d) * move * 2 * share[1]!;
        p[j]!.y -= (dy / d) * move * 2 * share[1]!;
      }
    }
    for (let i = 0; i < items.length; i++) {
      if (items[i]!.pinned) continue;
      p[i]!.x *= 1 - 0.03 * heat;
      p[i]!.y *= 1 - 0.03 * heat;
    }
  }
  return new Map(items.map((it, i) => [it.id, p[i]!]));
}

/**
 * Regions for every group, bottom-up: a group's skills sit in its core, its subgroups are packed
 * around them, and its radius covers both. Sibling groups that share links are placed side by
 * side; unrelated ones keep their distance, so a domain with nothing in common with the rest
 * (communication, next to programming) stands apart.
 */
export function regions(tree: Nesting, links: readonly { from: string; to: string }[]): Map<string, Region> {
  const path = (g: string | undefined) => {
    const out: string[] = [];
    for (let q = g; q !== undefined && out.length < 64; q = tree.parent.get(q)) out.unshift(q);
    return out;
  };
  // Links between skills count between the two sibling groups where their paths part.
  const affinity = new Map<string, number>();
  for (const l of links) {
    const a = path(tree.groupOf.get(l.from));
    const b = path(tree.groupOf.get(l.to));
    let i = 0;
    while (i < a.length && i < b.length && a[i] === b[i]) i++;
    if (i < a.length && i < b.length) {
      const key = [a[i], b[i]].sort().join('|');
      affinity.set(key, (affinity.get(key) ?? 0) + 1);
    }
  }
  const aff = (a: string, b: string) => affinity.get([a, b].sort().join('|')) ?? 0;
  const direct = new Map<string, number>();
  for (const g of tree.groupOf.values()) direct.set(g, (direct.get(g) ?? 0) + 1);

  const local = new Map<string, { x: number; y: number }>();
  const radius = new Map<string, number>();
  const place = (g: string): number => {
    const kids = tree.children.get(g) ?? [];
    const core = coreRadius(direct.get(g) ?? 0);
    if (kids.length === 0) {
      radius.set(g, Math.max(core, 30));
      return radius.get(g)!;
    }
    const items = kids.map((k) => ({ id: k, r: place(k) }));
    const at = pack(core > 0 ? [{ id: '\0core', r: core, pinned: true }, ...items] : items, aff, { linked: 14, apart: 40 });
    for (const k of kids) local.set(k, at.get(k)!);
    const r = Math.max(core, ...items.map((it) => Math.hypot(at.get(it.id)!.x, at.get(it.id)!.y) + it.r)) + 16;
    radius.set(g, r);
    return r;
  };
  const tops = tree.children.get(undefined) ?? [];
  const at = pack(tops.map((g) => ({ id: g, r: place(g) })), aff, { linked: 40, apart: 180 });
  const out = new Map<string, Region>();
  const absolute = (g: string, x: number, y: number) => {
    out.set(g, { x, y, r: radius.get(g)! });
    for (const k of tree.children.get(g) ?? []) absolute(k, x + local.get(k)!.x, y + local.get(k)!.y);
  };
  for (const g of tops) absolute(g, at.get(g)!.x, at.get(g)!.y);
  return out;
}

/** A tree with every group at the top (when the caller has no nesting). */
function flat(nodes: readonly { id: string; group?: string | undefined }[]): Nesting {
  const groups = [...new Set(nodes.flatMap((n) => (n.group === undefined ? [] : [n.group])))].sort();
  return {
    children: new Map([[undefined, groups]]),
    groupOf: new Map(nodes.flatMap((n) => (n.group === undefined ? [] : [[n.id, n.group] as const]))),
    parent: new Map(groups.map((g) => [g, undefined])),
  };
}

/** Build a simulation: each group in its region, each skill near its group's centre, placed by its id. */
export function createSim(
  nodes: readonly { id: string; group?: string | undefined; weight?: number }[],
  links: readonly { from: string; to: string; kind: SimLink['kind'] }[],
  tree: Nesting = flat(nodes),
): Sim {
  const regionMap = regions(tree, links);
  const groups = new Map([...regionMap].map(([g, r]) => [g, { x: r.x, y: r.y }]));
  const simNodes: SimNode[] = nodes.map((n) => {
    const h = hash(n.id);
    const a = ((h % 3600) / 3600) * 2 * Math.PI;
    const c = (n.group && regionMap.get(n.group)) || { x: 0, y: 0, r: 120 };
    const r = Math.min(c.r * 0.6, 30 + ((h >>> 12) % 90));
    return { id: n.id, group: n.group, weight: n.weight ?? 1, x: c.x + r * Math.cos(a), y: c.y + r * Math.sin(a), vx: 0, vy: 0 };
  });
  const index = new Map(simNodes.map((n, i) => [n.id, i]));
  const simLinks: SimLink[] = [];
  for (const l of links) {
    const source = index.get(l.from);
    const target = index.get(l.to);
    if (source !== undefined && target !== undefined && source !== target) {
      const across = simNodes[source]!.group !== simNodes[target]!.group;
      simLinks.push({ source, target, kind: l.kind, ...(across ? { across } : {}) });
    }
  }
  return { nodes: simNodes, links: simLinks, groups, regions: regionMap, alpha: 1 };
}

/** One tick. Returns the total movement (how far the layout still is from rest). */
export function step(sim: Sim): number {
  const { nodes, links } = sim;
  const k = sim.alpha;
  // Repulsion, within a range (so far-apart clusters do not push each other forever).
  for (let i = 0; i < nodes.length; i++) {
    const a = nodes[i]!;
    for (let j = i + 1; j < nodes.length; j++) {
      const b = nodes[j]!;
      let dx = b.x - a.x;
      let dy = b.y - a.y;
      let d2 = dx * dx + dy * dy;
      if (d2 > REPULSION_RANGE * REPULSION_RANGE) continue;
      if (d2 < 1) {
        // Exactly on top of each other: separate along a direction fixed by their ids.
        const angle = ((hash(a.id + b.id) % 360) * Math.PI) / 180;
        dx = Math.cos(angle);
        dy = Math.sin(angle);
        d2 = 1;
      }
      const f = (REPULSION * Math.sqrt(a.weight * b.weight) * k) / d2;
      const d = Math.sqrt(d2);
      const fx = (dx / d) * f;
      const fy = (dy / d) * f;
      a.vx -= fx;
      a.vy -= fy;
      b.vx += fx;
      b.vy += fy;
    }
  }
  // Springs.
  for (const l of links) {
    const a = nodes[l.source]!;
    const b = nodes[l.target]!;
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const d = Math.max(1, Math.sqrt(dx * dx + dy * dy));
    const f = l.across ? (d - REST[l.kind] * 1.6) * STIFF[l.kind] * 0.25 * k : (d - REST[l.kind]) * STIFF[l.kind] * k;
    a.vx += (dx / d) * f;
    a.vy += (dy / d) * f;
    b.vx -= (dx / d) * f;
    b.vy -= (dy / d) * f;
  }
  // Groups and centre.
  let moved = 0;
  for (const n of nodes) {
    const g = n.group === undefined ? undefined : sim.groups.get(n.group);
    // Skills gather in their group's region; the regions keep the map's shape, so only skills
    // without a group drift to the centre.
    if (g) {
      n.vx += (g.x - n.x) * GROUP_PULL * k;
      n.vy += (g.y - n.y) * GROUP_PULL * k;
      // Outside its region: pulled back firmly, so areas stay readable as areas.
      const r = sim.regions.get(n.group!)!.r;
      const d = Math.hypot(n.x - g.x, n.y - g.y);
      if (d > r) {
        n.vx -= ((n.x - g.x) / d) * (d - r) * CONTAIN * k;
        n.vy -= ((n.y - g.y) / d) * (d - r) * CONTAIN * k;
      }
    } else {
      n.vx -= n.x * CENTRE_PULL * k;
      n.vy -= n.y * CENTRE_PULL * k;
    }
    n.vx *= DAMPING;
    n.vy *= DAMPING;
    if (n.pinned) {
      n.vx = 0;
      n.vy = 0;
      continue;
    }
    n.x += n.vx;
    n.y += n.vy;
    moved += Math.abs(n.vx) + Math.abs(n.vy);
  }
  sim.alpha *= COOLING;
  return moved;
}

/** Run until the layout rests (or `maxTicks`): for reduced motion, and for the first frame. */
export function settle(sim: Sim, maxTicks = 600): void {
  for (let i = 0; i < maxTicks && sim.alpha > SETTLED; i++) step(sim);
}

/** Wake the layout up (after a drag), without starting from scratch. */
export function reheat(sim: Sim, alpha = 0.3): void {
  sim.alpha = Math.max(sim.alpha, alpha);
}

/** Where each group's label goes: the centre of its nodes. */
export function groupCentres(sim: Sim): Map<string, { x: number; y: number; count: number }> {
  const out = new Map<string, { x: number; y: number; count: number }>();
  for (const n of sim.nodes) {
    if (n.group === undefined) continue;
    const c = out.get(n.group) ?? { x: 0, y: 0, count: 0 };
    out.set(n.group, { x: c.x + n.x, y: c.y + n.y, count: c.count + 1 });
  }
  for (const [g, c] of out) out.set(g, { x: c.x / c.count, y: c.y / c.count, count: c.count });
  return out;
}

/** The box around every node, with a margin: what the view fits on screen. */
export function bounds(sim: Sim, margin = 60): { x: number; y: number; width: number; height: number } {
  if (sim.nodes.length === 0) return { x: -200, y: -150, width: 400, height: 300 };
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const n of sim.nodes) {
    minX = Math.min(minX, n.x);
    minY = Math.min(minY, n.y);
    maxX = Math.max(maxX, n.x);
    maxY = Math.max(maxY, n.y);
  }
  return { x: minX - margin, y: minY - margin, width: maxX - minX + 2 * margin, height: maxY - minY + 2 * margin };
}

/** The view to open on: the whole map, never zoomed in past natural size on a small map. */
export function fit(box: { x: number; y: number; width: number; height: number }, min = { width: 960, height: 600 }) {
  const width = Math.max(box.width, min.width);
  const height = Math.max(box.height, min.height);
  return { x: box.x - (width - box.width) / 2, y: box.y - (height - box.height) / 2, width, height };
}
