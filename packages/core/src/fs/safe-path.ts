import { realpath } from 'node:fs/promises';
import path from 'node:path';

export class PathEscapeError extends Error {
  override readonly name = 'PathEscapeError';
}

const FORBIDDEN_SEGMENT = /[\0]/;

/**
 * Resolve `segments` under `root`, refusing anything that would land outside it.
 * Pure string check: rejects absolute segments, NUL bytes and `..` escapes.
 * Use {@link resolveInsideReal} when symlinks inside root must also be contained.
 */
export function resolveInside(root: string, ...segments: string[]): string {
  if (!path.isAbsolute(root)) throw new PathEscapeError(`root must be absolute: ${root}`);
  for (const s of segments) {
    if (typeof s !== 'string' || s === '') throw new PathEscapeError('empty path segment');
    if (FORBIDDEN_SEGMENT.test(s)) throw new PathEscapeError('NUL byte in path segment');
    if (path.isAbsolute(s) || path.win32.isAbsolute(s)) {
      throw new PathEscapeError(`absolute path segment: ${s}`);
    }
  }
  const base = path.resolve(root);
  const target = path.resolve(base, ...segments.map((s) => s.replaceAll('\\', '/')));
  if (!isWithin(base, target)) throw new PathEscapeError(`path escapes root: ${segments.join('/')}`);
  return target;
}

/** Like {@link resolveInside}, then also follows symlinks of the deepest existing ancestor. */
export async function resolveInsideReal(root: string, ...segments: string[]): Promise<string> {
  const target = resolveInside(root, ...segments);
  const realRoot = await realpath(root);
  let probe = target;
  const rest: string[] = [];
  for (;;) {
    try {
      const real = await realpath(probe);
      const full = path.join(real, ...rest.reverse());
      if (!isWithin(realRoot, full)) throw new PathEscapeError(`symlink escapes root: ${segments.join('/')}`);
      return full;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
      const parent = path.dirname(probe);
      // The root itself exists (realpath above succeeded), so this loop always terminates.
      rest.push(path.basename(probe));
      probe = parent;
    }
  }
}

export function isWithin(base: string, target: string): boolean {
  const rel = path.relative(base, target);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}
