import { createContext, useContext, useState } from 'react';
import type { TaskHintsDTO } from '@app/server/protocol';
import { hintRequest, type Prompt } from '../prompts.ts';

/** The open lesson's hints, by task, and how to record an attempt. Absent outside a project. */
export interface HintActions {
  readonly data: Readonly<Record<string, TaskHintsDTO>> | undefined;
  attempt(taskId: string, text: string): Promise<void>;
}

export const HintsContext = createContext<HintActions | undefined>(undefined);

/**
 * The hints given on a task, as a ladder (pedagogy-model §6, H1–H2): which levels, about what,
 * and what the next level needs. Hints are not a failure; the ladder shows how much help the
 * task took, which is also what the evidence counts.
 */
export function HintLadder({ taskId }: { taskId: string }) {
  const h = useContext(HintsContext)?.data?.[taskId];
  if (!h || h.levels.length === 0) return null;
  return (
    <div className="hint-ladder" aria-label="Hints so far">
      <ol>
        {h.levels.map((l, i) => (
          <li key={i} className={`hint-level l${l.level}`} title={l.summary}>
            <span className="num">L{l.level}</span> {l.name}
            {l.summary && <span className="quiet"> · {l.summary}</span>}
          </li>
        ))}
      </ol>
      {h.nextNeedsAttempt && (
        <p className="quiet">The next level shows part of the structure: try something first (run the checkpoint, change your code, or say what you tried).</p>
      )}
    </div>
  );
}

/**
 * "I'm stuck": asks the tutor for the lowest hint that helps. What the learner tried, written
 * here, is recorded as an attempt (it opens the higher levels) and sent with the question.
 */
export function StuckButton({ taskId, title, ask }: { taskId: string; title: string; ask: (prompt: Prompt) => void }) {
  const hints = useContext(HintsContext);
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState('');
  const [error, setError] = useState<string>();
  if (!open) {
    return (
      <button type="button" className="hint" onClick={() => setOpen(true)}>
        I'm stuck: give me a hint
      </button>
    );
  }
  const send = async () => {
    const text = draft.trim();
    setError(undefined);
    try {
      if (text && hints) await hints.attempt(taskId, text);
    } catch (err) {
      setError((err as Error).message);
      return;
    }
    ask(hintRequest(title, text));
    setOpen(false);
    setDraft('');
  };
  return (
    <div className="stuck">
      <label>
        What have you tried? <span className="quiet">(optional; it lets your tutor go further)</span>
        <textarea rows={3} value={draft} onChange={(e) => setDraft(e.target.value)} />
      </label>
      {error && <p className="error">{error}</p>}
      <p className="stuck-actions">
        <button type="button" className="primary" onClick={() => void send()}>
          Ask for a hint
        </button>
        <button type="button" className="text" onClick={() => setOpen(false)}>
          Cancel
        </button>
      </p>
    </div>
  );
}
