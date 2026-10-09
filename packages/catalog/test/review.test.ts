import { describe, expect, it } from 'vitest';
import {
  formatNumber,
  instantiate,
  instantiateContext,
  isTemplate,
  pickVars,
  questionKey,
  questionProblems,
  reviewQuestion,
  selfContainedProblems,
  templateProblems,
  validateReviewBank,
  type ReviewQuestion,
} from '../src/index.ts';

const base = { kcs: ['quaternion.unit'], difficulty: 2, why: 'Because.' };
const mcq = (extra: Record<string, unknown> = {}): ReviewQuestion =>
  reviewQuestion.parse({ ...base, kind: 'mcq', angle: 'apply', prompt: 'Which is a unit quaternion?', options: ['(1, 0, 0, 0)', '(1, 1, 0, 0)'], answer: 0, ...extra });
const wheel = (extra: Record<string, unknown> = {}): ReviewQuestion =>
  reviewQuestion.parse({
    ...base,
    kind: 'numeric',
    angle: 'apply',
    context: 'A wheel of radius {{r}} m.',
    prompt: 'It spins at {{w}} rad/s. Rim speed in m/s?',
    vars: { r: { min: 0.5, max: 2, step: 0.5 }, w: { min: 1, max: 4, step: 1 } },
    answer: '{{ r * w }}',
    tolerance: 0.01,
    ...extra,
  });

describe('review questions', () => {
  it('are drill items without an id, with an angle, and never a short answer', () => {
    expect(mcq().angle).toBe('apply');
    expect(reviewQuestion.safeParse({ ...base, kind: 'short', angle: 'explain', prompt: 'Why?', answer: 'x' }).success).toBe(false);
    expect(reviewQuestion.safeParse({ ...base, kind: 'mcq', prompt: 'x', options: ['a', 'b'], answer: 0 }).success).toBe(false); // no angle
    expect(reviewQuestion.safeParse({ ...base, kind: 'numeric', angle: 'apply', prompt: 'x', answer: 1, vars: { a: { min: 2, max: 1, step: 1 } } }).success).toBe(false);
    expect(reviewQuestion.safeParse({ ...base, kind: 'numeric', angle: 'apply', prompt: 'x', answer: 1, vars: { a: { min: 0, max: 1e9, step: 1 } } }).success).toBe(false);
    const seven = Object.fromEntries('abcdefg'.split('').map((v) => [v, { min: 0, max: 1, step: 1 }]));
    expect(reviewQuestion.safeParse({ ...base, kind: 'numeric', angle: 'apply', prompt: 'x', answer: 1, vars: seven }).success).toBe(false);
  });

  it('must not point back at a lesson the learner cannot see', () => {
    expect(selfContainedProblems(mcq())).toEqual([]);
    for (const prompt of ['Which rule did we use in the lesson?', 'As we saw, which side?', 'What does the diagram show?', 'Using the formula we used, what is q?', 'Recall the example: which side?']) {
      expect(selfContainedProblems(mcq({ prompt })), prompt).toHaveLength(1);
    }
    // Options and the reason tier are read too.
    expect(selfContainedProblems(mcq({ options: ['the one shown earlier', 'b'], reason: { options: ['as you learned', 'b'], answer: 0 } }))).toHaveLength(2);
    // "Above" is the question's own context when it has one; without one, it can only be the lesson.
    expect(selfContainedProblems(mcq({ prompt: 'What does the code above return?' }))).toHaveLength(1);
    expect(selfContainedProblems(mcq({ prompt: 'What does the code above return?', context: '```\nf()\n```' }))).toEqual([]);
    expect(selfContainedProblems(mcq({ context: 'With the matrix above,' }))).toHaveLength(1);
    expect(selfContainedProblems(reviewQuestion.parse({ ...base, kind: 'order', angle: 'recall', prompt: 'Order the steps.', lines: ['as shown earlier', 'b'] }))).toHaveLength(1);
  });

  it('fill a template with new numbers each time, the same ones for the same showing', () => {
    const q = wheel();
    expect(isTemplate(q)).toBe(true);
    expect(isTemplate(mcq())).toBe(false);
    expect(templateProblems(q)).toEqual([]);
    const a = instantiate('w', q, '0');
    expect(a).toMatchObject({ id: 'w', kind: 'numeric', tolerance: 0.01 });
    expect(instantiate('w', q, '0')).toEqual(a);
    const shown = Array.from({ length: 12 }, (_, i) => instantiate('w', q, String(i)));
    expect(new Set(shown.map((s) => s.prompt)).size).toBeGreaterThan(1);
    for (const s of shown) {
      const [, w] = /at (\d+) rad/.exec(s.prompt)!;
      const r = Number(/radius ([\d.]+)/.exec(instantiateContext('w', q, shown.indexOf(s).toString())!)![1]);
      expect(s.kind === 'numeric' && s.answer).toBeCloseTo(r * Number(w));
    }
    expect(instantiateContext('w', mcq(), '0')).toBeUndefined();
    expect(instantiateContext('w', mcq({ context: 'plain' }), '0')).toBe('plain');
    expect(pickVars({ a: { min: 0.1, max: 0.3, step: 0.1 } }, 's')).toEqual(pickVars({ a: { min: 0.1, max: 0.3, step: 0.1 } }, 's'));
    expect([0.1, 0.2, 0.3]).toContain(pickVars({ a: { min: 0.1, max: 0.3, step: 0.1 } }, 'x').a);
  });

  it('turn into drill items of every kind', () => {
    expect(instantiate('m', mcq({ reason: { prompt: 'Why {{n}}?', options: ['norm {{n}}', 'no'], answer: 0 }, vars: { n: { min: 1, max: 1, step: 1 } }, prompt: 'Pick {{n}}' }), '0')).toMatchObject({
      prompt: 'Pick 1',
      reason: { prompt: 'Why 1?', options: ['norm 1', 'no'] },
    });
    expect(instantiate('n', reviewQuestion.parse({ ...base, kind: 'numeric', angle: 'recall', prompt: 'How many?', answer: 4 }), '0')).toMatchObject({ answer: 4, tolerance: 1e-6 });
    expect(instantiate('o', reviewQuestion.parse({ ...base, kind: 'order', angle: 'recall', prompt: 'Order {{a}}', lines: ['{{a}} first', '{{a + 1}} second'], vars: { a: { min: 1, max: 1, step: 1 } } }), '0')).toMatchObject({
      lines: ['1 first', '2 second'],
    });
  });

  it('say what is wrong with a template', () => {
    expect(templateProblems(mcq({ prompt: 'Pick {{n}}' }))).toEqual(['{{ … }} placeholders need "vars" to take their numbers from']);
    expect(templateProblems(reviewQuestion.parse({ ...base, kind: 'numeric', angle: 'apply', prompt: 'x', answer: 'r * 2' }))).toEqual(['answer: an expression answer needs "vars"; otherwise give the number']);
    expect(templateProblems(wheel({ context: undefined, prompt: 'No numbers.', answer: 3 }))).toEqual(['vars: no {{ … }} placeholder uses them']);
    expect(templateProblems(wheel({ answer: '{{ r * nope }}' }))[0]).toMatch(/r \* nope/);
    expect(templateProblems(wheel({ answer: '{{ r / 0 }}' }))[0]).toMatch(/does not give a finite number/);
    expect(templateProblems(wheel({ prompt: 'Is {{ r > 1 }} true?' }))[0]).toMatch(/does not give a finite number/);
    expect(templateProblems(mcq({ prompt: 'Pick {{n}}', options: ['{{n}}', '{{n * 1}}'], vars: { n: { min: 1, max: 3, step: 1 } } }))).toEqual(['options: two options come out the same for some numbers']);
    expect(
      templateProblems(reviewQuestion.parse({ ...base, kind: 'order', angle: 'recall', prompt: 'Order {{a}}', lines: ['{{a}}', '{{a * 1}}'], vars: { a: { min: 1, max: 2, step: 1 } } })),
    ).toEqual(['lines: two lines come out the same for some numbers']);
    expect(questionProblems(wheel({ prompt: 'As we saw, at {{w}} rad/s?' }))).toHaveLength(1);
  });

  it('format numbers the way a person writes them', () => {
    expect(formatNumber(3)).toBe('3');
    expect(formatNumber(0.1 + 0.2)).toBe('0.3');
    expect(formatNumber(2 / 3)).toBe('0.666667');
  });
});

describe('a review bank', () => {
  const entry = (q: ReviewQuestion, extra: Record<string, unknown> = {}) => ({ question: q, at: '2026-10-09T00:00:00.000Z', ...extra });

  it('is checked whole: shape, every live question, and no two alike', () => {
    expect(validateReviewBank({ questions: { a: entry(mcq()) } })).toEqual([]);
    expect(validateReviewBank({ questions: { 'Bad Id': entry(mcq()) } })[0]).toMatch(/Bad Id/);
    expect(validateReviewBank({ questions: { a: entry(mcq({ prompt: 'As we saw?' })) } })[0]).toMatch(/^questions\/a\/prompt:/);
    expect(validateReviewBank({ questions: { a: entry(mcq()), b: entry(mcq({ prompt: 'which is a UNIT quaternion' })) } })).toEqual(['questions/b: the same question as a']);
    // A retired question is never asked again, so it is not held to the rules.
    expect(validateReviewBank({ questions: { a: entry(mcq({ prompt: 'As we saw?' }), { retired: { at: 'x', reason: 'r' } }) }, retiredItems: ['l/w1'] })).toEqual([]);
  });

  it('knows a question by its words, not its case, spacing or punctuation', () => {
    expect(questionKey('Which  is a *unit* quaternion?')).toBe(questionKey('which is a unit quaternion'));
    expect(questionKey('A rotation of 30°')).not.toBe(questionKey('A rotation of 60°'));
  });
});
