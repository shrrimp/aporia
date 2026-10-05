import { ExprRuntimeError, isNum, isQuat, isVec, qmul, quat, rotate, typeName, type Quat, type Value, type Vec } from './values.ts';

type Builtin = { readonly arity: readonly [number, number]; readonly fn: (args: readonly Value[]) => Value };

const num = (v: Value, name: string): number => {
  if (!isNum(v)) throw new ExprRuntimeError(`${name}: expected a number, got ${typeName(v)}`);
  return v;
};
const vec = (v: Value, name: string, len?: number): Vec => {
  if (!isVec(v)) throw new ExprRuntimeError(`${name}: expected a vector, got ${typeName(v)}`);
  if (len !== undefined && v.length !== len) throw new ExprRuntimeError(`${name}: expected a ${len}-vector, got ${v.length}`);
  return v;
};
const qt = (v: Value, name: string): Quat => {
  if (!isQuat(v)) throw new ExprRuntimeError(`${name}: expected a quaternion, got ${typeName(v)}`);
  return v;
};

const scalar = (f: (x: number) => number, name: string): Builtin => ({ arity: [1, 1], fn: ([x]) => f(num(x!, name)) });

function norm(v: Value, name: string): number {
  if (isQuat(v)) return Math.hypot(v.w, v.x, v.y, v.z);
  return Math.hypot(...vec(v, name));
}

function normalize(v: Value): Value {
  const n = norm(v, 'normalize');
  if (n === 0) throw new ExprRuntimeError('normalize: zero length');
  if (isQuat(v)) return quat(v.w / n, v.x / n, v.y / n, v.z / n);
  return (v as Vec).map((x) => x / n);
}

/** Rotation by angle |v| about v/|v| (the exponential map of ω·dt). */
function qexp(v: Vec): Quat {
  const angle = Math.hypot(...v);
  if (angle === 0) return quat(1, 0, 0, 0);
  const s = Math.sin(angle / 2) / angle;
  return quat(Math.cos(angle / 2), v[0]! * s, v[1]! * s, v[2]! * s);
}

export const BUILTINS: Readonly<Record<string, Builtin>> = {
  sin: scalar(Math.sin, 'sin'),
  cos: scalar(Math.cos, 'cos'),
  tan: scalar(Math.tan, 'tan'),
  asin: scalar(Math.asin, 'asin'),
  acos: scalar(Math.acos, 'acos'),
  atan: scalar(Math.atan, 'atan'),
  sqrt: scalar(Math.sqrt, 'sqrt'),
  exp: scalar(Math.exp, 'exp'),
  log: scalar(Math.log, 'log'),
  floor: scalar(Math.floor, 'floor'),
  ceil: scalar(Math.ceil, 'ceil'),
  round: scalar(Math.round, 'round'),
  sign: scalar(Math.sign, 'sign'),
  deg: scalar((d) => (d * Math.PI) / 180, 'deg'),
  atan2: { arity: [2, 2], fn: ([y, x]) => Math.atan2(num(y!, 'atan2'), num(x!, 'atan2')) },
  min: { arity: [2, 2], fn: ([a, b]) => Math.min(num(a!, 'min'), num(b!, 'min')) },
  max: { arity: [2, 2], fn: ([a, b]) => Math.max(num(a!, 'max'), num(b!, 'max')) },
  clamp: {
    arity: [3, 3],
    fn: ([x, lo, hi]) => Math.min(num(hi!, 'clamp'), Math.max(num(lo!, 'clamp'), num(x!, 'clamp'))),
  },
  lerp: {
    arity: [3, 3],
    fn: ([a, b, t]) => {
      const tt = num(t!, 'lerp');
      if (isNum(a!) && isNum(b!)) return a + (b - a) * tt;
      const va = vec(a!, 'lerp');
      const vb = vec(b!, 'lerp', va.length);
      return va.map((x, i) => x + (vb[i]! - x) * tt);
    },
  },
  abs: {
    arity: [1, 1],
    fn: ([x]) => (isNum(x!) ? Math.abs(x) : norm(x!, 'abs')),
  },
  norm: { arity: [1, 1], fn: ([v]) => norm(v!, 'norm') },
  normalize: { arity: [1, 1], fn: ([v]) => normalize(v!) },
  len: { arity: [1, 1], fn: ([v]) => vec(v!, 'len').length },
  dot: {
    arity: [2, 2],
    fn: ([a, b]) => {
      const va = vec(a!, 'dot');
      const vb = vec(b!, 'dot', va.length);
      return va.reduce((s, x, i) => s + x * vb[i]!, 0);
    },
  },
  cross: {
    arity: [2, 2],
    fn: ([a, b]) => {
      const [ax, ay, az] = vec(a!, 'cross', 3) as [number, number, number];
      const [bx, by, bz] = vec(b!, 'cross', 3) as [number, number, number];
      return [ay * bz - az * by, az * bx - ax * bz, ax * by - ay * bx];
    },
  },
  quat: {
    arity: [4, 4],
    fn: (a) => quat(num(a[0]!, 'quat'), num(a[1]!, 'quat'), num(a[2]!, 'quat'), num(a[3]!, 'quat')),
  },
  quat_axis_angle: {
    arity: [2, 2],
    fn: ([axis, angle]) => {
      const a = vec(axis!, 'quat_axis_angle', 3);
      const n = Math.hypot(...a);
      if (n === 0) throw new ExprRuntimeError('quat_axis_angle: zero axis');
      return qexp(a.map((x) => (x / n) * num(angle!, 'quat_axis_angle')));
    },
  },
  qexp: { arity: [1, 1], fn: ([v]) => qexp(vec(v!, 'qexp', 3)) },
  conj: {
    arity: [1, 1],
    fn: ([q]) => {
      const a = qt(q!, 'conj');
      return quat(a.w, -a.x, -a.y, -a.z);
    },
  },
  inverse: {
    arity: [1, 1],
    fn: ([q]) => {
      const a = qt(q!, 'inverse');
      const n2 = a.w * a.w + a.x * a.x + a.y * a.y + a.z * a.z;
      if (n2 === 0) throw new ExprRuntimeError('inverse: zero quaternion');
      return quat(a.w / n2, -a.x / n2, -a.y / n2, -a.z / n2);
    },
  },
  qmul: { arity: [2, 2], fn: ([a, b]) => qmul(qt(a!, 'qmul'), qt(b!, 'qmul')) },
  rotate: { arity: [2, 2], fn: ([q, v]) => rotate(qt(q!, 'rotate'), vec(v!, 'rotate', 3)) },
};

export const CONSTANTS: Readonly<Record<string, Value>> = { pi: Math.PI, e: Math.E, true: true, false: false };

/** Functions with special evaluation (they take lambdas). */
export const SPECIAL_FORMS = new Set(['iterate']);

export const ITERATE_MAX = 10_000;
