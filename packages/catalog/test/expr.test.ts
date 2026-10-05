import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import {
  ExprRuntimeError,
  ExprSyntaxError,
  MAX_SOURCE_LENGTH,
  evalExpr,
  formatValue,
  freeVariables,
  parseAssignments,
  parseExpr,
  quat,
  runAssignments,
  rotate,
  tokenize,
  unknownFunctions,
  type Quat,
  type Value,
} from '../src/expr/index.ts';

const close = (a: Value, b: Value) => {
  const flat = (v: Value): number[] =>
    typeof v === 'number' ? [v] : Array.isArray(v) ? [...v] : [(v as Quat).w, (v as Quat).x, (v as Quat).y, (v as Quat).z];
  const fa = flat(a);
  const fb = flat(b);
  expect(fa).toHaveLength(fb.length);
  fa.forEach((x, i) => expect(x).toBeCloseTo(fb[i]!, 9));
};

describe('parsing', () => {
  it('respects precedence and associativity', () => {
    expect(evalExpr('1 + 2 * 3')).toBe(7);
    expect(evalExpr('2 ^ 3 ^ 2')).toBe(512);
    expect(evalExpr('-2 ^ 2')).toBe(-4);
    expect(evalExpr('(1 + 2) * 3')).toBe(9);
    expect(evalExpr('10 - 4 - 3')).toBe(3);
    expect(evalExpr('1 < 2 && 2 < 3 || false')).toBe(true);
    expect(evalExpr('!(1 > 2) ? 1 : 2')).toBe(1);
    expect(evalExpr('1 > 2 ? 1 : 2 > 1 ? 3 : 4')).toBe(3);
    expect(evalExpr('1.5e2 + .5')).toBe(150.5);
    expect(evalExpr('-[1, 2][1]')).toBe(-2);
  });

  it.each([
    ['1 +', /end of expression/],
    ['(1', /expected "\)"/],
    ['1 2', /unexpected "2"/],
    ['a.', /field name/],
    ['f(1,', /end of expression/],
    ['$', /unexpected character/],
    ['[1, ]', /unexpected "\]"/],
    ['1 ? 2', /expected ":"/],
  ])('rejects %s', (src, msg) => {
    expect(() => parseExpr(src)).toThrow(msg);
  });

  it('limits size and depth', () => {
    expect(() => tokenize('1'.repeat(MAX_SOURCE_LENGTH + 1))).toThrow(ExprSyntaxError);
    expect(() => parseExpr('('.repeat(100) + '1' + ')'.repeat(100))).toThrow(/nested too deeply/);
  });

  it('parses assignments', () => {
    expect(parseAssignments('a = 1; b = a + 1;').map((a) => a.name)).toEqual(['a', 'b']);
    expect(() => parseAssignments('')).toThrow(/at least one/);
    expect(() => parseAssignments('1 = 2')).toThrow(/variable name/);
    expect(() => parseAssignments('a = 1 b = 2')).toThrow(/unexpected/);
  });

  it('never throws anything but syntax errors on arbitrary input (property)', () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 60 }), (src) => {
        try {
          parseExpr(src);
        } catch (err) {
          expect(err).toBeInstanceOf(ExprSyntaxError);
        }
      }),
    );
  });
});

describe('evaluation', () => {
  it('vectors and scalars', () => {
    expect(evalExpr('[1, 2] + [3, 4]')).toEqual([4, 6]);
    expect(evalExpr('[1, 2] - [3, 4]')).toEqual([-2, -2]);
    expect(evalExpr('2 * [1, 2] / 2')).toEqual([1, 2]);
    expect(evalExpr('[1, 2] * 3')).toEqual([3, 6]);
    expect(evalExpr('dot([1, 2, 3], [4, 5, 6])')).toBe(32);
    expect(evalExpr('cross([1, 0, 0], [0, 1, 0])')).toEqual([0, 0, 1]);
    expect(evalExpr('norm([3, 4])')).toBe(5);
    expect(evalExpr('normalize([3, 4])')).toEqual([0.6, 0.8]);
    expect(evalExpr('len([1, 2, 3])')).toBe(3);
    expect(evalExpr('[1, 2, 3].z + [1, 2].x')).toBe(4);
    expect(evalExpr('abs(-2) + abs([3, 4])')).toBe(7);
    expect(evalExpr('lerp(0, 10, 0.25)')).toBe(2.5);
    expect(evalExpr('lerp([0, 0], [10, 20], 0.5)')).toEqual([5, 10]);
    expect(evalExpr('clamp(5, 0, 1) + min(1, 2) + max(1, 2)')).toBe(4);
    expect(evalExpr('atan2(1, 1)')).toBeCloseTo(Math.PI / 4);
    expect(evalExpr('deg(180)')).toBeCloseTo(Math.PI);
    expect(evalExpr('round(sin(pi)) + floor(e) + ceil(0.1) + sign(-3) + sqrt(4) + exp(0) + log(1)')).toBe(5);
    expect(evalExpr('cos(0) + tan(0) + asin(0) + acos(1) + atan(0)')).toBe(1);
    expect(evalExpr('x * 2', { x: 21 })).toBe(42);
    expect(evalExpr('1 == 1 && 1 != 2 && 2 >= 2 && 1 <= 2 && true == true')).toBe(true);
  });

  it('quaternions', () => {
    const q = evalExpr('quat_axis_angle([0, 0, 1], pi / 2)') as Quat;
    close(rotate(q, [1, 0, 0]), [0, 1, 0]);
    close(evalExpr('rotate(q, [1, 0, 0])', { q }), [0, 1, 0]);
    close(evalExpr('q * conj(q)', { q }), quat(1, 0, 0, 0));
    close(evalExpr('qmul(q, inverse(q))', { q }), quat(1, 0, 0, 0));
    close(evalExpr('qexp([0, 0, 0])'), quat(1, 0, 0, 0));
    close(evalExpr('norm(q + q - q)', { q }), 1);
    close(evalExpr('2 * q / 2', { q }), q);
    close(evalExpr('-q * 1', { q }), quat(-q.w, -q.x, -q.y, -q.z));
    expect(evalExpr('quat(1, 2, 3, 4).y')).toBe(3);
    close(evalExpr('normalize(quat(2, 0, 0, 0))'), quat(1, 0, 0, 0));
  });

  it('reproduces the lesson-9 quaternion experiment', () => {
    // Euler on q̇ = ½ q ⊗ (0, ω) drifts off the unit sphere; the exponential map does not.
    const q0 = evalExpr('quat_axis_angle([1, -2, 0.5], deg(50))');
    const euler = evalExpr('iterate(10, q -> q + q * quat(0, 0, 1.5, 0) * (0.5 * 0.05), q0)', { q0 });
    const expmap = evalExpr('iterate(10, q -> q * qexp([0, 1.5, 0] * 0.05), q0)', { q0 });
    expect(evalExpr('norm(q)', { q: euler })).toBeGreaterThan(1.001);
    expect(evalExpr('norm(q)', { q: expmap })).toBeCloseTo(1, 12);
  });

  it('lambdas, iterate and assignments', () => {
    expect(evalExpr('iterate(5, x -> x * 2, 1)')).toBe(32);
    expect(evalExpr('iterate(0, x -> x, 7)')).toBe(7);
    expect(runAssignments('a = b; b = a', { a: 1, b: 2 })).toEqual({ a: 2, b: 1 });
    expect(evalExpr('(x) -> x', {})).toMatchObject({ kind: 'fn', arity: 1 });
    expect(evalExpr('(a, b) -> a + b')).toMatchObject({ arity: 2 });
  });

  it.each([
    ['nope', /unknown variable/],
    ['nope(1)', /unknown function/],
    ['sin(1, 2)', /takes 1/],
    ['sin([1])', /expected a number/],
    ['[1] + [1, 2]', /lengths differ/],
    ['[1] + 1', /cannot apply/],
    ['[true]', /must be numbers/],
    ['-true', /cannot negate/],
    ['!1', /expected a boolean/],
    ['1 && true', /expected a boolean/],
    ['[1] == [1]', /compare numbers/],
    ['true < 1', /expected numbers/],
    ['1 ? 2 : 3', /expected a boolean/],
    ['[1, 2].z', /has no field/],
    ['quat(1,0,0,0).v', /has no field/],
    ['(1).x', /has no field/],
    ['[1][1]', /out of range/],
    ['[1][0.5]', /out of range/],
    ['1[0]', /cannot index/],
    ['normalize([0, 0])', /zero length/],
    ['cross([1, 0], [0, 1])', /3-vector/],
    ['conj(1)', /quaternion/],
    ['inverse(quat(0, 0, 0, 0))', /zero quaternion/],
    ['quat_axis_angle([0, 0, 0], 1)', /zero axis/],
    ['iterate(1, x -> x)', /3 arguments/],
    ['iterate(-1, x -> x, 0)', /integer/],
    ['iterate(2, 3, 0)', /one-argument function/],
    ['iterate(1, (a, b) -> a, 0)', /one-argument function/],
    ['dot(1, [1])', /expected a vector/],
  ])('runtime error: %s', (src, msg) => {
    expect(() => evalExpr(src)).toThrow(msg);
  });

  it('enforces the step budget', () => {
    expect(() => evalExpr('iterate(10000, x -> iterate(10000, y -> y + 1, x), 0)')).toThrow(/budget/);
    expect(() => evalExpr('1 + 1', {}, 1)).toThrow(ExprRuntimeError);
  });

  it('only ever throws expression errors and always terminates (property)', () => {
    const atom = fc.constantFrom('1', 'x', 'q', '[1, 2, 3]', 'pi', 'true', 'quat(1, 0, 0, 0)');
    const fnName = fc.constantFrom('sin', 'norm', 'normalize', 'rotate', 'cross', 'iterate', 'nope', 'qexp', 'conj');
    const exprArb: fc.Arbitrary<string> = fc.letrec<{ e: string }>((tie) => ({
      e: fc.oneof(
        { depthSize: 'small' },
        atom,
        fc.tuple(tie('e'), fc.constantFrom('+', '-', '*', '/', '^', '<', '==', '&&'), tie('e')).map(([a, o, b]) => `(${a} ${o} ${b})`),
        fc.tuple(fnName, fc.array(tie('e'), { maxLength: 3 })).map(([f, args]) => `${f}(${args.join(', ')})`),
        tie('e').map((e) => `-(${e})`),
      ),
    })).e;
    fc.assert(
      fc.property(exprArb, (src) => {
        try {
          evalExpr(src, { x: 2, q: quat(1, 0, 0, 0) }, 10_000);
        } catch (err) {
          expect(err instanceof ExprRuntimeError || err instanceof ExprSyntaxError).toBe(true);
        }
      }),
    );
  });
});

describe('static analysis and formatting', () => {
  it('finds free variables and unknown functions', () => {
    const n = parseExpr('iterate(n, s -> s * qexp(w * dt), q0) + nope(pi, [a][0].x, b ? c : -d, !e2)');
    expect([...freeVariables(n)].sort()).toEqual(['a', 'b', 'c', 'd', 'dt', 'e2', 'n', 'q0', 'w']);
    expect([...unknownFunctions(n)]).toEqual(['nope']);
    expect([...unknownFunctions(parseExpr('[f(1)] + (true ? g(2) : -h(3))[0].x + (k -> m(k))'))].sort()).toEqual(['f', 'g', 'h', 'm']);
    expect([...unknownFunctions(parseExpr('!z(1) && 2 + y(1)'))].sort()).toEqual(['y', 'z']);
  });

  it('formats values', () => {
    expect(formatValue(1.23456)).toBe('1.235');
    expect(formatValue(true)).toBe('true');
    expect(formatValue([1, Number.NaN], 1)).toBe('(1.0, NaN)');
    expect(formatValue(quat(1, 0, 0, 0), 0)).toBe('(1; 0, 0, 0)');
    expect(formatValue(evalExpr('x -> x'))).toBe('function');
  });
});
