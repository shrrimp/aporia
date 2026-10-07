export interface DiffLine {
  readonly op: ' ' | '+' | '-';
  readonly text: string;
}

/** Above this many changed lines on a side, the comparison shows the whole new text instead of a line diff. */
export const MAX_DIFF_LINES = 1500;

/**
 * Line diff (longest common subsequence), for showing a proposed change. The common start and
 * end are taken out first, so a small edit to a big file stays cheap.
 */
export function lineDiff(before: string, after: string): DiffLine[] {
  const a = before === '' ? [] : before.split('\n');
  const b = after === '' ? [] : after.split('\n');
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }
  const head = a.slice(0, start).map((text) => ({ op: ' ' as const, text }));
  const tail = a.slice(endA).map((text) => ({ op: ' ' as const, text }));
  const x = a.slice(start, endA);
  const y = b.slice(start, endB);
  if (x.length > MAX_DIFF_LINES || y.length > MAX_DIFF_LINES) {
    return [...head, ...x.map((text) => ({ op: '-' as const, text })), ...y.map((text) => ({ op: '+' as const, text })), ...tail];
  }
  // lcs[i][j]: length of the longest common subsequence of x[i..] and y[j..].
  const w = y.length + 1;
  const lcs = new Uint16Array((x.length + 1) * w);
  for (let i = x.length - 1; i >= 0; i--) {
    for (let j = y.length - 1; j >= 0; j--) {
      lcs[i * w + j] = x[i] === y[j] ? lcs[(i + 1) * w + j + 1]! + 1 : Math.max(lcs[(i + 1) * w + j]!, lcs[i * w + j + 1]!);
    }
  }
  const mid: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < x.length && j < y.length) {
    if (x[i] === y[j]) {
      mid.push({ op: ' ', text: x[i]! });
      i++;
      j++;
    } else if (lcs[(i + 1) * w + j]! >= lcs[i * w + j + 1]!) mid.push({ op: '-', text: x[i++]! });
    else mid.push({ op: '+', text: y[j++]! });
  }
  while (i < x.length) mid.push({ op: '-', text: x[i++]! });
  while (j < y.length) mid.push({ op: '+', text: y[j++]! });
  return [...head, ...mid, ...tail];
}

/** Long runs of unchanged lines are folded, keeping `context` lines around each change. */
export function folded(lines: readonly DiffLine[], context = 3): (DiffLine | { op: '…'; text: string })[] {
  const keep = lines.map((l, i) => l.op !== ' ' || lines.slice(Math.max(0, i - context), i + context + 1).some((n) => n.op !== ' '));
  const out: (DiffLine | { op: '…'; text: string })[] = [];
  let skipped = 0;
  lines.forEach((l, i) => {
    if (keep[i]) {
      if (skipped) out.push({ op: '…', text: `${skipped} unchanged line${skipped === 1 ? '' : 's'}` });
      skipped = 0;
      out.push(l);
    } else skipped++;
  });
  if (skipped) out.push({ op: '…', text: `${skipped} unchanged line${skipped === 1 ? '' : 's'}` });
  return out;
}
