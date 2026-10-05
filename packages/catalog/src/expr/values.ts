export interface Quat {
  readonly kind: 'quat';
  readonly w: number;
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

export interface Fn {
  readonly kind: 'fn';
  readonly arity: number;
  call(args: readonly Value[]): Value;
}

export type Vec = readonly number[];
export type Value = number | boolean | Vec | Quat | Fn;

export class ExprRuntimeError extends Error {
  override readonly name = 'ExprRuntimeError';
}

export const isNum = (v: Value): v is number => typeof v === 'number';
export const isBool = (v: Value): v is boolean => typeof v === 'boolean';
export const isVec = (v: Value): v is Vec => Array.isArray(v);
export const isQuat = (v: Value): v is Quat => typeof v === 'object' && !Array.isArray(v) && (v as Quat | Fn).kind === 'quat';
export const isFn = (v: Value): v is Fn => typeof v === 'object' && !Array.isArray(v) && (v as Quat | Fn).kind === 'fn';

export const quat = (w: number, x: number, y: number, z: number): Quat => ({ kind: 'quat', w, x, y, z });

export function typeName(v: Value): string {
  if (isNum(v)) return 'number';
  if (isBool(v)) return 'boolean';
  if (isVec(v)) return `vector${v.length}`;
  if (isQuat(v)) return 'quaternion';
  return 'function';
}

export function qmul(a: Quat, b: Quat): Quat {
  return quat(
    a.w * b.w - a.x * b.x - a.y * b.y - a.z * b.z,
    a.w * b.x + a.x * b.w + a.y * b.z - a.z * b.y,
    a.w * b.y - a.x * b.z + a.y * b.w + a.z * b.x,
    a.w * b.z + a.x * b.y - a.y * b.x + a.z * b.w,
  );
}

/** Rotate a 3-vector by a quaternion (q v q*). Does not assume |q| = 1, like glm::mat3_cast. */
export function rotate(q: Quat, v: Vec): Vec {
  const r = qmul(qmul(q, quat(0, v[0]!, v[1]!, v[2]!)), quat(q.w, -q.x, -q.y, -q.z));
  return [r.x, r.y, r.z];
}

/** Format a value for readouts. */
export function formatValue(v: Value, digits = 3): string {
  const f = (n: number) => (Number.isFinite(n) ? n.toFixed(digits) : String(n));
  if (isNum(v)) return f(v);
  if (isBool(v)) return String(v);
  if (isVec(v)) return `(${v.map(f).join(', ')})`;
  if (isQuat(v)) return `(${f(v.w)}; ${f(v.x)}, ${f(v.y)}, ${f(v.z)})`;
  return 'function';
}
