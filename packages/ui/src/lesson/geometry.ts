import { rotate, type Quat, type Vec } from './eval.ts';

export interface Camera {
  /** Rotation about the vertical (y) axis, radians. */
  readonly yaw: number;
  /** Tilt, radians. */
  readonly pitch: number;
}

export const DEFAULT_CAMERA: Camera = { yaw: -0.6, pitch: 0.45 };

export interface Projected {
  readonly x: number;
  readonly y: number;
  /** Larger = closer to the viewer. */
  readonly depth: number;
}

/**
 * Orthographic projection of a y-up, right-handed world onto the screen (screen y down).
 * 2D points map straight through with y flipped.
 */
export function project(p: Vec, camera: Camera): Projected {
  if (p.length === 2) return { x: p[0]!, y: -p[1]!, depth: 0 };
  const [x, y, z] = p as [number, number, number];
  const cy = Math.cos(camera.yaw);
  const sy = Math.sin(camera.yaw);
  const x1 = x * cy + z * sy;
  const z1 = -x * sy + z * cy;
  const cp = Math.cos(camera.pitch);
  const sp = Math.sin(camera.pitch);
  const y2 = y * cp - z1 * sp;
  const z2 = y * sp + z1 * cp;
  return { x: x1, y: -y2, depth: z2 };
}

/** The 12 edges of a box (as pairs of world points). */
export function boxEdges(center: Vec, size: Vec, q: Quat): [Vec, Vec][] {
  const h = size.map((s) => s / 2) as [number, number, number];
  const corners: Vec[] = [];
  for (const sx of [-1, 1]) for (const sy of [-1, 1]) for (const sz of [-1, 1]) {
    const r = rotate(q, [sx * h[0], sy * h[1], sz * h[2]]);
    corners.push([r[0]! + center[0]!, r[1]! + center[1]!, r[2]! + center[2]!]);
  }
  const edges: [Vec, Vec][] = [];
  for (let i = 0; i < 8; i++) {
    for (let j = i + 1; j < 8; j++) {
      const diff = (i ^ j) as number;
      if (diff === 1 || diff === 2 || diff === 4) edges.push([corners[i]!, corners[j]!]);
    }
  }
  return edges;
}

/** World-space axes of a frame: [x, y, z] unit vectors rotated by q and scaled. */
export function frameAxes(q: Quat, size: number, dims: 2 | 3, angle = 0): Vec[] {
  if (dims === 2) {
    const c = Math.cos(angle) * size;
    const s = Math.sin(angle) * size;
    return [
      [c, s],
      [-s, c],
    ];
  }
  return [rotate(q, [size, 0, 0]), rotate(q, [0, size, 0]), rotate(q, [0, 0, size])];
}

export const add = (a: Vec, b: Vec): Vec => a.map((x, i) => x + b[i]!);

/** "Nice" tick values covering [min, max]. */
export function ticks(min: number, max: number, target = 5): number[] {
  const span = max - min;
  if (!(span > 0) || !Number.isFinite(span)) return [min];
  const raw = span / target;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 5, 10].map((m) => m * mag).find((s) => span / s <= target) ?? 10 * mag;
  const out: number[] = [];
  for (let t = Math.ceil(min / step) * step; t <= max + step * 1e-9; t += step) out.push(Math.abs(t) < step * 1e-9 ? 0 : t);
  return out;
}

/** Sample a function on [a, b]; non-finite or failing samples split the curve. */
export function sample(f: (x: number) => number, a: number, b: number, n = 200): { x: number; y: number }[][] {
  const runs: { x: number; y: number }[][] = [[]];
  for (let i = 0; i <= n; i++) {
    const x = a + ((b - a) * i) / n;
    let y: number;
    try {
      y = f(x);
    } catch {
      y = Number.NaN;
    }
    if (Number.isFinite(y)) runs.at(-1)!.push({ x, y });
    else if (runs.at(-1)!.length > 0) runs.push([]);
  }
  return runs.filter((r) => r.length > 0);
}
