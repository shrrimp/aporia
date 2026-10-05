/**
 * The mark: a lowercase "a" drawn on a 5×5 pixel grid. While the tutor works, its pixels slide
 * away along the grid and settle back, in steps, so the motion itself looks pixelated.
 */
const A = ['.###.', '....#', '.####', '#...#', '.####'];

/** Deterministic little walks (in cells) for each pixel, so the animation is the same every time. */
function walk(i: number): [number, number, number, number] {
  const h = Math.imul(i + 1, 2654435761) >>> 0;
  const d = (shift: number) => ((h >>> shift) % 5) - 2; // -2..2
  return [d(0), d(3), d(6), d(9)];
}

export const PIXELS: readonly { x: number; y: number }[] = A.flatMap((row, y) =>
  [...row].flatMap((c, x) => (c === '#' ? [{ x, y }] : [])),
);

export function PixelMark({ working = false, size = 20, label }: { working?: boolean; size?: number; label?: string }) {
  return (
    <svg
      className={`pixelmark ${working ? 'working' : ''}`}
      width={size}
      height={size}
      viewBox="-1 -1 7 7"
      role={label ? 'img' : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
    >
      {PIXELS.map((p, i) => {
        const [ax, ay, bx, by] = walk(i);
        return (
          <rect
            key={i}
            x={p.x}
            y={p.y}
            width={0.92}
            height={0.92}
            style={
              {
                '--ax': `${ax}px`,
                '--ay': `${ay}px`,
                '--bx': `${bx}px`,
                '--by': `${by}px`,
                animationDelay: `${(i % 4) * 0.12}s`,
              } as React.CSSProperties
            }
          />
        );
      })}
    </svg>
  );
}
