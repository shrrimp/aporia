import { z } from 'zod';
import { EMPTY_ROADMAP, formatPointer, kcId, milestone, roadmapDoc, roadmapTarget, type ChangeService, type JsonValue, type PatchOp, type Roadmap } from '@app/core';

const SYSTEM = { kind: 'system' as const };
const slug = z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/);

/** The project's roadmap; created empty (by the app, applied at once) the first time it is needed. */
export async function ensureRoadmap(changes: ChangeService, projectId: string): Promise<Roadmap> {
  const doc = await changes.read(roadmapTarget(projectId));
  if (doc !== null) return roadmapDoc.parse(doc);
  await changes.propose({ author: SYSTEM, target: roadmapTarget(projectId), patch: [{ op: 'add', path: '', value: EMPTY_ROADMAP as unknown as JsonValue }], reason: 'start the roadmap' }, 'auto');
  return EMPTY_ROADMAP;
}

export async function readRoadmap(changes: ChangeService, projectId: string): Promise<Roadmap> {
  const parsed = roadmapDoc.safeParse(await changes.read(roadmapTarget(projectId)));
  return parsed.success ? parsed.data : EMPTY_ROADMAP;
}

/** What the tutor can send. Each milestone becomes its own change, so the learner judges them one by one. */
export const roadmapUpdate = {
  milestones: z
    .array(
      z.object({
        id: slug,
        title: z.string().trim().min(1).max(120).optional().describe('Required for a new milestone'),
        goal: z.string().trim().max(2000).optional().describe('What reaching it means, in the learner\'s project'),
        kcs: z.array(kcId).max(30).optional(),
        order: z.number().min(0).max(1e6).optional().describe('Position on the roadmap; required for a new milestone'),
        status: z.enum(['planned', 'active', 'done']).optional(),
        capability: z.string().trim().max(200).optional(),
      }),
    )
    .max(30)
    .default([]),
  remove: z.array(slug).max(30).default([]),
  reason: z.string().trim().min(1).max(1000),
};
export type RoadmapUpdate = z.output<z.ZodObject<typeof roadmapUpdate>>;

/** One patch per milestone (fields left out keep their value), and the problems that stop it. */
export function roadmapPatches(r: Roadmap, u: RoadmapUpdate): { patches: { id: string; patch: PatchOp[] }[]; problems: string[] } {
  const patches: { id: string; patch: PatchOp[] }[] = [];
  const problems: string[] = [];
  for (const m of u.milestones) {
    const { id, ...fields } = m;
    const existing = r.milestones[id];
    if (!existing && (fields.title === undefined || fields.order === undefined)) {
      problems.push(`milestone "${id}" is new, so it needs a title and an order`);
      continue;
    }
    const value = { ...existing, ...Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== undefined)) };
    patches.push({ id, patch: [{ op: 'add', path: formatPointer(['milestones', id]), value: milestone.parse(value) as unknown as JsonValue }] });
  }
  for (const id of u.remove) {
    if (!r.milestones[id]) problems.push(`there is no milestone "${id}"`);
    else patches.push({ id, patch: [{ op: 'remove', path: formatPointer(['milestones', id]) }] });
  }
  return { patches, problems };
}

/** The roadmap as the tutor reads it. */
export function describeRoadmap(r: Roadmap): string {
  const list = Object.entries(r.milestones).sort(([a, x], [b, y]) => x.order - y.order || a.localeCompare(b));
  if (list.length === 0) return 'No roadmap yet. Propose one with update_roadmap: the milestones of the learner\'s real project, in order.';
  return list
    .map(([id, m], i) => `${i + 1}. [${m.status}] ${m.title} (id ${id}, order ${m.order})${m.kcs.length ? `; skills: ${m.kcs.join(', ')}` : ''}${m.capability ? `; unlocks: ${m.capability}` : ''}${m.goal ? `\n   ${m.goal.replace(/\s+/g, ' ').slice(0, 300)}` : ''}`)
    .join('\n');
}
