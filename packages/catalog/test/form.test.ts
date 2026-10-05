import { describe, expect, it } from 'vitest';
import { formProblems, formatAnswers, learnerForm, type LearnerForm } from '../src/index.ts';

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
