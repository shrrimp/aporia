import { createContext, useContext, useState } from 'react';
import type { CheckpointRunDTO, CheckpointsDTO, Results } from '@app/server/protocol';

export type RunResult = Results['checkpoints.run'];

/** Checkpoints of the open lesson, and how to run them. Absent outside a project (e.g. tests of a bare lesson). */
export interface CheckpointActions {
  readonly data: CheckpointsDTO | undefined;
  run(taskId: string): Promise<RunResult>;
  cancel(): void;
}

export const CheckpointContext = createContext<CheckpointActions | undefined>(undefined);

const seconds = (ms: number) => (ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)} s`);

function describe(r: CheckpointRunDTO): string {
  if (r.timedOut) return 'Stopped: the tests ran too long.';
  if (!r.counts) return `Finished (exit code ${r.exitCode ?? 'none'}), but the app could not find a test summary in the output.`;
  return `${r.counts.passed} of ${r.counts.total} passing`;
}

/**
 * The checkpoint of one task: the expected count, a Run button, and the ladder of runs so far
 * ("100 → 112 → 121 ✓"). Failing tests are named, never fixed.
 */
export function Checkpoint({ taskId, suite, expect }: { taskId: string; suite: string; expect: { passed: number; of: number } }) {
  const cp = useContext(CheckpointContext);
  const [result, setResult] = useState<RunResult>();
  const [error, setError] = useState<string>();
  const task = cp?.data?.tasks[taskId];
  const running = cp?.data?.running === taskId;
  const busyElsewhere = cp?.data?.running !== undefined && !running;
  const latest = result && !result.cancelled ? result : task?.recent.at(-1);
  const ladder = (task?.recent ?? []).filter((r) => r.counts);

  const run = async () => {
    setError(undefined);
    try {
      setResult(await cp!.run(taskId));
    } catch (err) {
      setError((err as Error).message);
    }
  };

  return (
    <div className={`checkpoint ${task?.reached ? 'reached' : ''}`}>
      <p className="checkpoint-goal">
        <span className="counter num">
          {expect.passed} / {expect.of}
        </span>
        <span>
          checks in <code>{suite}</code> should pass when this step is done.
        </span>
      </p>
      {cp?.data && !cp.data.runnable && <p className="quiet">{cp.data.reason} Set it in the project settings to run checkpoints here.</p>}
      {cp?.data?.runnable && (
        <div className="checkpoint-run">
          {running ? (
            <button type="button" onClick={() => cp.cancel()}>
              Stop
            </button>
          ) : (
            <button type="button" disabled={busyElsewhere} onClick={() => void run()} title={busyElsewhere ? 'Another checkpoint is running' : undefined}>
              Run checkpoint
            </button>
          )}
          {running && <span className="status">running your tests…</span>}
          {ladder.length > 0 && (
            <ol className="ladder" aria-label="Your runs, oldest first">
              {ladder.map((r) => (
                <li key={r.id} className={r.reached ? 'reached' : ''}>
                  <span className="num">{r.counts!.passed}</span>
                </li>
              ))}
            </ol>
          )}
        </div>
      )}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {result?.cancelled && <p className="quiet">Stopped. Nothing was recorded.</p>}
      {latest && !running && (
        <div className="checkpoint-result" role="status">
          <p>
            <strong>{describe(latest)}</strong>
            {latest.counts && (latest.reached ? <span className="good"> · this step is reached.</span> : <span> · this step expects {expect.passed}.</span>)}
            <span className="quiet"> {seconds(latest.durationMs)}</span>
          </p>
          {latest.failures.length > 0 && (
            <details>
              <summary>Failing ({latest.failures.length})</summary>
              <ul className="failures">
                {latest.failures.map((f) => (
                  <li key={f}>
                    <code>{f}</code>
                  </li>
                ))}
              </ul>
            </details>
          )}
          {result && result.id === latest.id && result.output && (
            <details>
              <summary>Test output{result.truncated ? ' (the end of it)' : ''}</summary>
              <pre className="test-output">{result.output}</pre>
            </details>
          )}
        </div>
      )}
    </div>
  );
}
