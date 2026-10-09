/**
 * Small icons drawn in the mark's pixels, one string per row ("#" is a pixel). They take the
 * colour of the text around them.
 */
export function PixelIcon({ rows, size = 14 }: { rows: readonly string[]; size?: number }) {
  const w = Math.max(...rows.map((r) => r.length));
  return (
    <svg className="pixelicon" width={size} height={size} viewBox={`-0.5 -0.5 ${w + 1} ${rows.length + 1}`} aria-hidden>
      {rows.flatMap((row, y) => [...row].map((c, x) => (c === '#' ? <rect key={`${x},${y}`} x={x} y={y} width={0.92} height={0.92} /> : null)))}
    </svg>
  );
}

/** From the foundations up to the goal. */
export const PATH = ['     ##', '     ##', '    #  ', '   #   ', '  #    ', '##     ', '##     '];

/** Two cards, one behind the other. */
export const REVIEW = ['  #####', '  #   #', '##### #', '#   # #', '#   ###', '#   #  ', '#####  '];

/** Fold the contents to a rail, and back. */
export const FOLD = ['       ', '  #  # ', ' #  #  ', '#  #   ', ' #  #  ', '  #  # ', '       '];
export const UNFOLD = ['       ', ' #  #  ', '  #  # ', '   #  #', '  #  # ', ' #  #  ', '       '];
