import { z } from 'zod';
import { kcId } from '../store/schemas.ts';

/**
 * The profile's map of skills (data-and-privacy §3.1): one namespace shared by every project,
 * so "quaternions" learned for one project count for the next. The tutor describes the map
 * (skills, groups, links, suggestions); code validates it and colours it from evidence. The map
 * never holds a rating.
 *
 * Collections are keyed by id, so each change touches its own paths: two pending proposals that
 * add different skills never conflict, and undoing one leaves the other alone.
 */
export const SKILL_MAP_TARGET = 'learner/skills.json';

export const groupId = z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/);
const text = (max: number) => z.string().trim().min(1).max(max);

export const skillGroup = z.strictObject({
  title: text(80),
  summary: z.string().trim().max(400).optional(),
  /** The broader group this one belongs to (graphics programming ⊃ Vulkan). Absent: a top-level domain. */
  parent: groupId.optional(),
});
/** How deep groups may nest: domain → area → … → skill. */
export const MAX_GROUP_DEPTH = 6;
export const skill = z.strictObject({
  title: text(80),
  group: groupId.optional(),
  summary: z.string().trim().max(400).optional(),
  /** A suggestion at the edge of what the learner knows: an undiscovered node until they meet it. */
  suggested: z.boolean().optional(),
  /** Why this suggestion fits the learner (shown with it). */
  why: z.string().trim().max(300).optional(),
  /**
   * The learner's work suggests they know this (their repo, files they imported, what they said).
   * A claim is a hypothesis to verify with probes (P4): it never counts as evidence.
   */
  claim: z
    .strictObject({
      from: z.enum(['workspace', 'sources', 'learner']),
      basis: z.string().trim().min(1).max(300).describe('What suggests it, e.g. "src/Quat.cpp implements slerp"'),
    })
    .optional(),
});
export const edgeKind = z.enum(['prereq', 'confusable', 'related']);
export const skillEdge = z.strictObject({ from: kcId, to: kcId, kind: edgeKind });

export const MAX_SKILLS = 2000;
export const MAX_EDGES = 8000;

export const skillMapDoc = z.strictObject({
  schemaVersion: z.literal(1),
  groups: z.record(groupId, skillGroup).refine((g) => Object.keys(g).length <= 200, { message: 'at most 200 groups' }),
  skills: z.record(kcId, skill).refine((s) => Object.keys(s).length <= MAX_SKILLS, { message: `at most ${MAX_SKILLS} skills` }),
  edges: z.record(z.string().max(260), skillEdge).refine((e) => Object.keys(e).length <= MAX_EDGES, { message: `at most ${MAX_EDGES} links` }),
});

export type SkillGroup = z.output<typeof skillGroup>;
export type Skill = z.output<typeof skill>;
export type SkillEdge = z.output<typeof skillEdge>;
export type SkillMap = z.output<typeof skillMapDoc>;

export const EMPTY_SKILL_MAP: SkillMap = { schemaVersion: 1, groups: {}, skills: {}, edges: {} };

/** The key an edge is stored under: one edge per kind and direction. */
export const edgeKey = (e: Pick<SkillEdge, 'from' | 'to' | 'kind'>) => `${e.kind}:${e.from}>${e.to}`;

/** Prerequisite edges must form no cycle: returns one cycle (as ids) if there is one. */
export function findCycle(nodes: Iterable<string>, edges: readonly (readonly [string, string])[]): string[] | undefined {
  const out = new Map<string, string[]>();
  for (const [from, to] of edges) out.set(from, [...(out.get(from) ?? []), to]);
  const state = new Map<string, 'open' | 'done'>();
  const stack: string[] = [];
  // Iterative DFS: a deep chain of prerequisites cannot overflow the call stack.
  for (const start of nodes) {
    if (state.has(start)) continue;
    const frames: { node: string; next: number }[] = [{ node: start, next: 0 }];
    state.set(start, 'open');
    stack.push(start);
    while (frames.length > 0) {
      const f = frames.at(-1)!;
      const succ = out.get(f.node) ?? [];
      if (f.next < succ.length) {
        const n = succ[f.next++]!;
        if (state.get(n) === 'open') return [...stack.slice(stack.indexOf(n)), n];
        if (!state.has(n)) {
          state.set(n, 'open');
          stack.push(n);
          frames.push({ node: n, next: 0 });
        }
      } else {
        state.set(f.node, 'done');
        stack.pop();
        frames.pop();
      }
    }
  }
  return undefined;
}

/** Problems a valid-looking map can still have: dangling references, mismatched keys, a prerequisite loop. */
export function skillMapProblems(map: SkillMap): string[] {
  const problems: string[] = [];
  for (const [id, s] of Object.entries(map.skills)) {
    if (s.group !== undefined && !Object.hasOwn(map.groups, s.group)) problems.push(`skill "${id}" is in group "${s.group}", which does not exist; add the group first`);
  }
  for (const [id, g] of Object.entries(map.groups)) {
    if (g.parent === id) problems.push(`group "${id}" is its own parent`);
    else if (g.parent !== undefined && !Object.hasOwn(map.groups, g.parent)) problems.push(`group "${id}" is inside "${g.parent}", which does not exist; add that group first`);
  }
  const nesting = Object.entries(map.groups).flatMap(([id, g]) => (g.parent !== undefined && g.parent !== id ? [[id, g.parent] as const] : []));
  const loop = findCycle(Object.keys(map.groups), nesting);
  if (loop) problems.push(`groups are nested in a loop: ${loop.join(' → ')}`);
  else {
    for (const id of Object.keys(map.groups)) {
      if (groupPath(map, id).length > MAX_GROUP_DEPTH) {
        problems.push(`group "${id}" is nested more than ${MAX_GROUP_DEPTH} deep`);
        break;
      }
    }
  }
  for (const [key, e] of Object.entries(map.edges)) {
    if (key !== edgeKey(e)) problems.push(`link "${key}" must be stored under "${edgeKey(e)}"`);
    if (e.from === e.to) problems.push(`link "${key}" goes from a skill to itself`);
    for (const end of [e.from, e.to]) if (!Object.hasOwn(map.skills, end)) problems.push(`link "${key}" refers to "${end}", which is not a skill in the map`);
  }
  const prereq = Object.values(map.edges)
    .filter((e) => e.kind === 'prereq')
    .map((e) => [e.from, e.to] as const);
  const cycle = findCycle(Object.keys(map.skills), prereq);
  if (cycle) problems.push(`prerequisites form a loop: ${cycle.join(' → ')}`);
  return problems;
}

/**
 * A group and the groups it is inside, outermost first (["graphics", "vulkan"]). Stops at a
 * missing parent or a loop, so it is safe on a map that skipped validation.
 */
export function groupPath(map: Pick<SkillMap, 'groups'>, id: string): string[] {
  const path: string[] = [];
  const seen = new Set<string>();
  for (let g: string | undefined = id; g !== undefined && Object.hasOwn(map.groups, g) && !seen.has(g); g = map.groups[g]!.parent) {
    seen.add(g);
    path.unshift(g);
  }
  return path;
}

/** Validator for the change service: problems with a skill-map document (empty = valid). */
export function validateSkillMap(doc: unknown): string[] {
  const parsed = skillMapDoc.safeParse(doc);
  if (!parsed.success) return parsed.error.issues.map((i) => `${i.path.join('.') || '(map)'}: ${i.message}`);
  return skillMapProblems(parsed.data);
}

/** Direct prerequisites of each skill. */
export function prerequisites(map: SkillMap): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const e of Object.values(map.edges)) if (e.kind === 'prereq') out.set(e.to, [...(out.get(e.to) ?? []), e.from]);
  return out;
}

/** `kcs` and everything they (transitively) build on. */
export function withPrerequisites(map: SkillMap, kcs: Iterable<string>): Set<string> {
  const pre = prerequisites(map);
  const out = new Set<string>();
  const todo = [...kcs];
  while (todo.length > 0) {
    const kc = todo.pop()!;
    if (out.has(kc)) continue;
    out.add(kc);
    todo.push(...(pre.get(kc) ?? []));
  }
  return out;
}

/**
 * Longest-path layering for a prerequisite DAG (Kahn's order): each skill sits one layer after
 * its deepest prerequisite among `nodes`, so a path reads from foundations to goals. Nodes on a
 * loop (only possible in a map that skipped validation) get layer 0 rather than an error.
 */
export function layers(nodes: readonly string[], prereq: readonly (readonly [string, string])[]): Map<string, number> {
  const inSet = new Set(nodes);
  const next = new Map<string, string[]>();
  const indegree = new Map(nodes.map((n) => [n, 0]));
  for (const [from, to] of prereq) {
    if (!inSet.has(from) || !inSet.has(to)) continue;
    next.set(from, [...(next.get(from) ?? []), to]);
    indegree.set(to, indegree.get(to)! + 1);
  }
  const out = new Map(nodes.map((n) => [n, 0]));
  const queue = nodes.filter((n) => indegree.get(n) === 0);
  for (let i = 0; i < queue.length; i++) {
    const n = queue[i]!;
    for (const m of next.get(n) ?? []) {
      out.set(m, Math.max(out.get(m)!, out.get(n)! + 1));
      indegree.set(m, indegree.get(m)! - 1);
      if (indegree.get(m) === 0) queue.push(m);
    }
  }
  return out;
}
