import { useCallback, useEffect, useRef, useState } from 'react';
import type { AskEvent, ServerEvents } from '@app/server/protocol';
import { useEvent, useRpc } from '../hooks.tsx';
import { Markdown } from '../lesson/Markdown.tsx';

interface Turn {
  readonly askId?: string;
  readonly question: string;
  readonly selection?: string;
  answer: string;
  tools: string[];
  blocked: string[];
  state: 'running' | 'done' | 'error' | 'cancelled';
  error?: string;
}

export interface AskRequest {
  readonly question: string;
  readonly selection?: string;
  readonly anchor?: string;
  readonly nonce: number;
}

/** The (deliberately small) chat: answers stream in; tool use is shown, never hidden. */
export function AskPanel({ projectId, lessonId, request }: { projectId: string; lessonId: string | undefined; request: AskRequest | undefined }) {
  const rpc = useRpc();
  const [open, setOpen] = useState(false);
  const [turns, setTurns] = useState<Turn[]>([]);
  const [input, setInput] = useState('');
  const [selection, setSelection] = useState<{ text: string; anchor?: string }>();
  const endRef = useRef<HTMLDivElement>(null);

  const update = useCallback((askId: string, f: (t: Turn) => void) => {
    setTurns((ts) => ts.map((t) => (t.askId === askId ? (f((t = { ...t, tools: [...t.tools], blocked: [...t.blocked] })), t) : t)));
  }, []);

  useEvent(
    'ask.event',
    useCallback(
      ({ askId, event }: ServerEvents['ask.event']) =>
        update(askId, (t) => {
          const e = event as AskEvent;
          if (e.kind === 'text') t.answer += e.text;
          else if (e.kind === 'tool' && e.title && !t.tools.includes(e.title)) t.tools.push(e.title);
          else if (e.kind === 'permission' && !e.decision.allow) t.blocked.push(e.title);
          else if (e.kind === 'blocked-fs') t.blocked.push(`${e.op} ${e.path}`);
        }),
      [update],
    ),
  );
  useEvent('ask.done', useCallback(({ askId, stopReason }: ServerEvents['ask.done']) => update(askId, (t) => (t.state = stopReason === 'cancelled' ? 'cancelled' : 'done')), [update]));
  useEvent('ask.error', useCallback(({ askId, message }: ServerEvents['ask.error']) => update(askId, (t) => ((t.state = 'error'), (t.error = message))), [update]));

  const send = useCallback(
    async (question: string, sel?: { text: string; anchor?: string }) => {
      const pending: Turn = { question, ...(sel ? { selection: sel.text } : {}), answer: '', tools: [], blocked: [], state: 'running' };
      setOpen(true);
      try {
        const { askId } = await rpc.call('ask', {
          projectId,
          question,
          ...(lessonId ? { lessonId } : {}),
          ...(sel ? { selection: sel.text } : {}),
          ...(sel?.anchor ? { anchor: sel.anchor } : {}),
        });
        setTurns((ts) => [...ts, { ...pending, askId }]);
      } catch (err) {
        setTurns((ts) => [...ts, { ...pending, state: 'error', error: (err as Error).message }]);
      }
    },
    [rpc, projectId, lessonId],
  );

  useEffect(() => {
    if (!request) return;
    if (request.question) void send(request.question, request.selection ? { text: request.selection, ...(request.anchor ? { anchor: request.anchor } : {}) } : undefined);
    else if (request.selection) {
      setSelection({ text: request.selection, ...(request.anchor ? { anchor: request.anchor } : {}) });
      setOpen(true);
    }
  }, [request, send]);

  useEffect(() => {
    // Braces matter: newer browsers return a Promise from scrollIntoView, which React would treat as a cleanup.
    void endRef.current?.scrollIntoView?.({ block: 'end' });
  }, [turns]);
  const running = turns.find((t) => t.state === 'running' && t.askId);

  return (
    <aside className={`ask ${open ? 'open' : 'closed'}`} aria-label="Ask your tutor">
      <button type="button" className="ask-toggle" aria-expanded={open} onClick={() => setOpen(!open)}>
        {open ? 'Tutor' : 'Ask your tutor'} {running ? '· thinking…' : ''}
      </button>
      {open && (
        <div className="ask-body">
          <div className="turns">
            {turns.length === 0 && <p className="hint">Select any text in the lesson to ask about it, or type a question. Your tutor explains and hints; it won't write your solution.</p>}
            {turns.map((t, i) => (
              <div key={t.askId ?? `p${i}`} className={`turn state-${t.state}`}>
                {t.selection && <blockquote className="selection">{t.selection}</blockquote>}
                <p className="question">{t.question}</p>
                {t.answer && <Markdown md={t.answer} />}
                {t.tools.length > 0 && <p className="tools">Used: {t.tools.join(', ')}</p>}
                {t.blocked.length > 0 && <p className="blocked">Blocked by the app: {t.blocked.join(', ')}</p>}
                {t.state === 'error' && <p className="error" role="alert">{t.error}</p>}
                {t.state === 'cancelled' && <p className="hint">Stopped.</p>}
              </div>
            ))}
            <div ref={endRef} />
          </div>
          <form
            className="ask-input"
            onSubmit={(e) => {
              e.preventDefault();
              if (input.trim() === '') return;
              void send(input.trim(), selection);
              setInput('');
              setSelection(undefined);
            }}
          >
            {selection && (
              <p className="selection-chip">
                About: “{selection.text.slice(0, 80)}{selection.text.length > 80 ? '…' : ''}”
                <button type="button" aria-label="Remove selection" onClick={() => setSelection(undefined)}>×</button>
              </p>
            )}
            <textarea aria-label="Your question" rows={2} value={input} onChange={(e) => setInput(e.target.value)} placeholder="Ask anything about the lesson…" />
            {running ? (
              <button type="button" onClick={() => void rpc.call('ask.cancel', { askId: running.askId! })}>Stop</button>
            ) : (
              <button type="submit" disabled={input.trim() === ''}>Ask</button>
            )}
          </form>
        </div>
      )}
    </aside>
  );
}
