import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { MAX_DIFF_LINES, folded, lineDiff } from '../src/diff.ts';

const render = (d: ReturnType<typeof lineDiff>) => d.map((l) => `${l.op}${l.text}`);

describe('lineDiff', () => {
  it('marks added and removed lines, keeping what is common', () => {
    expect(render(lineDiff('a\nb\nc', 'a\nx\nc'))).toEqual([' a', '-b', '+x', ' c']);
    expect(render(lineDiff('', 'new\nfile'))).toEqual(['+new', '+file']);
    expect(render(lineDiff('gone', ''))).toEqual(['-gone']);
    expect(render(lineDiff('same', 'same'))).toEqual([' same']);
    expect(render(lineDiff('a\nb\nc\nd', 'b\nc\ne'))).toEqual(['-a', ' b', ' c', '-d', '+e']);
  });

  it('rebuilds both texts from the diff (property)', () => {
    fc.assert(
      fc.property(fc.array(fc.constantFrom('a', 'b', 'c', 'd'), { maxLength: 30 }), fc.array(fc.constantFrom('a', 'b', 'c', 'e'), { maxLength: 30 }), (x, y) => {
        const d = lineDiff(x.join('\n'), y.join('\n'));
        expect(d.filter((l) => l.op !== '+').map((l) => l.text)).toEqual(x.join('\n') === '' ? [] : x);
        expect(d.filter((l) => l.op !== '-').map((l) => l.text)).toEqual(y.join('\n') === '' ? [] : y);
      }),
    );
  });

  it('falls back to old-then-new for huge changes, and folds long unchanged runs', () => {
    const big = Array.from({ length: MAX_DIFF_LINES + 1 }, (_, i) => `l${i}`).join('\n');
    const d = lineDiff(`start\n${big}`, `start\n${big.replaceAll('l', 'm')}`);
    expect(d[0]).toEqual({ op: ' ', text: 'start' });
    expect(d.filter((l) => l.op === '-')).toHaveLength(MAX_DIFF_LINES + 1);
    const lines = lineDiff(Array.from({ length: 20 }, (_, i) => `${i}`).join('\n'), Array.from({ length: 20 }, (_, i) => (i === 10 ? 'ten' : `${i}`)).join('\n'));
    const f = folded(lines, 2);
    expect(f[0]).toEqual({ op: '…', text: '8 unchanged lines' });
    expect(f.at(-1)).toEqual({ op: '…', text: '7 unchanged lines' });
    expect(folded([{ op: ' ', text: 'x' }], 0)).toEqual([{ op: '…', text: '1 unchanged line' }]);
  });
});
