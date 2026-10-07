import { describe, expect, it } from 'vitest';
import { stubFindings, validateLesson, type LessonInput } from '../src/index.ts';
import { fourNumbers } from '../fixtures/four-numbers.ts';

const clone = (): LessonInput => structuredClone(fourNumbers);
type Any = Record<string, unknown> & { blocks: Record<string, unknown>[] };
const sec = (l: LessonInput, i: number) => l.sections[i] as unknown as Any;

function messages(l: LessonInput) {
  const r = validateLesson(l);
  return { errors: r.errors.map((e) => `${e.path}: ${e.message}`), warnings: r.warnings.map((w) => `${w.path}: ${w.message}`) };
}

describe('validateLesson', () => {
  it('accepts the golden lesson with no errors or warnings', () => {
    const r = validateLesson(fourNumbers);
    expect(r.errors).toEqual([]);
    expect(r.warnings).toEqual([]);
    expect(r.lesson?.sections).toHaveLength(6);
  });

  it('reports schema errors with readable paths, including a "solution" code kind', () => {
    const l = clone();
    sec(l, 3).blocks[1]!['kind'] = 'solution';
    const { errors } = messages(l);
    expect(errors[0]).toMatch(/^sections\[3\]\.blocks\[1\]\.kind/);
  });

  it('rejects stubs that contain an implementation', () => {
    const l = clone();
    sec(l, 3).blocks[1]!['source'] =
      'void integratePosition(const Joint& j, std::span<double> q, std::span<const double> v, double dt) {\n  Q = glm::normalize(Q * deltaQ);\n}';
    expect(messages(l).errors.join('\n')).toMatch(/stub contains implementation at line 2/);
  });

  it('checks expressions: syntax, unknown names, types, assignments', () => {
    const l = clone();
    const ex = sec(l, 1).blocks[2]! as Record<string, any>;
    ex['readouts'] = [{ label: 'bad', expr: 'norm(' }, { label: 'fn', expr: 'nope(q)' }, { label: 'v', expr: 'r + 1' }];
    ex['controls'][0].do = 'p = q';
    ex['controls'][1].do = 'q = 1';
    ex['controls'][2].do = 'q = undefinedVar';
    ex['controls'][3].do = 'q = zz(q)';
    ex['view'].elements[0].rotation = '[1, 2, 3]';
    const errors = messages(l).errors.join('\n');
    expect(errors).toMatch(/syntax error in "norm\("/);
    expect(errors).toMatch(/unknown function\(s\) nope/);
    expect(errors).toMatch(/unknown variable\(s\) r/);
    expect(errors).toMatch(/"p" is not in state/);
    expect(errors).toMatch(/assigning number to "q" which holds a quaternion/);
    expect(errors).toMatch(/unknown variable\(s\) undefinedVar/);
    expect(errors).toMatch(/unknown function\(s\) zz/);
    expect(errors).toMatch(/should be a quaternion, got vector3/);
  });

  it('checks explorable controls and state', () => {
    const l = clone();
    const ex = sec(l, 1).blocks[2]! as Record<string, any>;
    ex['controls'].push({ kind: 'slider', name: 'q', label: 'q', min: 1, max: 0, step: 1, initial: 5 });
    ex['controls'].push({ kind: 'toggle', name: 'show', label: 'show' });
    ex['controls'].push({ kind: 'play', label: 'go', do: 'q = q *' });
    expect(messages(l).errors.join('\n')).toMatch(/min must be less than max[\s\S]*initial value outside[\s\S]*also a control name/);
    const l2 = clone();
    const ex2 = sec(l2, 1).blocks[2]! as Record<string, any>;
    ex2['controls'].push({ kind: 'play', label: 'go', do: 'q = q *' });
    ex2['controls'].push({ kind: 'button', label: 'boom', do: 'q = normalize(quat(0, 0, 0, 0))' });
    const e2 = messages(l2).errors.join('\n');
    expect(e2).toMatch(/syntax error/);
    expect(e2).toMatch(/fails: normalize: zero length/);
    const l3 = clone();
    (sec(l3, 1).blocks[2]! as Record<string, any>)['state'] = { q: 'quat_axis_angle([0,0,0], 1)' };
    expect(messages(l3).errors.join('\n')).toMatch(/zero axis/);
  });

  it('checks diagrams and plots', () => {
    const l = clone();
    sec(l, 2).blocks.push(
      {
        type: 'diagram',
        dims: 2,
        description: 'd',
        elements: [
          { kind: 'point', at: '[1, 2, 3]' },
          { kind: 'vector', from: '[0, 0]', to: '[1, 0]' },
          { kind: 'segment', from: '[0, 0]', to: '1' },
          { kind: 'polyline', points: ['[0, 0]', '[1, 1]'] },
          { kind: 'circle', center: '[0, 0]', radius: '[1]' },
          { kind: 'frame', at: '[0, 0]', rotation: '0.5' },
          { kind: 'box', size: '[1, 1, 1]', center: '[0,0,0]' },
          { kind: 'label', at: '[0, 0]', text: 'O' },
        ],
      },
      { type: 'diagram', dims: 3, description: 'd', elements: [{ kind: 'circle', center: '[0,0,0]', radius: '1' }] },
      { type: 'plot', description: 'p', x: { min: 1, max: 0 }, y: { min: 1, max: 0 }, series: [{ label: 's' }, { label: 't', expr: 'x + [1]' }] },
    );
    const errors = messages(l).errors.join('\n');
    expect(errors).toMatch(/should be a vector2, got vector3/);
    expect(errors).toMatch(/should be a vector2, got number/);
    expect(errors).toMatch(/should be a number, got vector1/);
    expect(errors).toMatch(/box is only available in 3D/);
    expect(errors).toMatch(/circle is only available in 2D/);
    expect(errors).toMatch(/x\.min must be less/);
    expect(errors).toMatch(/y\.min must be less/);
    expect(errors).toMatch(/exactly one of "expr" or "data"/);
    expect(errors).toMatch(/cannot apply \+/);
  });

  it('checks code kinds, drills and duplicate ids', () => {
    const l = clone();
    sec(l, 3).blocks.push(
      { type: 'code', kind: 'trace', lang: 'cpp', source: 'x' },
      { type: 'code', kind: 'contrast', lang: 'cpp', source: 'x' },
      { type: 'code', kind: 'analogue', lang: 'cpp', source: 'x' },
      { type: 'task', id: 'step-2', title: 't', scaffold: 2, kcs: ['joint.nq-nv'], goal: 'g' },
      {
        type: 'drill',
        items: [
          { id: 'd1', kind: 'mcq', prompt: 'p', options: ['a', 'b'], answer: 2, kcs: ['joint.nq-nv'], difficulty: 3, why: 'w' },
          { id: 'd2', kind: 'order', prompt: 'p', lines: ['a', 'a'], kcs: ['joint.nq-nv'], difficulty: 3, why: 'w' },
          { id: 'd3', kind: 'numeric', prompt: 'p', answer: 1, kcs: ['joint.nq-nv'], difficulty: 3, why: 'w' },
          { id: 'd5', kind: 'mcq', prompt: 'p', options: ['a', 'b'], answer: 0, reason: { options: ['r1', 'r2'], answer: 2 }, kcs: ['joint.nq-nv'], difficulty: 3, why: 'w' },
          { id: 'd4', kind: 'short', prompt: 'p', answer: 'x', kcs: ['other.kc'], difficulty: 3, why: 'w' },
        ],
      },
    );
    const { errors, warnings } = messages(l);
    const all = errors.join('\n');
    expect(all).toMatch(/trace code must name/);
    expect(all).toMatch(/contrast code needs/);
    expect(all).toMatch(/analogue worked examples need subgoal/);
    expect(all).toMatch(/duplicate id "step-2"/);
    expect(all).toMatch(/answer index is out of range/);
    expect(all).toMatch(/\.reason: reason answer index is out of range/);
    expect(all).toMatch(/order lines must be distinct/);
    expect(warnings.join('\n')).toMatch(/KC "other\.kc" is not listed/);
  });

  it('gives composition warnings and rejects lessons with no activity', () => {
    const l: LessonInput = {
      ...clone(),
      sections: [
        { id: 'c', role: 'concept', blocks: [{ type: 'prose', md: 'word '.repeat(800) }, { type: 'math', tex: 'x' }] },
      ],
    };
    const { errors, warnings } = messages(l);
    expect(errors.join('\n')).toMatch(/no constructive activity/);
    const w = warnings.join('\n');
    expect(w).toMatch(/more than 700 words/);
    expect(w).toMatch(/should include a diagram/);
    expect(w).toMatch(/no warm-up/);
    expect(w).toMatch(/no open loop/);
    expect(w).toMatch(/transfer item/);
  });

  it('accepts open-loop blocks outside an open-loop section and drills with transfer items', () => {
    const l = clone();
    l.sections = l.sections.filter((s) => s.role !== 'open-loop' && s.role !== 'exit');
    l.sections.push({
      id: 'exit2',
      role: 'exit',
      blocks: [
        { type: 'drill', purpose: 'exit', items: [{ id: 'x1', kind: 'numeric', prompt: 'p', answer: 1, kcs: ['joint.nq-nv'], difficulty: 3, why: 'w', transfer: true }] },
        { type: 'open-loop', md: 'next' },
      ],
    });
    expect(validateLesson(l).warnings).toEqual([]);
  });
});

describe('stubFindings', () => {
  it.each([
    ['cpp stub', 'void f(int x) {\n  // TODO\n}', 0],
    ['cpp header', '#include <span>\nstruct Joint {\n  int type;\n};\nint nq(const Joint &j);', 0],
    ['placeholder returns', 'double g() {\n  return 0.0;\n}\nbool h() { return false; }', 0],
    ['python', 'def f(x):\n    """Docstring."""\n    raise NotImplementedError', 1],
    ['python pass', 'def f(x: int) -> int:\n    pass', 0],
    ['rust', 'fn f(x: f64) -> f64 {\n    todo!()\n}', 0],
    ['block comment', '/* explain\n   more */\nvoid f();', 0],
    ['implementation', 'int f(int x) {\n  int y = x * 2;\n  return y;\n}', 2],
    ['inline body', 'int f(int x) { return x * 2; }', 1],
  ])('%s', (_, src, count) => {
    expect(stubFindings(src)).toHaveLength(count);
  });
});
