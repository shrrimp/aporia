import { z } from 'zod';
import { drillItem, type DrillItem } from './schema.ts';
import { evalExpr } from './expr/index.ts';

/**
 * Review questions (roadmap 1.10). Lessons teach; reviews check that a skill stuck. A review
 * question is written for review: it carries the context it needs, because the lesson is not on
 * screen, and it is one of several on its skill, so coming back tests the skill and not the
 * memory of one question. Placeholders (`{{ r * w }}`) and `vars` make a template the app fills
 * with new numbers each time it comes back.
 */

/** How a question comes at a skill. Changing the angle is what makes a review test understanding. */
export const ANGLES = ['apply', 'explain', 'predict', 'spot-the-error', 'compare', 'recall'] as const;
export type Angle = (typeof ANGLES)[number];

const text = (max: number) => z.string().max(max).describe('Text: CommonMark subset, $…$ / $$…$$ TeX maths, `inline code`. No HTML.');
const range = z
  .strictObject({ min: z.number(), max: z.number(), step: z.number().positive() })
  .refine((r) => r.max >= r.min, { message: 'max must not be below min' })
  .refine((r) => (r.max - r.min) / r.step <= 100_000, { message: 'too many steps between min and max' });

const extra = {
  context: text(3000)
    .optional()
    .describe('What the question needs to make sense without the lesson: the definitions, code or numbers it relies on. Never the answer.'),
  angle: z.enum(ANGLES),
  vars: z
    .record(z.string().regex(/^[a-z][a-z0-9_]{0,15}$/), range)
    .refine((v) => Object.keys(v).length <= 6, { message: 'at most 6 vars' })
    .optional()
    .describe('Numbers the app picks each time the question comes back, used as {{ expressions }} in the text and the answer'),
};

const [mcq, numeric, , order] = drillItem.options;
const strip = { id: true, reviewOf: true } as const;

/** A review question as the tutor writes it (the app gives it its id). */
export const reviewQuestion = z.discriminatedUnion('kind', [
  mcq.omit(strip).extend(extra),
  numeric.omit(strip).extend({ ...extra, answer: z.union([z.number(), z.string().max(300)]).describe('A number, or an {{ expression }} of the vars') }),
  order.omit(strip).extend(extra),
]);
export type ReviewQuestion = z.output<typeof reviewQuestion>;

const iso = z.string().max(40);
export const reviewBankEntry = z.strictObject({
  question: reviewQuestion,
  at: iso,
  /** The learner said it makes no sense without its lesson: it is never asked again. */
  retired: z.strictObject({ at: iso, reason: z.string().max(300) }).optional(),
});

/** A project's review questions (`projects/<id>/reviews.json`). */
export const reviewBank = z.strictObject({
  questions: z.record(z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/), reviewBankEntry).default({}),
  /** Lesson items the learner said make no sense out of their lesson: never used for review again. */
  retiredItems: z.array(z.string().max(130)).max(5000).default([]),
});
export type ReviewBank = z.output<typeof reviewBank>;
export const EMPTY_BANK: ReviewBank = { questions: {}, retiredItems: [] };

/** Every piece of text a learner reads in a question, with where it is. */
function texts(q: ReviewQuestion): [string, string][] {
  const out: [string, string][] = [['prompt', q.prompt], ['why', q.why]];
  if (q.context) out.push(['context', q.context]);
  if (q.kind === 'mcq') {
    q.options.forEach((o, i) => out.push([`options/${i}`, o]));
    q.reason?.options.forEach((o, i) => out.push([`reason/options/${i}`, o]));
    if (q.reason) out.push(['reason/prompt', q.reason.prompt]);
  }
  if (q.kind === 'order') q.lines.forEach((l, i) => out.push([`lines/${i}`, l]));
  if (q.kind === 'numeric' && typeof q.answer === 'string') out.push(['answer', q.answer]);
  return out;
}

/** Ways of pointing back at a lesson the learner cannot see while reviewing. */
const BACK_REFERENCES: readonly RegExp[] = [
  /\b(?:in|from|of|earlier in|during) (?:the|this|our|your|that|today's|the previous|the last) (?:lesson|section|chapter|reading|explorable|warm-up)\b/i,
  /\b(?:the|this|that) (?:diagram|figure|plot|explorable|table|snippet|example|code|equation|formula|picture|animation) (?:earlier|before|we (?:saw|used|built))\b/i,
  /\b(?:shown|seen|given|defined|introduced|discussed|derived|described|mentioned) (?:earlier|before|previously)\b/i,
  /\bas (?:we|you) (?:saw|have seen|learned|learnt|did|found|showed|discussed)\b/i,
  // A review question can show no figure: any mention of one is the lesson's.
  /\b(?:the|this|that) (?:diagram|figure|explorable|animation|picture)\b/i,
  /\b(?:remember|recall) (?:the|that|when|how) (?:lesson|section|example|diagram|figure|we)\b/i,
];
/** "Above" is the question's own context when it has one; otherwise it can only be the lesson. */
const ABOVE = /\b(?:(?:the|this|that) \w+ above|(?:shown|seen|given|defined|introduced|discussed|derived|described|mentioned|see) above)\b/i;

/** Where a question leans on its lesson instead of carrying its own context. */
export function selfContainedProblems(q: ReviewQuestion): string[] {
  const out: string[] = [];
  for (const [where, t] of texts(q)) {
    const patterns = where === 'context' || !q.context ? [...BACK_REFERENCES, ABOVE] : BACK_REFERENCES;
    const hit = patterns.map((re) => re.exec(t)).find((m) => m !== null);
    if (hit) out.push(`${where}: "${hit[0]}" points back at a lesson the learner cannot see while reviewing. Put what it needs in "context" instead.`);
  }
  return out;
}

const PLACEHOLDER = /\{\{([^{}]*)\}\}/g;

/** A number as a learner reads it: no float noise, no needless decimals. */
export function formatNumber(v: number): string {
  return Number.isInteger(v) ? String(v) : String(Number(v.toPrecision(6)));
}

/** A small seeded generator (mulberry32): the same question and showing always get the same numbers. */
function rng(seed: string): () => number {
  let h = 1779033703 ^ seed.length;
  for (let i = 0; i < seed.length; i++) h = Math.imul(h ^ seed.charCodeAt(i), 3432918353);
  let a = (h << 13) | (h >>> 19);
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const decimals = (step: number) => (String(step).split('.')[1] ?? '').length;

/** The values of a template's vars for one showing. */
export function pickVars(vars: NonNullable<ReviewQuestion['vars']>, seed: string): Record<string, number> {
  const next = rng(seed);
  const out: Record<string, number> = {};
  for (const [name, r] of Object.entries(vars)) {
    const steps = Math.floor((r.max - r.min) / r.step + 1e-9);
    const k = Math.floor(next() * (steps + 1));
    out[name] = Number((r.min + k * r.step).toFixed(Math.min(12, decimals(r.step))));
  }
  return out;
}

class TemplateError extends Error {}

function evalNumber(src: string, env: Record<string, number>): number {
  let v: unknown;
  try {
    v = evalExpr(src, env);
  } catch (err) {
    throw new TemplateError(`"{{${src}}}": ${(err as Error).message}`);
  }
  if (typeof v !== 'number' || !Number.isFinite(v)) throw new TemplateError(`"{{${src}}}" does not give a finite number`);
  return v;
}

const fill = (t: string, env: Record<string, number>) => t.replace(PLACEHOLDER, (_, src: string) => formatNumber(evalNumber(src, env)));

/**
 * The question as a drill item the app can show and score. A template gets the numbers of
 * showing `seed`; its numeric answer is computed from them. Throws on a template that does not
 * work out, which validation catches before a question is ever saved.
 */
export function instantiate(id: string, q: ReviewQuestion, seed: string): DrillItem {
  const env = q.vars ? pickVars(q.vars, `${id}#${seed}`) : {};
  const f = (t: string) => fill(t, env);
  const { context: _c, angle: _a, vars: _v, ...rest } = q;
  const base = { ...rest, id, prompt: f(q.prompt), why: f(q.why) };
  switch (q.kind) {
    case 'mcq':
      return { ...base, kind: 'mcq', answer: q.answer, options: q.options.map(f), ...(q.reason ? { reason: { ...q.reason, prompt: f(q.reason.prompt), options: q.reason.options.map(f) } } : {}) };
    case 'numeric': {
      const answer = typeof q.answer === 'number' ? q.answer : evalNumber(q.answer.replace(/^\s*\{\{([^{}]*)\}\}\s*$/, '$1'), env);
      return { ...base, kind: 'numeric', answer: Number(answer.toPrecision(12)), tolerance: q.tolerance };
    }
    case 'order':
      return { ...base, kind: 'order', lines: q.lines.map(f) };
  }
}

/** The context, with a template's numbers filled in. */
export function instantiateContext(id: string, q: ReviewQuestion, seed: string): string | undefined {
  if (!q.context) return undefined;
  return fill(q.context, q.vars ? pickVars(q.vars, `${id}#${seed}`) : {});
}

/** Whether a question has numbers the app picks. */
export const isTemplate = (q: ReviewQuestion) => q.vars !== undefined && Object.keys(q.vars).length > 0;

/** What is wrong with a question's placeholders and numbers, tried on a few showings. */
export function templateProblems(q: ReviewQuestion): string[] {
  const used = texts(q).some(([, t]) => new RegExp(PLACEHOLDER.source).test(t));
  if (!isTemplate(q)) {
    const out: string[] = [];
    if (used) out.push('{{ … }} placeholders need "vars" to take their numbers from');
    if (q.kind === 'numeric' && typeof q.answer === 'string') out.push('answer: an expression answer needs "vars"; otherwise give the number');
    return out;
  }
  if (!used) return ['vars: no {{ … }} placeholder uses them'];
  for (let s = 0; s < 6; s++) {
    let item: DrillItem;
    try {
      item = instantiate('check', q, `check-${s}`);
    } catch (err) {
      return [(err as Error).message];
    }
    if (item.kind === 'mcq' && new Set(item.options).size !== item.options.length) return ['options: two options come out the same for some numbers'];
    if (item.kind === 'order' && new Set(item.lines).size !== item.lines.length) return ['lines: two lines come out the same for some numbers'];
  }
  return [];
}

/** A question's text reduced to what makes it the same question: case, spacing and punctuation do not count. */
export function questionKey(prompt: string): string {
  return prompt
    .toLowerCase()
    .replace(/[`*_~>#[\](){}.,;:!?"'’“”-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Problems with one question, before it joins a bank. */
export function questionProblems(q: ReviewQuestion): string[] {
  return [...selfContainedProblems(q), ...templateProblems(q)];
}

/** Every change to a bank is checked: its shape, each question that is not retired, and no two alike. */
export function validateReviewBank(doc: unknown): string[] {
  const parsed = reviewBank.safeParse(doc);
  if (!parsed.success) return parsed.error.issues.map((i) => `${i.path.join('/')}: ${i.message}`);
  const out: string[] = [];
  const seen = new Map<string, string>();
  for (const [id, e] of Object.entries(parsed.data.questions)) {
    if (e.retired) continue;
    for (const p of questionProblems(e.question)) out.push(`questions/${id}/${p}`);
    const key = questionKey(e.question.prompt);
    const twin = seen.get(key);
    if (twin) out.push(`questions/${id}: the same question as ${twin}`);
    else seen.set(key, id);
  }
  return out;
}
