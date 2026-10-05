import { useState } from 'react';
import { useQuery, useRpc } from '../hooks.tsx';

/** What a change touches, in words ("lesson hmp-09-four-numbers", "your project"). */
function describeTarget(target: string | undefined): string {
  if (!target) return 'a change';
  const lesson = /lessons\/([^/]+)\.json$/.exec(target);
  if (lesson) return `lesson “${lesson[1]}”`;
  if (/project\.json$/.test(target)) return 'project settings';
  return target;
}

/**
 * Changes the tutor proposed and that wait for the learner, shown where the conversation
 * happens. Nothing is applied until the learner accepts; everything stays undoable in History.
 */
export function Proposals() {
  const rpc = useRpc();
  const history = useQuery('history.list', { filter: {} }, ['history']);
  const [error, setError] = useState<string>();
  const pending = (history.data ?? []).filter((h) => h.status === 'proposed');
  if (pending.length === 0) return null;
  const act = async (f: () => Promise<unknown>) => {
    setError(undefined);
    try {
      await f();
    } catch (err) {
      setError((err as Error).message);
    }
  };
  return (
    <section className="proposals" aria-label="Proposed changes">
      <p className="who">Your tutor proposes</p>
      <ul>
        {pending.map((p) => (
          <li key={p.id}>
            <p className="proposal-text">
              {describeTarget(p.target)} <span className="reason">· {p.summary}</span>
            </p>
            <div className="proposal-actions">
              <button type="button" className="primary" onClick={() => void act(() => rpc.call('history.accept', { id: p.id }))}>
                Accept
              </button>
              <button type="button" onClick={() => void act(() => rpc.call('history.reject', { id: p.id }))}>
                Reject
              </button>
            </div>
          </li>
        ))}
      </ul>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}
