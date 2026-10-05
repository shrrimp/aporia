import { BUILTINS, CONSTANTS, ITERATE_MAX, SPECIAL_FORMS } from './builtins.ts';
import { parseAssignments, parseExpr } from './parser.ts';
import type { Node } from './ast.ts';
import {
  ExprRuntimeError,
  isBool,
  isFn,
  isNum,
  isQuat,
  isVec,
  qmul,
  quat,
  typeName,
  type Fn,
  type Quat,
  type Value,
  type Vec,
} from './values.ts';

export type Env = Readonly<Record<string, Value>>;

export const DEFAULT_BUDGET = 1_000_000;

class Budget {
  #left: number;
  constructor(steps: number) {
    this.#left = steps;
  }
  tick(): void {
    if (--this.#left < 0) throw new ExprRuntimeError('evaluation budget exceeded');
  }
}

function arith(op: string, a: Value, b: Value): Value {
  if (isNum(a) && isNum(b)) {
    switch (op) {
      case '+':
        return a + b;
      case '-':
        return a - b;
      case '*':
        return a * b;
      case '/':
        return a / b;
      default:
        return a ** b; // '^'
    }
  }
  if (isVec(a) && isVec(b) && (op === '+' || op === '-')) {
    if (a.length !== b.length) throw new ExprRuntimeError(`${op}: vector lengths differ (${a.length} vs ${b.length})`);
    return a.map((x, i) => (op === '+' ? x + b[i]! : x - b[i]!));
  }
  if (isVec(a) && isNum(b) && (op === '*' || op === '/')) return a.map((x) => (op === '*' ? x * b : x / b));
  if (isNum(a) && isVec(b) && op === '*') return b.map((x) => a * x);
  if (isQuat(a) && isQuat(b)) {
    if (op === '*') return qmul(a, b);
    if (op === '+' || op === '-') {
      const s = op === '+' ? 1 : -1;
      return quat(a.w + s * b.w, a.x + s * b.x, a.y + s * b.y, a.z + s * b.z);
    }
  }
  const scaleQ = (q: Quat, k: number) => quat(q.w * k, q.x * k, q.y * k, q.z * k);
  if (isQuat(a) && isNum(b) && (op === '*' || op === '/')) return scaleQ(a, op === '*' ? b : 1 / b);
  if (isNum(a) && isQuat(b) && op === '*') return scaleQ(b, a);
  throw new ExprRuntimeError(`cannot apply ${op} to ${typeName(a)} and ${typeName(b)}`);
}

function compare(op: string, a: Value, b: Value): boolean {
  if (op === '==' || op === '!=') {
    if (!((isNum(a) && isNum(b)) || (isBool(a) && isBool(b)))) {
      throw new ExprRuntimeError(`${op}: compare numbers or booleans, got ${typeName(a)} and ${typeName(b)}`);
    }
    return op === '==' ? a === b : a !== b;
  }
  if (!isNum(a) || !isNum(b)) throw new ExprRuntimeError(`${op}: expected numbers, got ${typeName(a)} and ${typeName(b)}`);
  switch (op) {
    case '<':
      return a < b;
    case '>':
      return a > b;
    case '<=':
      return a <= b;
    default:
      return a >= b;
  }
}

function bool(v: Value, what: string): boolean {
  if (!isBool(v)) throw new ExprRuntimeError(`${what}: expected a boolean, got ${typeName(v)}`);
  return v;
}

function ev(node: Node, env: Env, budget: Budget): Value {
  budget.tick();
  switch (node.type) {
    case 'num':
      return node.value;
    case 'var': {
      if (Object.hasOwn(env, node.name)) return env[node.name]!;
      if (Object.hasOwn(CONSTANTS, node.name)) return CONSTANTS[node.name]!;
      throw new ExprRuntimeError(`unknown variable "${node.name}"`);
    }
    case 'vec':
      return node.items.map((n) => {
        const v = ev(n, env, budget);
        if (!isNum(v)) throw new ExprRuntimeError(`vector items must be numbers, got ${typeName(v)}`);
        return v;
      });
    case 'unary': {
      const v = ev(node.arg, env, budget);
      if (node.op === '!') return !bool(v, '!');
      if (isNum(v)) return -v;
      if (isVec(v)) return v.map((x) => -x);
      if (isQuat(v)) return quat(-v.w, -v.x, -v.y, -v.z);
      throw new ExprRuntimeError(`cannot negate ${typeName(v)}`);
    }
    case 'binary': {
      if (node.op === '&&') return bool(ev(node.left, env, budget), '&&') && bool(ev(node.right, env, budget), '&&');
      if (node.op === '||') return bool(ev(node.left, env, budget), '||') || bool(ev(node.right, env, budget), '||');
      const a = ev(node.left, env, budget);
      const b = ev(node.right, env, budget);
      if (['==', '!=', '<', '>', '<=', '>='].includes(node.op)) return compare(node.op, a, b);
      return arith(node.op, a, b);
    }
    case 'cond':
      return bool(ev(node.test, env, budget), 'condition') ? ev(node.then, env, budget) : ev(node.else, env, budget);
    case 'lambda': {
      const fn: Fn = {
        kind: 'fn',
        arity: node.params.length,
        call: (args) => {
          const local: Record<string, Value> = { ...env };
          node.params.forEach((p, i) => (local[p] = args[i]!));
          return ev(node.body, local, budget);
        },
      };
      return fn;
    }
    case 'member': {
      const o = ev(node.object, env, budget);
      const field = node.name;
      if (isQuat(o) && (field === 'w' || field === 'x' || field === 'y' || field === 'z')) return o[field];
      if (isVec(o)) {
        const i = ['x', 'y', 'z', 'w'].indexOf(field);
        if (i >= 0 && i < o.length) return o[i]!;
      }
      throw new ExprRuntimeError(`${typeName(o)} has no field "${field}"`);
    }
    case 'index': {
      const o = ev(node.object, env, budget);
      const i = ev(node.index, env, budget);
      if (!isVec(o)) throw new ExprRuntimeError(`cannot index ${typeName(o)}`);
      if (!isNum(i) || !Number.isInteger(i) || i < 0 || i >= o.length) {
        throw new ExprRuntimeError(`index ${String(i)} out of range for ${typeName(o)}`);
      }
      return o[i]!;
    }
    case 'call': {
      if (SPECIAL_FORMS.has(node.fn)) return iterate(node.args, env, budget);
      const b = BUILTINS[node.fn];
      if (!b) throw new ExprRuntimeError(`unknown function "${node.fn}"`);
      const [lo, hi] = b.arity;
      if (node.args.length < lo || node.args.length > hi) {
        throw new ExprRuntimeError(`${node.fn} takes ${lo === hi ? lo : `${lo}–${hi}`} argument(s), got ${node.args.length}`);
      }
      return b.fn(node.args.map((a) => ev(a, env, budget)));
    }
  }
}

function iterate(args: readonly Node[], env: Env, budget: Budget): Value {
  if (args.length !== 3) throw new ExprRuntimeError('iterate takes 3 arguments: iterate(n, x -> f(x), x0)');
  const n = ev(args[0]!, env, budget);
  if (!isNum(n) || !Number.isInteger(n) || n < 0 || n > ITERATE_MAX) {
    throw new ExprRuntimeError(`iterate: n must be an integer in 0..${ITERATE_MAX}`);
  }
  const f = ev(args[1]!, env, budget);
  if (!isFn(f) || f.arity !== 1) throw new ExprRuntimeError('iterate: second argument must be a one-argument function');
  let x = ev(args[2]!, env, budget);
  for (let i = 0; i < n; i++) x = f.call([x]);
  return x;
}

/** Evaluate a parsed expression with a step budget. Never runs host code; never does I/O. */
export function evaluate(node: Node, env: Env = {}, budget = DEFAULT_BUDGET): Value {
  return ev(node, env, new Budget(budget));
}

export function evalExpr(src: string, env: Env = {}, budget = DEFAULT_BUDGET): Value {
  return evaluate(parseExpr(src), env, budget);
}

/** Run `a = …; b = …` against a state, returning the new state (all right-hand sides see the old state). */
export function runAssignments(src: string, state: Env, budget = DEFAULT_BUDGET): Record<string, Value> {
  const assigns = parseAssignments(src);
  const b = new Budget(budget);
  const next: Record<string, Value> = { ...state };
  for (const a of assigns) next[a.name] = ev(a.value, state, b);
  return next;
}

/** Variables an expression reads that are neither bound by lambdas nor constants. */
export function freeVariables(node: Node, bound: ReadonlySet<string> = new Set()): Set<string> {
  const out = new Set<string>();
  const walk = (n: Node, b: ReadonlySet<string>): void => {
    switch (n.type) {
      case 'var':
        if (!b.has(n.name) && !Object.hasOwn(CONSTANTS, n.name)) out.add(n.name);
        return;
      case 'num':
        return;
      case 'vec':
        n.items.forEach((i) => walk(i, b));
        return;
      case 'unary':
        walk(n.arg, b);
        return;
      case 'binary':
        walk(n.left, b);
        walk(n.right, b);
        return;
      case 'cond':
        walk(n.test, b);
        walk(n.then, b);
        walk(n.else, b);
        return;
      case 'lambda':
        walk(n.body, new Set([...b, ...n.params]));
        return;
      case 'member':
        walk(n.object, b);
        return;
      case 'index':
        walk(n.object, b);
        walk(n.index, b);
        return;
      case 'call':
        n.args.forEach((a) => walk(a, b));
        return;
    }
  };
  walk(node, bound);
  return out;
}

/** Function names an expression calls that do not exist. */
export function unknownFunctions(node: Node): Set<string> {
  const out = new Set<string>();
  const walk = (n: Node): void => {
    if (n.type === 'call') {
      if (!BUILTINS[n.fn] && !SPECIAL_FORMS.has(n.fn)) out.add(n.fn);
      n.args.forEach(walk);
    } else if (n.type === 'vec') n.items.forEach(walk);
    else if (n.type === 'unary') walk(n.arg);
    else if (n.type === 'binary') {
      walk(n.left);
      walk(n.right);
    } else if (n.type === 'cond') {
      walk(n.test);
      walk(n.then);
      walk(n.else);
    } else if (n.type === 'lambda') walk(n.body);
    else if (n.type === 'member') walk(n.object);
    else if (n.type === 'index') {
      walk(n.object);
      walk(n.index);
    }
  };
  walk(node);
  return out;
}

export type { Vec };
