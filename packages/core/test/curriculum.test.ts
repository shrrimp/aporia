import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import {
  EMPTY_SKILL_MAP,
  DAY_MS,
  ManualClock,
  Journal,
  Observations,
  deriveLearnerState,
  edgeKey,
  findCycle,
  groupPath,
  MAX_GROUP_DEPTH,
  layers,
  pathState,
  prerequisites,
  skillMapProblems,
  struggleReasons,
  orderedMilestones,
  roadmapDoc,
  validateAssessment,
  validateCurriculum,
  validateRoadmap,
  validateSkillMap,
  withPrerequisites,
  type SkillMap,
} from '../src/index.ts';
import { tempDir } from './helpers.ts';

const map = (skills: string[], edges: [string, string, 'prereq' | 'confusable' | 'related'][] = [], extra: Partial<SkillMap> = {}): SkillMap => ({
  ...EMPTY_SKILL_MAP,
  skills: Object.fromEntries(skills.map((s) => [s, { title: s }])),
  edges: Object.fromEntries(edges.map(([from, to, kind]) => [edgeKey({ from, to, kind }), { from, to, kind }])),
  ...extra,
});

describe('skill map validation', () => {
  it('accepts a consistent map', () => {
    const m = map(['a', 'b', 'c'], [['a', 'b', 'prereq'], ['b', 'c', 'prereq'], ['c', 'a', 'confusable']], { groups: { g: { title: 'G' } } });
    m.skills['a']!.group = 'g';
    expect(validateSkillMap(m)).toEqual([]);
    expect(validateSkillMap(EMPTY_SKILL_MAP)).toEqual([]);
  });

  it('reports dangling references, wrong keys, self links and prerequisite loops', () => {
    const m = map(['a', 'b'], [['a', 'b', 'prereq'], ['b', 'a', 'prereq'], ['a', 'zz', 'related'], ['a', 'a', 'related']]);
    m.skills['b']!.group = 'missing';
    m.edges['wrong-key'] = { from: 'a', to: 'b', kind: 'related' };
    const problems = skillMapProblems(m);
    expect(problems).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/group "missing", which does not exist/),
        expect.stringMatching(/"wrong-key" must be stored under "related:a>b"/),
        expect.stringMatching(/goes from a skill to itself/),
        expect.stringMatching(/refers to "zz"/),
        expect.stringMatching(/prerequisites form a loop: (a → b → a|b → a → b)/),
      ]),
    );
    expect(validateSkillMap({ schemaVersion: 1, groups: {}, skills: { 'Bad Id': { title: 'x' } }, edges: {} })[0]).toMatch(/skills/);
    expect(validateSkillMap(null)[0]).toMatch(/\(map\)/);
  });

  it('nests groups (domain → area → …), within limits', () => {
    const groups = (pairs: [string, string | undefined][]) => Object.fromEntries(pairs.map(([id, parent]) => [id, { title: id, ...(parent ? { parent } : {}) }]));
    const ok = map([], [], { groups: groups([['graphics', undefined], ['vulkan', 'graphics'], ['vk-sync', 'vulkan']]) });
    expect(validateSkillMap(ok)).toEqual([]);
    expect(groupPath(ok, 'vk-sync')).toEqual(['graphics', 'vulkan', 'vk-sync']);
    expect(groupPath(ok, 'nope')).toEqual([]);

    expect(skillMapProblems(map([], [], { groups: groups([['a', 'a']]) }))).toEqual(['group "a" is its own parent']);
    expect(skillMapProblems(map([], [], { groups: groups([['a', 'ghost']]) }))[0]).toMatch(/inside "ghost", which does not exist/);
    const loop = map([], [], { groups: groups([['a', 'b'], ['b', 'a']]) });
    expect(skillMapProblems(loop)[0]).toMatch(/nested in a loop/);
    expect(groupPath(loop, 'a')).toEqual(['b', 'a']); // safe on an invalid map
    const deep = map([], [], { groups: groups(Array.from({ length: MAX_GROUP_DEPTH + 1 }, (_, i) => [`g${i}`, i ? `g${i - 1}` : undefined] as [string, string | undefined])) });
    expect(skillMapProblems(deep)).toEqual([`group "g${MAX_GROUP_DEPTH}" is nested more than ${MAX_GROUP_DEPTH} deep`]);
  });

  it('finds a cycle in any graph that has one (property)', () => {
    fc.assert(
      fc.property(fc.array(fc.tuple(fc.integer({ min: 0, max: 7 }), fc.integer({ min: 0, max: 7 })), { maxLength: 20 }), (pairs) => {
        const edges = pairs.map(([a, b]) => [`n${a}`, `n${b}`] as const);
        const nodes = Array.from({ length: 8 }, (_, i) => `n${i}`);
        const cycle = findCycle(nodes, edges);
        // Independent check: a graph is acyclic iff Kahn's algorithm consumes every node.
        const indeg = new Map(nodes.map((n) => [n, 0]));
        for (const [, b] of edges) indeg.set(b, indeg.get(b)! + 1);
        const queue = nodes.filter((n) => indeg.get(n) === 0);
        for (let i = 0; i < queue.length; i++) for (const [a, b] of edges) if (a === queue[i]) { indeg.set(b, indeg.get(b)! - 1); if (indeg.get(b) === 0) queue.push(b); }
        expect(cycle === undefined).toBe(queue.length === nodes.length);
        if (cycle) {
          expect(cycle[0]).toBe(cycle.at(-1));
          for (let i = 1; i < cycle.length; i++) expect(edges.some(([a, b]) => a === cycle[i - 1] && b === cycle[i])).toBe(true);
        }
      }),
    );
  });

  it('handles long prerequisite chains without deep recursion', () => {
    const n = 20_000;
    const nodes = Array.from({ length: n }, (_, i) => `k${i}`);
    const edges = nodes.slice(1).map((k, i) => [nodes[i]!, k] as const);
    expect(findCycle(nodes, edges)).toBeUndefined();
    expect(layers(nodes, edges).get(`k${n - 1}`)).toBe(n - 1);
  });
});

describe('graph helpers', () => {
  const m = map(['vec', 'mat', 'quat', 'joint', 'other'], [['vec', 'mat', 'prereq'], ['mat', 'quat', 'prereq'], ['vec', 'quat', 'prereq'], ['quat', 'joint', 'prereq'], ['quat', 'mat', 'confusable']]);

  it('collects prerequisites, transitively', () => {
    expect(prerequisites(m).get('quat')!.sort()).toEqual(['mat', 'vec']);
    expect([...withPrerequisites(m, ['joint'])].sort()).toEqual(['joint', 'mat', 'quat', 'vec']);
    expect([...withPrerequisites(m, ['nope'])]).toEqual(['nope']);
  });

  it('layers a path from foundations to goals', () => {
    const prereq = Object.values(m.edges).filter((e) => e.kind === 'prereq').map((e) => [e.from, e.to] as const);
    expect(Object.fromEntries(layers(['vec', 'mat', 'quat', 'joint'], prereq))).toEqual({ vec: 0, mat: 1, quat: 2, joint: 3 });
    expect(Object.fromEntries(layers(['quat', 'joint'], prereq))).toEqual({ quat: 0, joint: 1 });
    expect(Object.fromEntries(layers(['a', 'b'], [['a', 'b'], ['b', 'a']]))).toEqual({ a: 0, b: 0 });
  });
});

describe('path state and struggles', () => {
  it('places a skill on the path from its own mastery and its prerequisites', () => {
    const m = new Map([['vec', 'durable' as const], ['mat', 'practising' as const]]);
    const of = (k: string) => m.get(k);
    expect(pathState('provisional', ['mat'], of)).toEqual({ state: 'mastered', needs: [] });
    expect(pathState('introduced', ['mat'], of)).toEqual({ state: 'in-progress', needs: [] });
    expect(pathState(undefined, ['vec'], of)).toEqual({ state: 'available', needs: [] });
    expect(pathState('unseen', ['vec', 'mat', 'x'], of)).toEqual({ state: 'locked', needs: ['mat', 'x'] });
  });

  it('names a struggle from evidence only', async () => {
    const clock = new ManualClock('2026-10-06T10:00:00.000Z');
    const journal = await Journal.open(await tempDir(), clock);
    const obs = new Observations(journal);
    const ev = (kc: string, outcome: number, evidenceType: 'production' | 'self-rating' = 'production') =>
      obs.recordEvidence({ author: { kind: 'system' }, itemId: `${kc}-${journal.events.length}`, kcs: [{ kc, weight: 1 }], difficulty: 0, evidenceType, outcome });
    await ev('missed', 0);
    await ev('missed', 0.2);
    await ev('missed', 1);
    await ev('slipping', 1);
    await ev('slipping', 1);
    clock.advance(3 * DAY_MS);
    await ev('slipping', 0);
    await ev('fine', 1);
    await ev('fine', 0);
    await ev('fine', 1);
    await ev('rated', 0, 'self-rating');
    await ev('rated', 0, 'self-rating');
    await ev('once', 0);
    const s = deriveLearnerState(journal.events, clock.now());
    expect(struggleReasons(s.kcs.get('missed'))).toEqual(['2 of the last 3 answers missed']);
    expect(struggleReasons(s.kcs.get('slipping'))).toEqual(['the latest answer was missed after earlier successes']);
    expect(struggleReasons(s.kcs.get('fine'))).toEqual([]);
    expect(struggleReasons(s.kcs.get('rated'))).toEqual([]);
    expect(struggleReasons(s.kcs.get('once'))).toEqual([]);
    expect(struggleReasons(undefined)).toEqual([]);
  });
});

describe('curriculum and assessment documents', () => {
  it('validates the plan', () => {
    const plan = (id: string, lessonId?: string) => ({ id, title: id, kcs: ['quat'], ...(lessonId ? { lessonId } : {}) });
    expect(validateCurriculum({ schemaVersion: 1, goals: ['joint'], plan: [plan('a', 'l1'), plan('b')] })).toEqual([]);
    expect(validateCurriculum({ schemaVersion: 1, goals: ['joint'], plan: [plan('a', 'l1'), plan('a', 'l1')] })).toEqual([
      'plan: the id "a" is used twice',
      'plan: lesson "l1" is planned twice',
    ]);
    expect(validateCurriculum({ schemaVersion: 1, goals: [], plan: [] })[0]).toMatch(/^goals/);
    expect(validateCurriculum(undefined)[0]).toMatch(/^\(curriculum\)/);
  });

  it('validates the assessment', () => {
    expect(validateAssessment({ schemaVersion: 1, summary: 'Strong on vectors.', gaps: [{ text: 'frames', kcs: ['frames'] }] })).toEqual([]);
    expect(validateAssessment({ schemaVersion: 1, summary: '' })[0]).toMatch(/^summary/);
    expect(validateAssessment(42)[0]).toMatch(/^\(assessment\)/);
  });
});

describe('the roadmap document', () => {
  it('validates, and orders milestones by order then id', () => {
    expect(validateRoadmap({ schemaVersion: 1, milestones: { b: { title: 'B', order: 1 }, a: { title: 'A', order: 1 }, c: { title: 'C', order: 0 } } })).toEqual([]);
    expect(validateRoadmap({ schemaVersion: 1, milestones: { 'Bad Id': { title: 'x', order: 1 } } })[0]).toMatch(/^milestones/);
    expect(validateRoadmap(null)[0]).toMatch(/^\(roadmap\)/);
    const r = roadmapDoc.parse({ schemaVersion: 1, milestones: { b: { title: 'B', order: 1 }, a: { title: 'A', order: 1 }, c: { title: 'C', order: 0 } } });
    expect(orderedMilestones(r).map((m) => m.id)).toEqual(['c', 'a', 'b']);
    expect(orderedMilestones(r)[0]).toMatchObject({ status: 'planned', goal: '', kcs: [] });
  });
});
