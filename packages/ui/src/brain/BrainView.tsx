import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode, type PointerEvent as ReactPointerEvent, type WheelEvent as ReactWheelEvent } from 'react';
import type { BrainDTO, BrainNodeDTO } from '@app/server/protocol';
import { useQuery } from '../hooks.tsx';
import { bounds, createSim, fit, reheat, settle, step, SETTLED, type Sim } from './layout.ts';
import { css, groupColors, skillColors } from './color.ts';
import { groupStats, visible, visibleLinks, type Folded } from './lod.ts';
import { depthOf, groupTree, OTHER, pathOf, type GroupTree } from './tree.ts';

/** How a skill looks: from evidence (computed by the app), or a suggestion not met yet. */
export type Look = 'undiscovered' | 'claimed' | 'unseen' | 'learning' | 'mastered' | 'durable';

export function lookOf(n: BrainNodeDTO): Look {
  // A claim is what the learner's work suggests; it is shown apart until evidence speaks (P4).
  if (!n.discovered) return n.claim ? 'claimed' : n.suggested ? 'undiscovered' : 'unseen';
  if (n.mastery === 'durable') return 'durable';
  if (n.mastery === 'provisional') return 'mastered';
  return 'learning';
}

const LOOK_LABEL: Record<Look, string> = {
  undiscovered: 'not discovered yet: a suggestion',
  claimed: 'claimed from your work, to verify',
  unseen: 'planned, not met yet',
  learning: 'learning',
  mastered: 'got it (to confirm later)',
  durable: 'learned, and it stuck',
};

export const radiusOf = (n: BrainNodeDTO) => (n.discovered ? Math.min(18, 7 + 2.2 * Math.sqrt(n.evidence)) : 6);

function prefersReducedMotion(): boolean {
  return typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/** Ticks run before the first frame, so the map opens already close to its shape. */
const WARM_UP = 80;
/** Skill names show from this zoom (screen pixels per map unit) up; below it, hover or pick a skill. */
const LABELS_FROM = 0.6;
/** A group is named on the map only when its skills spread over this much screen, at least. */
const GROUP_LABEL_PX = 40;
/** Assumed width before the map has been measured (and in tests). */
const DEFAULT_PX = 1200;

/** Fill of a folded group: how much of it the learner has met, weighted by how well. */
const METWEIGHT: Record<Look, number> = { durable: 1, mastered: 0.75, learning: 0.45, claimed: 0, unseen: 0, undiscovered: 0 };

type View = { x: number; y: number; width: number; height: number };

/** The map: an SVG the learner can pan, zoom, and rearrange by dragging. Groups fold into one node when zoomed out. */
function BrainMap({
  data,
  tree,
  fold,
  selected,
  onSelect,
}: {
  data: BrainDTO;
  tree: GroupTree;
  fold: boolean;
  selected: string | undefined;
  onSelect: (id: string | undefined) => void;
}) {
  const key = JSON.stringify([data.nodes.map((n) => [n.id, n.group]), data.groups, data.edges]);
  const sim = useMemo<Sim>(() => {
    const s = createSim(
      data.nodes.map((n) => ({ id: n.id, group: tree.groupOf.get(n.id), weight: n.discovered ? 1 + n.evidence / 20 : 0.7 })),
      data.edges,
      tree,
    );
    if (prefersReducedMotion()) settle(s);
    else for (let i = 0; i < WARM_UP; i++) step(s);
    return s;
    // The layout only restarts when the skills, groups or links change, not when levels do.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  const colors = useMemo(() => {
    const groups = groupColors(tree, sim.regions);
    const skills = skillColors(
      sim.nodes.map((n) => n.id),
      (id) => tree.groupOf.get(id),
      sim.links,
      groups,
    );
    return { groups, skills };
  }, [sim, tree]);
  const [, setTick] = useState(0);
  const [view, setView] = useState<View>(() => fit(bounds(sim)));
  const [px, setPx] = useState({ width: 0, height: 0 });
  const svg = useRef<SVGSVGElement>(null);
  const frame = useRef<number | undefined>(undefined);
  const drag = useRef<{ kind: 'node'; index: number } | { kind: 'pan'; x: number; y: number; view: View } | undefined>(undefined);

  useEffect(() => setView(fit(bounds(sim))), [sim]);
  // The map's width on screen decides what folds.
  useEffect(() => {
    const el = svg.current!;
    const measure = () => {
      const r = el.getBoundingClientRect();
      setPx({ width: r.width, height: r.height });
    };
    measure();
    if (typeof ResizeObserver !== 'function') return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Float into place, then stop: no motion once the layout rests (P7: calm, not a game).
  const animate = useCallback(() => {
    if (frame.current !== undefined || prefersReducedMotion() || typeof requestAnimationFrame !== 'function') return;
    const loop = () => {
      step(sim);
      setTick((t) => t + 1);
      frame.current = sim.alpha > SETTLED ? requestAnimationFrame(loop) : undefined;
    };
    frame.current = requestAnimationFrame(loop);
  }, [sim]);
  useEffect(() => {
    animate();
    return () => {
      if (frame.current !== undefined) cancelAnimationFrame(frame.current);
      frame.current = undefined;
    };
  }, [animate]);

  /** Screen point → map coordinates. */
  const toMap = (clientX: number, clientY: number) => {
    const r = svg.current!.getBoundingClientRect();
    const sx = r.width ? view.width / r.width : 1;
    const sy = r.height ? view.height / r.height : 1;
    return { x: view.x + (clientX - r.left) * sx, y: view.y + (clientY - r.top) * sy };
  };
  /** Zoom by `f` around a map point (f > 1 zooms out), within limits. */
  const zoom = (f: number, p = { x: view.x + view.width / 2, y: view.y + view.height / 2 }) =>
    setView((v) => {
      const g = Math.min(Math.max(f, MIN_WIDTH / v.width), MAX_WIDTH / v.width);
      return { x: p.x - (p.x - v.x) * g, y: p.y - (p.y - v.y) * g, width: v.width * g, height: v.height * g };
    });

  const onPointerDown = (e: ReactPointerEvent, index?: number) => {
    e.stopPropagation();
    (e.target as Element).setPointerCapture?.(e.pointerId);
    if (index === undefined) drag.current = { kind: 'pan', x: e.clientX, y: e.clientY, view };
    else {
      drag.current = { kind: 'node', index };
      sim.nodes[index]!.pinned = true;
    }
  };
  const onPointerMove = (e: ReactPointerEvent) => {
    const d = drag.current;
    if (!d) return;
    if (d.kind === 'node') {
      const p = toMap(e.clientX, e.clientY);
      const n = sim.nodes[d.index]!;
      n.x = p.x;
      n.y = p.y;
      reheat(sim);
      setTick((t) => t + 1);
      animate();
    } else {
      const r = svg.current!.getBoundingClientRect();
      const s = r.width ? d.view.width / r.width : 1;
      setView({ ...d.view, x: d.view.x - (e.clientX - d.x) * s, y: d.view.y - (e.clientY - d.y) * s });
    }
  };
  const onPointerUp = () => {
    const d = drag.current;
    if (d?.kind === 'node') sim.nodes[d.index]!.pinned = false;
    drag.current = undefined;
  };
  const onWheel = (e: ReactWheelEvent) => zoom(Math.min(1.5, Math.max(0.66, Math.exp(e.deltaY * 0.0015))), toMap(e.clientX, e.clientY));

  // The view is fitted inside the map (preserveAspectRatio "meet"): the tighter side sets the scale.
  const scale = px.width && px.height ? Math.min(px.width / view.width, px.height / view.height) : DEFAULT_PX / view.width;
  const stats = groupStats(sim.nodes, tree);
  const shown = visible(sim.nodes, tree, scale, fold, stats);
  const links = visibleLinks(sim.links, shown.rep);
  const foldedById = new Map(shown.folded.map((f) => [f.id, f]));
  const at = (rep: string) => (rep.startsWith('s:') ? sim.nodes[Number(rep.slice(2))]! : foldedById.get(rep.slice(2))!);

  const byId = new Map(data.nodes.map((n) => [n.id, n]));
  const neighbours = new Set(selected ? data.edges.flatMap((e) => (e.from === selected ? [e.to] : e.to === selected ? [e.from] : [])) : []);
  const discovered = data.nodes.filter((n) => n.discovered).length;
  const groupColor = (g: string) => colors.groups.get(g) ?? { L: 0.68, a: 0, b: 0 };
  const radiusOfFold = (f: Folded) => Math.max(f.spread * 0.8, 14 / scale);
  /** Open a folded group: zoom so its skills fill most of the map. */
  const openGroup = (f: Folded) => {
    const r = svg.current!.getBoundingClientRect();
    const aspect = r.width && r.height ? r.height / r.width : view.height / view.width;
    // Twice its spread, with a margin: it then spans about a third of the map, well past FOLD_PX.
    const width = Math.max(MIN_WIDTH, f.spread * 2 * 1.7);
    setView({ x: f.x - width / 2, y: f.y - (width * aspect) / 2, width, height: width * aspect });
  };

  return (
    <>
      <svg
        ref={svg}
        className="brain-map"
        viewBox={`${view.x} ${view.y} ${view.width} ${view.height}`}
        role="group"
        aria-label={`Map of ${data.nodes.length} skills, ${discovered} met so far`}
        onPointerDown={(e) => {
          onSelect(undefined);
          onPointerDown(e);
        }}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onWheel={onWheel}
      >
        <defs>
          <marker id="brain-arrow" viewBox="0 0 10 10" refX="10" refY="5" markerWidth="5" markerHeight="5" orient="auto-start-reverse">
            <path d="M0,0 L10,5 L0,10 z" className="brain-arrowhead" />
          </marker>
          {tree.ids.map((g, i) => (
            <radialGradient key={g} id={`brain-tint-${i}`}>
              <stop offset="0%" stopColor={css(groupColor(g), 0.2)} />
              <stop offset="100%" stopColor={css(groupColor(g), 0)} />
            </radialGradient>
          ))}
        </defs>
        {/* Each open group's region, tinted in its colour: the map's areas, at a glance. */}
        {shown.open.map((g) => {
          const s = stats.get(g)!;
          return depthOf(tree, g) <= 2 ? <circle key={g} className="brain-region" cx={s.x} cy={s.y} r={s.spread + 60} fill={`url(#brain-tint-${tree.ids.indexOf(g)})`} /> : null;
        })}
        {links.map((l) => {
          const a = at(l.a);
          const b = at(l.b);
          const end = l.b.startsWith('s:') ? Math.max(radiusOf(byId.get(sim.nodes[Number(l.b.slice(2))]!.id)!), 3.5 / scale) + 3 / scale : radiusOfFold(b as Folded);
          const d = Math.max(1e-6, Math.hypot(b.x - a.x, b.y - a.y));
          const ids = [l.a, l.b].flatMap((r) => (r.startsWith('s:') ? [sim.nodes[Number(r.slice(2))]!.id] : []));
          const on = selected !== undefined && ids.includes(selected);
          return (
            <line
              key={l.key}
              className={`brain-edge kind-${l.kind ?? 'merged'} ${on ? 'on' : ''}`}
              x1={a.x}
              y1={a.y}
              x2={b.x - ((b.x - a.x) / d) * end}
              y2={b.y - ((b.y - a.y) / d) * end}
              {...(l.kind === undefined ? { style: { strokeWidth: 1 + Math.log2(l.count) } } : {})}
              {...(l.kind === 'prereq' ? { markerEnd: 'url(#brain-arrow)' } : {})}
            />
          );
        })}
        {shown.folded.map((f) => {
          const title = tree.title.get(f.id) ?? f.id;
          const nodes = f.members.map((i) => byId.get(sim.nodes[i]!.id)!);
          const met = nodes.filter((n) => n.discovered).length;
          const progress = nodes.reduce((t, n) => t + METWEIGHT[lookOf(n)], 0) / nodes.length;
          const struggling = nodes.filter((n) => n.struggling.length > 0).length;
          const r = radiusOfFold(f);
          const open = () => openGroup(f);
          return (
            <g
              key={f.id}
              className={`brain-fold ${struggling ? 'struggling' : ''}`}
              transform={`translate(${f.x} ${f.y})`}
              style={{ '--c': css(groupColor(f.id)) } as CSSProperties}
              role="button"
              tabIndex={0}
              aria-label={`${title}: ${nodes.length} skills, ${met} met${struggling ? `, ${struggling} need attention` : ''}. Open it`}
              onPointerDown={(e) => e.stopPropagation()}
              onClick={open}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  open();
                }
              }}
            >
              {struggling > 0 && <circle className="brain-halo" r={r + 5 / scale} />}
              <circle r={r} style={{ fillOpacity: 0.18 + 0.62 * progress }} />
              <text y={r + 15 / scale} textAnchor="middle" fontSize={13 / scale} style={{ strokeWidth: 3 / scale }}>
                {title} <tspan className="count">{nodes.length}</tspan>
              </text>
            </g>
          );
        })}
        {shown.skills.map((i) => {
          const s = sim.nodes[i]!;
          const n = byId.get(s.id)!;
          const look = lookOf(n);
          const dim = selected !== undefined && selected !== n.id && !neighbours.has(n.id);
          const r = Math.max(radiusOf(n), 3.5 / scale);
          const label = scale >= LABELS_FROM || selected === n.id || neighbours.has(n.id);
          return (
            <g
              key={n.id}
              className={`brain-node look-${look} ${n.struggling.length ? 'struggling' : ''} ${selected === n.id ? 'selected' : ''} ${dim ? 'dim' : ''}`}
              transform={`translate(${s.x} ${s.y})`}
              style={{ '--c': css(colors.skills[i]!) } as CSSProperties}
              role="button"
              tabIndex={0}
              aria-pressed={selected === n.id}
              aria-label={`${n.title}: ${LOOK_LABEL[look]}${n.struggling.length ? `; needs attention: ${n.struggling.join(', ')}` : ''}`}
              onPointerDown={(e) => {
                onSelect(n.id);
                onPointerDown(e, i);
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  onSelect(n.id);
                }
              }}
            >
              {n.struggling.length > 0 && <circle className="brain-halo" r={r + 5 / scale} />}
              <circle r={r} style={{ opacity: n.discovered ? 0.45 + 0.55 * n.confidence : 1 }} />
              {label ? (
                <text y={r + 13 / scale} textAnchor="middle" fontSize={11.5 / scale} style={{ strokeWidth: 3 / scale }}>
                  {n.title}
                </text>
              ) : (
                <title>{n.title}</title>
              )}
            </g>
          );
        })}
        {/* Names of the open domains and areas, above their region, in their colour. */}
        {shown.open.map((g) => {
          const depth = depthOf(tree, g);
          const s = stats.get(g)!;
          // Too small on screen to name (the map far out, unfolded: colours only).
          if (depth > 2 || (s.extent + 40) * scale < GROUP_LABEL_PX) return null;
          return (
            <text
              key={g}
              className={`brain-group depth-${depth}`}
              x={s.x}
              y={s.y - s.extent - (depth === 1 ? 36 : 20) / scale}
              textAnchor="middle"
              fontSize={(depth === 1 ? 15 : 12) / scale}
              style={{ fill: css(groupColor(g)), strokeWidth: 4 / scale }}
              aria-hidden
            >
              {tree.title.get(g) ?? g}
            </text>
          );
        })}
      </svg>
      <div className="brain-zoom" role="group" aria-label="Zoom">
        <button type="button" aria-label="Zoom in" onClick={() => zoom(0.67)}>
          +
        </button>
        <button type="button" aria-label="Zoom out" onClick={() => zoom(1.5)}>
          −
        </button>
        <button type="button" onClick={() => setView(fit(bounds(sim)))}>
          Fit
        </button>
      </div>
    </>
  );
}

/** How far the map zooms in and out (the width of the view, in map units). */
const MIN_WIDTH = 160;
const MAX_WIDTH = 60_000;

function Details({ node, data, tree, onClose }: { node: BrainNodeDTO; data: BrainDTO; tree: GroupTree; onClose: () => void }) {
  const look = lookOf(node);
  const title = (id: string) => data.nodes.find((n) => n.id === id)?.title ?? id;
  const before = data.edges.filter((e) => e.kind === 'prereq' && e.to === node.id).map((e) => title(e.from));
  const after = data.edges.filter((e) => e.kind === 'prereq' && e.from === node.id).map((e) => title(e.to));
  const confusable = data.edges.filter((e) => e.kind === 'confusable' && (e.from === node.id || e.to === node.id)).map((e) => title(e.from === node.id ? e.to : e.from));
  return (
    <aside className="brain-details" aria-label={node.title}>
      <button type="button" className="text close" onClick={onClose} aria-label="Close">
        close
      </button>
      <p className="meta">
        {tree.groupOf.get(node.id) === OTHER || tree.groupOf.get(node.id) === undefined
          ? 'Skill'
          : pathOf(tree, tree.groupOf.get(node.id)!)
              .map((g) => tree.title.get(g) ?? g)
              .join(' › ')}
      </p>
      <h2>{node.title}</h2>
      {node.summary && <p>{node.summary}</p>}
      <p className={`look look-${look}`}>{LOOK_LABEL[look]}</p>
      {node.discovered && (
        <p className="quiet">
          {node.band && <>level {node.band} · </>}
          {node.evidence} piece{node.evidence === 1 ? '' : 's'} of evidence · the app is {Math.round(node.confidence * 100)}% sure
        </p>
      )}
      {node.claim && (
        <p className="claim">
          <strong>{node.discovered ? 'Claimed at the start:' : 'Claimed, to verify:'}</strong> {node.claim.basis}
        </p>
      )}
      {node.suggested && node.why && (
        <p>
          <strong>Why it could be next:</strong> {node.why}
        </p>
      )}
      {node.struggling.length > 0 && (
        <>
          <h3>Needs attention</h3>
          <ul>
            {node.struggling.map((r) => (
              <li key={r}>{r}</li>
            ))}
          </ul>
        </>
      )}
      {before.length > 0 && <p className="quiet">Builds on: {before.join(', ')}</p>}
      {after.length > 0 && <p className="quiet">Leads to: {after.join(', ')}</p>}
      {confusable.length > 0 && <p className="quiet">Often mixed up with: {confusable.join(', ')}</p>}
      {node.projects.length > 0 && (
        <p className="quiet">
          Used in {node.projects.length} project{node.projects.length === 1 ? '' : 's'}
        </p>
      )}
    </aside>
  );
}

/** The same map as a list, nested by group: for screen readers, and for reading rather than exploring. */
function BrainList({ data, tree, onSelect }: { data: BrainDTO; tree: GroupTree; onSelect: (id: string) => void }) {
  const section = (g: string, depth: number): ReactNode => {
    const nodes = data.nodes.filter((n) => tree.groupOf.get(n.id) === g);
    const Heading = depth === 1 ? 'h3' : 'h4';
    return (
      <section key={g} aria-label={tree.title.get(g) ?? g} className={`depth-${depth}`}>
        <Heading>{tree.title.get(g) ?? g}</Heading>
        {nodes.length > 0 && (
          <ul>
            {nodes.map((n) => (
              <li key={n.id} className={`look-${lookOf(n)}`}>
                <button type="button" className="text" onClick={() => onSelect(n.id)}>
                  {n.title}
                </button>{' '}
                <span className="quiet">
                  {LOOK_LABEL[lookOf(n)]}
                  {n.struggling.length > 0 && ` · needs attention: ${n.struggling.join(', ')}`}
                </span>
              </li>
            ))}
          </ul>
        )}
        {(tree.children.get(g) ?? []).map((k) => section(k, depth + 1))}
      </section>
    );
  };
  return <div className="brain-list">{(tree.children.get(undefined) ?? []).map((g) => section(g, 1))}</div>;
}

/**
 * The brain view (roadmap 2.8): every skill in this profile as one living map. Levels and
 * struggles come from evidence, computed by the app; groups, links and suggestions come from the
 * tutor's description of the skill map. Nothing here is a score to chase.
 */
export function BrainView({ onBack }: { onBack: () => void }) {
  const q = useQuery('brain.get', {}, ['learner', 'history', 'lessons', 'reviews', 'projects']);
  const [selected, setSelected] = useState<string>();
  const [mode, setMode] = useState<'map' | 'list'>('map');
  // Zoomed out, groups fold into one node each; off, every skill stays (the map as a gradient).
  const [fold, setFold] = useState(true);
  const data = q.data;
  const tree = useMemo(() => (data ? groupTree(data) : undefined), [data]);
  const node = data?.nodes.find((n) => n.id === selected);
  const counts = data && {
    durable: data.nodes.filter((n) => lookOf(n) === 'durable').length,
    learning: data.nodes.filter((n) => ['learning', 'mastered'].includes(lookOf(n))).length,
    struggling: data.nodes.filter((n) => n.struggling.length > 0).length,
    undiscovered: data.nodes.filter((n) => lookOf(n) === 'undiscovered').length,
    claimed: data.nodes.filter((n) => lookOf(n) === 'claimed').length,
  };
  return (
    <main className="brain">
      <header className="brain-head">
        <button type="button" className="text" onClick={onBack}>
          ← Back
        </button>
        <h1>Your brain</h1>
        {counts && (
          <p className="quiet">
            {counts.durable} learned to stay · {counts.learning} in progress · {counts.struggling} need attention
            {counts.claimed > 0 && ` · ${counts.claimed} to verify`} · {counts.undiscovered} to discover
          </p>
        )}
        {mode === 'map' && (
          <label className="brain-fold-toggle">
            <input type="checkbox" checked={fold} onChange={(e) => setFold(e.target.checked)} />
            Fold groups when zoomed out
          </label>
        )}
        <div className="brain-modes" role="radiogroup" aria-label="Show as">
          {(['map', 'list'] as const).map((m) => (
            <label key={m} className={mode === m ? 'on' : ''}>
              <input type="radio" name="brain-mode" checked={mode === m} onChange={() => setMode(m)} />
              {m === 'map' ? 'Map' : 'List'}
            </label>
          ))}
        </div>
      </header>
      {data && data.nodes.length === 0 && (
        <p className="quiet brain-empty">
          Your map is empty for now. Skills appear as your tutor describes them during an interview or a lesson, and fill in as you show what you know.
        </p>
      )}
      {data && data.nodes.length > 0 && (
        <div className="brain-body">
          {mode === 'map' ? (
            <BrainMap data={data} tree={tree!} fold={fold} selected={selected} onSelect={setSelected} />
          ) : (
            <BrainList data={data} tree={tree!} onSelect={setSelected} />
          )}
          {node && <Details node={node} data={data} tree={tree!} onClose={() => setSelected(undefined)} />}
          {mode === 'map' && (
            <details className="brain-legend-box">
              <summary>Legend</summary>
              <ul className="brain-legend" aria-label="Legend">
                {(['durable', 'mastered', 'learning', 'claimed', 'unseen', 'undiscovered'] as const).map((l) => (
                  <li key={l} className={`look-${l}`}>
                    <svg width="14" height="14" aria-hidden>
                      <circle cx="7" cy="7" r="5" />
                    </svg>
                    {LOOK_LABEL[l]}
                  </li>
                ))}
                <li className="struggling">
                  <svg width="14" height="14" aria-hidden>
                    <circle cx="7" cy="7" r="5" className="brain-halo" />
                  </svg>
                  needs attention
                </li>
                <li className="fold">
                  <svg width="14" height="14" aria-hidden>
                    <circle cx="7" cy="7" r="6" />
                  </svg>
                  a group, folded: click to open
                </li>
                <li className="hint">Colour is the area a skill belongs to; a skill between areas blends their colours.</li>
              </ul>
            </details>
          )}
        </div>
      )}
    </main>
  );
}
