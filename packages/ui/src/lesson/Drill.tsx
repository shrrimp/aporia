import { useState } from 'react';
import { itemKey, type DrillItem } from '@app/catalog';
import { useAnchor, useSaved } from './progress.tsx';
import { Markdown } from './Markdown.tsx';
import { score, shuffled, type Response } from './scoring.ts';
import { useLessonActions } from './actions.tsx';
import { checkAnswer } from '../prompts.ts';

type Confidence = 'sure' | 'think' | 'guess';

/** A checked item as saved: what was given, and the result (-1: sent to the tutor to judge). */
type SavedItem = { choice?: number; reason?: number; text?: string; order?: string[]; confidence?: Confidence; result: number };

/** One drill item: answer, check, feedback. Also used on its own by the review page. */
export function Item({ item, confidence: askConfidence, purpose }: { item: DrillItem; confidence: boolean; purpose: string }) {
  const anchor = useAnchor();
  const actions = useLessonActions();
  const [saved, save] = useSaved<SavedItem>(itemKey(item.id));
  const [choice, setChoice] = useState<number | undefined>(saved?.choice);
  const [reason, setReason] = useState<number | undefined>(saved?.reason);
  const twoTier = item.kind === 'mcq' ? item.reason : undefined;
  const [text, setText] = useState(saved?.text ?? '');
  const [order, setOrder] = useState(() => saved?.order ?? (item.kind === 'order' ? shuffled(item.lines, item.id) : []));
  const [confidence, setConfidence] = useState<Confidence | undefined>(saved?.confidence);
  const [result, setResult] = useState<number | undefined>(saved?.result);
  const keep = (r: number) => {
    setResult(r);
    save({
      ...(choice !== undefined ? { choice } : {}),
      ...(reason !== undefined ? { reason } : {}),
      ...(item.kind === 'numeric' || item.kind === 'short' ? { text } : {}),
      ...(item.kind === 'order' ? { order } : {}),
      ...(confidence ? { confidence } : {}),
      result: r,
    });
  };

  const response = (): Response | undefined => {
    if (item.kind === 'mcq') {
      if (choice === undefined || (twoTier && reason === undefined)) return undefined;
      return { kind: 'mcq', choice, ...(reason !== undefined ? { reason } : {}) };
    }
    if (item.kind === 'numeric') return text.trim() === '' || Number.isNaN(Number(text)) ? undefined : { kind: 'numeric', value: Number(text) };
    return { kind: 'order', lines: order }; // short answers never get here: the tutor judges them
  };
  const ready = (item.kind === 'short' ? text.trim() !== '' : response() !== undefined) && (!askConfidence || confidence !== undefined);
  const done = result !== undefined;

  const submit = () => {
    if (item.kind === 'short') {
      const p = checkAnswer(item, text);
      actions.ask(p.question, { ...(anchor ? { anchor } : {}), shown: p.shown });
      keep(-1);
      return;
    }
    const outcome = score(item, response()!);
    keep(outcome);
    actions.recordAnswer({
      itemId: item.id,
      ...(item.reviewOf ? { reviewOf: item.reviewOf } : {}),
      kcs: item.kcs,
      difficulty: item.difficulty,
      evidenceType: item.kind === 'mcq' ? 'recognition' : 'production',
      outcome,
      ...(confidence ? { confidence } : {}),
      transfer: item.transfer,
    });
  };

  // The buttons at either end are disabled, so i + d is always in range.
  const move = (i: number, d: -1 | 1) => {
    const j = i + d;
    const next = [...order];
    [next[i], next[j]] = [next[j]!, next[i]!];
    setOrder(next);
  };

  return (
    <li className={`drill-item ${done ? (result === 1 ? 'correct' : result === -1 ? 'judging' : 'incorrect') : ''}`}>
      <Markdown md={item.prompt} />
      {item.kind === 'mcq' && (
        <div className="options" role="radiogroup">
          {item.options.map((o, i) => (
            <label key={i} className={done && i === item.answer ? 'answer' : ''}>
              <input type="radio" name={item.id} disabled={done} checked={choice === i} onChange={() => setChoice(i)} />
              <Markdown md={o} inline />
            </label>
          ))}
        </div>
      )}
      {twoTier && (
        <div className="reason-tier">
          <p className="reason-prompt">{twoTier.prompt}</p>
          <div className="options" role="radiogroup" aria-label={twoTier.prompt}>
            {twoTier.options.map((o, i) => (
              <label key={i} className={done && i === twoTier.answer ? 'answer' : ''}>
                <input type="radio" name={`${item.id}-reason`} disabled={done} checked={reason === i} onChange={() => setReason(i)} />
                <Markdown md={o} inline />
              </label>
            ))}
          </div>
        </div>
      )}
      {item.kind === 'numeric' && <input aria-label="Your answer" inputMode="decimal" disabled={done} value={text} onChange={(e) => setText(e.target.value)} />}
      {item.kind === 'short' && <textarea aria-label="Your answer" disabled={done} rows={3} value={text} onChange={(e) => setText(e.target.value)} />}
      {item.kind === 'order' && (
        <ol className="order">
          {order.map((l, i) => (
            <li key={l}>
              <code>{l}</code>
              <button type="button" aria-label={`Move "${l}" up`} disabled={done || i === 0} onClick={() => move(i, -1)}>↑</button>
              <button type="button" aria-label={`Move "${l}" down`} disabled={done || i === order.length - 1} onClick={() => move(i, 1)}>↓</button>
            </li>
          ))}
        </ol>
      )}
      {!done && askConfidence && (
        <div className="confidence" role="radiogroup" aria-label="How sure are you?">
          {(['sure', 'think', 'guess'] as const).map((c) => (
            <label key={c}>
              <input type="radio" name={`${item.id}-conf`} checked={confidence === c} onChange={() => setConfidence(c)} />
              {c === 'sure' ? 'Sure' : c === 'think' ? 'I think so' : 'Guessing'}
            </label>
          ))}
        </div>
      )}
      {!done ? (
        <button type="button" disabled={!ready} onClick={submit}>
          {purpose === 'pretest' ? 'Lock in my guess' : 'Check'}
        </button>
      ) : result === -1 ? (
        <p className="feedback">Sent to your tutor for feedback.</p>
      ) : (
        <div className="feedback" role="status">
          <strong>{result === 1 ? 'Right.' : result! > 0 ? `Partly right (${Math.round(result! * 100)}%).` : purpose === 'pretest' ? 'Not yet — that is expected before the lesson.' : 'Not quite.'}</strong>
          {item.kind === 'numeric' && result !== 1 && <span> Answer: {item.answer}</span>}
          {twoTier && result === 0.25 && <span> The answer is right, but not the reason: the reason is what shows you know it.</span>}
          {item.kind === 'order' && result !== 1 && <ol className="order solution">{item.lines.map((l) => <li key={l}><code>{l}</code></li>)}</ol>}
          <Markdown md={item.why} />
        </div>
      )}
    </li>
  );
}

export function Drill({ doc }: { doc: { purpose: string; confidence: boolean; items: DrillItem[] } }) {
  return (
    <section className={`drill purpose-${doc.purpose}`}>
      <header>{{ warmup: 'Warm-up', pretest: 'Guess first', practice: 'Practice', exit: 'Check yourself' }[doc.purpose] ?? 'Drill'}</header>
      <ol>
        {doc.items.map((it) => (
          <Item key={it.id} item={it} confidence={doc.confidence} purpose={doc.purpose} />
        ))}
      </ol>
    </section>
  );
}
