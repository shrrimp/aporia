import { z } from 'zod';

/**
 * Learner forms: how the tutor asks for several answers, or an answer with a shape, without
 * making the learner type everything. The app renders them; the tutor never writes UI.
 */
const id = z.string().regex(/^[a-z0-9][a-z0-9-]{0,39}$/);
const text = (max: number) => z.string().min(1).max(max);
const kc = z.string().regex(/^[a-z0-9][a-z0-9-]*(\.[a-z0-9][a-z0-9-]*)*$/).max(120);

/**
 * Marks a question as a diagnostic probe on some skills. With an `answer`, the app scores it
 * itself when the learner sends the form and records the evidence (choices, numbers, a line);
 * a text probe is judged by the tutor. On a `scale`, it records the learner's self-rating, which
 * only sets a prior (P4).
 */
export const probe = z.strictObject({
  kcs: z.array(kc).min(1).max(6),
  difficulty: z.int().min(1).max(5).describe('1 easy … 3 standard … 5 hard'),
  answer: z
    .union([z.string().max(200), z.number(), z.array(z.string().max(200)).max(10)])
    .optional()
    .describe('single: the right option; multi: the right options; number: the value; line: the line number'),
  tolerance: z.number().nonnegative().optional().describe('number: accepted distance from the answer'),
});

const base = {
  id,
  prompt: text(500).describe('Markdown + TeX allowed'),
  /** Offer "I don't know yet" (default true): not knowing is information too. */
  allowUnsure: z.boolean().default(true),
  optional: z.boolean().default(false),
  probe: probe.optional(),
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
  /** "Spot the bug": the learner points at one line of a snippet. */
  z.strictObject({ ...base, kind: z.literal('line'), code: text(4000), lang: z.string().max(20).default('') }),
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

/** An answer as it arrives from the learner's app: checked before anything reads it. */
export const formAnswer = z.union([
  z.strictObject({ unsure: z.literal(true) }),
  z.strictObject({ skipped: z.literal(true) }),
  z.strictObject({ choice: z.string().max(400) }),
  z.strictObject({ choices: z.array(z.string().max(400)).max(20) }),
  z.strictObject({ text: z.string().max(10_000) }),
  z.strictObject({ number: z.number() }),
  z.strictObject({ scale: z.int().min(1).max(5) }),
  z.strictObject({ order: z.array(z.string().max(200)).max(20) }),
  z.strictObject({ line: z.int().min(1).max(10_000) }),
]);

export type FormAnswer =
  | { readonly unsure: true }
  | { readonly skipped: true }
  | { readonly choice: string }
  | { readonly choices: readonly string[] }
  | { readonly text: string }
  | { readonly number: number }
  | { readonly scale: number }
  | { readonly order: readonly string[] }
  | { readonly line: number };

/** Problems with a form beyond its schema (duplicate ids, impossible ranges). */
export function formProblems(form: LearnerForm): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const q of form.questions) {
    if (seen.has(q.id)) out.push(`duplicate question id "${q.id}"`);
    seen.add(q.id);
    if ('options' in q && new Set(q.options).size !== q.options.length) out.push(`question "${q.id}" has duplicate options`);
    if (q.kind === 'number' && q.min !== undefined && q.max !== undefined && q.min > q.max) out.push(`question "${q.id}": min is above max`);
    if (q.probe) out.push(...probeProblems(q));
  }
  return out;
}

function probeProblems(q: FormQuestion): string[] {
  const a = q.probe!.answer;
  const where = `question "${q.id}"`;
  if (a === undefined) return q.kind === 'rank' ? [`${where}: a ranking cannot be a probe`] : [];
  switch (q.kind) {
    case 'single':
      return typeof a === 'string' && q.options.includes(a) ? [] : [`${where}: the probe answer must be one of the options`];
    case 'multi':
      return Array.isArray(a) && a.every((x) => q.options.includes(x)) ? [] : [`${where}: the probe answer must list some of the options`];
    case 'number':
      return typeof a === 'number' ? [] : [`${where}: the probe answer must be a number`];
    case 'line':
      return typeof a === 'number' && Number.isInteger(a) && a >= 1 && a <= q.code.split('\n').length ? [] : [`${where}: the probe answer must be a line number of the code`];
    default:
      return [`${where}: a ${q.kind} probe has no answer key (the tutor judges text; a scale is a self-rating)`];
  }
}

/**
 * Score one probe answer, 0–1. Undefined when there is nothing for the app to score: no key, a
 * skipped question, or a kind the tutor judges. "I don't know yet" scores 0: honest, and useful.
 */
export function scoreProbe(q: FormQuestion, a: FormAnswer | undefined): number | undefined {
  const key = q.probe?.answer;
  if (!a || 'skipped' in a) return undefined;
  if (q.probe && q.kind === 'scale') return 'scale' in a ? (a.scale - 1) / 4 : undefined;
  if (key === undefined) return undefined;
  if ('unsure' in a) return 0;
  if ('choice' in a) return a.choice === key ? 1 : 0;
  if ('choices' in a && Array.isArray(key)) {
    const want = new Set(key);
    const got = new Set(a.choices);
    const union = new Set([...want, ...got]);
    return union.size === 0 ? 1 : [...union].filter((x) => want.has(x) && got.has(x)).length / union.size;
  }
  if ('number' in a && typeof key === 'number') return Math.abs(a.number - key) <= (q.probe!.tolerance ?? 1e-9) ? 1 : 0;
  if ('line' in a) return a.line === key ? 1 : 0;
  return undefined;
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
    else if ('line' in a) v = `line ${a.line}${q.kind === 'line' ? `: ${(q.code.split('\n')[a.line - 1] ?? '').trim()}` : ''}`;
    else v = a.order.map((o, i) => `${i + 1}. ${o}`).join(', ');
    lines.push(`- [${q.id}] ${q.prompt.replace(/\s+/g, ' ').trim()}\n  → ${v}`);
  }
  return lines.join('\n');
}
