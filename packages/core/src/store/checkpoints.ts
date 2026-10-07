import { difficultyFromLevel } from '../learner/params.ts';
import type { Author, CheckpointEvent, LogEvent } from './schemas.ts';
import type { Journal } from './journal.ts';
import { maxHintLevel } from './hints.ts';

export type CheckpointRun = Omit<CheckpointEvent, 'type' | 'id' | 'at' | 'author'>;

export interface TaskCheckpoints {
  readonly taskId: string;
  /** Every run, oldest first. */
  readonly runs: readonly CheckpointEvent[];
  /** The expected count was reached at least once. */
  readonly reached: boolean;
}

/** Checkpoint runs of one lesson (or a whole project), grouped by task, in log order. */
export function checkpointRuns(events: readonly LogEvent[], projectId: string, lessonId?: string): Map<string, TaskCheckpoints> {
  const out = new Map<string, { taskId: string; runs: CheckpointEvent[]; reached: boolean }>();
  for (const e of events) {
    if (e.type !== 'checkpoint' || e.projectId !== projectId || (lessonId !== undefined && e.lessonId !== lessonId)) continue;
    const key = lessonId === undefined ? `${e.lessonId}/${e.taskId}` : e.taskId;
    const entry = out.get(key) ?? { taskId: e.taskId, runs: [], reached: false };
    entry.runs.push(e);
    entry.reached ||= e.reached;
    out.set(key, entry);
  }
  return out;
}

/** The evidence item id of a task's checkpoint. */
export const checkpointItemId = (lessonId: string, taskId: string) => `${lessonId}/${taskId}`;

/**
 * Records checkpoint runs. Reaching a step's expected count is evidence on the task's skills,
 * recorded once per task: earlier runs on the way are work in progress, not failures (a test
 * suite is run before the code is written, and while it is half written). The runs themselves
 * stay in the journal for the ladder and for the tutor.
 */
export class Checkpoints {
  readonly journal: Journal;
  constructor(journal: Journal) {
    this.journal = journal;
  }

  record(author: Author, run: CheckpointRun, kcs: readonly string[]): Promise<CheckpointEvent> {
    return this.journal.exclusive(async () => {
      const before = checkpointRuns(this.journal.events, run.projectId, run.lessonId).get(run.taskId);
      const event = (await this.journal.append({ type: 'checkpoint', author, ...run })) as CheckpointEvent;
      if (run.reached && !before?.reached && kcs.length > 0) {
        await this.journal.append({
          type: 'evidence',
          author,
          itemId: checkpointItemId(run.lessonId, run.taskId),
          projectId: run.projectId,
          kcs: kcs.slice(0, 8).map((kc) => ({ kc, weight: 1 })),
          difficulty: difficultyFromLevel(3),
          evidenceType: 'checkpoint',
          outcome: 1,
          // Reached with hints: credit is reduced by the highest one given (W4).
          hintLevel: maxHintLevel(this.journal.events, run.projectId, run.lessonId, run.taskId),
          note: `checkpoint ${run.counts ? `${run.counts.passed}/${run.counts.total}` : ''} reached (expected ${run.expect.passed}/${run.expect.of}) after ${(before?.runs.length ?? 0) + 1} run(s)`,
        });
      }
      return event;
    });
  }
}
