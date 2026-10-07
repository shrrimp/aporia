import { z } from 'zod';
import { kcId } from '../store/schemas.ts';

const slug = z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/);
const text = (max: number) => z.string().trim().min(1).max(max);

export const curriculumTarget = (projectId: string) => `projects/${projectId}/curriculum.json`;
export const roadmapTarget = (projectId: string) => `projects/${projectId}/roadmap.json`;
export const assessmentTarget = (projectId: string) => `projects/${projectId}/assessment.json`;

/**
 * A project's curriculum (teaching-engine §1.3): the skills it aims at, and a rolling plan of
 * lessons. Only the next two or three are detailed; later ones are refined as evidence arrives.
 * The skills themselves live in the profile's skill map.
 */
export const curriculumDoc = z.strictObject({
  schemaVersion: z.literal(1),
  /** The skills the project is for; the path is these and everything they build on. */
  goals: z.array(kcId).min(1).max(30),
  plan: z
    .array(
      z.strictObject({
        id: slug,
        title: text(120),
        kcs: z.array(kcId).min(1).max(12),
        /** What the learner can do in their project afterwards (MO3). */
        capability: z.string().trim().max(200).optional(),
        /** Set once the lesson is written. */
        lessonId: slug.optional(),
        /** The roadmap milestone this lesson works towards. */
        milestone: slug.optional(),
        note: z.string().trim().max(400).optional(),
      }),
    )
    .max(40),
});
export type Curriculum = z.output<typeof curriculumDoc>;

export function validateCurriculum(doc: unknown): string[] {
  const parsed = curriculumDoc.safeParse(doc);
  if (!parsed.success) return parsed.error.issues.map((i) => `${i.path.join('.') || '(curriculum)'}: ${i.message}`);
  const problems: string[] = [];
  const ids = new Set<string>();
  const lessons = new Set<string>();
  for (const p of parsed.data.plan) {
    if (ids.has(p.id)) problems.push(`plan: the id "${p.id}" is used twice`);
    ids.add(p.id);
    if (p.lessonId !== undefined) {
      if (lessons.has(p.lessonId)) problems.push(`plan: lesson "${p.lessonId}" is planned twice`);
      lessons.add(p.lessonId);
    }
  }
  return problems;
}

const finding = z.strictObject({ text: text(300), kcs: z.array(kcId).max(6).default([]) });

/**
 * What the first interview found (teaching-engine §1.2): the tutor's playback, kept for the
 * learner to read and correct. Levels are not stored here: they come from the probe evidence.
 */
export const assessmentDoc = z.strictObject({
  schemaVersion: z.literal(1),
  /** The playback, in a few sentences ("strong on X, shaky on Y; bridge via Z"). */
  summary: text(2000),
  strengths: z.array(finding).max(12).default([]),
  gaps: z.array(finding).max(12).default([]),
  misconceptions: z.array(finding).max(12).default([]),
  /** Adjacent experience to build on (G4). */
  bridges: z.array(finding).max(12).default([]),
  /** Preferences as the learner stated them: respected, not treated as a learning mechanism (P6). */
  preferences: z.array(text(200)).max(12).default([]),
});
export type Assessment = z.output<typeof assessmentDoc>;

export function validateAssessment(doc: unknown): string[] {
  const parsed = assessmentDoc.safeParse(doc);
  return parsed.success ? [] : parsed.error.issues.map((i) => `${i.path.join('.') || '(assessment)'}: ${i.message}`);
}

/**
 * The project's roadmap: the milestones of the learner's real project (Stage 1, Stage 2…), in
 * order, each saying what it takes and what it unlocks. Keyed by id, so the tutor's changes to
 * one milestone can be accepted, rejected or undone without touching the others.
 */
export const milestone = z.strictObject({
  title: text(120),
  goal: z.string().trim().max(2000).default(''),
  kcs: z.array(kcId).max(30).default([]),
  /** Position on the roadmap (ascending). */
  order: z.number().min(0).max(1e6),
  status: z.enum(['planned', 'active', 'done']).default('planned'),
  /** What the learner's project can do once it is reached (MO3). */
  capability: z.string().trim().max(200).optional(),
});
export const roadmapDoc = z.strictObject({
  schemaVersion: z.literal(1),
  milestones: z.record(slug, milestone).refine((m) => Object.keys(m).length <= 60, { message: 'at most 60 milestones' }),
});
export type Milestone = z.output<typeof milestone>;
export const EMPTY_ROADMAP = { schemaVersion: 1 as const, milestones: {} };
export type Roadmap = z.output<typeof roadmapDoc>;

export function validateRoadmap(doc: unknown): string[] {
  const parsed = roadmapDoc.safeParse(doc);
  return parsed.success ? [] : parsed.error.issues.map((i) => `${i.path.join('.') || '(roadmap)'}: ${i.message}`);
}

/** Milestones in roadmap order (ties by id, so the order is stable). */
export function orderedMilestones(r: Roadmap): (Milestone & { id: string })[] {
  return Object.entries(r.milestones)
    .map(([id, m]) => ({ id, ...m }))
    .sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
}
