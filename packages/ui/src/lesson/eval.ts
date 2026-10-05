import {
  evaluate,
  isNum,
  isQuat,
  isVec,
  parseExpr,
  quat,
  rotate,
  runAssignments,
  type Env,
  type Node,
  type Quat,
  type Value,
  type Vec,
} from '@app/catalog';

const cache = new Map<string, Node>();
const RENDER_BUDGET = 100_000;

/** Parse once, evaluate many times (every frame of an explorable). */
export function ev(src: string, env: Env): Value {
  let node = cache.get(src);
  if (!node) {
    node = parseExpr(src);
    if (cache.size > 5000) cache.clear();
    cache.set(src, node);
  }
  return evaluate(node, env, RENDER_BUDGET);
}

export function evVec(src: string, env: Env, dims: 2 | 3): Vec {
  const v = ev(src, env);
  if (!isVec(v) || v.length !== dims) throw new Error(`"${src}" is not a ${dims}-vector`);
  return v;
}

export function evNum(src: string, env: Env): number {
  const v = ev(src, env);
  if (!isNum(v)) throw new Error(`"${src}" is not a number`);
  return v;
}

export function evQuat(src: string | undefined, env: Env): Quat {
  if (src === undefined) return quat(1, 0, 0, 0);
  const v = ev(src, env);
  if (!isQuat(v)) throw new Error(`"${src}" is not a quaternion`);
  return v;
}

export { runAssignments, rotate };
export type { Env, Value, Vec, Quat };
