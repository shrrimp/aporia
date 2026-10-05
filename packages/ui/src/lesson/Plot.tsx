import type { Plot as PlotDoc } from '@app/catalog';
import { evNum, type Env } from './eval.ts';
import { sample, ticks } from './geometry.ts';

const W = 600;
const H = 340;
const PAD = 44;

/** Renders a catalog plot: expression series are sampled, data series drawn as given. */
export function Plot({ doc, env = {} }: { doc: PlotDoc; env?: Env }) {
  const series = doc.series.map((s) => ({
    s,
    runs: s.expr ? sample((x) => evNum(s.expr!, { ...env, x }), doc.x.min, doc.x.max) : [s.data!.map(([x, y]) => ({ x, y }))],
  }));
  const ys = series.flatMap((r) => r.runs.flat().map((p) => p.y));
  let yMin = doc.y?.min ?? Math.min(...ys, 0);
  let yMax = doc.y?.max ?? Math.max(...ys, 0);
  if (!(yMax > yMin)) {
    yMin -= 1;
    yMax += 1;
  }
  const sx = (x: number) => PAD + ((x - doc.x.min) / (doc.x.max - doc.x.min)) * (W - 2 * PAD);
  const sy = (y: number) => H - PAD - ((y - yMin) / (yMax - yMin)) * (H - 2 * PAD);
  return (
    <figure className="plot">
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={doc.description}>
        <g className="axes">
          <line x1={PAD} y1={H - PAD} x2={W - PAD} y2={H - PAD} />
          <line x1={PAD} y1={PAD} x2={PAD} y2={H - PAD} />
          {ticks(doc.x.min, doc.x.max).map((t) => (
            <text key={`x${t}`} x={sx(t)} y={H - PAD + 18} textAnchor="middle">{+t.toPrecision(4)}</text>
          ))}
          {ticks(yMin, yMax).map((t) => (
            <text key={`y${t}`} x={PAD - 6} y={sy(t) + 4} textAnchor="end">{+t.toPrecision(4)}</text>
          ))}
          <text x={W / 2} y={H - 6} textAnchor="middle" className="axis-label">{doc.x.label}</text>
          {doc.y?.label && <text x={12} y={H / 2} transform={`rotate(-90 12 ${H / 2})`} textAnchor="middle" className="axis-label">{doc.y.label}</text>}
        </g>
        {series.map(({ s, runs }, i) => (
          <g key={i} className={`series role-${s.role} series-${i}`}>
            {runs.map((run, j) => (
              <polyline key={j} points={run.map((p) => `${sx(p.x)},${sy(p.y)}`).join(' ')} />
            ))}
          </g>
        ))}
      </svg>
      <figcaption>
        {doc.description}
        {doc.series.length > 1 && (
          <span className="legend">
            {doc.series.map((s, i) => (
              <span key={i} className={`legend-item series-${i}`}>{s.label}</span>
            ))}
          </span>
        )}
      </figcaption>
    </figure>
  );
}
