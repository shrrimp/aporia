import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import type { ServerEvents, TranscriptEntry } from '@app/server/protocol';
import { useEvent, useRpc } from '../hooks.tsx';
import { Markdown, type CodeGate } from '../lesson/Markdown.tsx';
import { PixelMark } from '../PixelMark.tsx';
import { describeTool } from './activity.ts';
import { Proposals } from './Proposals.tsx';
import { FormCard } from './FormCard.tsx';
import { applyEntry, replay, type Step, type Turn } from './turns.ts';
import { AddFilesButton, AttachedList, FileDrop, useAttach, type Attached } from '../sources.tsx';
import type { FormAnswer } from '@app/catalog';

export interface AskRequest {
  readonly question: string;
  readonly selection?: string;
  readonly anchor?: string;
  readonly nonce: number;
}

/** The nearest ancestor that scrolls (the page, or the chat margin). */
export function scrollerOf(el: HTMLElement | null): HTMLElement | undefined {
  for (let p = el?.parentElement; p; p = p.parentElement) {
    const y = getComputedStyle(p).overflowY;
    if (y === 'auto' || y === 'scroll') return p;
  }
  return undefined;
}

/** Laid out on screen (not inside something hidden). */
const isShown = (el: HTMLElement | null) => el !== null && el.getClientRects().length > 0;

/** Run `fn` on the next frame (or soon, where there are no frames); returns a cancel function. */
function nextFrame(fn: () => void): () => void {
  if (typeof requestAnimationFrame === 'function') {
    const id = requestAnimationFrame(fn);
    return () => cancelAnimationFrame(id);
  }
  const id = setTimeout(fn, 16);
  return () => clearTimeout(id);
}

// Stable defaults: a fresh `() => {}` per render would re-run the request effect forever.
const NOOP = () => undefined;
/** Sent by "Continue" after a turn was cut off; the core tells the tutor what it had done. */
export const CONTINUE = 'Please continue where you left off.';
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
  gate,
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
  /** Hides code in replies that looks like the solution to an open task. */
  gate?: CodeGate | undefined;
}) {
  const rpc = useRpc();
  const [turns, setTurns] = useState<Turn[]>([]);
  const [input, setInput] = useState('');
  const [selection, setSelection] = useState<{ text: string; anchor?: string }>();
  /** The last request handled: each request is acted on exactly once, whatever else re-renders. */
  const handled = useRef<number | undefined>(undefined);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  // Streamed text arrives in many small chunks; re-rendering the Markdown (and its maths) for
  // each one makes long answers stutter. Chunks are gathered and applied once per frame; any
  // other event first applies what is waiting, so the order never changes.
  const queue = useRef<TranscriptEntry[]>([]);
  const frame = useRef<(() => void) | undefined>(undefined);
  const flush = useCallback(() => {
    frame.current = undefined;
    const waiting = queue.current.splice(0);
    if (waiting.length) setTurns((ts) => waiting.reduce(applyEntry, ts));
  }, []);
  const apply = useCallback(
    (e: TranscriptEntry) => {
      queue.current.push(e);
      if (e.t === 'event' && e.event.kind === 'text') {
        frame.current ??= nextFrame(flush);
      } else {
        frame.current?.();
        flush();
      }
    },
    [flush],
  );
  useEffect(() => () => frame.current?.(), []);
  const thread = variant === 'chat' ? 'chat' : 'session';

  // The saved conversation comes first; anything that happened while it loaded stays after it.
  useEffect(() => {
    let live = true;
    // A turn still running (the page was reloaded while the tutor worked) goes on; others that
    // never ended were cut off by a restart.
    const inProgress = rpc.call('conversations.running', { projectId, thread }).catch(() => [] as string[]);
    Promise.all([rpc.call('conversations.get', { projectId, thread }), inProgress]).then(
      ([entries, ids]) => {
        if (!live) return;
        const saved = replay(entries, new Set(ids));
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
    async (
      question: string,
      sel?: { text: string; anchor?: string },
      answers?: { askId: string; form: number; title: string; values: Record<string, FormAnswer> },
      /** Where in the lesson it was asked, without a selection (e.g. a task's "I'm stuck"). */
      at?: string,
    ) => {
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
      fromBottom.current = 0; // a new message: show it, and follow the answer
      try {
        const { askId } = await rpc.call('ask', {
          projectId,
          question,
          ...(lessonId ? { lessonId } : {}),
          ...(sel ? { selection: sel.text } : {}),
          ...((sel?.anchor ?? at) ? { anchor: sel?.anchor ?? at } : {}),
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
    if (request.question) void send(request.question, sel, undefined, request.anchor);
    else if (sel) {
      setSelection(sel);
      onActivity();
      inputRef.current?.focus();
    }
  }, [request, send, onActivity]);

  // Scrolling keeps the learner's distance from the bottom: at the bottom, the view follows the
  // tutor as it writes; scrolled up to read, it stays put while new steps arrive below.
  const sectionRef = useRef<HTMLElement>(null);
  const fromBottom = useRef(0);
  useEffect(() => {
    const scroller = scrollerOf(sectionRef.current);
    if (!scroller) return;
    const remember = () => {
      // The scroller can be shared with a lesson (the page): only count scrolling while this is shown.
      if (isShown(sectionRef.current)) fromBottom.current = Math.max(0, scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight);
    };
    scroller.addEventListener('scroll', remember, { passive: true });
    return () => scroller.removeEventListener('scroll', remember);
  }, []);
  useLayoutEffect(() => {
    const scroller = scrollerOf(sectionRef.current);
    if (!scroller || !isShown(sectionRef.current)) return;
    scroller.scrollTop = scroller.scrollHeight - scroller.clientHeight - fromBottom.current;
  }, [turns]);

  const running = turns.find((t) => t.state === 'running' && t.askId);
  const busy = running !== undefined;
  useEffect(() => {
    onBusy(busy);
  }, [busy, onBusy]);

  // Files dropped or picked here are copied into the project right away; the next message tells
  // the tutor about them.
  const attach = useAttach(rpc, projectId);
  const added = attach.items.filter((a) => a.state === 'done');
  const sending = attach.items.some((a) => a.state === 'sending');
  const submit = () => {
    if ((input.trim() === '' && added.length === 0) || sending) return;
    void send(withFiles(input.trim(), added), selection);
    setInput('');
    setSelection(undefined);
    attach.clear();
  };

  return (
    <FileDrop onFiles={(files) => void attach.add(files)} className="conversation-drop">
    <section ref={sectionRef} className={`conversation ${variant}`} aria-label={variant === 'chat' ? 'Tutor' : 'Session'}>
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
              {t.answer && <Markdown md={t.answer} gate={gate} />}
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
              {t.state === 'interrupted' && (
                <p className="quiet interrupted">
                  Cut off: the app closed before your tutor finished. What it had saved is kept.
                  {i === turns.length - 1 && !busy && (
                    <button type="button" onClick={() => void send(CONTINUE)}>
                      Continue
                    </button>
                  )}
                </p>
              )}
            </div>
          </div>
        ))}
        {proposals && <Proposals projectId={projectId} />}
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
        <AttachedList items={attach.items} onRemove={attach.remove} />
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
          <AddFilesButton onFiles={(files) => void attach.add(files)} label="Add files" />
          {running ? (
            <button type="button" onClick={() => void rpc.call('ask.cancel', { askId: running.askId! })}>
              Stop
            </button>
          ) : (
            <button type="submit" className="primary" disabled={(input.trim() === '' && added.length === 0) || sending}>
              Send
            </button>
          )}
        </div>
      </form>
    </section>
    </FileDrop>
  );
}

/** The message, with a line telling the tutor which files were just added (it reads them with its tools). */
export function withFiles(message: string, added: readonly Attached[]): string {
  if (added.length === 0) return message;
  const list = added.map((a) => `"${a.name}" (${a.source!.id})`).join(', ');
  const note = `I added ${added.length === 1 ? 'a file' : `${added.length} files`} to the project: ${list}.`;
  return message ? `${message}\n\n${note}` : `${note} Have a look.`;
}
