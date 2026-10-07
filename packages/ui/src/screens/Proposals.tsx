import { useState } from 'react';
import { useQuery, useRpc } from '../hooks.tsx';
import { folded, lineDiff } from '../diff.ts';

/** What a change touches, in words ("lesson hmp-09-four-numbers", "the roadmap"). */
export function describeTarget(target: string | undefined): string {
  if (!target) return 'a change';
  const lesson = /lessons\/([^/]+)\.json$/.exec(target);
  if (lesson) return `lesson “${lesson[1]}”`;
  if (/project\.json$/.test(target)) return 'project settings';
  if (/\/agent-files\//.test(target)) return 'a file in your workspace';
  if (/roadmap\.json$/.test(target)) return 'the roadmap';
  if (/curriculum\.json$/.test(target)) return 'the lesson plan';
  if (/assessment\.json$/.test(target)) return 'what the interview found';
  if (/sources\.json$/.test(target)) return 'imported files';
  if (target === 'learner/skills.json') return 'your skill map';
  return target;
}

/** What a proposed change would do: a line diff for a file, before/after for a document. */
export function ChangeDiff({ id }: { id: string }) {
  const diff = useQuery('history.diff', { id });
  if (diff.error) return <p className="error">{diff.error.message}</p>;
  if (!diff.data) return <p className="quiet">Loading…</p>;
  const d = diff.data;
  const before = d.kind === 'file' ? (d.before ?? '') : d.before === null ? '' : JSON.stringify(d.before, null, 2);
  const after = d.kind === 'file' ? (d.after ?? '') : d.after === null ? '' : JSON.stringify(d.after, null, 2);
  return (
    <div className="change-diff">
      {d.kind === 'file' && (
        <p className="quiet">
          <code>{d.path}</code> {d.before === null ? '(a new file)' : d.after === null ? '(removed)' : ''}
        </p>
      )}
      <pre aria-label="Changes">
        {folded(lineDiff(before, after)).map((l, i) => (
          <span key={i} className={`dl op-${l.op === '+' ? 'add' : l.op === '-' ? 'del' : l.op === '…' ? 'skip' : 'same'}`}>
            {l.op === '…' ? `… ${l.text}` : `${l.op} ${l.text}`}
            {'\n'}
          </span>
        ))}
      </pre>
    </div>
  );
}

/**
 * Whether a change belongs where it is shown: in a project, its own documents and the profile's
 * (the skill map, the learner model), never another project's.
 */
export function concerns(target: string | undefined, projectId: string | undefined): boolean {
  if (projectId === undefined || target === undefined) return true;
  return !target.startsWith('projects/') || target.startsWith(`projects/${projectId}/`);
}

/** "Show the change", loaded only when opened. */
export function ShowChange({ id }: { id: string }) {
  const [open, setOpen] = useState(false);
  return (
    <details onToggle={(e) => setOpen((e.currentTarget as HTMLDetailsElement).open)}>
      <summary>Show the change</summary>
      {open && <ChangeDiff id={id} />}
    </details>
  );
}

/**
 * Changes the tutor proposed and that wait for the learner, shown where the conversation
 * happens. Nothing is applied until the learner accepts; everything stays undoable in History.
 */
export function Proposals({ projectId }: { projectId?: string | undefined } = {}) {
  const rpc = useRpc();
  const history = useQuery('history.list', { filter: {} }, ['history']);
  const [error, setError] = useState<string>();
  const pending = (history.data ?? []).filter((h) => h.status === 'proposed' && concerns(h.target, projectId));
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
            <ShowChange id={p.id} />
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
