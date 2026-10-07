import type { AttemptEvent, Author, HintEvent, LogEvent } from './schemas.ts';
import type { Journal } from './journal.ts';

/**
 * The hint ladder (pedagogy-model §6): the levels, and the rules code enforces on them. The
 * tutor chooses what to say; the app decides which level it may say it at.
 */
export const HINT_LEVELS = [
  { name: 'Reflect', does: 'ask what they tried and what they expected' },
  { name: 'Point', does: 'name the concept or lesson section that matters' },
  { name: 'Question', does: 'a Socratic question that narrows the search' },
  { name: 'Analogy', does: 'a fully worked analogous example, different in shape from the task' },
  { name: 'Structure', does: 'the outline of their function with the key part left blank' },
  { name: 'Principle', does: 'the exact principle stated plainly, still no code for the task' },
] as const;

/** From this level on, a hint needs an attempt since the previous one (H2). */
export const GATED_FROM = 4;

export interface HintState {
  readonly lessonId: string;
  readonly taskId: string;
  /** Levels given, oldest first. */
  readonly levels: readonly number[];
  readonly max: number;
  /** The learner tried something since the last hint: ran the checkpoint or wrote an attempt. */
  readonly attemptSince: boolean;
  /** The task's files when the last hint was given. */
  readonly files: HintEvent['files'];
}

/** Hint states of a project's tasks, keyed `lessonId/taskId` (one lesson's when `lessonId` is set). */
export function hintStates(events: readonly LogEvent[], projectId: string, lessonId?: string): Map<string, HintState> {
  const out = new Map<string, { lessonId: string; taskId: string; levels: number[]; max: number; attemptSince: boolean; files: HintEvent['files'] }>();
  for (const e of events) {
    if ((e.type !== 'hint' && e.type !== 'attempt' && e.type !== 'checkpoint') || e.projectId !== projectId) continue;
    if (lessonId !== undefined && e.lessonId !== lessonId) continue;
    const key = `${e.lessonId}/${e.taskId}`;
    if (e.type === 'hint') {
      const s = out.get(key) ?? { lessonId: e.lessonId, taskId: e.taskId, levels: [], max: 0, attemptSince: false, files: [] };
      s.levels.push(e.level);
      s.max = Math.max(s.max, e.level);
      s.attemptSince = false;
      s.files = e.files;
      out.set(key, s);
    } else {
      const s = out.get(key);
      if (s) s.attemptSince = true;
    }
  }
  return out;
}

/** The highest hint level given on a task (0 when none). */
export function maxHintLevel(events: readonly LogEvent[], projectId: string, lessonId: string, taskId: string): number {
  return hintStates(events, projectId, lessonId).get(`${lessonId}/${taskId}`)?.max ?? 0;
}

export type HintCheck = { readonly ok: true } | { readonly ok: false; readonly allowed: number; readonly reason: string };

/**
 * May a hint at `level` be given now? Start low (L0 or L1), go up one level at a time, and from
 * L4 only after a new attempt: a checkpoint run, a written attempt, or a change to the task's
 * files (`codeChanged`, which the caller measures). Going back down is always allowed.
 */
export function checkHint(state: HintState | undefined, level: number, codeChanged: boolean): HintCheck {
  if (!state) {
    return level <= 1 ? { ok: true } : { ok: false, allowed: 1, reason: 'Start low: the first hint on a task is L0 or L1.' };
  }
  if (level > state.max + 1) return { ok: false, allowed: state.max + 1, reason: `One level at a time: the highest so far is L${state.max}.` };
  if (level >= GATED_FROM && !state.attemptSince && !codeChanged) {
    return {
      ok: false,
      allowed: GATED_FROM - 1,
      reason: `L${GATED_FROM} and above need a new attempt since the last hint: the learner runs the task's checkpoint, changes their code, or writes what they tried.`,
    };
  }
  return { ok: true };
}

export type HintInput = Omit<HintEvent, 'type' | 'id' | 'at' | 'author' | 'files'> & { files?: HintEvent['files'] };
export type AttemptInput = Omit<AttemptEvent, 'type' | 'id' | 'at' | 'author'>;

/** Records hints and attempts. */
export class Hints {
  readonly journal: Journal;
  constructor(journal: Journal) {
    this.journal = journal;
  }

  record(author: Author, input: HintInput): Promise<HintEvent> {
    return this.journal.exclusive(async () => (await this.journal.append({ type: 'hint', author, ...input })) as HintEvent);
  }

  attempt(author: Author, input: AttemptInput): Promise<AttemptEvent> {
    return this.journal.exclusive(async () => (await this.journal.append({ type: 'attempt', author, ...input })) as AttemptEvent);
  }
}
