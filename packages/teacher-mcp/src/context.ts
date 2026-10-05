import { readFileSync } from 'node:fs';
import {
  band,
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

export const lessonsDir = (projectId: string) => `projects/${projectId}/lessons`;
export const lessonTarget = (projectId: string, lessonId: string) => `${lessonsDir(projectId)}/${lessonId}.json`;
export const projectTarget = (projectId: string) => `projects/${projectId}/project.json`;

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

export async function teachingContext(ctx: TeacherContext): Promise<string> {
  const state = deriveLearnerState(ctx.profile.journal.events, ctx.profile.journal.now());
  const project = await ctx.profile.changes.read(projectTarget(ctx.projectId));
  const lessons = ctx.profile.changes
    .list({ status: 'applied' })
    .map((c) => c.target)
    .filter((t, i, all) => t.startsWith(`${lessonsDir(ctx.projectId)}/`) && all.indexOf(t) === i)
    .map((t) => t.slice(lessonsDir(ctx.projectId).length + 1, -'.json'.length));
  return [
    `# Project`,
    project === null ? '(project details not set)' : JSON.stringify(project, null, 2),
    '',
    `# Lessons so far`,
    lessons.length ? lessons.map((l) => `- ${l}`).join('\n') : 'None yet.',
    '',
    `# Learner`,
    learnerSummary(state),
    '',
    `# Changes`,
    `The learner is in "${ctx.changeMode()}" mode: ${ctx.changeMode() === 'review' ? 'your lesson drafts and revisions wait for their approval' : 'your changes apply immediately (still undoable)'}.`,
  ].join('\n');
}
