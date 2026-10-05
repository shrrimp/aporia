import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { isId, newId, uuidv7 } from '../src/index.ts';

describe('uuidv7', () => {
  it('encodes the timestamp, version and variant', () => {
    const id = uuidv7(0x0123456789ab, () => new Uint8Array(10).fill(0xff));
    expect(id).toBe('01234567-89ab-7fff-bfff-ffffffffffff');
  });

  it('orders by time', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 2 ** 47 }), fc.integer({ min: 1, max: 2 ** 20 }), (t, d) => {
        expect(uuidv7(t) < uuidv7(t + d)).toBe(true);
      }),
    );
  });

  it.each([-1, 2 ** 48, 1.5, Number.NaN])('rejects timestamp %s', (t) => {
    expect(() => uuidv7(t)).toThrow(RangeError);
  });
});

describe('newId / isId', () => {
  it('round-trips', () => {
    const id = newId('ev');
    expect(isId(id)).toBe(true);
    expect(isId(id, 'ev')).toBe(true);
    expect(isId(id, 'chg')).toBe(false);
  });

  it.each(['E', 'a', 'toolongprefix', 'a1'])('rejects prefix %s', (p) => {
    expect(() => newId(p)).toThrow(TypeError);
  });

  it.each([42, 'ev_nope', 'ev_01234567-89ab-4fff-bfff-ffffffffffff', null])('isId rejects %s', (v) => {
    expect(isId(v)).toBe(false);
  });
});
