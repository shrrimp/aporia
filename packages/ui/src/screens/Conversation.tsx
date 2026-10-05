import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import type { ServerEvents, TranscriptEntry } from '@app/server/protocol';
import { useEvent, useRpc } from '../hooks.tsx';
import { Markdown } from '../lesson/Markdown.tsx';
import { PixelMark } from '../PixelMark.tsx';
import { describeTool } from './activity.ts';
import { Proposals } from './Proposals.tsx';
import { FormCard } from './FormCard.tsx';
import { applyEntry, replay, type Step, type Turn } from './turns.ts';
import type { FormAnswer } from '@app/catalog';

export interface AskRequest {
  readonly question: string;
  readonly selection?: string;
  readonly anchor?: string;
  readonly nonce: number;
}

// Stable defaults: a fresh `() => {}` per render would re-run the request effect forever.
const NOOP = () => undefined;
const NOOP_BUSY = (_busy: boolean) => undefined;

const STEP_STATE: Record<string, 'done' | 'failed' | 'working'> = { completed: 'done', failed: 'failed' };

function Steps({ steps, blocked }: { steps: readonly Step[]; blocked: readonly string[] }) {
  if (steps.length === 0 && blocked.length === 0) return null;
  return (
    <ul className="steps" aria-label="What your tutor did">
      {steps.map((s, i) => {
        const a = describeTool(s.title);
        const state = STEP_STATE[s.status ?? ''] ?? 'working';
        // A failed call is usually the tutor's own input being rejected and fixed on the next try.
        const retried = state === 'failed' && steps.slice(i + 1).some((later) => describeTool(later.title).label === a.label);
        return (
          <li key={s.id} className={`step kind-${a.kind} step-${state}`}>
            <span className="step-mark" aria-hidden />
            <span className="step-label">{a.label}</span>
            {a.detail && <span className="step-detail">{a.detail}</span>}
            {state === 'failed' && <span className="step-state">{retried ? 'needed another try' : "didn't work"}</span>}
          </li>
        );
      })}
      {blocked.map((b, i) => (
        <li key={`b${i}`} className="step step-failed">
          <span className="step-mark" aria-hidden />
          <span className="step-label">Blocked by the app</span>
          <span className="step-detail">{b}</span>
        </li>
      ))}
    </ul>
  );
}

/**
 * The tutor conversation, as a page: the first interview, questions about a lesson, hints.
 * Answers stream in, and what the tutor does is shown in plain words. It stays mounted while a
 * lesson is shown, so nothing is lost when the learner goes back and forth.
 */
export function Conversation({
  projectId,
  lessonId,
  request,
  intro,
  backTo,
  onBack,
  onActivity = NOOP,
  onBusy = NOOP_BUSY,
  variant = 'page',
  proposals = true,
}: {
  projectId: string;
  lessonId: string | undefined;
  request: AskRequest | undefined;
  /** Shown above the conversation while it is empty (e.g. before the first interview). */
  intro?: ReactNode;
  /** Title of the lesson the learner came from, for the way back. */
  backTo?: string | undefined;
  onBack?: () => void;
  /** A new request arrived: the page should show the conversation. */
  onActivity?: () => void;
  onBusy?: (busy: boolean) => void;
  /** "page": a full session (interview, planning). "chat": the quick-question margin. */
  variant?: 'page' | 'chat';
  /** Show pending proposals at the end of the conversation (off when another view shows them). */
  proposals?: boolean;
}) {
  const rpc = useRpc();
  const [turns, setTurns] = useState<Turn[]>([]);
  const [input, setInput] = useState('');
  const [selection, setSelection] = useState<{ text: string; anchor?: string }>();
  const endRef = useRef<HTMLDivElement>(null);
  /** The last request handled: each request is acted on exactly once, whatever else re-renders. */
  const handled = useRef<number | undefined>(undefined);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  const apply = useCallback((e: TranscriptEntry) => setTurns((ts) => applyEntry(ts, e)), []);
  const thread = variant === 'chat' ? 'chat' : 'session';

  // The saved conversation comes first; anything that happened while it loaded stays after it.
  useEffect(() => {
    let live = true;
    rpc.call('conversations.get', { projectId, thread }).then(
      (entries) => {
        if (!live) return;
        const saved = replay(entries);
        setTurns((ts) => [...saved, ...ts.filter((t) => !t.askId || !saved.some((x) => x.askId === t.askId))]);
      },
      () => undefined, // nothing saved can be read: start empty
    );
    return () => {
      live = false;
    };
  }, [rpc, projectId, thread]);

  useEvent('ask.event', useCallback(({ askId, event }: ServerEvents['ask.event']) => apply({ t: 'event', askId, event }), [apply]));
  useEvent(
    'ask.done',
    useCallback(({ askId, stopReason }: ServerEvents['ask.done']) => apply({ t: 'end', askId, state: stopReason === 'cancelled' ? 'cancelled' : 'done' }), [apply]),
  );
  useEvent('ask.error', useCallback(({ askId, message }: ServerEvents['ask.error']) => apply({ t: 'end', askId, state: 'error', error: message }), [apply]));

  const send = useCallback(
    async (question: string, sel?: { text: string; anchor?: string }, answers?: { askId: string; form: number; title: string; values: Record<string, FormAnswer> }) => {
      const pending: Turn = {
        question,
        ...(sel ? { selection: sel.text } : {}),
        ...(answers ? { answersTo: answers.title } : {}),
        answer: '',
        steps: [],
        blocked: [],
        forms: [],
        state: 'running',
      };
      onActivity();
      try {
        const { askId } = await rpc.call('ask', {
          projectId,
          question,
          ...(lessonId ? { lessonId } : {}),
          ...(sel ? { selection: sel.text } : {}),
          ...(sel?.anchor ? { anchor: sel.anchor } : {}),
          thread,
          ...(answers ? { answers } : {}),
        });
        setTurns((ts) => [...ts, { ...pending, askId }]);
      } catch (err) {
        setTurns((ts) => [...ts, { ...pending, state: 'error', error: (err as Error).message }]);
      }
    },
    [rpc, projectId, lessonId, onActivity, thread],
  );

  useEffect(() => {
    if (!request || handled.current === request.nonce) return;
    handled.current = request.nonce;
    const sel = request.selection ? { text: request.selection, ...(request.anchor ? { anchor: request.anchor } : {}) } : undefined;
    if (request.question) void send(request.question, sel);
    else if (sel) {
      setSelection(sel);
      onActivity();
      inputRef.current?.focus();
    }
  }, [request, send, onActivity]);

  useEffect(() => {
    // Braces matter: newer browsers return a Promise from scrollIntoView, which React would treat as a cleanup.
    void endRef.current?.scrollIntoView?.({ block: 'end' });
  }, [turns]);

  const running = turns.find((t) => t.state === 'running' && t.askId);
  const busy = running !== undefined;
  useEffect(() => {
    onBusy(busy);
  }, [busy, onBusy]);

  const submit = () => {
    if (input.trim() === '') return;
    void send(input.trim(), selection);
    setInput('');
    setSelection(undefined);
  };

  return (
    <section className={`conversation ${variant}`} aria-label={variant === 'chat' ? 'Tutor' : 'Session'}>
      {backTo && onBack && (
        <button type="button" className="text back" onClick={onBack}>
          ← Back to {backTo}
        </button>
      )}
      {turns.length === 0 && intro}
      {turns.length === 0 && variant === 'chat' && (
        <p className="quiet">Select a passage in the lesson to ask about it, or ask anything here. Your tutor explains and hints; it won't write your solution.</p>
      )}
      <div className="turns">
        {turns.map((t, i) => (
          <div key={t.askId ?? `p${i}`} className={`exchange state-${t.state}`}>
            <div className="you">
              <p className="who">You</p>
              {t.selection && <blockquote className="quote">{t.selection}</blockquote>}
              {t.answersTo ? <p className="question answered">Sent my answers to “{t.answersTo}”</p> : <p className="question">{t.question}</p>}
            </div>
            <div className="tutor-says">
              <p className="who">
                <PixelMark working={t.state === 'running'} size={14} />
                Tutor
                {t.state === 'running' && <span className="status">working</span>}
              </p>
              {variant === 'chat' && t.state === 'running' && !t.answer ? (
                <p className="loading">
                  <PixelMark working size={16} />
                  {t.steps.length > 0 ? describeTool(t.steps.at(-1)!.title).label : 'Thinking'}…
                </p>
              ) : (
                <Steps steps={t.steps} blocked={t.blocked} />
              )}
              {t.answer && <Markdown md={t.answer} />}
              {t.forms.map((f, fi) => (
                <FormCard
                  key={fi}
                  form={f.form}
                  submitted={f.submitted}
                  onSubmit={(message, answers) => {
                    // Saved turns all have an askId; only a turn that failed to start lacks one, and it has no forms.
                    apply({ t: 'submitted', askId: t.askId!, form: fi, answers });
                    void send(message, undefined, { askId: t.askId!, form: fi, title: f.form.title, values: answers });
                  }}
                />
              ))}
              {t.state === 'error' && (
                <p className="error" role="alert">
                  {t.error}
                </p>
              )}
              {t.state === 'cancelled' && <p className="quiet">Stopped.</p>}
              {t.state === 'interrupted' && <p className="quiet">Cut off: the app closed before your tutor finished. Ask again to pick up.</p>}
            </div>
          </div>
        ))}
        {proposals && <Proposals />}
        <div ref={endRef} />
      </div>
      <form
        className="compose"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        {selection && (
          <p className="quote">
            <span>
              “{selection.text.slice(0, 160)}
              {selection.text.length > 160 ? '…' : ''}”
            </span>
            <button type="button" className="text" aria-label="Remove selection" onClick={() => setSelection(undefined)}>
              remove
            </button>
          </p>
        )}
        <textarea
          ref={inputRef}
          aria-label={variant === 'chat' ? 'Your question' : 'Your message'}
          rows={variant === 'chat' ? 2 : 4}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
              e.preventDefault();
              submit();
            }
          }}
          placeholder={variant === 'chat' ? 'Ask a quick question…' : turns.length === 0 ? 'Write to your tutor…' : 'Answer, ask, or say what you tried…'}
        />
        <div className="compose-row">
          <span className="quiet">{variant === 'chat' ? 'Ctrl + Enter to send' : "Ctrl + Enter to send. Your tutor explains and hints; it won't write your solution."}</span>
          {running ? (
            <button type="button" onClick={() => void rpc.call('ask.cancel', { askId: running.askId! })}>
              Stop
            </button>
          ) : (
            <button type="submit" className="primary" disabled={input.trim() === ''}>
              Send
            </button>
          )}
        </div>
      </form>
    </section>
  );
}
