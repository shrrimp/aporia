import { spawn } from 'node:child_process';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import { CommandError } from './command.ts';

export interface RunOptions {
  readonly argv: readonly string[];
  /** Absolute directory the command runs in (the learner's workspace). */
  readonly cwd: string;
  readonly timeoutMs: number;
  /** Bytes of output kept (the end of it: summaries come last). */
  readonly maxOutput: number;
  readonly env?: NodeJS.ProcessEnv;
  readonly signal?: AbortSignal;
}

export interface RunResult {
  /** null when the process was killed. */
  readonly exitCode: number | null;
  readonly timedOut: boolean;
  readonly cancelled: boolean;
  /** stdout and stderr interleaved as they arrived; the last `maxOutput` bytes. */
  readonly output: string;
  readonly truncated: boolean;
  readonly durationMs: number;
}

/** Keeps the last `max` bytes written to it. */
class Tail {
  readonly #max: number;
  #chunks: Buffer[] = [];
  #size = 0;
  truncated = false;
  constructor(max: number) {
    this.#max = max;
  }
  push(b: Buffer): void {
    this.#chunks.push(b);
    this.#size += b.length;
    if (this.#size > 2 * this.#max) this.#compact();
  }
  #compact(): void {
    const all = Buffer.concat(this.#chunks);
    this.truncated ||= all.length > this.#max;
    const keep = all.subarray(Math.max(0, all.length - this.#max));
    this.#chunks = [keep];
    this.#size = keep.length;
  }
  text(): string {
    this.#compact();
    return this.#chunks[0]!.toString('utf8');
  }
}

/**
 * Run the learner's test command: no shell, no stdin, bounded time and output. On POSIX the
 * command gets its own process group, so a timeout or cancel also stops the test binaries it
 * started.
 */
export async function runCommand(opts: RunOptions): Promise<RunResult> {
  if (!path.isAbsolute(opts.cwd)) throw new CommandError(`the workspace must be an absolute path: ${opts.cwd}`);
  const info = await stat(opts.cwd).catch(() => undefined);
  if (!info?.isDirectory()) throw new CommandError(`the workspace folder does not exist: ${opts.cwd}`);
  const [command, ...args] = opts.argv;
  if (command === undefined) throw new CommandError('the test command is empty');
  if (opts.signal?.aborted) return { exitCode: null, timedOut: false, cancelled: true, output: '', truncated: false, durationMs: 0 };

  const started = performance.now();
  const tail = new Tail(opts.maxOutput);
  const posix = process.platform !== 'win32';
  // Windows: .cmd/.bat launchers need a shell, which this runner never uses; point the
  // command at the real executable (e.g. node.exe, ctest.exe) instead.
  const child = spawn(command, args, {
    cwd: opts.cwd,
    env: { ...(opts.env ?? process.env), NO_COLOR: '1', FORCE_COLOR: '0' },
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: false,
    detached: posix,
    windowsHide: true,
  });
  let timedOut = false;
  let cancelled = false;
  const kill = () => {
    // POSIX: the whole process group, so the test binaries the command started stop too.
    /* v8 ignore next */
    if (!posix || child.pid === undefined) return void child.kill('SIGKILL');
    try {
      process.kill(-child.pid, 'SIGKILL');
    } catch {
      // the group already exited
    }
  };
  const timer = setTimeout(() => {
    timedOut = true;
    kill();
  }, opts.timeoutMs);
  const onAbort = () => {
    cancelled = true;
    kill();
  };
  opts.signal?.addEventListener('abort', onAbort, { once: true });
  child.stdout.on('data', (b: Buffer) => tail.push(b));
  child.stderr.on('data', (b: Buffer) => tail.push(b));

  try {
    const exitCode = await new Promise<number | null>((resolve, reject) => {
      child.once('error', (err: NodeJS.ErrnoException) =>
        reject(err.code === 'ENOENT' ? new CommandError(`"${command}" was not found. Is it installed and on your PATH?`) : err),
      );
      child.once('close', (code) => resolve(code));
    });
    return {
      exitCode,
      timedOut,
      cancelled,
      output: tail.text(),
      truncated: tail.truncated,
      durationMs: Math.round(performance.now() - started),
    };
  } finally {
    clearTimeout(timer);
    opts.signal?.removeEventListener('abort', onAbort);
  }
}
