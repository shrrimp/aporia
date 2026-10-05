import { mkdir, open, readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { logEvent, type LogEvent, type LogEventInput } from './schemas.ts';

export interface LogProblem {
  readonly file: string;
  readonly line: number;
  readonly message: string;
}

export interface LogReadResult {
  readonly events: LogEvent[];
  /** Lines that could not be read. Reported, never silently dropped. */
  readonly problems: LogProblem[];
}

const MONTH_FILE = /^\d{4}-\d{2}\.jsonl$/;

/**
 * Append-only event log, one JSONL file per month. The source of truth for everything
 * derived about a learner. Writes are fsynced; a torn last line (crash mid-append) is
 * detected on read and reported, and the next append starts on a fresh line.
 *
 * Order is append order (month files by name, then line order). Callers must stamp events
 * with a non-decreasing clock; {@link Journal} does this.
 */
export class EventLog {
  readonly dir: string;
  constructor(dir: string) {
    this.dir = dir;
  }

  fileFor(at: string): string {
    return path.join(this.dir, `${at.slice(0, 7)}.jsonl`);
  }

  async append(input: LogEventInput): Promise<LogEvent> {
    const event = logEvent.parse(input);
    await mkdir(this.dir, { recursive: true });
    const file = this.fileFor(event.at);
    const handle = await open(file, 'a+');
    try {
      const { size } = await handle.stat();
      let prefix = '';
      if (size > 0) {
        const last = Buffer.alloc(1);
        await handle.read(last, 0, 1, size - 1);
        if (last[0] !== 0x0a) prefix = '\n';
      }
      await handle.appendFile(`${prefix}${JSON.stringify(event)}\n`);
      await handle.sync();
    } finally {
      await handle.close();
    }
    return event;
  }

  async readAll(): Promise<LogReadResult> {
    let names: string[];
    try {
      names = (await readdir(this.dir)).filter((n) => MONTH_FILE.test(n)).sort();
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { events: [], problems: [] };
      throw err;
    }
    const events: LogEvent[] = [];
    const problems: LogProblem[] = [];
    for (const name of names) {
      const file = path.join(this.dir, name);
      const lines = (await readFile(file, 'utf8')).split('\n');
      lines.forEach((text, i) => {
        if (text.trim() === '') return;
        try {
          const parsed = logEvent.safeParse(JSON.parse(text));
          if (parsed.success) events.push(parsed.data);
          else problems.push({ file, line: i + 1, message: parsed.error.message });
        } catch (err) {
          problems.push({ file, line: i + 1, message: `invalid JSON: ${(err as Error).message}` });
        }
      });
    }
    return { events, problems };
  }
}
