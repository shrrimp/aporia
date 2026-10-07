import { hash, type Region } from './layout.ts';
import { OTHER, type GroupTree } from './tree.ts';

/**
 * Colours for the brain view, in OKLab: a perceptual space, so mixing two colours gives the one
 * a person sees between them (blue and red mix to purple, not to mud). Each domain gets a hue,
 * its areas shades of it, and each skill its group's colour blended with the skills it links
 * to. A skill that bridges two domains comes out in between, so the map reads as a gradient.
 * The colours say *where* a skill belongs, never how well it is known (that is the fill).
 */
export interface Lab {
  readonly L: number;
  readonly a: number;
  readonly b: number;
}

const lch = (L: number, C: number, h: number): Lab => ({ L, a: C * Math.cos((h * Math.PI) / 180), b: C * Math.sin((h * Math.PI) / 180) });
const chroma = (c: Lab) => Math.hypot(c.a, c.b);
const hueOf = (c: Lab) => ((Math.atan2(c.b, c.a) * 180) / Math.PI + 360) % 360;

/** Where the hue wheel starts: the first domain is blue. */
const FIRST_HUE = 255;
const DOMAIN = { L: 0.72, C: 0.14 };
/** Skills without a group: a quiet grey. */
const GREY: Lab = { L: 0.68, a: 0, b: 0 };

/** CSS for a colour (Chromium understands oklab()). */
export function css(c: Lab, alpha = 1): string {
  const f = (n: number) => Number(n.toFixed(4));
  return `oklab(${f(c.L)} ${f(c.a)} ${f(c.b)}${alpha < 1 ? ` / ${f(alpha)}` : ''})`;
}

/** Angle of a point around a centre, in degrees from 0 to 360. */
const angle = (p: { x: number; y: number }, c: { x: number; y: number }) => ((Math.atan2(p.y - c.y, p.x - c.x) * 180) / Math.PI + 360) % 360;

/**
 * A colour per group. Domains get hues spread evenly, in the order they sit around the map, so
 * neighbours on the map are neighbours on the wheel and the map shades smoothly from one to the
 * next. Inside a domain, each area takes a slice of the domain's hue range (again in map order),
 * a little lighter and softer the deeper it is.
 */
export function groupColors(tree: GroupTree, regions: ReadonlyMap<string, Region>): Map<string, Lab> {
  const out = new Map<string, Lab>();
  const at = (g: string) => regions.get(g) ?? { x: 0, y: 0, r: 0 };
  const tops = (tree.children.get(undefined) ?? []).filter((g) => g !== OTHER);
  const centre = tops.length ? { x: tops.reduce((t, g) => t + at(g).x, 0) / tops.length, y: tops.reduce((t, g) => t + at(g).y, 0) / tops.length } : { x: 0, y: 0 };
  const byAngle = (gs: readonly string[], c: { x: number; y: number }) => [...gs].sort((a, b) => angle(at(a), c) - angle(at(b), c) || a.localeCompare(b));
  const slice = tops.length ? 360 / tops.length : 360;
  const shade = (g: string, hue: number, range: number, depth: number) => {
    const L = Math.min(0.86, DOMAIN.L + 0.035 * depth + (depth > 0 ? ((hash(g) % 3) - 1) * 0.02 : 0));
    out.set(g, lch(L, DOMAIN.C * (1 - 0.1 * depth), hue));
    const kids = byAngle((tree.children.get(g) ?? []).filter((k) => k !== OTHER), at(g));
    const step = kids.length ? range / kids.length : 0;
    kids.forEach((k, i) => shade(k, hue - range / 2 + step * (i + 0.5), step * 0.8, depth + 1));
  };
  byAngle(tops, centre).forEach((g, i) => shade(g, FIRST_HUE + slice * i, Math.min(70, slice * 0.75), 0));
  if (tree.parent.has(OTHER)) out.set(OTHER, GREY);
  return out;
}

/**
 * A colour per skill: its group's, with a slight shift of its own (no two skills quite alike),
 * then blended with its neighbours along the links, `rounds` times. `hold` is how strongly a
 * skill keeps its own colour against its neighbours. Blends keep most of their vividness, so a
 * bridge between blue and red is a real purple rather than a grey.
 */
export function skillColors(
  ids: readonly string[],
  groupOf: (id: string) => string | undefined,
  links: readonly { source: number; target: number }[],
  colors: ReadonlyMap<string, Lab>,
  rounds = 6,
  hold = 1.5,
): Lab[] {
  const base = ids.map((id) => {
    const g = groupOf(id);
    const c = (g !== undefined && colors.get(g)) || GREY;
    const C = chroma(c);
    return C < 1e-6 ? c : lch(c.L + (((hash(id) >>> 8) % 5) - 2) * 0.008, C, hueOf(c) + ((hash(id) % 9) - 4) * 1.2);
  });
  const near = ids.map(() => [] as number[]);
  for (const l of links) {
    near[l.source]!.push(l.target);
    near[l.target]!.push(l.source);
  }
  let cur = base;
  for (let r = 0; r < rounds; r++) {
    cur = cur.map((_, i) => {
      const n = near[i]!;
      if (n.length === 0) return base[i]!;
      const w = hold + n.length;
      return {
        L: (hold * base[i]!.L + n.reduce((t, j) => t + cur[j]!.L, 0)) / w,
        a: (hold * base[i]!.a + n.reduce((t, j) => t + cur[j]!.a, 0)) / w,
        b: (hold * base[i]!.b + n.reduce((t, j) => t + cur[j]!.b, 0)) / w,
      };
    });
  }
  // Mixing opposite hues loses chroma; give most of it back.
  return cur.map((c, i) => {
    const C = chroma(c);
    const want = chroma(base[i]!) * 0.9;
    if (C < 1e-6 || want < 1e-6) return c;
    const k = (C + (want - C) * 0.6) / C;
    return { L: c.L, a: c.a * k, b: c.b * k };
  });
}
