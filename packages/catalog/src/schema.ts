import { z } from 'zod';

/**
 * Component catalog v1 (docs/component-catalog.md). Semantic only: no colours, sizes or
 * markup. A lesson is stored exactly as this document. Every field carries a description
 * because the schema is also what the agent reads.
 */
export const CATALOG_VERSION = 1;

const md = (max = 6000) => z.string().max(max).describe('Text: CommonMark subset, $…$ / $$…$$ TeX maths, `inline code`. No HTML.');
const expr = z.string().min(1).max(2000).describe('Expression in the catalog expression language');
const slug = z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/);
const kc = z.string().regex(/^[a-z0-9][a-z0-9-]*(\.[a-z0-9][a-z0-9-]*)*$/).max(120);
const role = z.enum(['primary', 'secondary', 'ghost', 'highlight', 'correct', 'incorrect']).default('primary');
const description = z.string().min(1).max(500).describe('What the visual shows, for screen readers and for learners who cannot see it');

export const prose = z.strictObject({ type: z.literal('prose'), md: md() });
export const math = z.strictObject({ type: z.literal('math'), tex: z.string().min(1).max(2000), tag: z.string().max(20).optional() });
export const callout = z.strictObject({
  type: z.literal('callout'),
  kind: z.enum(['note', 'trap', 'key-idea', 'history', 'aside']),
  title: z.string().max(80).optional(),
  md: md(3000),
});

export const codeKind = z.enum(['stub', 'api', 'layout', 'analogue', 'trace', 'contrast']);
export const code = z.strictObject({
  type: z.literal('code'),
  kind: codeKind.describe('There is deliberately no "solution" kind'),
  lang: z.string().min(1).max(20),
  source: z.string().min(1).max(8000),
  caption: z.string().max(300).optional(),
  annotations: z.array(z.strictObject({ line: z.int().min(1), note: z.string().max(300) })).max(40).default([]),
  /** analogue: subgoal labels for the worked example (C3). */
  subgoals: z.array(z.strictObject({ line: z.int().min(1), label: z.string().max(120) })).max(20).optional(),
  /** trace: the learner's own file. */
  file: z.string().max(300).optional(),
  /** contrast: the alternative variant and what differs. */
  variant: z.string().max(8000).optional(),
  difference: z.string().max(300).optional(),
});

export const table = z.strictObject({
  type: z.literal('table'),
  caption: z.string().max(300).optional(),
  columns: z.array(z.string().max(80)).min(1).max(12),
  rows: z.array(z.array(z.string().max(300)).min(1).max(12)).min(1).max(60),
});

const point = z.strictObject({ kind: z.literal('point'), at: expr, label: z.string().max(40).optional(), role });
const vector = z.strictObject({ kind: z.literal('vector'), from: expr.optional(), to: expr, label: z.string().max(40).optional(), role });
const segment = z.strictObject({ kind: z.literal('segment'), from: expr, to: expr, label: z.string().max(40).optional(), role });
const polyline = z.strictObject({ kind: z.literal('polyline'), points: z.array(expr).min(2).max(200), closed: z.boolean().default(false), role });
const circle = z.strictObject({ kind: z.literal('circle'), center: expr, radius: expr, role });
const frame = z.strictObject({
  kind: z.literal('frame'),
  at: expr.optional(),
  rotation: expr.optional().describe('Quaternion expression'),
  size: z.number().positive().max(100).default(1),
  label: z.string().max(40).optional(),
  role,
});
const box = z.strictObject({
  kind: z.literal('box'),
  center: expr.optional(),
  size: expr.describe('3-vector of edge lengths'),
  rotation: expr.optional().describe('Quaternion expression'),
  role,
});
const label = z.strictObject({ kind: z.literal('label'), at: expr, text: z.string().min(1).max(80), role });

export const diagramElement = z.discriminatedUnion('kind', [point, vector, segment, polyline, circle, frame, box, label]);
export const diagram = z.strictObject({
  type: z.literal('diagram'),
  dims: z.union([z.literal(2), z.literal(3)]),
  description,
  /** Half-width of the visible region around the origin, in scene units. */
  extent: z.number().positive().max(1e6).default(2),
  elements: z.array(diagramElement).min(1).max(100),
});

const axis = z.strictObject({ label: z.string().max(40).default(''), min: z.number(), max: z.number() });
export const plot = z.strictObject({
  type: z.literal('plot'),
  description,
  x: axis,
  y: axis.optional(),
  series: z
    .array(
      z.strictObject({
        label: z.string().max(60),
        expr: expr.optional().describe('Function of x (and explorable state)'),
        data: z.array(z.tuple([z.number(), z.number()])).max(5000).optional(),
        role,
      }),
    )
    .min(1)
    .max(8),
});

const control = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('slider'),
    name: z.string().regex(/^[A-Za-z_]\w*$/),
    label: z.string().max(60),
    min: z.number(),
    max: z.number(),
    step: z.number().positive(),
    initial: z.number().optional(),
  }),
  z.strictObject({ kind: z.literal('toggle'), name: z.string().regex(/^[A-Za-z_]\w*$/), label: z.string().max(60), initial: z.boolean().default(false) }),
  z.strictObject({ kind: z.literal('button'), label: z.string().max(60), do: z.string().min(1).max(2000), role }),
  z.strictObject({ kind: z.literal('play'), label: z.string().max(60), do: z.string().min(1).max(2000), fps: z.int().min(1).max(60).default(30) }),
  z.strictObject({ kind: z.literal('reset'), label: z.string().max(60).default('Reset') }),
]);

export const explorable = z.strictObject({
  type: z.literal('explorable'),
  description,
  /** Initial state: variable → expression (evaluated in order, may use earlier variables and controls). */
  state: z.record(z.string().regex(/^[A-Za-z_]\w*$/), expr).default({}),
  controls: z.array(control).min(1).max(12),
  readouts: z.array(z.strictObject({ label: z.string().max(60), expr, digits: z.int().min(0).max(8).default(3) })).max(8).default([]),
  view: z.discriminatedUnion('type', [diagram, plot]),
  /** Prediction the learner must commit to before using it (G3). */
  predictFirst: z.string().max(500).optional(),
});

const difficulty = z.int().min(1).max(5).describe('1 = easy … 3 = standard … 5 = hard');
const itemBase = {
  id: slug,
  prompt: md(2000),
  kcs: z.array(kc).min(1).max(6),
  difficulty,
  why: md(2000),
  transfer: z.boolean().default(false),
  /** A warm-up item that reviews an earlier one ("lesson-id/item-id"): its answer reschedules that item. */
  reviewOf: z
    .string()
    .regex(/^[a-z0-9][a-z0-9-]{0,63}\/[a-z0-9][a-z0-9-]{0,63}$/)
    .optional()
    .describe('For warm-up items taken from the due-for-review list: the id shown there'),
};
export const drillItem = z.discriminatedUnion('kind', [
  z.strictObject({
    ...itemBase,
    kind: z.literal('mcq'),
    options: z.array(z.string().max(300)).min(2).max(6),
    answer: z.int().min(0),
    /**
     * Two-tier item (R8): after the answer, the learner picks why. Wrong reasons are the
     * misconceptions to look for. Credit needs both, so elimination alone is not taken for knowing.
     */
    reason: z
      .strictObject({
        prompt: z.string().max(300).default('Why?'),
        options: z.array(z.string().max(300)).min(2).max(5),
        answer: z.int().min(0),
      })
      .optional(),
  }),
  z.strictObject({ ...itemBase, kind: z.literal('numeric'), answer: z.number(), tolerance: z.number().nonnegative().default(1e-6) }),
  z.strictObject({ ...itemBase, kind: z.literal('short'), answer: z.string().max(500).describe('Reference answer; judged by rubric') }),
  z.strictObject({ ...itemBase, kind: z.literal('order'), lines: z.array(z.string().max(200)).min(2).max(15).describe('Correct order; shuffled for the learner') }),
]);
export const drill = z.strictObject({
  type: z.literal('drill'),
  purpose: z.enum(['warmup', 'pretest', 'practice', 'exit']).default('practice'),
  confidence: z.boolean().default(true),
  items: z.array(drillItem).min(1).max(12),
});

export const predict = z.strictObject({
  type: z.literal('predict'),
  prompt: md(1000),
  options: z.array(z.string().max(200)).max(6).optional(),
  reveal: md(4000),
  kcs: z.array(kc).min(1).max(6),
});
export const thinkFirst = z.strictObject({ type: z.literal('think-first'), prompt: md(1000), reveal: md(4000) });
export const explainBack = z.strictObject({
  type: z.literal('explain-back'),
  prompt: md(1000),
  kcs: z.array(kc).min(1).max(6),
  rubric: z.array(z.string().max(300)).min(1).max(8).describe('Points a good explanation covers'),
});

export const task = z.strictObject({
  type: z.literal('task'),
  id: slug,
  title: z.string().min(1).max(120),
  scaffold: z.int().min(0).max(4).describe('4 guided … 0 open (pedagogy-model §5)'),
  kcs: z.array(kc).min(1).max(8),
  files: z.array(z.string().max(300)).max(10).default([]),
  goal: md(3000),
  contract: md(4000).optional(),
  traps: z.array(md(600)).max(8).default([]),
  checkpoint: z
    .strictObject({
      suite: z.string().max(300).describe('Test filter or file understood by the project test command'),
      expect: z.strictObject({ passed: z.int().min(0), of: z.int().min(1) }),
    })
    .optional(),
});

export const openLoop = z.strictObject({ type: z.literal('open-loop'), md: md(1500) });
export const utilityLink = z.strictObject({ type: z.literal('utility-link'), md: md(1000), prompt: z.string().max(300).optional() });

export const component = z.discriminatedUnion('type', [
  prose,
  math,
  callout,
  code,
  table,
  diagram,
  plot,
  explorable,
  drill,
  predict,
  thinkFirst,
  explainBack,
  task,
  openLoop,
  utilityLink,
]);

export const sectionRole = z.enum(['warmup', 'hook', 'concept', 'practice', 'build', 'exit', 'open-loop']);
export const section = z.strictObject({
  id: slug,
  role: sectionRole,
  title: z.string().max(120).optional(),
  blocks: z.array(component).min(1).max(60),
});

export const lesson = z.strictObject({
  schemaVersion: z.literal(1),
  catalogVersion: z.literal(CATALOG_VERSION),
  id: slug,
  title: z.string().min(1).max(120),
  standfirst: md(1500),
  kind: z.enum(['build', 'theory', 'review', 'source-study']).default('build'),
  kcs: z.array(kc).min(1).max(30),
  estimateMin: z.int().min(5).max(600),
  capability: z.string().max(200).optional().describe('What the learner can do in their project after this lesson (MO3)'),
  sections: z.array(section).min(1).max(30),
});

export type Component = z.output<typeof component>;
export type ComponentType = Component['type'];
export type Section = z.output<typeof section>;
export type Lesson = z.output<typeof lesson>;
export type LessonInput = z.input<typeof lesson>;
export type DiagramElement = z.output<typeof diagramElement>;
export type Diagram = z.output<typeof diagram>;
export type Plot = z.output<typeof plot>;
export type Explorable = z.output<typeof explorable>;
export type DrillItem = z.output<typeof drillItem>;

/** ICAP mode of each component (G1): drives the composition rules. */
export const ICAP: Readonly<Record<ComponentType, 'P' | 'A' | 'C' | 'I'>> = {
  prose: 'P',
  math: 'P',
  callout: 'P',
  code: 'P',
  table: 'P',
  diagram: 'P',
  plot: 'P',
  explorable: 'A',
  drill: 'C',
  predict: 'C',
  'think-first': 'C',
  'explain-back': 'I',
  task: 'C',
  'open-loop': 'P',
  'utility-link': 'C',
};
