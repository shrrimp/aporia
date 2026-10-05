import { useState } from 'react';
import { formatAnswers, type FormAnswer, type FormQuestion, type LearnerForm } from '@app/catalog';
import { Markdown } from '../lesson/Markdown.tsx';

type Answers = Record<string, FormAnswer>;

const pad = (n: number) => String(n).padStart(2, '0');

function isAnswered(q: FormQuestion, a: FormAnswer | undefined): boolean {
  if (!a) return q.optional;
  if ('unsure' in a || 'skipped' in a) return true;
  if ('choices' in a) return a.choices.length > 0 || q.optional;
  if ('text' in a) return a.text.trim() !== '' || q.optional;
  return true;
}

/** Short text of an answer, for the summary after sending. */
export function answerText(a: FormAnswer | undefined): string {
  if (!a || 'skipped' in a) return '—';
  if ('unsure' in a) return "don't know yet";
  if ('choice' in a) return a.choice;
  if ('choices' in a) return a.choices.join(', ') || '—';
  if ('text' in a) return a.text || '—';
  if ('number' in a) return String(a.number);
  if ('scale' in a) return `${a.scale}/5`;
  return a.order.join(' › ');
}

function Choice({ q, value, onChange }: { q: Extract<FormQuestion, { kind: 'single' | 'multi' }>; value: FormAnswer | undefined; onChange: (a: FormAnswer | undefined) => void }) {
  const [other, setOther] = useState('');
  const multi = q.kind === 'multi';
  const selected: readonly string[] = value && 'choices' in value ? value.choices : value && 'choice' in value ? [value.choice] : [];
  const toggle = (opt: string) => {
    if (!multi) return onChange({ choice: opt });
    const next = selected.includes(opt) ? selected.filter((s) => s !== opt) : [...selected, opt];
    onChange({ choices: next });
  };
  return (
    <div className={`f-options ${multi ? 'multi' : 'single'}`} role={multi ? 'group' : 'radiogroup'} aria-label={q.prompt}>
      {q.options.map((o) => (
        <label key={o} className={selected.includes(o) ? 'on' : ''}>
          <input type={multi ? 'checkbox' : 'radio'} name={q.id} checked={selected.includes(o)} onChange={() => toggle(o)} />
          <span className="px" aria-hidden />
          <Markdown md={o} inline />
        </label>
      ))}
      {q.allowOther && (
        <label className={`other ${other && selected.includes(other) ? 'on' : ''}`}>
          <span className="px" aria-hidden />
          <input
            className="other-input"
            aria-label="Something else"
            placeholder="Something else…"
            value={other}
            onChange={(e) => {
              const prev = other;
              setOther(e.target.value);
              const rest = selected.filter((s) => s !== prev);
              if (e.target.value.trim() === '') onChange(multi ? { choices: rest } : undefined);
              else onChange(multi ? { choices: [...rest, e.target.value] } : { choice: e.target.value });
            }}
          />
        </label>
      )}
    </div>
  );
}

function Scale({ q, value, onChange }: { q: Extract<FormQuestion, { kind: 'scale' }>; value: FormAnswer | undefined; onChange: (a: FormAnswer) => void }) {
  const v = value && 'scale' in value ? value.scale : 0;
  return (
    <div className="f-scale">
      <span className="end">{q.low}</span>
      <div className="cells" role="radiogroup" aria-label={q.prompt}>
        {[1, 2, 3, 4, 5].map((n) => (
          <label key={n} className={n <= v ? 'on' : ''} style={{ height: `${0.7 + n * 0.22}rem` }}>
            <input type="radio" name={q.id} aria-label={`${n} of 5`} checked={v === n} onChange={() => onChange({ scale: n })} />
          </label>
        ))}
      </div>
      <span className="end">{q.high}</span>
    </div>
  );
}

function Rank({ q, value, onChange }: { q: Extract<FormQuestion, { kind: 'rank' }>; value: FormAnswer | undefined; onChange: (a: FormAnswer) => void }) {
  const order = value && 'order' in value ? value.order : q.options;
  const move = (i: number, d: -1 | 1) => {
    const next = [...order];
    [next[i], next[i + d]] = [next[i + d]!, next[i]!];
    onChange({ order: next });
  };
  return (
    <ol className="f-rank">
      {order.map((o, i) => (
        <li key={o}>
          <span className="num">{i + 1}</span>
          <span className="rank-label">{o}</span>
          <button type="button" className="text" aria-label={`Move "${o}" up`} disabled={i === 0} onClick={() => move(i, -1)}>
            up
          </button>
          <button type="button" className="text" aria-label={`Move "${o}" down`} disabled={i === order.length - 1} onClick={() => move(i, 1)}>
            down
          </button>
        </li>
      ))}
    </ol>
  );
}

/**
 * A form the tutor put in front of the learner (via `ask_learner`). Answered by clicking
 * wherever possible; sent back to the tutor as one structured message.
 */
export function FormCard({ form, onSubmit, submitted }: { form: LearnerForm; onSubmit: (message: string, answers: Answers) => void; submitted?: Answers | undefined }) {
  const [answers, setAnswers] = useState<Answers>(() => Object.fromEntries(form.questions.flatMap((q) => (q.kind === 'rank' ? [[q.id, { order: q.options }]] : []))));
  const set = (id: string, a: FormAnswer | undefined) =>
    setAnswers((prev) => {
      const next = { ...prev };
      if (a === undefined) delete next[id];
      else next[id] = a;
      return next;
    });
  const answered = form.questions.filter((q) => isAnswered(q, answers[q.id])).length;
  const done = answered === form.questions.length;

  if (submitted) {
    return (
      <section className="formcard sent" aria-label={form.title}>
        <p className="f-title">{form.title}</p>
        <dl>
          {form.questions.map((q, i) => (
            <div key={q.id}>
              <dt>
                <span className="num">{pad(i + 1)}</span> <Markdown md={q.prompt} inline />
              </dt>
              <dd>{answerText(submitted[q.id])}</dd>
            </div>
          ))}
        </dl>
      </section>
    );
  }

  return (
    <form
      className="formcard"
      aria-label={form.title}
      onSubmit={(e) => {
        e.preventDefault();
        if (!done) return;
        const final: Answers = Object.fromEntries(form.questions.map((q) => [q.id, answers[q.id] ?? { skipped: true }]));
        onSubmit(formatAnswers(form, final), final);
      }}
    >
      <p className="f-title">{form.title}</p>
      {form.intro && (
        <div className="f-intro">
          <Markdown md={form.intro} />
        </div>
      )}
      <ol className="f-questions">
        {form.questions.map((q, i) => {
          const a = answers[q.id];
          const unsure = a !== undefined && 'unsure' in a;
          return (
            <li key={q.id} className={`f-q kind-${q.kind} ${unsure ? 'unsure' : ''}`}>
              <div className="f-prompt">
                <span className="num">{pad(i + 1)}</span>
                <Markdown md={q.prompt} inline />
                {q.optional && <span className="quiet"> optional</span>}
              </div>
              <div className="f-body">
                {(q.kind === 'single' || q.kind === 'multi') && <Choice q={q} value={unsure ? undefined : a} onChange={(v) => set(q.id, v)} />}
                {q.kind === 'scale' && <Scale q={q} value={a} onChange={(v) => set(q.id, v)} />}
                {q.kind === 'rank' && <Rank q={q} value={a} onChange={(v) => set(q.id, v)} />}
                {q.kind === 'text' &&
                  (q.long ? (
                    <textarea
                      aria-label={q.prompt}
                      rows={3}
                      placeholder={q.placeholder}
                      value={a && 'text' in a ? a.text : ''}
                      onChange={(e) => set(q.id, { text: e.target.value })}
                    />
                  ) : (
                    <input aria-label={q.prompt} placeholder={q.placeholder} value={a && 'text' in a ? a.text : ''} onChange={(e) => set(q.id, { text: e.target.value })} />
                  ))}
                {q.kind === 'number' && (
                  <span className="f-number">
                    <input
                      aria-label={q.prompt}
                      type="number"
                      {...(q.min !== undefined ? { min: q.min } : {})}
                      {...(q.max !== undefined ? { max: q.max } : {})}
                      value={a && 'number' in a ? a.number : ''}
                      onChange={(e) => set(q.id, e.target.value === '' ? undefined : { number: Number(e.target.value) })}
                    />
                    {q.unit && <span className="quiet">{q.unit}</span>}
                  </span>
                )}
                {q.allowUnsure && (
                  <label className={`f-unsure ${unsure ? 'on' : ''}`}>
                    <input type="checkbox" checked={unsure} onChange={(e) => set(q.id, e.target.checked ? { unsure: true } : undefined)} />
                    <span className="px" aria-hidden />I don't know yet
                  </label>
                )}
              </div>
            </li>
          );
        })}
      </ol>
      <div className="f-foot">
        <span className="f-progress">
          <span className="num">
            {answered}/{form.questions.length}
          </span>{' '}
          answered
        </span>
        <button type="submit" className="primary" disabled={!done}>
          {form.submitLabel ?? 'Send answers'}
        </button>
      </div>
    </form>
  );
}
