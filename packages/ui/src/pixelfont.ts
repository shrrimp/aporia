/**
 * Aporia's lettering: lowercase glyphs drawn on a pixel grid, 9 rows tall.
 * Rows 0–1 hold dots, rows 2–6 the x-height, rows 7–8 descenders.
 */
export const GLYPHS: Readonly<Record<string, readonly string[]>> = {
  a: ['....', '....', '.##.', '...#', '.###', '#..#', '.###', '....', '....'],
  p: ['....', '....', '###.', '#..#', '#..#', '#..#', '###.', '#...', '#...'],
  o: ['....', '....', '.##.', '#..#', '#..#', '#..#', '.##.', '....', '....'],
  r: ['....', '....', '#.##', '##..', '#...', '#...', '#...', '....', '....'],
  i: ['#', '.', '#', '#', '#', '#', '#', '.', '.'],
};

export interface Pixel {
  readonly x: number;
  readonly y: number;
}

/** Lay a word out on the grid, one empty column between letters. */
export function layout(word: string): { pixels: Pixel[]; width: number; height: number } {
  const pixels: Pixel[] = [];
  let x0 = 0;
  for (const ch of word) {
    const g = GLYPHS[ch];
    if (!g) throw new Error(`no pixel glyph for "${ch}"`);
    g.forEach((row, y) => [...row].forEach((c, x) => c === '#' && pixels.push({ x: x0 + x, y })));
    x0 += g[0]!.length + 1;
  }
  return { pixels, width: x0 - 1, height: 9 };
}

/** Deterministic little walks (in cells) for each pixel, used by the "working" animation. */
export function walk(i: number): [number, number, number, number] {
  const h = Math.imul(i + 1, 2654435761) >>> 0;
  const d = (shift: number) => ((h >>> shift) % 5) - 2; // -2..2
  return [d(0), d(3), d(6), d(9)];
}
