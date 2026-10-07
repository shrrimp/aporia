import path from 'node:path';
import {
  CommandError,
  checkpointArgv,
  checkpointRuns,
  parseTestOutput,
  runCommand,
  type Author,
  type CheckpointEvent,
  type OpenProfile,
} from '@app/core';
import { lesson as lessonSchema, normalizeLesson, type Lesson } from '@app/catalog';
import { lessonTarget, projectTarget } from '@app/teacher-mcp';
import { AppError } from './errors.ts';
import type { CheckpointRunDTO, CheckpointsDTO, ProjectDTO } from './protocol.ts';

const SYSTEM: Author = { kind: 'system' };
const TIMEOUT_MS = 10 * 60_000;
/** Output kept for parsing (summaries come last) and the part shown to the learner. */
const MAX_OUTPUT = 1024 * 1024;
const SHOWN_OUTPUT = 24_000;
const RUNS_SHOWN = 12;

type Task = Extract<Lesson['sections'][number]['blocks'][number], { type: 'task' }>;

export const runDTO = (e: CheckpointEvent): CheckpointRunDTO => ({
  id: e.id,
  at: e.at,
  ...(e.counts ? { counts: { passed: e.counts.passed, failed: e.counts.failed, total: e.counts.total } } : {}),
  expect: e.expect,
  reached: e.reached,
  exitCode: e.exitCode,
  timedOut: e.timedOut,
  durationMs: e.durationMs,
  failures: e.failures,
});

/**
 * Runs checkpoints for the open profile: the learner's own test command, in their workspace,
 * one run per project at a time. The command is the learner's (never the agent's): a project
 * whose test command was set by anyone else is refused. Results are facts recorded by code.
 */
export class CheckpointRunner {
  readonly #profile: OpenProfile;
  readonly #running = new Map<string, { taskKey: string; abort: AbortController }>();

  constructor(profile: OpenProfile) {
    this.#profile = profile;
  }

  /** Why checkpoints cannot run in this project, or undefined when they can. */
  blocker(project: ProjectDTO): string | undefined {
    if (!project.workspace) return 'This project has no workspace folder.';
    if (!project.testCommand) return 'This project has no test command.';
    if (!path.isAbsolute(project.workspace)) return 'The workspace folder must be an absolute path.';
    const authors = this.#profile.changes.list({ target: projectTarget(project.id) }).filter((c) => c.status === 'applied');
    if (authors.some((c) => c.author.kind === 'agent')) return 'The test command was changed by the tutor, so it is not run. Set it again yourself.';
    return undefined;
  }

  list(project: ProjectDTO, lessonId: string): CheckpointsDTO {
    const blocker = this.blocker(project);
    const running = this.#running.get(project.id)?.taskKey;
    const tasks: Record<string, CheckpointsDTO['tasks'][string]> = {};
    for (const [taskId, t] of checkpointRuns(this.#profile.journal.events, project.id, lessonId)) {
      tasks[taskId] = { reached: t.reached, runs: t.runs.length, recent: t.runs.slice(-RUNS_SHOWN).map(runDTO) };
    }
    return {
      runnable: blocker === undefined,
      ...(blocker ? { reason: blocker } : {}),
      ...(running?.startsWith(`${lessonId}/`) ? { running: running.slice(lessonId.length + 1) } : {}),
      tasks,
    };
  }

  async run(project: ProjectDTO, lessonId: string, taskId: string): Promise<CheckpointRunDTO & { output: string; truncated: boolean }> {
    const blocker = this.blocker(project);
    if (blocker) throw new AppError('conflict', blocker);
    const task = await this.#task(project.id, lessonId, taskId);
    if (!task.checkpoint) throw new AppError('invalid_params', `task "${taskId}" has no checkpoint`);
    if (this.#running.has(project.id)) throw new AppError('conflict', 'A checkpoint is already running in this project.');

    let argv: string[];
    try {
      argv = checkpointArgv(project.testCommand!, task.checkpoint.suite);
    } catch (err) {
      throw new AppError('invalid_params', (err as CommandError).message);
    }
    const abort = new AbortController();
    this.#running.set(project.id, { taskKey: `${lessonId}/${taskId}`, abort });
    try {
      let result;
      try {
        result = await runCommand({ argv, cwd: project.workspace!, timeoutMs: TIMEOUT_MS, maxOutput: MAX_OUTPUT, signal: abort.signal });
      } catch (err) {
        if (err instanceof CommandError) throw new AppError('invalid_params', err.message);
        throw err;
      }
      const shown = result.output.slice(-SHOWN_OUTPUT);
      const truncated = result.truncated || shown.length < result.output.length;
      if (result.cancelled) {
        return { id: '', at: this.#profile.journal.now().toISOString(), expect: task.checkpoint.expect, reached: false, exitCode: null, timedOut: false, durationMs: result.durationMs, failures: [], cancelled: true, output: shown, truncated };
      }
      const counts = parseTestOutput(result.output);
      const event = await this.#profile.checkpoints.record(
        SYSTEM,
        {
          projectId: project.id,
          lessonId,
          taskId,
          suite: task.checkpoint.suite,
          ...(counts ? { counts: { passed: counts.passed, failed: counts.failed, total: counts.total, format: counts.format } } : {}),
          expect: task.checkpoint.expect,
          reached: counts !== undefined && !result.timedOut && counts.passed >= task.checkpoint.expect.passed,
          exitCode: result.exitCode,
          timedOut: result.timedOut,
          durationMs: result.durationMs,
          failures: counts ? [...counts.failures] : [],
        },
        task.kcs,
      );
      return { ...runDTO(event), output: shown, truncated };
    } finally {
      this.#running.delete(project.id);
    }
  }

  cancel(projectId: string): boolean {
    const r = this.#running.get(projectId);
    r?.abort.abort();
    return r !== undefined;
  }

  cancelAll(): void {
    for (const r of this.#running.values()) r.abort.abort();
  }

  async #task(projectId: string, lessonId: string, taskId: string): Promise<Task> {
    const doc = await this.#profile.changes.read(lessonTarget(projectId, lessonId));
    if (doc === null) throw new AppError('not_found', `no lesson ${lessonId}`);
    const parsed = lessonSchema.safeParse(normalizeLesson(doc));
    if (!parsed.success) throw new AppError('conflict', `lesson ${lessonId} could not be read`);
    for (const s of parsed.data.sections) {
      for (const b of s.blocks) if (b.type === 'task' && b.id === taskId) return b;
    }
    throw new AppError('not_found', `no task ${taskId} in lesson ${lessonId}`);
  }
}
