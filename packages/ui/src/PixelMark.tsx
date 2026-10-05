import type { CSSProperties } from 'react';
import { layout, walk, type Pixel } from './pixelfont.ts';

function Pixels({ pixels }: { pixels: readonly Pixel[] }) {
  return (
    <>
      {pixels.map((p, i) => {
        const [ax, ay, bx, by] = walk(i);
        return (
          <rect
            key={i}
            x={p.x}
            y={p.y}
            width={0.92}
            height={0.92}
            style={{ '--ax': `${ax}px`, '--ay': `${ay}px`, '--bx': `${bx}px`, '--by': `${by}px`, animationDelay: `${(i % 5) * 0.11}s` } as CSSProperties}
          />
        );
      })}
    </>
  );
}

const A = layout('a');
/** The small x-height rows of the "a", without the empty dot and descender rows. */
export const PIXELS: readonly Pixel[] = A.pixels.map((p) => ({ x: p.x, y: p.y - 2 }));

/**
 * The mark: the wordmark's "a" in pixels. While the tutor works, its pixels walk along the grid
 * and settle back, in steps, so the motion itself looks pixelated.
 */
export function PixelMark({ working = false, size = 20, label }: { working?: boolean; size?: number; label?: string }) {
  return (
    <svg
      className={`pixelmark ${working ? 'working' : ''}`}
      width={size}
      height={size}
      viewBox="-1.5 -1 7 7"
      role={label ? 'img' : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
    >
      <Pixels pixels={PIXELS} />
    </svg>
  );
}

const WORD = layout('aporia');

/** The full wordmark, "aporia", in the same pixels. It can come alive too. */
export function Wordmark({ height = 18, working = false }: { height?: number; working?: boolean }) {
  const w = (WORD.width / WORD.height) * height;
  return (
    <svg
      className={`pixelmark wordmark-svg ${working ? 'working' : ''}`}
      width={w}
      height={height}
      viewBox={`0 0 ${WORD.width} ${WORD.height}`}
      role="img"
      aria-label="Aporia"
    >
      <Pixels pixels={WORD.pixels} />
    </svg>
  );
}
