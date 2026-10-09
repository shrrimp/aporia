import { readFileSync } from 'node:fs';
import type { LearnerForm } from '@app/catalog';
import { lessonIds } from './lessons.ts';
import { projectReviews, type ProjectReviews } from './reviews.ts';
import { projectTarget } from './paths.ts';
import { readSkillMap } from './skills.ts';
import { readSources, type SourcesDoc } from './sources.ts';
import { projectAccess } from './files.ts';
import { describeRoadmap, readRoadmap } from './roadmap.ts';
import { describePermissions } from '@app/catalog';
import {
  assessmentTarget,
  band,
  checkpointRuns,
  GATED_FROM,
  hintStates,
  curriculumDoc,
  curriculumTarget,
  type Curriculum,
  type SkillMap,
  deriveLearnerState,
  difficultyAdjustment,
  ratingConfidence,
  type Author,
  type ChangeMode,
  type LearnerState,
  type OpenProfile,
} from '@app/core';

/** Everything one agent session is bound to. Tools can only touch this profile and project. */
export interface TeacherContext {
  readonly profile: OpenProfile;
  readonly projectId: string;
  /** Who is acting (agent product, model, session): stamped on every record. */
  readonly agent: Author;
  /** The learner's current review/auto setting. */
  changeMode(): ChangeMode;
  /** Shows a form to the learner in the app. Absent when no learner interface is attached. */
  present?(form: LearnerForm): void;
}

const RULES_DIR = new URL('../rules/', import.meta.url);
export const RULES = {
  constitution: readFileSync(new URL('constitution.md', RULES_DIR), 'utf8'),
  lessonAuthoring: readFileSync(new URL('lesson-authoring.md', RULES_DIR), 'utf8'),
};

/** The system prompt handed to agents that accept one. */
export function systemPrompt(): string {
  return `${RULES.constitution}\n\n${RULES.lessonAuthoring}\n\nCall get_teaching_context before teaching.`;
}

export { lessonsDir, lessonTarget, projectTarget, reviewsTarget } from './paths.ts';

/** Recommended scaffold level for a KC (pedagogy-model §3, §5). */
export function scaffoldFor(theta: number): number {
  const b = band(theta);
  return { new: 4, emerging: 3, developing: 3, solid: 2, strong: 1 }[b];
}

/** Plain-text learner summary computed by code: what the agent sees instead of raw files. */
export function learnerSummary(state: LearnerState): string {
  const lines: string[] = [];
  const kcs = [...state.kcs.values()].sort((a, b) => a.kc.localeCompare(b.kc));
  lines.push('## Skills (computed by the app from evidence)');
  if (kcs.length === 0) lines.push('No evidence yet: run a short diagnostic before assuming any level.');
  for (const k of kcs) {
    lines.push(
      `- ${k.kc}: ${band(k.rating.theta)}, ${k.mastery}, confidence ${ratingConfidence(k.rating).toFixed(2)}, recommended scaffold ${scaffoldFor(k.rating.theta)}`,
    );
  }
  const recent = state.firstAttempts.slice(-12);
  const adj = difficultyAdjustment(state.firstAttempts, Number.POSITIVE_INFINITY);
  lines.push('', '## Difficulty');
  lines.push(
    recent.length === 0
      ? 'No first attempts yet.'
      : `First-attempt success: ${recent.filter(Boolean).length}/${recent.length} recent items. ` +
          (adj === 1 ? 'Make the next tasks harder.' : adj === -1 ? 'Make the next tasks easier.' : 'Keep the current difficulty.'),
  );
  lines.push('', '## How this learner seems to learn (hypotheses; trust 0–1, computed by the app)');
  if (state.insights.length === 0) lines.push('None recorded yet.');
  for (const i of state.insights) {
    lines.push(`- [${i.trust.toFixed(2)}] ${i.text} (id ${i.id}, scope ${i.scope}, seen ${i.support.length}×, contradicted ${i.contradict.length}×)`);
  }
  return lines.join('\n');
}

/** What the learner's own tests said, per task: facts measured by the app (most recent first). */
export function checkpointSummary(events: Parameters<typeof checkpointRuns>[0], projectId: string, max = 10): string {
  const tasks = [...checkpointRuns(events, projectId).entries()].sort(([, a], [, b]) => b.runs.at(-1)!.at.localeCompare(a.runs.at(-1)!.at)).slice(0, max);
  if (tasks.length === 0) return 'No checkpoint runs yet.';
  return tasks
    .map(([key, t]) => {
      const last = t.runs.at(-1)!;
      const result = last.counts ? `${last.counts.passed}/${last.counts.total} passing` : last.timedOut ? 'timed out' : 'no readable summary';
      const failing = last.failures.length ? `; failing: ${last.failures.slice(0, 5).join(', ')}${last.failures.length > 5 ? ', …' : ''}` : '';
      return `- ${key}: ${t.runs.length} run(s), last ${result} (expects ${last.expect.passed}/${last.expect.of})${t.reached ? ', reached' : ''}${failing}`;
    })
    .join('\n');
}

/** Hints given per task so far, and what the ladder allows next (pedagogy-model §6). */
export function hintSummary(events: Parameters<typeof hintStates>[0], projectId: string, max = 10): string {
  const tasks = [...hintStates(events, projectId).entries()].slice(-max);
  if (tasks.length === 0) return 'No hints given yet. Before any hint on a task, call record_hint with its level.';
  return tasks
    .map(([key, h]) => {
      const next = h.max >= 5 ? 'top of the ladder' : h.max + 1 >= GATED_FROM && !h.attemptSince ? `L${h.max + 1} needs a new attempt first` : `next may be L${h.max + 1}`;
      return `- ${key}: ${h.levels.map((l) => `L${l}`).join(', ')}${h.attemptSince ? ' (tried again since)' : ''}; ${next}`;
    })
    .join('\n');
}

/** Skills due for review, for the next warm-up: asked again with new questions, never copies (roadmap 1.10). */
export function reviewSummary(r: ProjectReviews, max = 8): string {
  if (r.dueCount === 0) return r.nextDue ? `Nothing due. Next skill due ${r.nextDue.slice(0, 10)}.` : 'Nothing answered yet, so nothing to review.';
  const lines = r.due.slice(0, max).map((d) => `- ${d.kc} (${d.title}, recall ≈ ${Math.round(d.retrievability * 100)}%)`);
  return [
    `${r.dueCount} skill(s) due. The app schedules skills, not questions: any answer on a skill reviews it. Ask 2–4 of the most at risk in the next lesson's warm-up, each with a new question (another angle or situation than before, never a copy of an earlier item):`,
    ...lines,
  ].join('\n');
}

/** The project's plan and where each planned lesson stands, so the tutor continues it instead of starting over. */
export function curriculumSummary(curriculum: Curriculum | undefined, lessons: readonly string[], map: SkillMap, hasAssessment: boolean): string {
  const lines: string[] = [];
  const suggestions = Object.values(map.skills).filter((s) => s.suggested).length;
  lines.push(
    `Skill map: ${Object.keys(map.skills).length} skill(s) in ${Object.keys(map.groups).length} group(s), ${suggestions} suggestion(s). Read it with get_skill_map.`,
    hasAssessment ? 'Interview: done (assessment saved).' : 'Interview: not done yet. Run it, then save_assessment.',
  );
  if (!curriculum) {
    lines.push('No curriculum yet: describe the skills with update_skill_map, then set the goals and plan with set_curriculum.');
    return lines.join('\n');
  }
  lines.push(`Goals: ${curriculum.goals.join(', ')}`, 'Plan:');
  const written = new Set(lessons);
  let next = true;
  curriculum.plan.forEach((p, i) => {
    const done = p.lessonId !== undefined && written.has(p.lessonId);
    const mark = done ? `written as ${p.lessonId}` : next ? 'NEXT' : 'later';
    if (!done) next = false;
    lines.push(`${i + 1}. [${mark}] ${p.title} (${p.kcs.join(', ')})${p.capability ? `: ${p.capability}` : ''}`);
  });
  return lines.join('\n');
}

/** The imported files, newest last, so the tutor knows what it can read. */
export function sourcesSummary(sources: SourcesDoc['sources'], max = 30): string {
  const list = Object.entries(sources).sort(([, a], [, b]) => a.addedAt.localeCompare(b.addedAt));
  if (list.length === 0) return 'None.';
  const lines = list.slice(-max).map(([id, s]) => `- ${id}: "${s.name}" (${s.kind}${s.pages ? `, ${s.pages} pages` : ''})`);
  return [...(list.length > max ? [`(${list.length - max} older files not listed; see list_sources)`] : []), ...lines].join('\n');
}

export async function teachingContext(ctx: TeacherContext): Promise<string> {
  const now = ctx.profile.journal.now();
  const state = deriveLearnerState(ctx.profile.journal.events, now);
  const project = await ctx.profile.changes.read(projectTarget(ctx.projectId));
  const lessons = lessonIds(ctx.profile.changes, ctx.projectId);
  const reviews = await projectReviews(ctx.profile, ctx.projectId, now);
  const curriculum = curriculumDoc.safeParse(await ctx.profile.changes.read(curriculumTarget(ctx.projectId)));
  const hasAssessment = (await ctx.profile.changes.read(assessmentTarget(ctx.projectId))) !== null;
  const map = await readSkillMap(ctx.profile.changes);
  const access = await projectAccess(ctx.profile.changes, ctx.projectId);
  return [
    `# Project`,
    project === null ? '(project details not set)' : JSON.stringify(project, null, 2),
    '',
    `# Lessons so far`,
    lessons.length ? lessons.map((l) => `- ${l}`).join('\n') : 'None yet.',
    '',
    `# What the learner allows you to do in their workspace`,
    access.workspace ? describePermissions(access.permissions) : 'No workspace folder: you can read imported files, nothing else.',
    '',
    `# Imported files (read with read_source, search with search_sources)`,
    sourcesSummary(await readSources(ctx.profile, ctx.projectId)),
    '',
    `# Roadmap (the milestones of the project; change it with update_roadmap)`,
    describeRoadmap(await readRoadmap(ctx.profile.changes, ctx.projectId)),
    '',
    `# Curriculum`,
    curriculumSummary(curriculum.success ? curriculum.data : undefined, lessons, map, hasAssessment),
    '',
    `# Learner`,
    learnerSummary(state),
    '',
    `# Checkpoints (the learner's tests, run by the app)`,
    checkpointSummary(ctx.profile.journal.events, ctx.projectId),
    '',
    `# Hints given (the hint ladder, checked by the app)`,
    hintSummary(ctx.profile.journal.events, ctx.projectId),
    '',
    `# Due for review (scheduled by the app)`,
    reviewSummary(reviews),
    '',
    `# Changes`,
    `The learner is in "${ctx.changeMode()}" mode: ${ctx.changeMode() === 'review' ? 'your lesson drafts and revisions wait for their approval' : 'your changes apply immediately (still undoable)'}.`,
  ].join('\n');
}
