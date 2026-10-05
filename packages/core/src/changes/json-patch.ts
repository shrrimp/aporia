/**
 * Minimal RFC 6902 JSON Patch (add, remove, replace, test) with RFC 6901 pointers.
 * Every apply also produces the exact inverse patch, which is what makes changes undoable.
 * Documents are treated as immutable: apply returns a new document.
 */

export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

export type PatchOp =
  | { op: 'add'; path: string; value: JsonValue }
  | { op: 'remove'; path: string }
  | { op: 'replace'; path: string; value: JsonValue }
  | { op: 'test'; path: string; value: JsonValue };

export class PatchError extends Error {
  override readonly name = 'PatchError';
  readonly opIndex: number;
  constructor(message: string, opIndex: number) {
    super(`op ${opIndex}: ${message}`);
    this.opIndex = opIndex;
  }
}

const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

export function parsePointer(pointer: string): string[] {
  if (pointer === '') return [];
  if (!pointer.startsWith('/')) throw new Error(`invalid JSON pointer: ${pointer}`);
  return pointer
    .slice(1)
    .split('/')
    .map((t) => {
      if (/~[^01]|~$/.test(t)) throw new Error(`invalid escape in JSON pointer: ${pointer}`);
      const key = t.replaceAll('~1', '/').replaceAll('~0', '~');
      if (FORBIDDEN_KEYS.has(key)) throw new Error(`forbidden key in JSON pointer: ${key}`);
      return key;
    });
}

export function formatPointer(tokens: readonly string[]): string {
  return tokens.map((t) => `/${t.replaceAll('~', '~0').replaceAll('/', '~1')}`).join('');
}

function isObject(v: unknown): v is { [key: string]: JsonValue } {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

export function deepEqual(a: JsonValue, b: JsonValue): boolean {
  if (a === b) return true;
  if (Array.isArray(a)) {
    return Array.isArray(b) && a.length === b.length && a.every((x, i) => deepEqual(x, b[i]!));
  }
  if (isObject(a) && isObject(b)) {
    const ka = Object.keys(a);
    const kb = Object.keys(b);
    return ka.length === kb.length && ka.every((k) => Object.hasOwn(b, k) && deepEqual(a[k]!, b[k]!));
  }
  return false;
}

function arrayIndex(token: string, length: number, allowEnd: boolean): number {
  if (allowEnd && token === '-') return length;
  if (!/^(0|[1-9][0-9]*)$/.test(token)) throw new Error(`invalid array index "${token}"`);
  const i = Number(token);
  if (i > length || (!allowEnd && i === length)) throw new Error(`array index ${i} out of bounds`);
  return i;
}

/** Copy-on-write update of the container at `parentTokens`. */
function updateAt(
  doc: JsonValue,
  parentTokens: readonly string[],
  fn: (container: JsonValue) => JsonValue,
): JsonValue {
  if (parentTokens.length === 0) return fn(doc);
  const [head, ...rest] = parentTokens as [string, ...string[]];
  if (Array.isArray(doc)) {
    const i = arrayIndex(head, doc.length, false);
    const copy = doc.slice();
    copy[i] = updateAt(doc[i]!, rest, fn);
    return copy;
  }
  if (isObject(doc)) {
    if (!Object.hasOwn(doc, head)) throw new Error(`path not found at "${head}"`);
    return { ...doc, [head]: updateAt(doc[head]!, rest, fn) };
  }
  throw new Error(`cannot traverse into a primitive at "${head}"`);
}

export function getAt(doc: JsonValue, tokens: readonly string[]): JsonValue {
  let cur = doc;
  for (const t of tokens) {
    if (Array.isArray(cur)) cur = cur[arrayIndex(t, cur.length, false)]!;
    else if (isObject(cur) && Object.hasOwn(cur, t)) cur = cur[t]!;
    else throw new Error(`path not found at "${t}"`);
  }
  return cur;
}

export interface PatchResult {
  readonly doc: JsonValue;
  /** Applying `inverse` to `doc` yields the original document. */
  readonly inverse: PatchOp[];
}

export function applyPatch(doc: JsonValue, patch: readonly PatchOp[]): PatchResult {
  let cur = doc;
  const inverse: PatchOp[] = [];
  patch.forEach((op, index) => {
    try {
      const tokens = parsePointer(op.path);
      const r = applyOne(cur, op, tokens);
      cur = r.doc;
      inverse.unshift(...r.inverse);
    } catch (err) {
      if (err instanceof PatchError) throw err;
      throw new PatchError((err as Error).message, index);
    }
  });
  return { doc: cur, inverse };
}

function applyOne(doc: JsonValue, op: PatchOp, tokens: string[]): { doc: JsonValue; inverse: PatchOp[] } {
  if (op.op === 'test') {
    if (!deepEqual(getAt(doc, tokens), op.value)) throw new Error(`test failed at ${op.path}`);
    return { doc, inverse: [] };
  }
  if (tokens.length === 0) {
    // Whole-document operations.
    if (op.op === 'remove') throw new Error('cannot remove the document root');
    return {
      doc: structuredClone(op.value),
      inverse: [{ op: 'replace', path: '', value: doc }],
    };
  }
  const parent = tokens.slice(0, -1);
  const key = tokens.at(-1)!;
  let inverse: PatchOp[] = [];
  const next = updateAt(doc, parent, (container) => {
    if (Array.isArray(container)) {
      const copy = container.slice();
      if (op.op === 'add') {
        const i = arrayIndex(key, container.length, true);
        copy.splice(i, 0, structuredClone(op.value));
        inverse = [{ op: 'remove', path: formatPointer([...parent, String(i)]) }];
      } else {
        const i = arrayIndex(key, container.length, false);
        const old = container[i]!;
        if (op.op === 'remove') {
          copy.splice(i, 1);
          inverse = [{ op: 'add', path: op.path, value: old }];
        } else {
          copy[i] = structuredClone(op.value);
          inverse = [{ op: 'replace', path: op.path, value: old }];
        }
      }
      return copy;
    }
    if (isObject(container)) {
      const exists = Object.hasOwn(container, key);
      if (op.op === 'add') {
        inverse = exists
          ? [{ op: 'replace', path: op.path, value: container[key]! }]
          : [{ op: 'remove', path: op.path }];
        return { ...container, [key]: structuredClone(op.value) };
      }
      if (!exists) throw new Error(`path not found: ${op.path}`);
      const old = container[key]!;
      if (op.op === 'remove') {
        const { [key]: _removed, ...rest } = container;
        inverse = [{ op: 'add', path: op.path, value: old }];
        return rest;
      }
      inverse = [{ op: 'replace', path: op.path, value: old }];
      return { ...container, [key]: structuredClone(op.value) };
    }
    throw new Error(`cannot apply ${op.op} inside a primitive at ${op.path}`);
  });
  return { doc: next, inverse };
}

/** Paths a patch writes to (used to detect overlapping, dependent changes). */
export function touchedPaths(patch: readonly PatchOp[]): string[] {
  return patch.filter((op) => op.op !== 'test').map((op) => op.path);
}

const ARRAY_TOKEN = /^(0|[1-9][0-9]*|-)$/;

/**
 * Conservative overlap test between two pointers: true when one is a prefix of the other,
 * or when they diverge at sibling array positions (an insert or removal shifts the other).
 */
export function pathsOverlap(a: string, b: string): boolean {
  const ta = parsePointer(a);
  const tb = parsePointer(b);
  const n = Math.min(ta.length, tb.length);
  for (let i = 0; i < n; i++) {
    if (ta[i] !== tb[i]) return ARRAY_TOKEN.test(ta[i]!) && ARRAY_TOKEN.test(tb[i]!);
  }
  return true;
}
