import type { ReviewMode } from '@app/teacher-mcp';

/** What asks for a check: an answer (in a lesson or a review), opening the Review page, or a question flagged as making no sense. */
export type Trigger = 'answer' | 'open' | 'flag';

/** Which of them each setting acts on: "when due" writes only for a learner who is reviewing. */
const ACTS: Record<ReviewMode, ReadonlySet<Trigger>> = {
  pool: new Set(['answer', 'open', 'flag']),
  'when-due': new Set(['open', 'flag']),
  numbers: new Set(['answer', 'open', 'flag']),
};

export interface WriterDeps {
  mode(): ReviewMode;
  /** The skills of a project that need new questions, most urgent first. */
  needs(projectId: string): Promise<readonly string[]>;
  /** Have the tutor write questions on `kcs`: one turn, in a session of its own. */
  write(projectId: string, kcs: readonly string[]): Promise<void>;
  /** Writing started or stopped in a project. */
  onChange(projectId: string): void;
  log(message: string): void;
}

export interface WriterOptions {
  /** Answers come in bursts: wait this long after the last one. */
  readonly debounceMs?: number;
  /** A skill the tutor was asked about is not asked about again before this. */
  readonly retryMs?: number;
  /** Skills per job, so one turn stays short. */
  readonly perJob?: number;
  readonly now?: () => number;
}

/**
 * Keeps each project's review questions stocked, in the background (roadmap 1.10): one job per
 * project at a time, and a request during a job is looked at once it ends. A skill the tutor was
 * just asked about waits `retryMs` before it is asked about again, so an agent that cannot help
 * (logged out, or writing nothing usable) is never called in a loop.
 */
export class ReviewWriter {
  readonly #deps: WriterDeps;
  readonly #debounceMs: number;
  readonly #retryMs: number;
  readonly #perJob: number;
  readonly #now: () => number;
  readonly #running = new Map<string, Promise<void>>();
  readonly #writing = new Set<string>();
  readonly #again = new Set<string>();
  readonly #timers = new Map<string, ReturnType<typeof setTimeout>>();
  readonly #asked = new Map<string, number>();
  #closed = false;

  constructor(deps: WriterDeps, opts: WriterOptions = {}) {
    this.#deps = deps;
    this.#debounceMs = opts.debounceMs ?? 15_000;
    this.#retryMs = opts.retryMs ?? 10 * 60_000;
    this.#perJob = opts.perJob ?? 6;
    this.#now = opts.now ?? Date.now;
  }

  /** Whether the tutor is writing questions for this project now. */
  writing(projectId: string): boolean {
    return this.#writing.has(projectId);
  }

  /**
   * Look at a project's questions after `trigger`, if the learner's setting acts on it. `needs`,
   * when the caller already knows them, lets the job (and `writing`) start at once.
   */
  request(projectId: string, trigger: Trigger, needs?: readonly string[]): void {
    if (this.#closed || !ACTS[this.#deps.mode()].has(trigger)) return;
    clearTimeout(this.#timers.get(projectId));
    if (trigger === 'answer') {
      this.#timers.set(
        projectId,
        setTimeout(() => {
          this.#timers.delete(projectId);
          this.#start(projectId);
        }, this.#debounceMs),
      );
      return;
    }
    this.#timers.delete(projectId);
    this.#start(projectId, needs);
  }

  #start(projectId: string, needs?: readonly string[]): void {
    if (this.#running.has(projectId)) {
      this.#again.add(projectId);
      return;
    }
    const job = this.#run(projectId, needs)
      .catch((err: unknown) => this.#deps.log(`could not write review questions: ${(err as Error).message}`))
      .finally(() => {
        this.#running.delete(projectId);
        if (this.#writing.delete(projectId)) this.#deps.onChange(projectId);
        if (this.#again.delete(projectId) && !this.#closed) this.#start(projectId);
      });
    this.#running.set(projectId, job);
  }

  /** Picks the skills to write for, marks the project as writing (before any await, when `needs` is known), then writes. */
  #run(projectId: string, needs: readonly string[] | undefined): Promise<void> {
    const go = (all: readonly string[]): Promise<void> => {
      const now = this.#now();
      const kcs = all.filter((kc) => now - (this.#asked.get(`${projectId}/${kc}`) ?? -Infinity) >= this.#retryMs).slice(0, this.#perJob);
      if (kcs.length === 0 || this.#closed) return Promise.resolve();
      for (const kc of kcs) this.#asked.set(`${projectId}/${kc}`, now);
      this.#writing.add(projectId);
      this.#deps.onChange(projectId);
      return this.#deps.write(projectId, kcs);
    };
    return needs ? go(needs) : this.#deps.needs(projectId).then(go);
  }

  /** Wait until no job is waiting or running (tests). */
  async idle(): Promise<void> {
    while (this.#running.size > 0 || this.#timers.size > 0) {
      if (this.#running.size > 0) await Promise.allSettled([...this.#running.values()]);
      else await new Promise((r) => setTimeout(r, Math.min(this.#debounceMs, 50)));
    }
  }

  /** Stop: no new jobs start (the ones running end with the agent). */
  close(): void {
    this.#closed = true;
    for (const t of this.#timers.values()) clearTimeout(t);
    this.#timers.clear();
  }
}
