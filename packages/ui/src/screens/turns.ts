import type { FormAnswer, LearnerForm } from '@app/catalog';
import type { AskEvent, TranscriptEntry } from '@app/server/protocol';
import { describeTool } from './activity.ts';

export interface Step {
  readonly id: string;
  title?: string;
  status?: string;
}

export interface Turn {
  readonly askId?: string;
  readonly question: string;
  readonly selection?: string;
  /** Set when this message carries answers to a form: shown compactly. */
  readonly answersTo?: string;
  forms: { form: LearnerForm; submitted?: Record<string, FormAnswer> }[];
  answer: string;
  steps: Step[];
  blocked: string[];
  /** "interrupted": saved without an end, e.g. the app closed while the tutor was working. */
  state: 'running' | 'done' | 'error' | 'cancelled' | 'interrupted';
  error?: string;
}

function onTurn(turns: readonly Turn[], askId: string, f: (t: Turn) => void): Turn[] {
  return turns.map((t) => {
    if (t.askId !== askId) return t;
    const copy: Turn = { ...t, steps: t.steps.map((s) => ({ ...s })), blocked: [...t.blocked], forms: [...t.forms] };
    f(copy);
    return copy;
  });
}

function applyEvent(t: Turn, e: AskEvent): void {
  if (e.kind === 'text') t.answer += e.text;
  else if (e.kind === 'form') t.forms.push({ form: e.form });
  else if (e.kind === 'tool') {
    const s = t.steps.find((x) => x.id === e.id);
    if (!s) t.steps.push({ id: e.id, ...(e.title ? { title: e.title } : {}), ...(e.status ? { status: e.status } : {}) });
    else {
      if (e.status) s.status = e.status;
      if (e.title && !s.title) s.title = e.title;
    }
  } else if (e.kind === 'permission' && !e.decision.allow) t.blocked.push(describeTool(e.title).label);
  else if (e.kind === 'blocked-fs') t.blocked.push(`${e.op === 'write' ? 'writing' : 'reading'} ${e.path.split(/[\\/]/).at(-1)}`);
}

/**
 * One step of a conversation. Live events and a saved transcript go through this same function,
 * so a restored conversation looks exactly like it did.
 */
export function applyEntry(turns: readonly Turn[], e: TranscriptEntry): Turn[] {
  switch (e.t) {
    case 'ask':
      if (turns.some((t) => t.askId === e.askId)) return [...turns];
      return [
        ...turns,
        {
          askId: e.askId,
          question: e.question,
          ...(e.selection ? { selection: e.selection } : {}),
          ...(e.answersTo ? { answersTo: e.answersTo } : {}),
          forms: [],
          answer: '',
          steps: [],
          blocked: [],
          state: 'running',
        },
      ];
    case 'event':
      return onTurn(turns, e.askId, (t) => applyEvent(t, e.event));
    case 'submitted':
      return onTurn(turns, e.askId, (t) => {
        t.forms = t.forms.map((f, i) => (i === e.form ? { ...f, submitted: e.answers as Record<string, FormAnswer> } : f));
      });
    case 'end':
      return onTurn(turns, e.askId, (t) => {
        t.state = e.state;
        if (e.error !== undefined) t.error = e.error;
      });
  }
}

/** A saved conversation, replayed. Turns that never ended were cut off by a restart. */
export function replay(entries: readonly TranscriptEntry[]): Turn[] {
  return entries.reduce(applyEntry, [] as Turn[]).map((t) => (t.state === 'running' ? { ...t, state: 'interrupted' } : t));
}
