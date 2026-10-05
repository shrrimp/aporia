/**
 * A few faint mathematical glyphs at the edges of the page: a sense of place, kept out of the
 * reading column. Fixed and deterministic so nothing moves while you read.
 */
const GLYPHS: readonly { g: string; x: number; y: number; size: number; r: number }[] = [
  { g: '∂', x: 3, y: 12, size: 3.2, r: -8 },
  { g: '∑', x: 7, y: 64, size: 2.4, r: 4 },
  { g: 'θ', x: 2.5, y: 86, size: 2, r: 0 },
  { g: '∇', x: 12, y: 36, size: 1.6, r: 10 },
  { g: '∫', x: 93, y: 18, size: 3.6, r: 6 },
  { g: 'ω', x: 88, y: 48, size: 2.2, r: -6 },
  { g: '⊗', x: 95, y: 74, size: 1.8, r: 0 },
  { g: 'λ', x: 84, y: 90, size: 2.6, r: 8 },
  { g: 'π', x: 46, y: 95, size: 1.6, r: -4 },
  { g: '√', x: 60, y: 4, size: 1.8, r: 0 },
  { g: 'ε', x: 30, y: 96, size: 1.4, r: 12 },
  { g: '∞', x: 76, y: 6, size: 1.5, r: 0 },
];

export function MathField() {
  return (
    <div className="mathfield" aria-hidden>
      {GLYPHS.map((s, i) => (
        <span key={i} style={{ left: `${s.x}%`, top: `${s.y}%`, fontSize: `${s.size}rem`, transform: `rotate(${s.r}deg)` }}>
          {s.g}
        </span>
      ))}
    </div>
  );
}
