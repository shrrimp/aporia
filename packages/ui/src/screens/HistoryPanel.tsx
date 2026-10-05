import { useState } from 'react';
import type { HistoryItemDTO } from '@app/server/protocol';
import { useQuery, useRpc } from '../hooks.tsx';
import { RpcFailure } from '../rpc.ts';

const who = (a: HistoryItemDTO['author']) => (a.kind === 'agent' ? `${a.agent ?? 'agent'}${a.model ? ` (${a.model})` : ''}` : a.kind === 'learner' ? 'you' : 'the app');

/**
 * Every change and observation, with explicit buttons. There is deliberately no keyboard
 * shortcut for undo here, so typing elsewhere can never trigger it (D4).
 */
export function HistoryPanel() {
  const rpc = useRpc();
  const history = useQuery('history.list', { filter: {} }, ['history', 'learner', 'lessons']);
  const [confirm, setConfirm] = useState<{ id: string; dependants: string[] }>();
  const [error, setError] = useState<string>();
  const run = async (f: () => Promise<unknown>) => {
    setError(undefined);
    try {
      await f();
    } catch (err) {
      if (err instanceof RpcFailure && err.code === 'dependants') return;
      setError((err as Error).message);
    }
  };
  const undo = (id: string) =>
    run(async () => {
      try {
        await rpc.call('history.undo', { id });
      } catch (err) {
        if (err instanceof RpcFailure && err.code === 'dependants') setConfirm({ id, dependants: (err.data as { dependants: string[] }).dependants });
        throw err;
      }
    });
  const items = history.data ?? [];
  const pending = items.filter((i) => i.status === 'proposed');
  return (
    <section className="history" aria-label="History">
      <h2>History</h2>
      {pending.length > 0 && <p className="pending-count">{pending.length} change(s) waiting for your review</p>}
      {confirm && (
        <div className="confirm" role="alertdialog" aria-label="Undo later changes too?">
          <p>{confirm.dependants.length} later change(s) build on this one. Undo them too?</p>
          <button type="button" onClick={() => run(async () => { await rpc.call('history.undo', { id: confirm.id, withDependants: true }); setConfirm(undefined); })}>
            Undo all {confirm.dependants.length + 1}
          </button>
          <button type="button" onClick={() => setConfirm(undefined)}>Cancel</button>
        </div>
      )}
      {error && <p className="error" role="alert">{error}</p>}
      <ol>
        {items.map((h) => (
          <li key={h.id} className={`history-item status-${h.status}`}>
            <p className="summary">{h.summary}</p>
            <p className="meta">
              {new Date(h.at).toLocaleString()} · {who(h.author)} · <span className="status">{h.status}</span>
            </p>
            <div className="buttons">
              {h.status === 'proposed' && (
                <>
                  <button type="button" onClick={() => run(() => rpc.call('history.accept', { id: h.id }))}>Accept</button>
                  <button type="button" onClick={() => run(() => rpc.call('history.reject', { id: h.id }))}>Reject</button>
                </>
              )}
              {(h.status === 'applied' || h.status === 'active') && <button type="button" onClick={() => void undo(h.id)}>Undo</button>}
              {(h.status === 'reverted' || h.status === 'revoked') && <button type="button" onClick={() => run(() => rpc.call('history.redo', { id: h.id }))}>Redo</button>}
              {h.author.kind === 'agent' && h.author.session && (h.status === 'applied' || h.status === 'active') && (
                <button type="button" className="secondary" onClick={() => run(() => rpc.call('history.undoWhere', { filter: { session: h.author.session! } }))}>
                  Undo this whole session
                </button>
              )}
            </div>
          </li>
        ))}
      </ol>
      {items.length === 0 && <p className="quiet">Nothing yet.</p>}
    </section>
  );
}
