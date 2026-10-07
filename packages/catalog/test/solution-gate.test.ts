import { describe, expect, it } from 'vitest';
import { declaredNames, implementationLines, lesson as lessonSchema, openTaskShapes, solutionFor, taskKey } from '../src/index.ts';
import { fourNumbers } from '../fixtures/four-numbers.ts';

const lesson = lessonSchema.parse(fourNumbers);

const SOLUTION_CPP = `void integratePosition(const Joint& j, std::span<double> q,
                       std::span<const double> v, double dt) {
    Quat w = qexp(Vec3(v[0], v[1], v[2]) * dt);
    Quat r = Quat(q[0], q[1], q[2], q[3]) * w;
    store(q, r.normalized());
}`;

describe('declaredNames', () => {
  it('finds definitions across languages, not calls or control flow', () => {
    expect(declaredNames(SOLUTION_CPP)).toEqual(['integratePosition']);
    expect(declaredNames('static inline Quat* Joint::step(int n) const noexcept {\n}')).toEqual(['step']);
    expect(declaredNames('Vec3\nJoint::axis(const Model& m,\n    std::span<double> q)\n{\n}')).toEqual(['axis']);
    expect(declaredNames('def integrate(q, v, dt):\n    return q')).toEqual(['integrate']);
    expect(declaredNames('pub fn integrate(q: &mut [f64]) {}')).toEqual(['integrate']);
    expect(declaredNames('func Integrate(q []float64) {}')).toEqual(['Integrate']);
    expect(declaredNames('export function integrate(q) {}\nconst step = (x) => x;\nlet go = async function () {}')).toEqual(['integrate', 'step', 'go']);
    expect(declaredNames('integratePosition(j, q, v, dt);\nreturn integratePosition(j, q, v, dt);\nif (x) {\n}\n} else if (y) {')).toEqual([]);
    expect(declaredNames('int main() {\n}')).toEqual([]);
  });

  it('stays fast on hostile input', () => {
    const nasty = [`${'a '.repeat(20_000)}(`, `x ${'** '.repeat(5000)}y(`, `f(${'('.repeat(10_000)}`, `void f(${'a,'.repeat(20_000)}`].join('\n');
    const t = performance.now();
    declaredNames(nasty);
    expect(performance.now() - t).toBeLessThan(1500);
  });
});

describe('implementationLines', () => {
  it('counts logic, not headers, comments, braces or placeholders', () => {
    expect(implementationLines(SOLUTION_CPP)).toBe(3);
    expect(implementationLines('def integrate(q, v, dt):\n    # rotate\n    pass')).toBe(0);
    expect(implementationLines('def integrate(q, v, dt):\n    w = exp(v * dt)\n    return q * w')).toBe(2);
    expect(implementationLines('void f() {\n  /* a\n  b */\n  // TODO\n  return;\n}')).toBe(0);
  });
});

describe('openTaskShapes', () => {
  it('takes the names from the section stubs and the task title, until the task is done', () => {
    expect(openTaskShapes(lesson, {})).toEqual([{ taskId: 'step-2', title: 'integratePosition', names: ['integratePosition'] }]);
    expect(openTaskShapes(lesson, { [taskKey('step-2')]: null })).toHaveLength(1);
    expect(openTaskShapes(lesson, { [taskKey('step-2')]: { done: true } })).toEqual([]);
  });

  it('uses a title that is a name even without stubs, and skips tasks with neither', () => {
    const doc = structuredClone(fourNumbers) as unknown as { sections: { id: string; blocks: Record<string, unknown>[] }[] };
    const build = doc.sections.find((s) => s.id === 'build')!;
    build.blocks = build.blocks.filter((b) => b['type'] === 'task');
    build.blocks.push({ ...build.blocks[0], id: 'step-3', title: 'Make the chain fly' });
    build.blocks.push({ ...build.blocks[0], id: 'step-4', title: 'Body::applyImpulse' });
    expect(openTaskShapes(lessonSchema.parse(doc), {}).map((s) => [s.taskId, s.names])).toEqual([
      ['step-2', ['integratePosition']],
      ['step-4', ['applyImpulse']],
    ]);
  });
});

describe('solutionFor', () => {
  const shapes = openTaskShapes(lesson, {});

  it('hides an implementation of an open task', () => {
    expect(solutionFor(SOLUTION_CPP, shapes)).toMatchObject({ taskId: 'step-2' });
  });

  it('shows stubs, analogues, unrelated code, calls, and anything when no task is open', () => {
    const stub = fourNumbers.sections.flatMap((s) => s.blocks).find((b) => b.type === 'code') as { source: string };
    expect(solutionFor(stub.source, shapes)).toBeUndefined();
    expect(solutionFor('void integrateVelocity(Joint& j) {\n  a = b;\n  c = d;\n}', shapes)).toBeUndefined();
    expect(solutionFor('// call it from step():\nintegratePosition(j, q, v, dt);\nx = 1;\ny = 2;', shapes)).toBeUndefined();
    expect(solutionFor('void integratePosition(Joint& j) {\n  a = b;\n}', shapes)).toBeUndefined(); // one statement: not an implementation
    expect(solutionFor(SOLUTION_CPP, [])).toBeUndefined();
  });
});
