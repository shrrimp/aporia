import { newId } from '../ids.ts';
import { Mutex } from '../mutex.ts';
import { systemClock, type Clock } from '../clock.ts';
import { EventLog, type LogProblem } from './event-log.ts';
import type { Author, LogEvent, LogEventInput } from './schemas.ts';

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
export type Unstamped = DistributiveOmit<LogEventInput, 'id' | 'at'>;

/**
 * The profile's journal: the event log plus an in-memory copy (the core is the only writer),
 * a non-decreasing clock, and a mutex that serialises every write.
 */
export class Journal {
  readonly #log: EventLog;
  readonly #clock: Clock;
  readonly #mutex = new Mutex();
  readonly #events: LogEvent[];
  readonly problems: readonly LogProblem[];
  #lastAt: number;

  private constructor(log: EventLog, clock: Clock, events: LogEvent[], problems: LogProblem[]) {
    this.#log = log;
    this.#clock = clock;
    this.#events = events;
    this.problems = problems;
    this.#lastAt = events.reduce((max, e) => Math.max(max, Date.parse(e.at)), 0);
  }

  static async open(dir: string, clock: Clock = systemClock): Promise<Journal> {
    const log = new EventLog(dir);
    const { events, problems } = await log.readAll();
    return new Journal(log, clock, events, problems);
  }

  get events(): readonly LogEvent[] {
    return this.#events;
  }

  /** Run a critical section; all writes must happen inside one. */
  exclusive<T>(fn: () => Promise<T>): Promise<T> {
    return this.#mutex.run(fn);
  }

  /** Stamp (id, non-decreasing time), validate and append. Call inside {@link exclusive}. */
  async append(input: Unstamped): Promise<LogEvent> {
    const ms = Math.max(this.#clock.now().getTime(), this.#lastAt);
    const event = await this.#log.append({ ...input, id: newId('ev', ms), at: new Date(ms).toISOString() } as LogEventInput);
    this.#lastAt = ms;
    this.#events.push(event);
    return event;
  }

  now(): Date {
    return new Date(Math.max(this.#clock.now().getTime(), this.#lastAt));
  }
}

export interface HistoryFilter {
  readonly authorKind?: Author['kind'];
  readonly agent?: string;
  readonly model?: string;
  readonly session?: string;
  /** Inclusive ISO bounds. */
  readonly since?: string;
  readonly until?: string;
}

export function matchesFilter(event: LogEvent, f: HistoryFilter): boolean {
  const a = event.author;
  return (
    (f.authorKind === undefined || a.kind === f.authorKind) &&
    (f.agent === undefined || a.agent === f.agent) &&
    (f.model === undefined || a.model === f.model) &&
    (f.session === undefined || a.session === f.session) &&
    (f.since === undefined || event.at >= f.since) &&
    (f.until === undefined || event.at <= f.until)
  );
}
