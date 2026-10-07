import { z } from 'zod';
import {
  EMPTY_SKILL_MAP,
  SKILL_MAP_TARGET,
  band,
  edgeKey,
  edgeKind,
  formatPointer,
  groupId,
  kcId,
  ratingConfidence,
  skillMapDoc,
  type ChangeService,
  type JsonValue,
  type LearnerState,
  type PatchOp,
  type SkillMap,
} from '@app/core';

const SYSTEM = { kind: 'system' as const };

/** The profile's skill map; created empty (by the app, applied at once) the first time it is needed. */
export async function ensureSkillMap(changes: ChangeService): Promise<SkillMap> {
  const doc = await changes.read(SKILL_MAP_TARGET);
  if (doc !== null) return skillMapDoc.parse(doc);
  await changes.propose({ author: SYSTEM, target: SKILL_MAP_TARGET, patch: [{ op: 'add', path: '', value: EMPTY_SKILL_MAP as unknown as JsonValue }], reason: 'start the skill map' }, 'auto');
  return EMPTY_SKILL_MAP;
}

export async function readSkillMap(changes: ChangeService): Promise<SkillMap> {
  const doc = await changes.read(SKILL_MAP_TARGET);
  return doc === null ? EMPTY_SKILL_MAP : skillMapDoc.parse(doc);
}

const text = (max: number) => z.string().trim().min(1).max(max);
const edge = z.object({ from: kcId, to: kcId, kind: edgeKind });

/** What the tutor can send to describe the map. Flat on purpose (models produce broken deeply nested JSON). */
export const skillMapUpdate = {
  groups: z
    .array(
      z.object({
        id: groupId,
        title: text(80).optional().describe('Required for a new group'),
        summary: z.string().trim().max(400).optional(),
        parent: groupId.optional().describe('The broader group it belongs to (vulkan → graphics-programming); leave out for a top-level domain'),
      }),
    )
    .max(50)
    .default([]),
  skills: z
    .array(
      z.object({
        id: kcId,
        title: text(80).optional().describe('Required for a new skill'),
        group: groupId.optional(),
        summary: z.string().trim().max(400).optional(),
        suggested: z.boolean().optional().describe('An undiscovered skill the learner could take on next'),
        why: z.string().trim().max(300).optional().describe('For a suggestion: why it fits this learner'),
        claim: z
          .object({ from: z.enum(['workspace', 'sources', 'learner']), basis: z.string().trim().min(1).max(300) })
          .optional()
          .describe("The learner's work suggests they know this (their repo, their files, what they said). A claim to verify with probes, never evidence"),
      }),
    )
    .max(100)
    .default([]),
  edges: z.array(edge).max(200).default([]).describe('prereq: "from" must be learned before "to"; confusable: often mixed up; related: worth seeing together'),
  removeSkills: z.array(kcId).max(50).default([]),
  removeEdges: z.array(edge).max(100).default([]),
  reason: z.string().trim().min(1).max(1000),
};
export type SkillMapUpdate = z.output<z.ZodObject<typeof skillMapUpdate>>;

const ptr = (...tokens: string[]) => formatPointer(tokens);

/** Groups or skills added by proposals still waiting for the learner's review (id → value). */
export function pendingEntries(changes: ChangeService, kind: 'groups' | 'skills'): Map<string, Record<string, unknown>> {
  const out = new Map<string, Record<string, unknown>>();
  const path = new RegExp(`^/${kind}/([^/]+)$`);
  for (const c of changes.list({ status: 'proposed', target: SKILL_MAP_TARGET })) {
    for (const op of c.patch) {
      const m = path.exec(op.path);
      if (m && op.op === 'add' && typeof op.value === 'object' && op.value !== null) out.set(m[1]!, op.value as Record<string, unknown>);
    }
  }
  return out;
}

/**
 * Links and skills may use skills and groups that were proposed earlier and still wait for the
 * learner's review. Those are brought into this update, so it applies on its own (and accepting
 * the proposals in any order works).
 */
export function withPendingReferences(map: SkillMap, u: SkillMapUpdate, changes: ChangeService): SkillMapUpdate {
  const skills = pendingEntries(changes, 'skills');
  const groups = pendingEntries(changes, 'groups');
  const out: SkillMapUpdate = { ...u, skills: [...u.skills], groups: [...u.groups] };
  const haveSkill = new Set(out.skills.map((x) => x.id));
  for (const e of u.edges) {
    for (const end of [e.from, e.to]) {
      const value = skills.get(end);
      if (!map.skills[end] && !haveSkill.has(end) && value) {
        haveSkill.add(end);
        out.skills.push({ id: end, ...(value as { title: string }) });
      }
    }
  }
  const haveGroup = new Set(out.groups.map((g) => g.id));
  const bring = (id: string | undefined) => {
    const value = id === undefined ? undefined : groups.get(id);
    if (id !== undefined && !map.groups[id] && !haveGroup.has(id) && value) {
      haveGroup.add(id);
      out.groups.push({ id, ...(value as { title: string }) });
    }
  };
  for (const s of out.skills) bring(s.group);
  // Parents too, up the chain (the list grows as they are brought in).
  for (let i = 0; i < out.groups.length; i++) bring(out.groups[i]!.parent ?? (map.groups[out.groups[i]!.id]?.parent));
  return out;
}

/** Every skill id the tutor can refer to: in the map, or proposed and waiting for review. */
export async function knownSkills(changes: ChangeService): Promise<Set<string>> {
  return new Set([...Object.keys((await readSkillMap(changes)).skills), ...pendingEntries(changes, 'skills').keys()]);
}

/**
 * Fine-grained patch for an update: one path per group, skill and link, so separate proposals
 * do not collide. Fields left out of a skill keep their value. Removing a skill removes its links.
 */
export function skillMapPatch(map: SkillMap, u: SkillMapUpdate): { patch: PatchOp[]; problems: string[] } {
  const patch: PatchOp[] = [];
  const problems: string[] = [];
  for (const g of u.groups) {
    const { id, ...value } = g;
    if (!map.groups[id] && value.title === undefined) {
      problems.push(`group "${id}" is new, so it needs a title`);
      continue;
    }
    patch.push({ op: 'add', path: ptr('groups', id), value: { ...map.groups[id], ...strip(value) } as JsonValue });
  }
  for (const s of u.skills) {
    const { id, ...fields } = s;
    const existing = map.skills[id];
    if (!existing && fields.title === undefined) {
      problems.push(`skill "${id}" is new, so it needs a title`);
      continue;
    }
    patch.push({ op: 'add', path: ptr('skills', id), value: { ...existing, ...strip(fields) } as JsonValue });
  }
  for (const e of u.edges) patch.push({ op: 'add', path: ptr('edges', edgeKey(e)), value: { from: e.from, to: e.to, kind: e.kind } });
  const removed = new Set<string>();
  for (const e of u.removeEdges) {
    const key = edgeKey(e);
    if (!map.edges[key]) problems.push(`there is no ${e.kind} link from "${e.from}" to "${e.to}"`);
    else if (!removed.has(key)) {
      removed.add(key);
      patch.push({ op: 'remove', path: ptr('edges', key) });
    }
  }
  const added = new Set(u.edges.map(edgeKey));
  for (const id of u.removeSkills) {
    if (!map.skills[id]) {
      problems.push(`there is no skill "${id}"`);
      continue;
    }
    patch.push({ op: 'remove', path: ptr('skills', id) });
    for (const [key, e] of Object.entries(map.edges)) {
      if ((e.from === id || e.to === id) && !removed.has(key) && !added.has(key)) {
        removed.add(key);
        patch.push({ op: 'remove', path: ptr('edges', key) });
      }
    }
  }
  return { patch, problems };
}

function strip<T extends Record<string, unknown>>(o: T): Partial<T> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>;
}

/** The map as the tutor reads it: what each skill is, and where the learner stands (computed by the app). */
export function describeSkillMap(map: SkillMap, state: LearnerState, max = 400): string {
  const skills = Object.entries(map.skills).sort(([a], [b]) => a.localeCompare(b));
  if (skills.length === 0) return 'The skill map is empty. Add the skills this learner works on with update_skill_map.';
  const lines: string[] = [];
  const groups = Object.entries(map.groups);
  if (groups.length) {
    // As a tree: each group under its parent.
    const children = new Map<string | undefined, string[]>();
    for (const [id, g] of groups) {
      const parent = g.parent !== undefined && map.groups[g.parent] ? g.parent : undefined;
      children.set(parent, [...(children.get(parent) ?? []), id]);
    }
    const tree: string[] = [];
    const seen = new Set<string>();
    const walk = (parent: string | undefined, depth: number) => {
      for (const id of (children.get(parent) ?? []).sort()) {
        if (seen.has(id)) continue;
        seen.add(id);
        tree.push(`${'  '.repeat(depth)}- ${id}: ${map.groups[id]!.title}`);
        walk(id, depth + 1);
      }
    };
    walk(undefined, 0);
    lines.push('## Groups (nested: domain → area → …)', ...tree, '');
  }
  lines.push(`## Skills (${skills.length}; level and status computed by the app from evidence)`);
  for (const [id, s] of skills.slice(0, max)) {
    const kc = state.kcs.get(id);
    const level = kc
      ? `${band(kc.rating.theta)}, ${kc.mastery}, confidence ${ratingConfidence(kc.rating).toFixed(2)}`
      : s.claim
        ? 'CLAIMED, NOT VERIFIED: probe it'
        : s.suggested
          ? 'suggestion, not met yet'
          : 'no evidence yet';
    lines.push(
      `- ${id}: ${s.title}${s.group ? ` [${s.group}]` : ''} (${level})${s.claim ? `. Claimed from ${s.claim.from}: ${s.claim.basis}` : ''}${s.suggested && s.why ? `. Suggested because: ${s.why}` : ''}`,
    );
  }
  if (skills.length > max) lines.push(`… and ${skills.length - max} more`);
  const edges = Object.values(map.edges);
  if (edges.length) lines.push('', '## Links', ...edges.slice(0, max).map((e) => `- ${e.kind}: ${e.from} → ${e.to}`));
  return lines.join('\n');
}
