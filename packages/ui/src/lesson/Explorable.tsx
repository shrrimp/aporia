import { useCallback, useEffect, useRef, useState } from 'react';
import { blockKey, formatValue, type Explorable as ExplorableDoc } from '@app/catalog';
import { useAnchor, useSaved } from './progress.tsx';
import { Diagram } from './Diagram.tsx';
import { Plot } from './Plot.tsx';
import { ev, runAssignments, type Env, type Value } from './eval.ts';

/** Initial environment: control values, then state expressions in order. */
export function initialEnv(doc: ExplorableDoc): Record<string, Value> {
  const env: Record<string, Value> = {};
  for (const c of doc.controls) {
    if (c.kind === 'slider') env[c.name] = c.initial ?? c.min;
    else if (c.kind === 'toggle') env[c.name] = c.initial;
  }
  for (const [name, src] of Object.entries(doc.state)) env[name] = ev(src, env);
  return env;
}

export function Explorable({ doc }: { doc: ExplorableDoc }) {
  const [saved, save] = useSaved<{ prediction: string }>(blockKey(useAnchor()));
  const [predicted, setPredicted] = useState(doc.predictFirst === undefined || saved !== undefined);
  const [prediction, setPrediction] = useState(saved?.prediction ?? '');
  const [env, setEnv] = useState<Record<string, Value>>(() => initialEnv(doc));
  const [error, setError] = useState<string>();
  const [playing, setPlaying] = useState<number | null>(null);
  const envRef = useRef(env);
  envRef.current = env;

  const apply = useCallback(
    (src: string) => {
      try {
        setEnv(runAssignments(src, envRef.current) as Record<string, Value>);
        setError(undefined);
      } catch (err) {
        setError((err as Error).message);
        setPlaying(null);
      }
    },
    [],
  );

  useEffect(() => {
    if (playing === null) return;
    const c = doc.controls[playing];
    if (c?.kind !== 'play') return;
    const id = setInterval(() => apply(c.do), 1000 / c.fps);
    return () => clearInterval(id);
  }, [playing, doc, apply]);

  if (!predicted) {
    return (
      <div className="explorable locked">
        <p className="predict-label">Before you try it: {doc.predictFirst}</p>
        <textarea aria-label="Your prediction" value={prediction} onChange={(e) => setPrediction(e.target.value)} rows={2} />
        <button type="button" disabled={prediction.trim() === ''} onClick={() => {
            setPredicted(true);
            save({ prediction });
          }}>
          Commit prediction
        </button>
      </div>
    );
  }

  const set = (name: string, value: Value) => setEnv((e) => ({ ...e, [name]: value }));
  return (
    <div className="explorable">
      {prediction && <p className="your-prediction">Your prediction: {prediction}</p>}
      <div className="controls">
        {doc.controls.map((c, i) => {
          switch (c.kind) {
            case 'slider':
              return (
                <label key={i} className="slider">
                  <span>{c.label}</span>
                  <input type="range" min={c.min} max={c.max} step={c.step} value={env[c.name] as number} onChange={(e) => set(c.name, Number(e.target.value))} />
                  <output>{formatValue(env[c.name]!, 2)}</output>
                </label>
              );
            case 'toggle':
              return (
                <label key={i} className="toggle">
                  <input type="checkbox" checked={env[c.name] as boolean} onChange={(e) => set(c.name, e.target.checked)} />
                  {c.label}
                </label>
              );
            case 'button':
              return (
                <button key={i} type="button" className={`role-${c.role}`} onClick={() => apply(c.do)}>
                  {c.label}
                </button>
              );
            case 'play':
              return (
                <button key={i} type="button" aria-pressed={playing === i} onClick={() => setPlaying(playing === i ? null : i)}>
                  {playing === i ? 'Pause' : c.label}
                </button>
              );
            case 'reset':
              return (
                <button
                  key={i}
                  type="button"
                  onClick={() => {
                    setPlaying(null);
                    setError(undefined);
                    setEnv(initialEnv(doc));
                  }}
                >
                  {c.label}
                </button>
              );
          }
        })}
      </div>
      <div className="explorable-body">
        {doc.view.type === 'diagram' ? <Diagram doc={doc.view} env={env as Env} /> : <Plot doc={doc.view} env={env as Env} />}
        {doc.readouts.length > 0 && (
          <dl className="readouts">
            {doc.readouts.map((r, i) => {
              let text: string;
              try {
                text = formatValue(ev(r.expr, env), r.digits);
              } catch (err) {
                text = `⚠ ${(err as Error).message}`;
              }
              return (
                <div key={i}>
                  <dt>{r.label}</dt>
                  <dd className="num">{text}</dd>
                </div>
              );
            })}
          </dl>
        )}
      </div>
      {error && <p className="error" role="alert">{error}</p>}
      <p className="sr-only">{doc.description}</p>
    </div>
  );
}
