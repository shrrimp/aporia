import { describe, expect, it } from 'vitest';
import { SETTLED, bounds, createSim, fit, groupCentres, hash, reheat, settle, step } from '../src/brain/layout.ts';

const nodes = [
  { id: 'linalg.vectors', group: 'linalg', weight: 2 },
  { id: 'linalg.matrices', group: 'linalg' },
  { id: 'rot.quaternion', group: 'rot' },
  { id: 'rot.exp-map', group: 'rot' },
  { id: 'misc.alone' },
];
const links = [
  { from: 'linalg.vectors', to: 'linalg.matrices', kind: 'prereq' as const },
  { from: 'linalg.matrices', to: 'rot.quaternion', kind: 'prereq' as const },
  { from: 'rot.quaternion', to: 'rot.exp-map', kind: 'confusable' as const },
  { from: 'rot.exp-map', to: 'misc.alone', kind: 'related' as const },
  { from: 'rot.exp-map', to: 'nowhere', kind: 'related' as const },
  { from: 'misc.alone', to: 'misc.alone', kind: 'related' as const },
];

const dist = (a: { x: number; y: number }, b: { x: number; y: number }) => Math.hypot(a.x - b.x, a.y - b.y);

describe('brain layout', () => {
  it('is deterministic, drops links to unknown or the same node, and settles', () => {
    const a = createSim(nodes, links);
    const b = createSim(nodes, links);
    expect(a.links).toHaveLength(4);
    settle(a);
    settle(b);
    expect(a.nodes.map((n) => [n.x, n.y])).toEqual(b.nodes.map((n) => [n.x, n.y]));
    expect(a.alpha).toBeLessThanOrEqual(SETTLED);
    expect(step(a)).toBeLessThan(5);
    expect(hash('x')).toBe(hash('x'));
    expect(hash('x')).not.toBe(hash('y'));
  });

  it('keeps nodes apart, groups together, and linked skills near', () => {
    const sim = createSim(nodes, links);
    settle(sim);
    const at = (id: string) => sim.nodes.find((n) => n.id === id)!;
    for (let i = 0; i < sim.nodes.length; i++) for (let j = i + 1; j < sim.nodes.length; j++) expect(dist(sim.nodes[i]!, sim.nodes[j]!)).toBeGreaterThan(20);
    const centres = groupCentres(sim);
    expect(centres.get('linalg')!.count).toBe(2);
    expect(centres.has('misc')).toBe(false);
    expect(dist(at('linalg.vectors'), at('linalg.matrices'))).toBeLessThan(dist(at('linalg.vectors'), at('rot.exp-map')));
    const box = bounds(sim);
    for (const n of sim.nodes) {
      expect(n.x).toBeGreaterThan(box.x);
      expect(n.y).toBeLessThan(box.y + box.height);
    }
  });

  it('separates nodes that start on the same spot, holds pinned ones, and reheats', () => {
    const sim = createSim([{ id: 'a' }, { id: 'b' }], []);
    sim.nodes[1]!.x = sim.nodes[0]!.x;
    sim.nodes[1]!.y = sim.nodes[0]!.y;
    sim.nodes[0]!.pinned = true;
    const pinned = { x: sim.nodes[0]!.x, y: sim.nodes[0]!.y };
    settle(sim, 50);
    expect(dist(sim.nodes[0]!, sim.nodes[1]!)).toBeGreaterThan(5);
    expect(sim.nodes[0]).toMatchObject(pinned);
    sim.alpha = 0.01;
    reheat(sim);
    expect(sim.alpha).toBe(0.3);
    reheat(sim, 0.1);
    expect(sim.alpha).toBe(0.3);
  });

  it('frames an empty map, and never zooms a small one in past natural size', () => {
    expect(bounds(createSim([], []))).toEqual({ x: -200, y: -150, width: 400, height: 300 });
    expect(fit({ x: -200, y: -150, width: 400, height: 300 })).toEqual({ x: -480, y: -300, width: 960, height: 600 });
    expect(fit({ x: 0, y: 0, width: 2000, height: 1000 })).toEqual({ x: 0, y: 0, width: 2000, height: 1000 });
  });

  it('lays out a few hundred skills quickly', () => {
    const many = Array.from({ length: 300 }, (_, i) => ({ id: `s${i}`, group: `g${i % 12}` }));
    const chain = many.slice(1).map((n, i) => ({ from: many[i]!.id, to: n.id, kind: 'prereq' as const }));
    const t = performance.now();
    settle(createSim(many, chain));
    expect(performance.now() - t).toBeLessThan(3000);
  });
});
