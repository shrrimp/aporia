import { useRef, useState, type PointerEvent } from 'react';
import type { Diagram as DiagramDoc, DiagramElement } from '@app/catalog';
import { evNum, evQuat, evVec, type Env, type Vec } from './eval.ts';
import { DEFAULT_CAMERA, add, boxEdges, frameAxes, project, type Camera } from './geometry.ts';

interface Shape {
  readonly key: string;
  readonly depth: number;
  readonly el: React.ReactElement;
}

const AXIS = ['x', 'y', 'z'] as const;

function shapesFor(e: DiagramElement, i: number, dims: 2 | 3, env: Env, cam: Camera): Shape[] {
  const P = (v: Vec) => project(v, cam);
  const cls = `el role-${e.role}`;
  const origin: Vec = dims === 2 ? [0, 0] : [0, 0, 0];
  switch (e.kind) {
    case 'point': {
      const p = P(evVec(e.at, env, dims));
      return [
        {
          key: `p${i}`,
          depth: p.depth,
          el: (
            <g key={`p${i}`} className={cls}>
              <circle cx={p.x} cy={p.y} r={0.045} className="point" />
              {e.label && <text x={p.x + 0.07} y={p.y - 0.07} className="label">{e.label}</text>}
            </g>
          ),
        },
      ];
    }
    case 'label': {
      const p = P(evVec(e.at, env, dims));
      return [{ key: `l${i}`, depth: p.depth, el: <text key={`l${i}`} x={p.x} y={p.y} className={`${cls} label`}>{e.text}</text> }];
    }
    case 'vector':
    case 'segment': {
      const a = P(e.from ? evVec(e.from, env, dims) : origin);
      const b = P(evVec(e.to, env, dims));
      return [
        {
          key: `v${i}`,
          depth: (a.depth + b.depth) / 2,
          el: (
            <g key={`v${i}`} className={cls}>
              <line x1={a.x} y1={a.y} x2={b.x} y2={b.y} className="stroke" markerEnd={e.kind === 'vector' ? 'url(#arrow)' : undefined} />
              {e.label && <text x={b.x + 0.06} y={b.y - 0.06} className="label">{e.label}</text>}
            </g>
          ),
        },
      ];
    }
    case 'polyline': {
      const pts = e.points.map((s) => P(evVec(s, env, dims)));
      const d = pts.map((p, j) => `${j ? 'L' : 'M'}${p.x} ${p.y}`).join(' ') + (e.closed ? ' Z' : '');
      return [{ key: `pl${i}`, depth: pts.reduce((s, p) => s + p.depth, 0) / pts.length, el: <path key={`pl${i}`} d={d} className={`${cls} stroke fill-none`} /> }];
    }
    case 'circle': {
      const c = P(evVec(e.center, env, 2));
      return [{ key: `c${i}`, depth: 0, el: <circle key={`c${i}`} cx={c.x} cy={c.y} r={Math.abs(evNum(e.radius, env))} className={`${cls} stroke fill-none`} /> }];
    }
    case 'frame': {
      const at = e.at ? evVec(e.at, env, dims) : origin;
      const axes = dims === 3 ? frameAxes(evQuat(e.rotation, env), e.size, 3) : frameAxes(evQuat(undefined, env), e.size, 2, e.rotation ? evNum(e.rotation, env) : 0);
      const o = P(at);
      return axes.map((ax, k) => {
        const tip = P(add(at, ax));
        return {
          key: `f${i}${k}`,
          depth: (o.depth + tip.depth) / 2,
          el: (
            <g key={`f${i}${k}`} className={`${cls} axis axis-${AXIS[k]}`}>
              <line x1={o.x} y1={o.y} x2={tip.x} y2={tip.y} className="stroke" markerEnd="url(#arrow)" />
              {k === 0 && e.label && <text x={o.x - 0.12} y={o.y + 0.16} className="label">{e.label}</text>}
            </g>
          ),
        };
      });
    }
    case 'box': {
      const center = e.center ? evVec(e.center, env, 3) : [0, 0, 0];
      return boxEdges(center, evVec(e.size, env, 3), evQuat(e.rotation, env)).map(([a, b], k) => {
        const pa = P(a);
        const pb = P(b);
        return {
          key: `b${i}${k}`,
          depth: (pa.depth + pb.depth) / 2,
          el: <line key={`b${i}${k}`} x1={pa.x} y1={pa.y} x2={pb.x} y2={pb.y} className={`${cls} stroke`} />,
        };
      });
    }
  }
}

/** Renders a catalog diagram. 3D diagrams can be orbited by dragging. */
export function Diagram({ doc, env = {} }: { doc: DiagramDoc; env?: Env }) {
  const [cam, setCam] = useState<Camera>(DEFAULT_CAMERA);
  const drag = useRef<{ x: number; y: number; cam: Camera } | null>(null);
  const ext = doc.extent;
  let shapes: Shape[] = [];
  let error: string | undefined;
  try {
    shapes = doc.elements.flatMap((e, i) => shapesFor(e, i, doc.dims, env, cam));
  } catch (err) {
    error = (err as Error).message;
  }
  shapes.sort((a, b) => a.depth - b.depth);
  const onDown = (ev: PointerEvent<SVGSVGElement>) => {
    if (doc.dims !== 3) return;
    drag.current = { x: ev.clientX, y: ev.clientY, cam };
    ev.currentTarget.setPointerCapture?.(ev.pointerId);
  };
  const onMove = (ev: PointerEvent<SVGSVGElement>) => {
    const d = drag.current;
    if (!d) return;
    const pitch = Math.max(-1.5, Math.min(1.5, d.cam.pitch + (ev.clientY - d.y) * 0.01));
    setCam({ yaw: d.cam.yaw - (ev.clientX - d.x) * 0.01, pitch });
  };
  return (
    <figure className={`diagram dims-${doc.dims}`}>
      <svg
        viewBox={`${-ext} ${-ext} ${2 * ext} ${2 * ext}`}
        role="img"
        aria-label={doc.description}
        onPointerDown={onDown}
        onPointerMove={onMove}
        onPointerUp={() => (drag.current = null)}
        style={{ fontSize: ext * 0.08, strokeWidth: ext * 0.012 }}
      >
        <defs>
          <marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="5" markerHeight="5" orient="auto-start-reverse">
            <path d="M0 0 L10 5 L0 10 z" className="arrowhead" />
          </marker>
        </defs>
        {shapes.map((s) => s.el)}
      </svg>
      {error ? <figcaption className="error">Could not draw: {error}</figcaption> : <figcaption>{doc.description}</figcaption>}
    </figure>
  );
}
