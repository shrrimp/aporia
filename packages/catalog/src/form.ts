import { z } from 'zod';

/**
 * Learner forms: how the tutor asks for several answers, or an answer with a shape, without
 * making the learner type everything. The app renders them; the tutor never writes UI.
 */
const id = z.string().regex(/^[a-z0-9][a-z0-9-]{0,39}$/);
const text = (max: number) => z.string().min(1).max(max);
const base = {
  id,
  prompt: text(500).describe('Markdown + TeX allowed'),
  /** Offer "I don't know yet" (default true): not knowing is information too. */
  allowUnsure: z.boolean().default(true),
  optional: z.boolean().default(false),
};

export const formQuestion = z.discriminatedUnion('kind', [
  z.strictObject({ ...base, kind: z.literal('single'), options: z.array(text(200)).min(2).max(8), allowOther: z.boolean().default(false) }),
  z.strictObject({
    ...base,
    kind: z.literal('multi'),
    options: z.array(text(200)).min(2).max(10),
    allowOther: z.boolean().default(false),
  }),
  z.strictObject({ ...base, kind: z.literal('text'), placeholder: z.string().max(120).optional(), long: z.boolean().default(false) }),
  z.strictObject({ ...base, kind: z.literal('number'), unit: z.string().max(20).optional(), min: z.number().optional(), max: z.number().optional() }),
  z.strictObject({
    ...base,
    kind: z.literal('scale'),
    /** Labels for the two ends of a 1–5 scale. */
    low: text(60),
    high: text(60),
  }),
  z.strictObject({ ...base, kind: z.literal('rank'), options: z.array(text(120)).min(2).max(8) }),
]);

export const learnerForm = z.strictObject({
  title: text(120),
  intro: z.string().max(800).optional(),
  questions: z.array(formQuestion).min(1).max(12),
  submitLabel: z.string().max(40).optional(),
});

export type FormQuestion = z.output<typeof formQuestion>;
export type LearnerForm = z.output<typeof learnerForm>;
export type LearnerFormInput = z.input<typeof learnerForm>;

export type FormAnswer =
  | { readonly unsure: true }
  | { readonly skipped: true }
  | { readonly choice: string }
  | { readonly choices: readonly string[] }
  | { readonly text: string }
  | { readonly number: number }
  | { readonly scale: number }
  | { readonly order: readonly string[] };

/** Problems with a form beyond its schema (duplicate ids, impossible ranges). */
export function formProblems(form: LearnerForm): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const q of form.questions) {
    if (seen.has(q.id)) out.push(`duplicate question id "${q.id}"`);
    seen.add(q.id);
    if ('options' in q && new Set(q.options).size !== q.options.length) out.push(`question "${q.id}" has duplicate options`);
    if (q.kind === 'number' && q.min !== undefined && q.max !== undefined && q.min > q.max) out.push(`question "${q.id}": min is above max`);
  }
  return out;
}

/** The learner's answers as the message the tutor receives: readable, and parseable. */
export function formatAnswers(form: LearnerForm, answers: Readonly<Record<string, FormAnswer>>): string {
  const lines = [`Answers to the form "${form.title}":`];
  for (const q of form.questions) {
    const a = answers[q.id];
    let v: string;
    if (!a || 'skipped' in a) v = '(skipped)';
    else if ('unsure' in a) v = "I don't know yet";
    else if ('choice' in a) v = a.choice;
    else if ('choices' in a) v = a.choices.length ? a.choices.join('; ') : '(none)';
    else if ('text' in a) v = a.text;
    else if ('number' in a) v = `${a.number}${q.kind === 'number' && q.unit ? ` ${q.unit}` : ''}`;
    else if ('scale' in a) v = `${a.scale}/5 (1 = ${q.kind === 'scale' ? q.low : ''}, 5 = ${q.kind === 'scale' ? q.high : ''})`;
    else v = a.order.map((o, i) => `${i + 1}. ${o}`).join(', ');
    lines.push(`- [${q.id}] ${q.prompt.replace(/\s+/g, ' ').trim()}\n  → ${v}`);
  }
  return lines.join('\n');
}
