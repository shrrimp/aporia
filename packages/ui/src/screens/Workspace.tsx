import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type PointerEvent, type ReactNode } from 'react';
import type { Layout } from '@app/server/protocol';
import { PixelIcon, FOLD, UNFOLD } from '../PixelIcon.tsx';

type Side = 'contents' | 'margin' | 'editor';

/** The folded contents, in pixels: the lesson numbers and icons, nothing else. */
export const RAIL = 56;
/** Room the page keeps, whatever the panels want. */
const PAGE_MIN = 360;
const LIMITS: Record<Side, { min: number; max: number; initial: number }> = {
  contents: { min: 180, max: 420, initial: 240 },
  margin: { min: 280, max: 760, initial: 384 },
  editor: { min: 320, max: 2400, initial: 560 },
};
/** How long panels take to open, close and fold (kept in step with the CSS). */
export const MOTION_MS = 260;
const STEP = 16;

const clamp = (v: number, side: Side) => Math.round(Math.min(LIMITS[side].max, Math.max(LIMITS[side].min, v)));

export interface Fitted {
  readonly contents: number;
  readonly margin: number;
  readonly editor: number;
  readonly folded: boolean;
  /** Folded because the window is too narrow, not by the learner. */
  readonly autoFolded: boolean;
  /** Too narrow even then: the editor and the margin lie over the page instead of beside it. */
  readonly overlay: boolean;
}

/**
 * The panels' widths in a workspace `width` pixels wide. The learner's widths where they fit;
 * otherwise the editor gives way first, then the margin, then the contents, which at last fold
 * to a rail. Closed panels keep the width they will open to. Without a width (not laid out yet),
 * the learner's widths as they are.
 */
export function fit(layout: Layout, open: { margin: boolean; editor: boolean }, width: number | undefined): Fitted {
  let contents = clamp(layout.contents ?? LIMITS.contents.initial, 'contents');
  let margin = clamp(layout.margin ?? LIMITS.margin.initial, 'margin');
  let folded = layout.folded === true;
  // Until the learner sets it, the editor shares the room with the page.
  const share = width === undefined ? LIMITS.editor.initial : (width - (folded ? RAIL : contents) - (open.margin ? margin : 0)) / 2;
  let editor = clamp(layout.editor ?? share, 'editor');
  if (width === undefined) return { contents, margin, editor, folded, autoFolded: false, overlay: false };
  let over = (folded ? RAIL : contents) + (open.margin ? margin : 0) + (open.editor ? editor : 0) + PAGE_MIN - width;
  const give = (have: number, side: Side) => {
    const d = Math.max(0, Math.min(over, have - LIMITS[side].min));
    over -= d;
    return have - d;
  };
  if (over > 0 && open.editor) editor = give(editor, 'editor');
  if (over > 0 && open.margin) margin = give(margin, 'margin');
  if (over > 0 && !folded) contents = give(contents, 'contents');
  const autoFolded = over > 0 && !folded;
  if (autoFolded) {
    over -= contents - RAIL;
    folded = true;
  }
  const overlay = over > 0;
  if (overlay) {
    margin = Math.min(margin, width - RAIL);
    editor = Math.min(editor, width - RAIL - (open.margin ? margin : 0));
  }
  return { contents, margin, editor, folded, autoFolded, overlay };
}

/**
 * The layout with the panel on `side` resized to `want` pixels, at most `max`. Pulled most of
 * the way to the rail, the contents fold; pulled back out, they unfold.
 */
export function resized(layout: Layout, side: Side, want: number, max: number): Layout {
  if (side === 'contents' && want < (RAIL + LIMITS.contents.min) / 2) return { ...layout, folded: true };
  return { ...layout, [side]: Math.min(clamp(want, side), Math.round(max)), ...(side === 'contents' ? { folded: false } : {}) };
}

/** A value that stays for a moment after it is gone: what a closing panel shows while it closes. */
export function useLingering<T>(value: T | undefined, ms = MOTION_MS + 40): T | undefined {
  const [last, setLast] = useState(value);
  useEffect(() => {
    if (value !== undefined) {
      setLast(value);
      return;
    }
    const id = setTimeout(() => setLast(undefined), ms);
    return () => clearTimeout(id);
  }, [value, ms]);
  return value ?? last;
}

interface Tip {
  readonly text: string;
  readonly meta: string | undefined;
  readonly top: number;
  readonly left: number;
}

/**
 * The line between two panels, dragged (or moved with the arrow keys) to resize the panel on its
 * `side`. `onResize` gets the width wanted, and `done` once the drag ends.
 */
function Gutter({
  side,
  label,
  value,
  max,
  onResize,
  onReset,
}: {
  side: Side;
  label: string;
  value: number;
  max: number;
  onResize: (side: Side, want: number, done: boolean) => void;
  onReset: (side: Side) => void;
}) {
  const drag = useRef<{ x: number; width: number; want?: number }>(undefined);
  // Dragging right widens the contents, and narrows the panels on the right.
  const sign = side === 'contents' ? 1 : -1;
  const end = () => {
    const want = drag.current?.want;
    drag.current = undefined;
    if (want !== undefined) onResize(side, want, true);
  };
  return (
    <div
      className={`gutter gutter-${side}`}
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      aria-valuenow={value}
      aria-valuemin={side === 'contents' ? RAIL : LIMITS[side].min}
      aria-valuemax={max}
      tabIndex={0}
      onPointerDown={(e: PointerEvent<HTMLDivElement>) => {
        if (e.button !== 0) return;
        e.preventDefault();
        e.currentTarget.setPointerCapture?.(e.pointerId);
        drag.current = { x: e.clientX, width: value };
      }}
      onPointerMove={(e) => {
        const d = drag.current;
        if (!d) return;
        d.want = d.width + sign * (e.clientX - d.x);
        onResize(side, d.want, false);
      }}
      onPointerUp={end}
      onPointerCancel={end}
      onDoubleClick={() => onReset(side)}
      onKeyDown={(e: KeyboardEvent) => {
        const by = e.shiftKey ? STEP * 4 : STEP;
        // Left and right move the line; Home and End take the panel to its narrowest and widest.
        const dx = { ArrowRight: by, ArrowLeft: -by }[e.key];
        const want = e.key === 'Home' ? 0 : e.key === 'End' ? 10_000 : dx !== undefined ? value + sign * dx : undefined;
        if (e.key === 'Enter') onReset(side);
        else if (want !== undefined) onResize(side, want, true);
        else return;
        e.preventDefault();
      }}
    />
  );
}

/**
 * The project's workspace: the contents, the page, the editor and the margin, side by side.
 * Every panel can be resized from its edge, and opens, closes and folds with a short slide;
 * a panel's content keeps its width while the panel moves, so text never reflows mid-motion.
 * Only this frame re-renders while a panel is dragged, never the lesson inside it.
 */
export function Workspace({
  layout,
  onLayout,
  marginOpen,
  editorOpen,
  contents,
  page,
  editor,
  margin,
}: {
  layout: Layout;
  onLayout: (layout: Layout) => void;
  marginOpen: boolean;
  editorOpen: boolean;
  contents: ReactNode;
  page: ReactNode;
  /** Absent for a project without a workspace folder. */
  editor?: ReactNode;
  margin: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState<number>();
  // While dragging, the layout being made; committed when the pointer is released.
  const [draft, setDraft] = useState<Layout>();
  // No motion on the first frame, or while the window itself is being resized.
  const [still, setStill] = useState(true);
  const [tip, setTip] = useState<Tip>();

  useLayoutEffect(() => {
    const el = ref.current!;
    let last = el.getBoundingClientRect().width || undefined;
    setWidth(last);
    // On opening, the panels appear where they are, without sliding there.
    const ready = setTimeout(() => setStill(false), 50);
    if (typeof ResizeObserver === 'undefined') return () => clearTimeout(ready);
    let settle: ReturnType<typeof setTimeout> | undefined;
    const ro = new ResizeObserver(([entry]) => {
      const w = entry!.contentRect.width || undefined;
      if (w === last) return;
      last = w;
      setWidth(w);
      setStill(true);
      clearTimeout(settle);
      settle = setTimeout(() => setStill(false), 160);
    });
    ro.observe(el);
    return () => {
      clearTimeout(ready);
      clearTimeout(settle);
      ro.disconnect();
    };
  }, []);

  const current = draft ?? layout;
  const open = { margin: marginOpen, editor: editorOpen && editor !== undefined };
  const f = fit(current, open, width);
  const shownContents = f.folded ? RAIL : f.contents;

  // The widest a panel can be: what the others leave the page.
  const maxOf = (side: Side) => {
    const others = (side === 'contents' ? 0 : shownContents) + (side !== 'margin' && open.margin ? f.margin : 0) + (side !== 'editor' && open.editor ? f.editor : 0);
    return Math.max(LIMITS[side].min, Math.min(LIMITS[side].max, (width ?? Infinity) - others - PAGE_MIN));
  };
  const onResize = (side: Side, want: number, done: boolean) => {
    const next = resized(layout, side, want, maxOf(side));
    setDraft(done ? undefined : next);
    if (done) onLayout(next);
  };
  const onReset = (side: Side) => {
    const { [side]: _, ...rest } = layout;
    onLayout(side === 'contents' ? { ...rest, folded: false } : rest);
  };

  // The rail's tooltips: the name of what is under the pointer (or the focus), beside the rail.
  const showTip = (target: EventTarget, rail: Element) => {
    const el = (target as Element).closest<HTMLElement>('[data-tip]');
    if (!f.folded || !el) return setTip(undefined);
    const r = el.getBoundingClientRect();
    setTip({ text: el.dataset.tip!, meta: el.dataset.tipMeta, top: r.top + r.height / 2, left: rail.getBoundingClientRect().right + 10 });
  };
  useEffect(() => {
    if (!f.folded) setTip(undefined);
  }, [f.folded]);

  const style = {
    '--contents-w': `${f.contents}px`,
    '--contents-shown': `${shownContents}px`,
    '--margin-w': `${f.margin}px`,
    '--editor-w': `${f.editor}px`,
  } as CSSProperties;
  const classes = ['workspace', still || draft ? 'still' : '', draft ? 'dragging' : '', f.folded ? 'folded' : '', f.overlay ? 'overlay' : '', open.margin ? 'with-margin' : '', open.editor ? 'with-editor' : ''];
  return (
    <div ref={ref} className={classes.filter(Boolean).join(' ')} style={style}>
      <div
        className="panel contents"
        onPointerOver={(e) => showTip(e.target, e.currentTarget)}
        onPointerLeave={() => setTip(undefined)}
        onFocus={(e) => showTip(e.target, e.currentTarget)}
        onBlur={() => setTip(undefined)}
        onScroll={() => setTip(undefined)}
      >
        <div className="panel-inner">
          <div className="contents-scroll">{contents}</div>
          {!f.autoFolded && (
            <div className="contents-foot">
              <button
                type="button"
                className="fold"
                aria-label={f.folded ? 'Expand contents' : 'Collapse contents'}
                aria-expanded={!f.folded}
                data-tip="Expand contents"
                onClick={() => onLayout({ ...layout, folded: !f.folded })}
              >
                <span className="ico">
                  <PixelIcon rows={f.folded ? UNFOLD : FOLD} />
                </span>
                <span className="t">Collapse</span>
              </button>
            </div>
          )}
        </div>
      </div>
      {!f.autoFolded && (
        <Gutter side="contents" label="Resize the contents" value={shownContents} max={maxOf('contents')} onResize={onResize} onReset={onReset} />
      )}
      {page}
      {editor !== undefined && (
        <>
          {open.editor && <Gutter side="editor" label="Resize the editor" value={f.editor} max={maxOf('editor')} onResize={onResize} onReset={onReset} />}
          <div className={`panel editor-panel ${open.editor ? 'open' : ''}`} aria-hidden={!open.editor || undefined} inert={!open.editor}>
            <div className="panel-inner">{editor}</div>
          </div>
        </>
      )}
      {open.margin && <Gutter side="margin" label="Resize the side panel" value={f.margin} max={maxOf('margin')} onResize={onResize} onReset={onReset} />}
      <aside className={`panel margin ${open.margin ? 'open' : ''}`} aria-hidden={!open.margin || undefined} inert={!open.margin}>
        <div className="panel-inner">{margin}</div>
      </aside>
      {tip && (
        <div className="rail-tip" role="tooltip" style={{ top: tip.top, left: tip.left }}>
          {tip.meta && <span className="rail-tip-meta">{tip.meta}</span>}
          {tip.text}
        </div>
      )}
    </div>
  );
}
