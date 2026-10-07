import { describe, expect, it } from 'vitest';
import type { BrainDTO } from '@app/server/protocol';
import { OTHER, depthOf, groupTree, pathOf } from '../src/brain/tree.ts';
import { css, groupColors, skillColors, type Lab } from '../src/brain/color.ts';
import { createSim, pack, regions, settle } from '../src/brain/layout.ts';
import { CROWDED_PX, FOLD_PX, groupStats, visible, visibleLinks } from '../src/brain/lod.ts';

const node = (id: string, group?: string) => ({ id, title: id, ...(group ? { group } : {}), suggested: false, discovered: true, mastery: 'practising' as const, confidence: 0.5, evidence: 1, struggling: [], projects: [] });

const data: Pick<BrainDTO, 'groups' | 'nodes'> = {
  groups: [
    { id: 'gfx', title: 'Graphics' },
    { id: 'vk', title: 'Vulkan', parent: 'gfx' },
    { id: 'gl', title: 'OpenGL', parent: 'gfx' },
    { id: 'sim', title: 'Simulation' },
    { id: 'maths', title: 'Mathematics' },
    { id: 'talk', title: 'Communication' },
    { id: 'empty', title: 'Nothing yet' },
  ],
  nodes: [
    ...['vk.a', 'vk.b', 'vk.c'].map((id) => node(id, 'vk')),
    ...['gl.a', 'gl.b'].map((id) => node(id, 'gl')),
    node('gfx.top', 'gfx'),
    ...['sim.a', 'sim.b', 'sim.c'].map((id) => node(id, 'sim')),
    ...['m.vec', 'm.mat'].map((id) => node(id, 'maths')),
    ...['t.a', 't.b'].map((id) => node(id, 'talk')),
    node('loose'),
    node('lost', 'not-a-group'),
  ],
};
const links = [
  { from: 'vk.a', to: 'vk.b', kind: 'prereq' as const },
  { from: 'vk.b', to: 'vk.c', kind: 'prereq' as const },
  { from: 'vk.a', to: 'gl.a', kind: 'related' as const },
  { from: 'm.vec', to: 'vk.a', kind: 'prereq' as const },
  { from: 'm.vec', to: 'sim.a', kind: 'prereq' as const },
  { from: 'm.mat', to: 'sim.b', kind: 'prereq' as const },
  { from: 'sim.a', to: 'sim.b', kind: 'prereq' as const },
];

describe('group tree', () => {
  it('nests groups, puts skills without a known group under "Other", and leaves empty groups out', () => {
    const t = groupTree(data);
    expect(t.children.get(undefined)).toEqual(['gfx', 'maths', 'sim', 'talk', OTHER]);
    expect(t.children.get('gfx')).toEqual(['gl', 'vk']);
    expect(t.ids).toEqual(['gfx', 'gl', 'vk', 'maths', 'sim', 'talk', OTHER]);
    expect(t.size.get('gfx')).toBe(6);
    expect(t.groupOf.get('lost')).toBe(OTHER);
    expect(t.title.get(OTHER)).toBe('Other skills');
    expect(pathOf(t, 'vk')).toEqual(['gfx', 'vk']);
    expect(depthOf(t, 'vk')).toBe(2);
  });

  it('survives a loop or a missing parent (a map that skipped validation)', () => {
    const t = groupTree({
      groups: [
        { id: 'a', title: 'A', parent: 'b' },
        { id: 'b', title: 'B', parent: 'a' },
        { id: 'c', title: 'C', parent: 'ghost' },
        { id: 'd', title: 'D', parent: 'a' },
      ],
      nodes: [node('x', 'a'), node('y', 'c'), node('z', 'd')],
    });
    expect(t.parent.get('a')).toBeUndefined();
    expect(t.parent.get('b')).toBeUndefined();
    expect(t.parent.get('c')).toBeUndefined();
    expect(t.parent.get('d')).toBe('a');
    expect(t.parent.has(OTHER)).toBe(false);
    expect(t.children.get(undefined)).toEqual(['a', 'c']);
  });
});

describe('layout regions', () => {
  it('puts subgroups inside their domain, linked domains close, and an unrelated one apart', () => {
    const t = groupTree(data);
    const r = regions(t, links);
    const inside = (g: string, parent: string) => Math.hypot(r.get(g)!.x - r.get(parent)!.x, r.get(g)!.y - r.get(parent)!.y) + r.get(g)!.r <= r.get(parent)!.r + 1e-6;
    expect(inside('vk', 'gfx')).toBe(true);
    expect(inside('gl', 'gfx')).toBe(true);
    const gap = (a: string, b: string) => Math.hypot(r.get(a)!.x - r.get(b)!.x, r.get(a)!.y - r.get(b)!.y) - r.get(a)!.r - r.get(b)!.r;
    // Mathematics is linked to both graphics and simulation; communication to nothing.
    expect(gap('maths', 'sim')).toBeLessThan(gap('talk', 'sim'));
    expect(gap('maths', 'gfx')).toBeLessThan(gap('talk', 'gfx'));
    for (const a of ['gfx', 'sim', 'maths', 'talk']) for (const b of ['gfx', 'sim', 'maths', 'talk']) if (a < b) expect(gap(a, b)).toBeGreaterThan(-1);
  });

  it('packs around a pinned core, separating items that start on the same spot', () => {
    const at = pack([{ id: 'core', r: 50, pinned: true }, { id: 'a', r: 20 }], () => 0, { linked: 10, apart: 30 });
    expect(at.get('core')).toEqual({ x: 0, y: 0 });
    expect(Math.hypot(at.get('a')!.x, at.get('a')!.y)).toBeGreaterThanOrEqual(99);
    const twin = pack([{ id: 'p', r: 10, pinned: true }, { id: 'q', r: 10, pinned: true }], () => 1, { linked: 5, apart: 5 });
    expect(twin.get('q')).toEqual({ x: 0, y: 0 });
  });
});

describe('colours', () => {
  const t = groupTree(data);
  const sim = createSim(
    data.nodes.map((n) => ({ id: n.id, group: t.groupOf.get(n.id) })),
    links,
    t,
  );
  const g = groupColors(t, sim.regions);
  const hue = (c: Lab) => ((Math.atan2(c.b, c.a) * 180) / Math.PI + 360) % 360;
  const between = (h: number, a: number, b: number) => {
    const d = (x: number, y: number) => Math.abs(((x - y + 540) % 360) - 180);
    return d(h, a) + d(h, b) <= d(a, b) + 1e-6;
  };

  it('gives each domain its own hue and its areas shades of it', () => {
    const tops = ['gfx', 'sim', 'maths', 'talk'].map((x) => hue(g.get(x)!));
    for (let i = 0; i < tops.length; i++) for (let j = i + 1; j < tops.length; j++) expect(Math.abs(((tops[i]! - tops[j]! + 540) % 360) - 180)).toBeGreaterThan(60);
    for (const area of ['vk', 'gl']) expect(Math.abs(((hue(g.get(area)!) - hue(g.get('gfx')!) + 540) % 360) - 180)).toBeLessThan(40);
    expect(g.get(OTHER)).toEqual({ L: 0.68, a: 0, b: 0 });
  });

  it('blends a skill that bridges two domains towards both, and keeps it vivid', () => {
    const ids = sim.nodes.map((n) => n.id);
    const c = skillColors(ids, (id) => t.groupOf.get(id), sim.links, g);
    const at = (id: string) => c[ids.indexOf(id)]!;
    // m.vec links graphics and simulation: its hue moves off its own domain's.
    expect(Math.abs(hue(at('m.vec')) - hue(g.get('maths')!))).toBeGreaterThan(3);
    expect(Math.hypot(at('m.vec').a, at('m.vec').b)).toBeGreaterThan(0.08);
    // An unlinked skill keeps its group's colour (give or take its own slight shift).
    expect(Math.abs(((hue(at('t.a')) - hue(g.get('talk')!) + 540) % 360) - 180)).toBeLessThan(6);
    // Blending blue and red lands between them.
    const blue = { L: 0.7, a: Math.cos((250 * Math.PI) / 180) * 0.14, b: Math.sin((250 * Math.PI) / 180) * 0.14 };
    const red = { L: 0.7, a: Math.cos((25 * Math.PI) / 180) * 0.14, b: Math.sin((25 * Math.PI) / 180) * 0.14 };
    const mix = skillColors(['x', 'y', 'z'], (id) => id, [{ source: 0, target: 1 }, { source: 1, target: 2 }], new Map([['x', blue], ['y', red], ['z', red]]));
    expect(between(hue(mix[0]!), 250, 25)).toBe(true);
    // A grey skill stays grey on its own, and greys never divide by zero.
    expect(skillColors(['g'], () => undefined, [], new Map())[0]).toEqual({ L: 0.68, a: 0, b: 0 });
    expect(skillColors(['g', 'h'], () => undefined, [{ source: 0, target: 1 }], new Map())[0]).toEqual({ L: 0.68, a: 0, b: 0 });
  });

  it('writes CSS colours', () => {
    expect(css({ L: 0.7, a: 0.1, b: -0.05 })).toBe('oklab(0.7 0.1 -0.05)');
    expect(css({ L: 0.7, a: 0, b: 0 }, 0.2)).toBe('oklab(0.7 0 0 / 0.2)');
  });
});

describe('level of detail', () => {
  const t = groupTree(data);
  const sim = createSim(
    data.nodes.map((n) => ({ id: n.id, group: t.groupOf.get(n.id) })),
    links,
    t,
  );
  settle(sim);
  const stats = groupStats(sim.nodes, t);

  it('shows every skill close up, areas folded further out, then domains', () => {
    const near = visible(sim.nodes, t, 4);
    expect(near.folded).toEqual([]);
    expect(near.skills).toHaveLength(sim.nodes.length);
    expect(near.open).toContain('vk');

    // Far enough out that Vulkan folds but Graphics does not.
    const vk = stats.get('vk')!;
    const gfx = stats.get('gfx')!;
    expect(gfx.spread).toBeGreaterThan(vk.spread);
    const mid = (Math.min(FOLD_PX, CROWDED_PX * Math.sqrt(3)) * 0.9) / vk.spread;
    const some = visible(sim.nodes, t, mid);
    expect(some.folded.map((f) => f.id)).toContain('vk');
    expect(some.open).toContain('gfx');
    expect(some.rep[sim.nodes.findIndex((n) => n.id === 'vk.a')]).toBe('g:vk');

    const far = visible(sim.nodes, t, 0.001);
    expect(far.folded.map((f) => f.id).sort()).toEqual(['gfx', 'maths', 'sim', 'talk', OTHER].sort());
    expect(far.skills).toEqual([]);
    // Unfolded on request.
    expect(visible(sim.nodes, t, 0.001, false).skills).toHaveLength(sim.nodes.length);
  });

  it('never folds a single skill, nor skills that are not crowded', () => {
    const lone = groupTree({ groups: [{ id: 'g', title: 'G' }], nodes: [node('only', 'g')] });
    const s = createSim([{ id: 'only', group: 'g' }], [], lone);
    expect(visible(s.nodes, lone, 0.0001).skills).toEqual([0]);
    // Two skills far apart: small on screen, but not crowded.
    const pair = groupTree({ groups: [{ id: 'g', title: 'G' }], nodes: [node('a', 'g'), node('b', 'g')] });
    const p = createSim([{ id: 'a', group: 'g' }, { id: 'b', group: 'g' }], [], pair);
    p.nodes[0]!.x = -100;
    p.nodes[1]!.x = 100;
    p.nodes[0]!.y = p.nodes[1]!.y = 0;
    expect(visible(p.nodes, pair, 0.38).folded).toEqual([]);
  });

  it('merges the links into a folded group, and drops those inside it', () => {
    const far = visible(sim.nodes, t, 0.001);
    const merged = visibleLinks(sim.links, far.rep);
    expect(merged.every((l) => l.kind === undefined)).toBe(true);
    expect(merged.find((l) => l.a === 'g:maths' && l.b === 'g:sim')!.count).toBe(2);
    expect(merged.find((l) => l.a === 'g:gfx' && l.b === 'g:maths')!.count).toBe(1);
    const near = visibleLinks(sim.links, visible(sim.nodes, t, 4).rep);
    expect(near).toHaveLength(links.length);
    expect(near.every((l) => l.kind !== undefined && l.count === 1)).toBe(true);
  });
});
