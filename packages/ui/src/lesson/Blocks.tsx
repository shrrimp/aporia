import { useState } from 'react';
import katex from 'katex';
import { blockKey, taskKey, type Component } from '@app/catalog';
import { useAnchor, useSaved } from './progress.tsx';
import { HintLadder, StuckButton } from './hints.tsx';
import { Markdown } from './Markdown.tsx';
import { Diagram } from './Diagram.tsx';
import { Plot } from './Plot.tsx';
import { Explorable } from './Explorable.tsx';
import { Drill } from './Drill.tsx';
import { useLessonActions } from './actions.tsx';
import { Checkpoint } from './checkpoints.tsx';

type Of<T extends Component['type']> = Extract<Component, { type: T }>;

function MathBlock({ doc }: { doc: Of<'math'> }) {
  // KaTeX output is generated from TeX by the app's own renderer, never from agent HTML; trust is off.
  const html = katex.renderToString(doc.tex, { displayMode: true, throwOnError: false, trust: false, strict: 'ignore' });
  return (
    <div className="math-block">
      <div className="math" dangerouslySetInnerHTML={{ __html: html }} />
      {doc.tag && <span className="math-tag">({doc.tag})</span>}
    </div>
  );
}

const CODE_LABEL: Record<Of<'code'>['kind'], string> = {
  stub: 'Your function to write',
  api: 'How to use it',
  layout: 'Data layout',
  analogue: 'Worked example (a similar problem)',
  trace: 'Your code, line by line',
  contrast: 'Spot the difference',
};

function CodeBlock({ doc }: { doc: Of<'code'> }) {
  const lines = doc.source.split('\n');
  const notes = new Map(doc.annotations.map((a) => [a.line, a.note]));
  const goals = new Map((doc.subgoals ?? []).map((g) => [g.line, g.label]));
  const render = (src: string, label: string) => (
    <figure className={`code kind-${doc.kind}`}>
      <figcaption>
        {label}
        {doc.file && <span className="file"> · {doc.file}</span>}
      </figcaption>
      <pre>
        <code className={`lang-${doc.lang}`}>
          {src.split('\n').map((l, i) => (
            <span key={i} className="line">
              {goals.has(i + 1) && <span className="subgoal">{goals.get(i + 1)}</span>}
              {l || ' '}
              {notes.has(i + 1) && <span className="note">{notes.get(i + 1)}</span>}
              {'\n'}
            </span>
          ))}
        </code>
      </pre>
      {doc.caption && <p className="caption">{doc.caption}</p>}
    </figure>
  );
  if (doc.kind === 'contrast') {
    return (
      <div className="contrast">
        {render(lines.join('\n'), 'Version A')}
        {render(doc.variant ?? '', 'Version B')}
        {doc.difference && <p className="difference">Differs in: {doc.difference}</p>}
      </div>
    );
  }
  return render(doc.source, CODE_LABEL[doc.kind]);
}

function Reveal({ prompt, reveal, options }: { prompt: string; reveal: string; options?: string[] }) {
  const [saved, save] = useSaved<{ answer: string }>(blockKey(useAnchor()));
  const [answer, setAnswer] = useState(saved?.answer ?? '');
  const [shown, setShown] = useState(saved !== undefined);
  return (
    <div className={`reveal ${shown ? 'shown' : ''}`}>
      <Markdown md={prompt} />
      {!shown && (
        <>
          {options ? (
            <div className="options" role="radiogroup">
              {options.map((o) => (
                <label key={o}>
                  <input type="radio" checked={answer === o} onChange={() => setAnswer(o)} />
                  <Markdown md={o} inline />
                </label>
              ))}
            </div>
          ) : (
            <textarea aria-label="Your thinking" rows={3} value={answer} onChange={(e) => setAnswer(e.target.value)} />
          )}
          <button
            type="button"
            disabled={answer.trim() === ''}
            onClick={() => {
              setShown(true);
              save({ answer });
            }}
          >
            Reveal
          </button>
        </>
      )}
      {shown && (
        <div className="revealed">
          <p className="your-answer">You said: {answer}</p>
          <Markdown md={reveal} />
        </div>
      )}
    </div>
  );
}

function ExplainBack({ doc }: { doc: Of<'explain-back'> }) {
  const actions = useLessonActions();
  const anchor = useAnchor();
  const [saved, save] = useSaved<{ text: string }>(blockKey(anchor));
  const [text, setText] = useState(saved?.text ?? '');
  const [sent, setSent] = useState(saved !== undefined);
  return (
    <div className="explain-back">
      <header>Explain it back</header>
      <Markdown md={doc.prompt} />
      <textarea aria-label="Your explanation" rows={5} disabled={sent} value={text} onChange={(e) => setText(e.target.value)} />
      <button
        type="button"
        disabled={sent || text.trim().length < 10}
        onClick={() => {
          setSent(true);
          save({ text });
          actions.ask(
            `Explain-back on ${doc.kcs.join(', ')}. Prompt: ${doc.prompt}\nMy explanation: ${text}\nRubric: ${doc.rubric.join('; ')}\n` +
              'Score it 0–5 twice independently against the rubric, record the evidence (explain-back, with agreement), then tell me what I got right and the one thing to fix, ' +
              'and send me back to the lesson.',
            { anchor },
          );
        }}
      >
        {sent ? 'Sent to your tutor' : 'Send to your tutor'}
      </button>
    </div>
  );
}

const SCAFFOLD = ['Open problem', 'Goal only', 'Contract', 'Completion', 'Guided'];

function Task({ doc }: { doc: Of<'task'> }) {
  const actions = useLessonActions();
  const [saved, save] = useSaved<{ done: true }>(taskKey(doc.id));
  const [done, setDone] = useState(saved !== undefined);
  return (
    <article className={`task ${done ? 'done' : ''}`} data-anchor={`task:${doc.id}`}>
      <header>
        <span className="task-label">Task</span> {doc.title}
        <span className="scaffold" title="How much structure this task gives you">{SCAFFOLD[doc.scaffold]} level</span>
      </header>
      {doc.files.length > 0 && (
        <p className="files">
          {doc.files.map((f, i) => (
            <span key={f}>
              {i > 0 && ' · '}
              {actions.openFile ? (
                <button type="button" className="text file-link" onClick={() => actions.openFile!(f)} title="Open in the editor">
                  {f}
                </button>
              ) : (
                f
              )}
            </span>
          ))}
        </p>
      )}
      <Markdown md={doc.goal} />
      {doc.contract && (
        <section>
          <h4>Contract</h4>
          <Markdown md={doc.contract} />
        </section>
      )}
      {doc.traps.length > 0 && (
        <details>
          <summary>Traps to watch for ({doc.traps.length})</summary>
          <ul>
            {doc.traps.map((t, i) => (
              <li key={i}><Markdown md={t} inline /></li>
            ))}
          </ul>
        </details>
      )}
      {doc.checkpoint && <Checkpoint taskId={doc.id} suite={doc.checkpoint.suite} expect={doc.checkpoint.expect} />}
      <HintLadder taskId={doc.id} />
      <StuckButton taskId={doc.id} title={doc.title} ask={(q) => actions.ask(q, { anchor: `task:${doc.id}` })} />
      <label className="task-done">
        <input
          type="checkbox"
          checked={done}
          onChange={(e) => {
            setDone(e.target.checked);
            save(e.target.checked ? { done: true } : null);
          }}
        />
        <span className="px" aria-hidden />
        Done
      </label>
    </article>
  );
}

export function Block({ doc }: { doc: Component }) {
  switch (doc.type) {
    case 'prose':
      return <Markdown md={doc.md} />;
    case 'math':
      return <MathBlock doc={doc} />;
    case 'callout':
      return (
        <aside className={`callout kind-${doc.kind}`}>
          {doc.title && <header>{doc.title}</header>}
          <Markdown md={doc.md} />
        </aside>
      );
    case 'code':
      return <CodeBlock doc={doc} />;
    case 'table':
      return (
        <div className="table-wrap">
          <table>
            {doc.caption && <caption>{doc.caption}</caption>}
            <thead>
              <tr>{doc.columns.map((c, i) => <th key={i}>{c}</th>)}</tr>
            </thead>
            <tbody>
              {doc.rows.map((r, i) => (
                <tr key={i}>{r.map((c, j) => <td key={j}><Markdown md={c} inline /></td>)}</tr>
              ))}
            </tbody>
          </table>
        </div>
      );
    case 'diagram':
      return <Diagram doc={doc} />;
    case 'plot':
      return <Plot doc={doc} />;
    case 'explorable':
      return <Explorable doc={doc} />;
    case 'drill':
      return <Drill doc={doc} />;
    case 'predict':
      return (
        <div className="predict">
          <header>Predict</header>
          <Reveal prompt={doc.prompt} reveal={doc.reveal} {...(doc.options ? { options: doc.options } : {})} />
        </div>
      );
    case 'think-first':
      return (
        <div className="think-first">
          <header>Think first</header>
          <Reveal prompt={doc.prompt} reveal={doc.reveal} />
        </div>
      );
    case 'explain-back':
      return <ExplainBack doc={doc} />;
    case 'task':
      return <Task doc={doc} />;
    case 'open-loop':
      return (
        <aside className="open-loop">
          <header>Next</header>
          <Markdown md={doc.md} />
        </aside>
      );
    case 'utility-link':
      return (
        <aside className="utility-link">
          <Markdown md={doc.md} />
          {doc.prompt && <p className="prompt">{doc.prompt}</p>}
        </aside>
      );
  }
}
