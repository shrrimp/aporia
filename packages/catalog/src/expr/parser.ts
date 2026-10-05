import { ExprSyntaxError, tokenize, type Token } from './lexer.ts';
import type { Assignment, Node } from './ast.ts';

const BINARY: Record<string, [number, 'left' | 'right']> = {
  '||': [1, 'left'],
  '&&': [2, 'left'],
  '==': [3, 'left'],
  '!=': [3, 'left'],
  '<': [4, 'left'],
  '>': [4, 'left'],
  '<=': [4, 'left'],
  '>=': [4, 'left'],
  '+': [5, 'left'],
  '-': [5, 'left'],
  '*': [6, 'left'],
  '/': [6, 'left'],
  '^': [8, 'right'],
};
const UNARY_PREC = 7;
const MAX_DEPTH = 64;

class Parser {
  #i = 0;
  #depth = 0;
  readonly #t: Token[];
  constructor(src: string) {
    this.#t = tokenize(src);
  }

  peek(): Token {
    return this.#t[this.#i]!;
  }
  next(): Token {
    return this.#t[this.#i++]!;
  }
  is(text: string): boolean {
    const t = this.peek();
    return t.kind === 'op' && t.text === text;
  }
  expect(text: string): void {
    const t = this.next();
    if (t.kind !== 'op' || t.text !== text) throw new ExprSyntaxError(`expected "${text}"`, t.pos);
  }
  end(): void {
    const t = this.peek();
    if (t.kind !== 'eof') throw new ExprSyntaxError(`unexpected "${t.text}"`, t.pos);
  }

  expr(): Node {
    if (++this.#depth > MAX_DEPTH) throw new ExprSyntaxError('expression nested too deeply', this.peek().pos);
    try {
      return this.conditional();
    } finally {
      this.#depth--;
    }
  }

  conditional(): Node {
    const test = this.binary(0);
    if (!this.is('?')) return test;
    this.next();
    const then = this.expr();
    this.expect(':');
    return { type: 'cond', test, then, else: this.expr() };
  }

  binary(minPrec: number): Node {
    let left = this.unary();
    for (;;) {
      const t = this.peek();
      const info = t.kind === 'op' ? BINARY[t.text] : undefined;
      if (!info || info[0] < minPrec) return left;
      this.next();
      const right = this.binary(info[1] === 'left' ? info[0] + 1 : info[0]);
      left = { type: 'binary', op: t.text, left, right };
    }
  }

  unary(): Node {
    if (this.is('-') || this.is('!')) {
      const op = this.next().text as '-' | '!';
      return { type: 'unary', op, arg: this.binaryFrom(UNARY_PREC) };
    }
    return this.postfix(this.primary());
  }

  /** Operand of a unary operator: binds tighter than * but looser than ^. */
  binaryFrom(prec: number): Node {
    const base = this.postfix(this.primary());
    if (this.is('^') && BINARY['^']![0] > prec) {
      this.next();
      return { type: 'binary', op: '^', left: base, right: this.binary(BINARY['^']![0]) };
    }
    return base;
  }

  postfix(node: Node): Node {
    for (;;) {
      if (this.is('.')) {
        this.next();
        const t = this.next();
        if (t.kind !== 'ident') throw new ExprSyntaxError('expected a field name', t.pos);
        node = { type: 'member', object: node, name: t.text };
      } else if (this.is('[')) {
        this.next();
        const index = this.expr();
        this.expect(']');
        node = { type: 'index', object: node, index };
      } else return node;
    }
  }

  primary(): Node {
    const t = this.next();
    if (t.kind === 'num') return { type: 'num', value: Number(t.text) };
    if (t.kind === 'ident') {
      if (this.is('->')) {
        this.next();
        return { type: 'lambda', params: [t.text], body: this.expr() };
      }
      if (this.is('(')) {
        this.next();
        const args: Node[] = [];
        if (!this.is(')')) {
          do args.push(this.expr());
          while (this.is(',') && this.next());
        }
        this.expect(')');
        return { type: 'call', fn: t.text, args };
      }
      return { type: 'var', name: t.text };
    }
    if (t.kind === 'op' && t.text === '(') {
      // (a, b) -> body  |  ( expr )
      const save = this.#i;
      const params: string[] = [];
      let ok = true;
      if (this.peek().kind === 'ident') {
        params.push(this.next().text);
        while (this.is(',')) {
          this.next();
          const p = this.next();
          if (p.kind !== 'ident') {
            ok = false;
            break;
          }
          params.push(p.text);
        }
        if (ok && this.is(')')) {
          this.next();
          if (this.is('->')) {
            this.next();
            return { type: 'lambda', params, body: this.expr() };
          }
        }
      }
      this.#i = save;
      const inner = this.expr();
      this.expect(')');
      return inner;
    }
    if (t.kind === 'op' && t.text === '[') {
      const items: Node[] = [];
      if (!this.is(']')) {
        do items.push(this.expr());
        while (this.is(',') && this.next());
      }
      this.expect(']');
      return { type: 'vec', items };
    }
    throw new ExprSyntaxError(t.kind === 'eof' ? 'unexpected end of expression' : `unexpected "${t.text}"`, t.pos);
  }

  assignments(): Assignment[] {
    const out: Assignment[] = [];
    do {
      if (this.peek().kind === 'eof') break;
      const name = this.next();
      if (name.kind !== 'ident') throw new ExprSyntaxError('expected a variable name', name.pos);
      this.expect('=');
      out.push({ name: name.text, value: this.expr() });
    } while (this.is(';') && this.next());
    this.end();
    if (out.length === 0) throw new ExprSyntaxError('expected at least one assignment', 0);
    return out;
  }
}

export function parseExpr(src: string): Node {
  const p = new Parser(src);
  const node = p.expr();
  p.end();
  return node;
}

export function parseAssignments(src: string): Assignment[] {
  return new Parser(src).assignments();
}
