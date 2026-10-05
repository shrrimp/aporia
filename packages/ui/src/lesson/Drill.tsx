import { useState } from 'react';
import type { DrillItem } from '@app/catalog';
import { Markdown } from './Markdown.tsx';
import { score, shuffled, type Response } from './scoring.ts';
import { useLessonActions } from './actions.tsx';

type Confidence = 'sure' | 'think' | 'guess';

function Item({ item, confidence: askConfidence, purpose }: { item: DrillItem; confidence: boolean; purpose: string }) {
  const actions = useLessonActions();
  const [choice, setChoice] = useState<number>();
  const [text, setText] = useState('');
  const [order, setOrder] = useState(() => (item.kind === 'order' ? shuffled(item.lines, item.id) : []));
  const [confidence, setConfidence] = useState<Confidence>();
  const [result, setResult] = useState<number>();

  const response = (): Response | undefined => {
    if (item.kind === 'mcq') return choice === undefined ? undefined : { kind: 'mcq', choice };
    if (item.kind === 'numeric') return text.trim() === '' || Number.isNaN(Number(text)) ? undefined : { kind: 'numeric', value: Number(text) };
    return { kind: 'order', lines: order }; // short answers never get here: the tutor judges them
  };
  const ready = (item.kind === 'short' ? text.trim() !== '' : response() !== undefined) && (!askConfidence || confidence !== undefined);
  const done = result !== undefined;

  const submit = () => {
    if (item.kind === 'short') {
      actions.ask(
        `Judge my answer to drill item "${item.id}" (KCs ${item.kcs.join(', ')}). Question: ${item.prompt}\nMy answer: ${text}\n` +
          `Reference: ${item.answer}\nScore it 0–5 against the reference twice independently, record the evidence (production, difficulty ${item.difficulty}), and give me feedback without lecturing.`,
      );
      setResult(-1);
      return;
    }
    const outcome = score(item, response()!);
    setResult(outcome);
    actions.recordAnswer({
      itemId: item.id,
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
