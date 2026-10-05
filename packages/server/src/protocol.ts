/**
 * The UI ↔ app-service protocol. Browser-safe: zod and plain data only.
 * JSON-RPC-like over WebSocket: {id, method, params} → {id, result} | {id, error};
 * server pushes {event, data}.
 */
import { z } from 'zod';
import type { LearnerForm } from '@app/catalog';

export const slugId = z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/);

export const changeModeSchema = z.enum(['review', 'auto']);
export const sessionModeSchema = z.enum(['interaction', 'lesson', 'permanent']);

export interface ProfileDTO {
  readonly id: string;
  readonly displayName: string;
  readonly createdAt: string;
  readonly settings: { changeMode: 'review' | 'auto'; sessionMode: 'interaction' | 'lesson' | 'permanent'; encrypted: boolean };
}

export const projectInput = z.strictObject({
  title: z.string().trim().min(1).max(120),
  goal: z.string().trim().min(1).max(2000),
  why: z.string().trim().max(2000).default(''),
  workspace: z.string().max(1000).optional(),
  testCommand: z.string().max(500).optional(),
});
export type ProjectInput = z.input<typeof projectInput>;

export interface ProjectDTO {
  readonly id: string;
  readonly title: string;
  readonly goal: string;
  readonly why: string;
  readonly workspace?: string;
  readonly testCommand?: string;
  readonly createdAt: string;
}

export interface LessonSummaryDTO {
  readonly id: string;
  readonly title: string;
  readonly kind: string;
  readonly estimateMin: number;
}

export interface LearnerDTO {
  readonly kcs: readonly { kc: string; band: string; mastery: string; confidence: number }[];
  readonly insights: readonly { id: string; text: string; trust: number; scope: string }[];
  readonly recentSuccess: { readonly correct: number; readonly total: number };
}

export interface HistoryItemDTO {
  readonly id: string;
  readonly kind: 'change' | 'observation';
  readonly at: string;
  readonly author: { kind: string; agent?: string | undefined; model?: string | undefined; session?: string | undefined };
  readonly summary: string;
  readonly status: 'proposed' | 'applied' | 'rejected' | 'reverted' | 'active' | 'revoked';
  readonly target?: string;
}

export const historyFilter = z.strictObject({
  authorKind: z.enum(['agent', 'learner', 'system']).optional(),
  agent: z.string().max(80).optional(),
  model: z.string().max(80).optional(),
  session: z.string().max(80).optional(),
  since: z.string().max(40).optional(),
  until: z.string().max(40).optional(),
});

export const answerInput = z.strictObject({
  projectId: slugId,
  lessonId: slugId,
  itemId: z.string().max(120),
  kcs: z.array(z.string().max(120)).min(1).max(8),
  difficulty: z.int().min(1).max(5),
  evidenceType: z.enum(['production', 'prediction', 'recognition']),
  outcome: z.number().min(0).max(1),
  confidence: z.enum(['sure', 'think', 'guess']).optional(),
  transfer: z.boolean().default(false),
});

export const askInput = z.strictObject({
  projectId: slugId,
  lessonId: slugId.optional(),
  /** Where in the lesson the question is anchored, e.g. "section-id/3". */
  anchor: z.string().max(200).optional(),
  /** Text the learner selected. */
  selection: z.string().max(4000).optional(),
  question: z.string().trim().min(1).max(4000),
  /**
   * Which conversation this belongs to. "chat": quick questions, one agent session per lesson
   * (per the learner's setting). "session": the interview and planning page, one agent session
   * per project whatever lesson is open, so it remembers what was already discussed.
   */
  thread: z.enum(['chat', 'session']).default('chat'),
});

/** Every method: params schema + result type. */
export const methods = {
  'app.info': z.strictObject({}),
  'profiles.list': z.strictObject({}),
  'profiles.create': z.strictObject({ displayName: z.string().trim().min(1).max(60) }),
  'profiles.open': z.strictObject({ profileId: z.string().max(80) }),
  'profiles.updateSettings': z.strictObject({ changeMode: changeModeSchema.optional(), sessionMode: sessionModeSchema.optional() }),
  'projects.list': z.strictObject({}),
  'projects.create': projectInput,
  'lessons.list': z.strictObject({ projectId: slugId }),
  'lessons.get': z.strictObject({ projectId: slugId, lessonId: slugId }),
  'learner.summary': z.strictObject({}),
  'answers.record': answerInput,
  'history.list': z.strictObject({ filter: historyFilter.default({}) }),
  'history.undo': z.strictObject({ id: z.string().max(80), withDependants: z.boolean().default(false) }),
  'history.redo': z.strictObject({ id: z.string().max(80) }),
  'history.accept': z.strictObject({ id: z.string().max(80) }),
  'history.reject': z.strictObject({ id: z.string().max(80) }),
  'history.undoWhere': z.strictObject({ filter: historyFilter }),
  ask: askInput,
  'ask.cancel': z.strictObject({ askId: z.string().max(80) }),
} as const;

export type Method = keyof typeof methods;
export type Params<M extends Method> = z.input<(typeof methods)[M]>;

export interface Results {
  'app.info': { name: string; id: string; tagline: string; agent: string };
  'profiles.list': ProfileDTO[];
  'profiles.create': ProfileDTO;
  'profiles.open': ProfileDTO;
  'profiles.updateSettings': ProfileDTO;
  'projects.list': ProjectDTO[];
  'projects.create': ProjectDTO;
  'lessons.list': LessonSummaryDTO[];
  'lessons.get': unknown;
  'learner.summary': LearnerDTO;
  'answers.record': { id: string };
  'history.list': HistoryItemDTO[];
  'history.undo': { undone: string[] };
  'history.redo': { id: string };
  'history.accept': { id: string };
  'history.reject': { id: string };
  'history.undoWhere': { undone: string[] };
  ask: { askId: string };
  'ask.cancel': { ok: true };
}

/** Agent turn events forwarded to the UI (mirrors the agent host's HostEvent). */
export type AskEvent =
  | { kind: 'text'; text: string }
  | { kind: 'thought'; text: string }
  | { kind: 'tool'; id: string; title?: string; status?: string; toolKind?: string }
  | { kind: 'permission'; title: string; decision: { allow: boolean; reason: string } }
  | { kind: 'blocked-fs'; op: 'read' | 'write'; path: string }
  | { kind: 'stop'; reason: string }
  /** The tutor asked for structured answers: render this form; answers go back as the next question. */
  | { kind: 'form'; form: LearnerForm };

export interface ServerEvents {
  'ask.event': { askId: string; event: AskEvent };
  'ask.done': { askId: string; stopReason: string };
  'ask.error': { askId: string; message: string };
  /** Something changed: the UI refreshes what it shows. */
  changed: { what: 'profiles' | 'projects' | 'lessons' | 'history' | 'learner' };
}

export type ErrorCode = 'invalid_params' | 'not_found' | 'no_profile' | 'conflict' | 'dependants' | 'agent' | 'internal' | 'unknown_method';

export interface RpcError {
  readonly code: ErrorCode;
  readonly message: string;
  readonly data?: unknown;
}

export type ClientMessage = { id: number; method: string; params?: unknown };
export type ServerMessage =
  | { id: number; result: unknown }
  | { id: number; error: RpcError }
  | { event: keyof ServerEvents; data: unknown };
