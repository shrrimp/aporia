import { z } from 'zod';
import { isId } from '../ids.ts';
import type { JsonValue, PatchOp } from '../changes/json-patch.ts';

export const idOf = (prefix: string) =>
  z.string().refine((v) => isId(v, prefix), { message: `expected a ${prefix}_ id` });

/** UTC, millisecond precision (as produced by Date#toISOString), so string order = time order. */
export const isoDate = z.iso.datetime({ offset: false, precision: 3 });

/** A knowledge-component id such as `quaternion.exp-map-side`. */
export const kcId = z.string().regex(/^[a-z0-9][a-z0-9-]*(\.[a-z0-9][a-z0-9-]*)*$/).max(120);

export const author = z.strictObject({
  kind: z.enum(['agent', 'learner', 'system']),
  /** Agent product, e.g. "claude-code". */
  agent: z.string().max(80).optional(),
  /** Model id, e.g. "claude-opus-5-5". */
  model: z.string().max(80).optional(),
  session: z.string().max(80).optional(),
});
export type Author = z.infer<typeof author>;

export const evidenceType = z.enum([
  'probe', // interview diagnostic
  'checkpoint', // staged tests
  'production', // recall, math-input, fill-in, sketch
  'prediction',
  'recognition', // multiple choice
  'explain-back', // LLM-judged
  'self-rating',
]);
export type EvidenceType = z.infer<typeof evidenceType>;

const jsonValue: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([z.null(), z.boolean(), z.number(), z.string(), z.array(jsonValue), z.record(z.string(), jsonValue)]),
);

const pointer = z.string().max(1000);
export const patchOp: z.ZodType<PatchOp> = z.union([
  z.strictObject({ op: z.literal('add'), path: pointer, value: jsonValue }),
  z.strictObject({ op: z.literal('remove'), path: pointer }),
  z.strictObject({ op: z.literal('replace'), path: pointer, value: jsonValue }),
  z.strictObject({ op: z.literal('test'), path: pointer, value: jsonValue }),
]);

/** Relative, forward-slash document path inside a profile, e.g. `projects/p/lessons/09.json`. */
export const docPath = z
  .string()
  .max(300)
  .regex(/^(?!\/)(?!.*\/\/)(?!.*(^|\/)\.\.?(\/|$))[A-Za-z0-9._\/-]+\.json$/);

const base = { id: z.string(), at: isoDate, author };

export const evidenceEvent = z.strictObject({
  ...base,
  id: idOf('ev'),
  type: z.literal('evidence'),
  itemId: z.string().max(120),
  /** The project the item belongs to (absent on evidence recorded before projects were noted). */
  projectId: z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/).optional(),
  kcs: z
    .array(z.strictObject({ kc: kcId, weight: z.number().positive().max(1) }))
    .min(1)
    .max(8),
  /** Item difficulty on the logit scale (see learner/rating.ts). */
  difficulty: z.number().min(-6).max(6),
  evidenceType,
  /** 0 = failure, 1 = full success; partial credit allowed. */
  outcome: z.number().min(0).max(1),
  hintLevel: z.int().min(0).max(5).default(0),
  confidence: z.enum(['sure', 'think', 'guess']).optional(),
  /** Item asked the learner to apply the KC in a new situation. */
  transfer: z.boolean().default(false),
  /** For LLM-judged evidence: agreement between independent scorings, 0–1. */
  agreement: z.number().min(0).max(1).optional(),
  note: z.string().max(2000).optional(),
});

export const instructionEvent = z.strictObject({
  ...base,
  id: idOf('ev'),
  type: z.literal('instruction'),
  kcs: z.array(kcId).min(1).max(32),
  lessonId: z.string().max(120).optional(),
});

export const insightScope = z.union([
  z.literal('global'),
  z.string().regex(/^project:[A-Za-z0-9_-]+$/),
  z.string().regex(/^kc:[a-z0-9.-]+$/),
]);

export const insightObservation = z.strictObject({
  ...base,
  id: idOf('ev'),
  type: z.literal('insight'),
  /** New insights get a fresh `ins_` id; support/contradict refer to an existing one. */
  insightId: idOf('ins'),
  stance: z.enum(['propose', 'support', 'contradict']),
  text: z.string().min(1).max(500).optional(),
  scope: insightScope.optional(),
  evidence: z.array(z.string().max(80)).max(20).default([]),
  note: z.string().max(1000).optional(),
});

/** Undo / redo for observations: revoked events are ignored when deriving state. */
export const revokeEvent = z.strictObject({
  ...base,
  id: idOf('ev'),
  type: z.enum(['revoke', 'restore']),
  targets: z.array(idOf('ev')).min(1).max(1000),
  reason: z.string().max(1000).optional(),
});

/**
 * Where the learner is inside a lesson: an answer given, a prediction committed, a task marked
 * done, the section last read. The latest value per key wins. Not evidence (that is recorded
 * separately); just so nothing is lost when the app closes.
 */
export const progressEvent = z.strictObject({
  ...base,
  id: idOf('ev'),
  type: z.literal('progress'),
  projectId: z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/),
  lessonId: z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/),
  key: z.string().min(1).max(200),
  value: jsonValue.refine((v) => JSON.stringify(v).length <= 20_000, { message: 'progress value too large' }),
});

/**
 * One run of a task's checkpoint: the learner's test command, run by the app. A fact measured
 * by code, never reported by the agent.
 */
export const checkpointEvent = z.strictObject({
  ...base,
  id: idOf('ev'),
  type: z.literal('checkpoint'),
  projectId: z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/),
  lessonId: z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/),
  taskId: z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/),
  suite: z.string().max(300),
  /** Absent when the output had no summary the app could read. */
  counts: z
    .strictObject({
      passed: z.int().min(0),
      failed: z.int().min(0),
      total: z.int().min(0),
      format: z.string().max(40),
    })
    .optional(),
  expect: z.strictObject({ passed: z.int().min(0), of: z.int().min(1) }),
  /** Reached the expected pass count. */
  reached: z.boolean(),
  exitCode: z.int().nullable(),
  timedOut: z.boolean().default(false),
  durationMs: z.int().min(0),
  failures: z.array(z.string().max(300)).max(50).default([]),
});

const slug = z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/);

/**
 * A hint the tutor gave on a task, at a level of the hint ladder (pedagogy-model §6, H1). The
 * app checks the level before it is recorded (one step at a time, L4+ only after an attempt).
 * `files` are the task's files as they were (content hashes), to tell later whether the
 * learner changed their code since.
 */
export const hintEvent = z.strictObject({
  ...base,
  id: idOf('ev'),
  type: z.literal('hint'),
  projectId: slug,
  lessonId: slug,
  taskId: slug,
  level: z.int().min(0).max(5),
  summary: z.string().max(300).optional(),
  files: z.array(z.strictObject({ path: z.string().max(500), sha: z.string().max(64).nullable() })).max(20).default([]),
});

/** The learner wrote down what they tried on a task (an attempt, for the hint ladder's H2). */
export const attemptEvent = z.strictObject({
  ...base,
  id: idOf('ev'),
  type: z.literal('attempt'),
  projectId: slug,
  lessonId: slug,
  taskId: slug,
  text: z.string().min(1).max(4000),
});

const changeBase = { ...base, id: idOf('ev'), changeId: idOf('chg') };

export const changeProposed = z.strictObject({
  ...changeBase,
  type: z.literal('change.proposed'),
  target: docPath,
  patch: z.array(patchOp).min(1).max(500),
  reason: z.string().max(2000),
  evidence: z.array(z.string().max(80)).max(50).default([]),
});

/** Change applied to the document; `inverse` restores the previous state. */
export const changeApplied = z.strictObject({
  ...changeBase,
  type: z.enum(['change.applied', 'change.restored']),
  inverse: z.array(patchOp),
});

export const changeClosed = z.strictObject({
  ...changeBase,
  type: z.enum(['change.rejected', 'change.reverted']),
  reason: z.string().max(1000).optional(),
});

export const logEvent = z.discriminatedUnion('type', [
  evidenceEvent,
  instructionEvent,
  insightObservation,
  revokeEvent,
  progressEvent,
  checkpointEvent,
  hintEvent,
  attemptEvent,
  changeProposed,
  changeApplied,
  changeClosed,
]);

export type EvidenceEvent = z.output<typeof evidenceEvent>;
export type InstructionEvent = z.output<typeof instructionEvent>;
export type InsightObservation = z.output<typeof insightObservation>;
export type RevokeEvent = z.output<typeof revokeEvent>;
export type ProgressEvent = z.output<typeof progressEvent>;
export type CheckpointEvent = z.output<typeof checkpointEvent>;
export type HintEvent = z.output<typeof hintEvent>;
export type AttemptEvent = z.output<typeof attemptEvent>;
export type ChangeProposed = z.output<typeof changeProposed>;
export type ChangeApplied = z.output<typeof changeApplied>;
export type ChangeClosed = z.output<typeof changeClosed>;
export type LogEvent = z.output<typeof logEvent>;
export type LogEventInput = z.input<typeof logEvent>;
