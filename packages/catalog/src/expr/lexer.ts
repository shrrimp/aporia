export type TokenKind = 'num' | 'ident' | 'op' | 'eof';

export interface Token {
  readonly kind: TokenKind;
  readonly text: string;
  readonly pos: number;
}

export class ExprSyntaxError extends Error {
  override readonly name = 'ExprSyntaxError';
  readonly pos: number;
  constructor(message: string, pos: number) {
    super(`${message} (at ${pos})`);
    this.pos = pos;
  }
}

const OPS = ['->', '==', '!=', '<=', '>=', '&&', '||', '+', '-', '*', '/', '^', '(', ')', '[', ']', ',', '<', '>', '!', '?', ':', '=', ';', '.'];

export const MAX_SOURCE_LENGTH = 4000;

export function tokenize(src: string): Token[] {
  if (src.length > MAX_SOURCE_LENGTH) throw new ExprSyntaxError(`expression longer than ${MAX_SOURCE_LENGTH} characters`, 0);
  const out: Token[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i]!;
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    const num = /^(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?/.exec(src.slice(i));
    if (num) {
      out.push({ kind: 'num', text: num[0], pos: i });
      i += num[0].length;
      continue;
    }
    const id = /^[A-Za-z_][A-Za-z0-9_]*/.exec(src.slice(i));
    if (id) {
      out.push({ kind: 'ident', text: id[0], pos: i });
      i += id[0].length;
      continue;
    }
    const op = OPS.find((o) => src.startsWith(o, i));
    if (!op) throw new ExprSyntaxError(`unexpected character "${c}"`, i);
    out.push({ kind: 'op', text: op, pos: i });
    i += op.length;
  }
  out.push({ kind: 'eof', text: '', pos: src.length });
  return out;
}
