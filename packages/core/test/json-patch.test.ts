import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import {
  PatchError,
  applyPatch,
  deepEqual,
  formatPointer,
  getAt,
  parsePointer,
  pathsOverlap,
  touchedPaths,
  type JsonValue,
  type PatchOp,
} from '../src/index.ts';

describe('JSON pointers', () => {
  it('parses and escapes', () => {
    expect(parsePointer('')).toEqual([]);
    expect(parsePointer('/a~1b/~0c/0')).toEqual(['a/b', '~c', '0']);
    expect(formatPointer(['a/b', '~c'])).toBe('/a~1b/~0c');
  });

  it.each(['a', '/a~2', '/a~', '/__proto__', '/x/constructor', '/prototype'])('rejects %s', (p) => {
    expect(() => parsePointer(p)).toThrow();
  });

  it('round-trips (property)', () => {
    const safe = fc.string().filter((s) => !['__proto__', 'constructor', 'prototype'].includes(s));
    fc.assert(
      fc.property(fc.array(safe), (tokens) => {
        expect(parsePointer(formatPointer(tokens))).toEqual(tokens);
      }),
    );
  });
});

describe('applyPatch', () => {
  const doc: JsonValue = { a: 1, list: [10, 20], nested: { x: true } };

  it('applies add/remove/replace/test without mutating the input', () => {
    const before = structuredClone(doc);
    const { doc: out } = applyPatch(doc, [
      { op: 'test', path: '/a', value: 1 },
      { op: 'add', path: '/b', value: [1] },
      { op: 'add', path: '/list/1', value: 15 },
      { op: 'add', path: '/list/-', value: 30 },
      { op: 'replace', path: '/nested/x', value: false },
      { op: 'remove', path: '/a' },
      { op: 'remove', path: '/list/0' },
      { op: 'replace', path: '/list/0', value: 16 },
    ]);
    expect(out).toEqual({ b: [1], list: [16, 20, 30], nested: { x: false } });
    expect(doc).toEqual(before);
  });

  it('add on an existing key replaces it and inverts to the old value', () => {
    const r = applyPatch(doc, [{ op: 'add', path: '/a', value: 2 }]);
    expect(r.inverse).toEqual([{ op: 'replace', path: '/a', value: 1 }]);
    expect(applyPatch(r.doc, r.inverse).doc).toEqual(doc);
  });

  it('replaces the whole document and inverts it', () => {
    const r = applyPatch(null, [{ op: 'add', path: '', value: { new: 1 } }]);
    expect(r.doc).toEqual({ new: 1 });
    expect(applyPatch(r.doc, r.inverse).doc).toBeNull();
  });

  it.each<[string, PatchOp[]]>([
    ['test failure', [{ op: 'test', path: '/a', value: 2 }]],
    ['missing key', [{ op: 'remove', path: '/zzz' }]],
    ['missing parent', [{ op: 'add', path: '/no/x', value: 1 }]],
    ['root remove', [{ op: 'remove', path: '' }]],
    ['bad index', [{ op: 'replace', path: '/list/2', value: 1 }]],
    ['leading zero', [{ op: 'remove', path: '/list/01' }]],
    ['index past end', [{ op: 'add', path: '/list/3', value: 1 }]],
    ['into primitive', [{ op: 'add', path: '/a/x', value: 1 }]],
    ['traverse primitive', [{ op: 'add', path: '/a/x/y', value: 1 }]],
    ['traverse array', [{ op: 'add', path: '/list/9/y', value: 1 }]],
    ['test missing', [{ op: 'test', path: '/list/9', value: 1 }]],
    ['test through primitive', [{ op: 'test', path: '/a/b', value: 1 }]],
    ['bad pointer', [{ op: 'add', path: 'nope', value: 1 }]],
  ])('fails cleanly: %s', (_, patch) => {
    expect(() => applyPatch(doc, [{ op: 'test', path: '/a', value: 1 }, ...patch])).toThrow(PatchError);
    try {
      applyPatch(doc, [{ op: 'test', path: '/a', value: 1 }, ...patch]);
    } catch (err) {
      expect((err as PatchError).opIndex).toBe(1);
    }
  });

  it('inverse always restores the original (property)', () => {
    const json = fc.jsonValue({ maxDepth: 3 }) as fc.Arbitrary<JsonValue>;
    const docArb = fc.dictionary(fc.constantFrom('a', 'b', 'c'), json);
    fc.assert(
      fc.property(docArb, fc.array(fc.tuple(fc.constantFrom('add', 'remove', 'replace'), fc.constantFrom('a', 'b', 'c', 'd'), json), { maxLength: 6 }), (start, ops) => {
        let cur: JsonValue = start;
        for (const [op, key, value] of ops) {
          const patch: PatchOp[] = [op === 'remove' ? { op, path: `/${key}` } : { op, path: `/${key}`, value }];
          let r;
          try {
            r = applyPatch(cur, patch);
          } catch {
            continue;
          }
          expect(deepEqual(applyPatch(r.doc, r.inverse).doc, cur)).toBe(true);
          cur = r.doc;
        }
      }),
    );
  });
});

describe('helpers', () => {
  it('deepEqual', () => {
    expect(deepEqual({ a: [1, { b: null }] }, { a: [1, { b: null }] })).toBe(true);
    expect(deepEqual({ a: 1 }, { b: 1 })).toBe(false);
    expect(deepEqual({ a: 1 }, { a: 1, b: 2 })).toBe(false);
    expect(deepEqual([1], [1, 2])).toBe(false);
    expect(deepEqual([1], { 0: 1 })).toBe(false);
    expect(deepEqual(1, '1')).toBe(false);
  });

  it('getAt', () => {
    expect(getAt({ a: [{ b: 2 }] }, ['a', '0', 'b'])).toBe(2);
    expect(() => getAt({ a: 1 }, ['b'])).toThrow();
  });

  it('touchedPaths ignores tests', () => {
    expect(
      touchedPaths([
        { op: 'test', path: '/a', value: 1 },
        { op: 'remove', path: '/b' },
      ]),
    ).toEqual(['/b']);
  });

  it.each([
    ['/a', '/a/b', true],
    ['/a/b', '/a', true],
    ['/a/b', '/a/c', false],
    ['/list/0', '/list/3', true],
    ['/list/0/x', '/list/-', true],
    ['/a/x', '/b/x', false],
    ['', '/anything', true],
  ])('pathsOverlap(%s, %s) = %s', (a, b, expected) => {
    expect(pathsOverlap(a, b)).toBe(expected);
  });
});
