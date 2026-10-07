import { describe, expect, it } from 'vitest';
import { formAnswer, formProblems, formatAnswers, learnerForm, scoreProbe, type LearnerForm } from '../src/index.ts';

const form: LearnerForm = learnerForm.parse({
  title: 'Start',
  questions: [
    { id: 'bg', kind: 'single', prompt: 'Background?', options: ['a', 'b'] },
    { id: 'tools', kind: 'multi', prompt: 'Tools?', options: ['x', 'y'] },
    { id: 'probe', kind: 'text', prompt: 'Why?\n  explain' },
    { id: 'n', kind: 'number', prompt: 'How many?', unit: 'h' },
    { id: 'n2', kind: 'number', prompt: 'Plain number?' },
    { id: 'conf', kind: 'scale', prompt: 'Comfort?', low: 'shaky', high: 'fluent' },
    { id: 'rank', kind: 'rank', prompt: 'Order', options: ['p', 'q'] },
    { id: 'u', kind: 'single', prompt: 'Unsure?', options: ['a', 'b'] },
    { id: 's', kind: 'text', prompt: 'Skipped?', optional: true },
    { id: 'none', kind: 'multi', prompt: 'None picked?', options: ['x', 'y'] },
  ],
});

describe('learner forms', () => {
  it('applies defaults', () => {
    expect(form.questions[0]).toMatchObject({ allowUnsure: true, optional: false, allowOther: false });
  });

  it('rejects malformed forms', () => {
    expect(learnerForm.safeParse({ title: 't', questions: [] }).success).toBe(false);
    expect(learnerForm.safeParse({ title: 't', questions: [{ id: 'Bad Id', kind: 'text', prompt: 'p' }] }).success).toBe(false);
    expect(learnerForm.safeParse({ title: 't', questions: [{ id: 'a', kind: 'single', prompt: 'p', options: ['only'] }] }).success).toBe(false);
  });

  it('finds problems beyond the schema', () => {
    const bad = learnerForm.parse({
      title: 't',
      questions: [
        { id: 'a', kind: 'single', prompt: 'p', options: ['x', 'x'] },
        { id: 'a', kind: 'number', prompt: 'p', min: 5, max: 1 },
        { id: 'b', kind: 'number', prompt: 'p', min: 1 },
      ],
    });
    expect(formProblems(bad)).toEqual(['question "a" has duplicate options', 'duplicate question id "a"', 'question "a": min is above max']);
    expect(formProblems(form)).toEqual([]);
  });

  it('formats answers for the tutor, question by question', () => {
    const text = formatAnswers(form, {
      bg: { choice: 'b' },
      tools: { choices: ['x', 'y'] },
      probe: { text: 'because' },
      n: { number: 3 },
      n2: { number: 7 },
      conf: { scale: 4 },
      rank: { order: ['q', 'p'] },
      u: { unsure: true },
      s: { skipped: true },
      none: { choices: [] },
    });
    expect(text.split('\n')).toEqual([
      'Answers to the form "Start":',
      '- [bg] Background?',
      '  → b',
      '- [tools] Tools?',
      '  → x; y',
      '- [probe] Why? explain',
      '  → because',
      '- [n] How many?',
      '  → 3 h',
      '- [n2] Plain number?',
      '  → 7',
      '- [conf] Comfort?',
      '  → 4/5 (1 = shaky, 5 = fluent)',
      '- [rank] Order',
      '  → 1. q, 2. p',
      '- [u] Unsure?',
      "  → I don't know yet",
      '- [s] Skipped?',
      '  → (skipped)',
      '- [none] None picked?',
      '  → (none)',
    ]);
    expect(formatAnswers(form, {})).toContain('[bg] Background?\n  → (skipped)');
  });

  it('only uses scale labels on scale questions', () => {
    // A scale answer given to a non-scale question still formats without crashing.
    expect(formatAnswers(form, { bg: { scale: 2 } })).toContain('2/5 (1 = , 5 = )');
  });
});

describe('probes', () => {
  const probeForm = learnerForm.parse({
    title: 'Probes',
    questions: [
      { id: 'one', kind: 'single', prompt: '|q|?', options: ['0', '1'], probe: { kcs: ['quat.unit'], difficulty: 2, answer: '1' } },
      { id: 'many', kind: 'multi', prompt: 'Which?', options: ['a', 'b', 'c'], probe: { kcs: ['quat.unit'], difficulty: 3, answer: ['a', 'b'] } },
      { id: 'none', kind: 'multi', prompt: 'None right?', options: ['a', 'b'], probe: { kcs: ['quat.unit'], difficulty: 3, answer: [] } },
      { id: 'n', kind: 'number', prompt: 'How many?', probe: { kcs: ['quat.unit'], difficulty: 1, answer: 4, tolerance: 0.5 } },
      { id: 'exact', kind: 'number', prompt: 'Exactly?', probe: { kcs: ['quat.unit'], difficulty: 1, answer: 2 } },
      { id: 'bug', kind: 'line', prompt: 'Which line?', code: 'a = 1;\n  b = a * 2;\nc = b;', probe: { kcs: ['quat.unit'], difficulty: 3, answer: 2 } },
      { id: 'self', kind: 'scale', prompt: 'Comfort?', low: 'low', high: 'high', probe: { kcs: ['quat.unit'], difficulty: 3 } },
      { id: 'judge', kind: 'text', prompt: 'Why?', probe: { kcs: ['quat.unit'], difficulty: 3 } },
      { id: 'plain', kind: 'single', prompt: 'Not a probe', options: ['x', 'y'] },
    ],
  });
  const q = (id: string) => probeForm.questions.find((x) => x.id === id)!;

  it('scores what has a key, and leaves the rest to the tutor', () => {
    expect(formProblems(probeForm)).toEqual([]);
    expect(scoreProbe(q('one'), { choice: '1' })).toBe(1);
    expect(scoreProbe(q('one'), { choice: '0' })).toBe(0);
    expect(scoreProbe(q('one'), { unsure: true })).toBe(0);
    expect(scoreProbe(q('one'), { skipped: true })).toBeUndefined();
    expect(scoreProbe(q('one'), undefined)).toBeUndefined();
    expect(scoreProbe(q('many'), { choices: ['a', 'c'] })).toBeCloseTo(1 / 3);
    expect(scoreProbe(q('many'), { choices: ['b', 'a'] })).toBe(1);
    expect(scoreProbe(q('none'), { choices: [] })).toBe(1);
    expect(scoreProbe(q('n'), { number: 4.4 })).toBe(1);
    expect(scoreProbe(q('n'), { number: 5 })).toBe(0);
    expect(scoreProbe(q('exact'), { number: 2 })).toBe(1);
    expect(scoreProbe(q('bug'), { line: 2 })).toBe(1);
    expect(scoreProbe(q('bug'), { line: 1 })).toBe(0);
    expect(scoreProbe(q('self'), { scale: 5 })).toBe(1);
    expect(scoreProbe(q('self'), { scale: 1 })).toBe(0);
    expect(scoreProbe(q('self'), { unsure: true })).toBeUndefined();
    expect(scoreProbe(q('judge'), { text: 'because' })).toBeUndefined();
    expect(scoreProbe(q('plain'), { choice: 'x' })).toBeUndefined();
    // A key of the wrong shape for the answer scores nothing.
    expect(scoreProbe(q('many'), { text: 'a' })).toBeUndefined();
  });

  it('checks the answer key against the question', () => {
    const bad = learnerForm.parse({
      title: 'Bad',
      questions: [
        { id: 'a', kind: 'single', prompt: 'p', options: ['x', 'y'], probe: { kcs: ['k'], difficulty: 1, answer: 'z' } },
        { id: 'b', kind: 'multi', prompt: 'p', options: ['x', 'y'], probe: { kcs: ['k'], difficulty: 1, answer: ['x', 'z'] } },
        { id: 'c', kind: 'number', prompt: 'p', probe: { kcs: ['k'], difficulty: 1, answer: 'four' } },
        { id: 'd', kind: 'line', prompt: 'p', code: 'one\ntwo', probe: { kcs: ['k'], difficulty: 1, answer: 3 } },
        { id: 'e', kind: 'text', prompt: 'p', probe: { kcs: ['k'], difficulty: 1, answer: 'x' } },
        { id: 'f', kind: 'rank', prompt: 'p', options: ['x', 'y'], probe: { kcs: ['k'], difficulty: 1 } },
      ],
    });
    expect(formProblems(bad)).toEqual([
      'question "a": the probe answer must be one of the options',
      'question "b": the probe answer must list some of the options',
      'question "c": the probe answer must be a number',
      'question "d": the probe answer must be a line number of the code',
      'question "e": a text probe has no answer key (the tutor judges text; a scale is a self-rating)',
      'question "f": a ranking cannot be a probe',
    ]);
  });

  it('checks answers from the app before they are read, and formats a line answer', () => {
    expect(formAnswer.safeParse({ line: 2 }).success).toBe(true);
    expect(formAnswer.safeParse({ choice: 5 }).success).toBe(false);
    expect(formAnswer.safeParse({ choice: 'x', extra: 1 }).success).toBe(false);
    expect(formatAnswers(probeForm, { bug: { line: 2 } })).toContain('[bug] Which line?\n  → line 2: b = a * 2;');
    expect(formatAnswers(form, { bg: { line: 9 } })).toContain('→ line 9');
  });
});
