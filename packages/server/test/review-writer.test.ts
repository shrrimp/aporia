import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ReviewMode } from '@app/teacher-mcp';
import { ReviewWriter, type WriterDeps } from '../src/review-writer.ts';

afterEach(() => vi.useRealTimers());

function setup(mode: ReviewMode = 'pool', needs: string[] = ['a', 'b', 'c'], opts: ConstructorParameters<typeof ReviewWriter>[1] = {}) {
  const writes: [string, readonly string[]][] = [];
  const changes: string[] = [];
  const logs: string[] = [];
  let release: (() => void) | undefined;
  const deps: WriterDeps & { setMode(m: ReviewMode): void; hold(): void; fail?: Error } = {
    mode: () => mode,
    setMode: (m) => (mode = m),
    needs: async () => needs,
    write: async (projectId, kcs) => {
      writes.push([projectId, kcs]);
      if (deps.fail) throw deps.fail;
      if (release === undefined) return;
      // Held once: this job waits for release(), the next ones do not.
      await new Promise<void>((r) => (release = r));
      release = undefined;
    },
    onChange: (projectId) => changes.push(projectId),
    log: (m) => logs.push(m),
    hold: () => (release = () => undefined),
  };
  let t = 0;
  const writer = new ReviewWriter(deps, { debounceMs: 20, retryMs: 1000, perJob: 2, now: () => t, ...opts });
  return { writer, deps, writes, changes, logs, tick: (ms: number) => (t += ms), release: () => release?.() };
}

describe('the review-question writer', () => {
  it('waits for a burst of answers to end, then writes for a few skills at a time', async () => {
    vi.useFakeTimers();
    const { writer, writes, changes } = setup();
    writer.request('p', 'answer');
    writer.request('p', 'answer');
    expect(writes).toEqual([]);
    await vi.advanceTimersByTimeAsync(25);
    await writer.idle();
    expect(writes).toEqual([['p', ['a', 'b']]]);
    expect(changes).toEqual(['p', 'p']); // writing, then done
    expect(writer.writing('p')).toBe(false);
  });

  it('acts on what the learner chose: "when due" never writes ahead', async () => {
    const { writer, deps, writes } = setup('when-due');
    writer.request('p', 'answer');
    await writer.idle();
    expect(writes).toEqual([]);
    writer.request('p', 'open', ['a']);
    expect(writer.writing('p')).toBe(true);
    await writer.idle();
    expect(writes).toEqual([['p', ['a']]]);
    deps.setMode('numbers');
    writer.request('q', 'flag');
    await writer.idle();
    expect(writes.at(-1)).toEqual(['q', ['a', 'b']]);
  });

  it('runs one job per project, looks again after it, and does not ask about a skill twice in a row', async () => {
    const { writer, deps, writes, tick, release } = setup();
    deps.hold();
    writer.request('p', 'open');
    await vi.waitFor(() => expect(writes).toHaveLength(1));
    writer.request('p', 'open'); // during the job: looked at once it ends
    release();
    await writer.idle();
    // a and b were just asked about; c was not.
    expect(writes).toEqual([
      ['p', ['a', 'b']],
      ['p', ['c']],
    ]);
    writer.request('p', 'open');
    await writer.idle();
    expect(writes).toHaveLength(2);
    tick(1000);
    writer.request('p', 'open');
    await writer.idle();
    expect(writes.at(-1)).toEqual(['p', ['a', 'b']]);
  });

  it('logs a job that fails, and stops on close', async () => {
    vi.useFakeTimers();
    const { writer, deps, writes, logs } = setup();
    deps.fail = new Error('not logged in');
    writer.request('p', 'flag');
    await writer.idle();
    expect(logs).toEqual(['could not write review questions: not logged in']);
    writer.request('p', 'answer');
    writer.close();
    await vi.advanceTimersByTimeAsync(50);
    writer.request('p', 'open');
    await writer.idle();
    expect(writes).toHaveLength(1);
  });

  it('does nothing when no skill needs questions', async () => {
    const { writer, writes, changes } = setup('pool', []);
    writer.request('p', 'open');
    await writer.idle();
    expect(writes).toEqual([]);
    expect(changes).toEqual([]);
  });
});
