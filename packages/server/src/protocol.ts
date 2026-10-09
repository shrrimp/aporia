/**
 * The UI ↔ app-service protocol. Browser-safe: zod and plain data only.
 * JSON-RPC-like over WebSocket: {id, method, params} → {id, result} | {id, error};
 * server pushes {event, data}.
 */
import { z } from 'zod';
import { agentPermissions } from '@app/catalog';
import type { AgentPermissions, DrillItem, LearnerForm } from '@app/catalog';

export const slugId = z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/);

export const changeModeSchema = z.enum(['review', 'auto']);
export const sessionModeSchema = z.enum(['interaction', 'lesson', 'permanent']);
export const reviewQuestionsSchema = z.enum(['pool', 'when-due', 'numbers']);

export interface ProfileDTO {
  readonly id: string;
  readonly displayName: string;
  readonly createdAt: string;
  readonly settings: {
    changeMode: 'review' | 'auto';
    sessionMode: 'interaction' | 'lesson' | 'permanent';
    encrypted: boolean;
    /** Where new review questions come from (roadmap 1.10). */
    reviewQuestions: z.output<typeof reviewQuestionsSchema>;
  };
}

/** An absolute folder path on any desktop OS (POSIX, drive letter, or UNC). */
const absolutePath = z
  .string()
  .trim()
  .max(1000)
  .regex(/^(\/|[A-Za-z]:[\\/]|\\\\)/, { message: 'use the full path of the folder, e.g. /home/you/dev/my-engine' });

export const projectInput = z.strictObject({
  title: z.string().trim().min(1).max(120),
  goal: z.string().trim().min(1).max(2000),
  why: z.string().trim().max(2000).default(''),
  workspace: absolutePath.optional(),
  testCommand: z.string().trim().max(500).optional(),
  agent: agentPermissions.optional(),
});
export type ProjectInput = z.input<typeof projectInput>;

/** Learner edits to a project. An empty workspace or test command removes it. */
export const projectUpdate = z.strictObject({
  projectId: slugId,
  title: z.string().trim().min(1).max(120).optional(),
  goal: z.string().trim().min(1).max(2000).optional(),
  why: z.string().trim().max(2000).optional(),
  workspace: z.union([z.literal(''), absolutePath]).optional(),
  testCommand: z.string().trim().max(500).optional(),
  agent: agentPermissions.optional(),
});
export interface ProjectDTO {
  readonly id: string;
  readonly title: string;
  readonly goal: string;
  readonly why: string;
  readonly workspace?: string;
  readonly testCommand?: string;
  /** What the tutor may do in the workspace; absent means the defaults. */
  readonly agent?: AgentPermissions;
  readonly createdAt: string;
}

export interface LessonSummaryDTO {
  readonly id: string;
  readonly title: string;
  readonly kind: string;
  readonly estimateMin: number;
  /** Units the learner finished (answered, revealed, sent, marked done) out of all of them. */
  readonly progress: { readonly done: number; readonly total: number };
}

export interface LearnerDTO {
  readonly kcs: readonly { kc: string; band: string; mastery: string; confidence: number }[];
  readonly insights: readonly { id: string; text: string; trust: number; scope: string }[];
  readonly recentSuccess: { readonly correct: number; readonly total: number };
}

/** One run of a task's checkpoint, as measured by the app. */
export interface CheckpointRunDTO {
  readonly id: string;
  readonly at: string;
  /** Absent when the output had no test summary the app could read. */
  readonly counts?: { readonly passed: number; readonly failed: number; readonly total: number };
  readonly expect: { readonly passed: number; readonly of: number };
  readonly reached: boolean;
  readonly exitCode: number | null;
  readonly timedOut: boolean;
  readonly durationMs: number;
  readonly failures: readonly string[];
  /** Stopped by the learner: not recorded. */
  readonly cancelled?: boolean;
}

export interface CheckpointsDTO {
  /** Checkpoints can run in this project (workspace and test command set by the learner). */
  readonly runnable: boolean;
  readonly reason?: string;
  /** Task currently running in this lesson. */
  readonly running?: string;
  readonly tasks: Readonly<Record<string, { readonly reached: boolean; readonly runs: number; readonly recent: readonly CheckpointRunDTO[] }>>;
}

/** One due skill on the Review page, and the question chosen for it (roadmap 1.10). */
export interface ReviewSlotDTO {
  readonly kc: string;
  /** The skill's name. */
  readonly skill: string;
  /** Estimated probability of recalling it now. */
  readonly retrievability: number;
  readonly reviews: number;
  /** Absent while there is nothing to ask on the skill yet. */
  readonly question?: {
    /** As its answer is recorded: `~reviews/<id>` for a review question, `lesson/item` for a lesson's own item. */
    readonly id: string;
    readonly item: DrillItem;
    /** What the question needs to make sense with the lesson closed. */
    readonly context?: string;
    /** Met for the first time, the same template with new numbers, or answered before. */
    readonly seen: 'new' | 'new-numbers' | 'again';
    /** For a lesson's own item: the lesson's title. */
    readonly from?: string;
  };
}

export interface ReviewQueueDTO {
  /** Due skills, most at risk first, up to the daily cap. */
  readonly slots: readonly ReviewSlotDTO[];
  readonly dueCount: number;
  readonly nextDue?: string;
  /** The tutor is writing new questions for this project right now. */
  readonly writing: boolean;
}

/** Where the learner stands on a skill: computed by the app from evidence. */
export interface SkillLevelDTO {
  readonly mastery: 'unseen' | 'introduced' | 'practising' | 'provisional' | 'durable';
  /** Plain-language band; absent with no evidence. */
  readonly band?: string;
  /** How sure the app is, 0–1. */
  readonly confidence: number;
  readonly evidence: number;
}

export interface PathNodeDTO extends SkillLevelDTO {
  readonly id: string;
  readonly title: string;
  readonly group?: string;
  readonly summary?: string;
  /** 0 = foundations; each skill sits after its prerequisites. */
  readonly layer: number;
  readonly state: 'mastered' | 'in-progress' | 'available' | 'locked';
  /** For a locked skill: the prerequisites still to master (titles). */
  readonly needs: readonly string[];
  readonly goal: boolean;
  /** The learner's work suggests they know it; to verify (it is not evidence). */
  readonly claim?: ClaimDTO;
}

export interface ClaimDTO {
  readonly from: 'workspace' | 'sources' | 'learner';
  readonly basis: string;
}

export interface MilestoneDTO {
  readonly id: string;
  readonly title: string;
  readonly goal: string;
  readonly kcs: readonly string[];
  readonly order: number;
  readonly status: 'planned' | 'active' | 'done';
  readonly capability?: string;
}

export interface PlanItemDTO {
  readonly id: string;
  readonly title: string;
  readonly kcs: readonly string[];
  readonly capability?: string;
  readonly lessonId?: string;
  readonly note?: string;
  readonly status: 'planned' | 'written' | 'in-progress' | 'done';
  readonly progress?: { readonly done: number; readonly total: number };
}

export type NextStepDTO =
  /** existing: the learner already has work (a workspace or imported files) to start from. */
  | { readonly kind: 'interview'; readonly existing: boolean; readonly text: string }
  | { readonly kind: 'review'; readonly due: number; readonly text: string }
  | { readonly kind: 'lesson'; readonly lessonId: string; readonly title: string; readonly text: string }
  | { readonly kind: 'draft'; readonly planId: string; readonly title: string; readonly text: string }
  | { readonly kind: 'plan'; readonly text: string };

export interface FindingDTO {
  readonly text: string;
  readonly kcs: readonly string[];
}

export interface AssessmentDTO {
  readonly summary: string;
  readonly strengths: readonly FindingDTO[];
  readonly gaps: readonly FindingDTO[];
  readonly misconceptions: readonly FindingDTO[];
  readonly bridges: readonly FindingDTO[];
  readonly preferences: readonly string[];
}

export interface CurriculumDTO {
  readonly goals: readonly string[];
  readonly nodes: readonly PathNodeDTO[];
  /** Prerequisite links between path skills. */
  readonly edges: readonly { readonly from: string; readonly to: string }[];
  readonly plan: readonly PlanItemDTO[];
  readonly next: NextStepDTO;
  readonly assessment?: AssessmentDTO;
  /** The project's milestones, in order. */
  readonly roadmap: readonly MilestoneDTO[];
}

export interface BrainNodeDTO extends SkillLevelDTO {
  readonly id: string;
  readonly title: string;
  readonly group?: string;
  readonly summary?: string;
  /** Suggested by the tutor as a next thing to learn. */
  readonly suggested: boolean;
  readonly why?: string;
  /** The learner has met it (taught, or any evidence). */
  readonly discovered: boolean;
  /** Plain-language reasons it needs attention; empty when it does not. */
  readonly struggling: readonly string[];
  /** Projects that use it. */
  readonly projects: readonly string[];
  readonly claim?: ClaimDTO;
}

export interface BrainDTO {
  /** Nested: a group's parent is the broader group it belongs to (absent for a top-level domain). */
  readonly groups: readonly { readonly id: string; readonly title: string; readonly summary?: string; readonly parent?: string }[];
  readonly nodes: readonly BrainNodeDTO[];
  readonly edges: readonly { readonly from: string; readonly to: string; readonly kind: 'prereq' | 'confusable' | 'related' }[];
}

/** Whether the tutor can work: the learner's own agent, installed, running and logged in. */
export interface AgentStatusDTO {
  readonly agent: string;
  /** unknown: not started yet. login: running but not logged in. missing: could not be started. */
  readonly state: 'unknown' | 'starting' | 'ready' | 'login' | 'missing' | 'stopped' | 'error';
  /** The kind of login, e.g. "Claude Pro" (never personal details). */
  readonly account?: string;
  /** What went wrong, or what to do. */
  readonly message?: string;
}

/** What a proposed change would do: a file of the workspace, or a document of the app. */
export type ChangeDiffDTO =
  | { readonly kind: 'file'; readonly path: string; readonly before: string | null; readonly after: string | null }
  | { readonly kind: 'document'; readonly target: string; readonly before: JsonValue; readonly after: JsonValue };

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
  /** The earlier item this one reviews ("lesson/item"): the answer is recorded on it. */
  reviewOf: z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}\/[a-z0-9][a-z0-9-]{0,63}$/).optional(),
  kcs: z.array(z.string().max(120)).min(1).max(8),
  difficulty: z.int().min(1).max(5),
  evidenceType: z.enum(['production', 'prediction', 'recognition']),
  outcome: z.number().min(0).max(1),
  confidence: z.enum(['sure', 'think', 'guess']).optional(),
  transfer: z.boolean().default(false),
});

/**
 * What the learner sees of a message the app wrote for them (a hint request, an answer to check,
 * the interview...): a card with their own words, instead of the prompt the tutor gets.
 */
export const askShown = z.strictObject({
  kind: z.enum(['message', 'hint', 'check-answer', 'explain-back', 'interview', 'existing-work', 'plan', 'draft-lesson', 'continue']),
  /** What it is about: a task, a drill question, a planned lesson. */
  about: z.string().max(4000).optional(),
  /** The learner's own words, as they wrote them. */
  text: z.string().max(4000).optional(),
  /** Files the learner added with the message, by name. */
  files: z.array(z.string().max(300)).max(50).optional(),
});
export type AskShown = z.output<typeof askShown>;

export const askInput = z.strictObject({
  projectId: slugId,
  lessonId: slugId.optional(),
  /** Where in the lesson the question is anchored, e.g. "section-id/3". */
  anchor: z.string().max(200).optional(),
  /** Text the learner selected. */
  selection: z.string().max(4000).optional(),
  question: z.string().trim().min(1).max(4000),
  /** Shown in place of the question, when the app wrote it. The tutor still gets the question. */
  shown: askShown.optional(),
  /**
   * Which conversation this belongs to. "chat": quick questions, one agent session per lesson
   * (per the learner's setting). "session": the interview and planning page, one agent session
   * per project whatever lesson is open, so it remembers what was already discussed.
   */
  thread: z.enum(['chat', 'session']).default('chat'),
  /** This message carries the answers to a form the tutor showed (shown compactly, and saved). */
  answers: z
    .strictObject({
      askId: z.string().max(80),
      form: z.number().int().min(0).max(50),
      title: z.string().max(120),
      values: z.record(z.string().max(64), z.unknown()).refine((v) => JSON.stringify(v).length <= 40_000, { message: 'answers too large' }),
    })
    .optional(),
});

/** Any JSON value (kept local: the UI imports this file and must not pull in Node code). */
export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

const progressValue = z.json().refine((v) => JSON.stringify(v).length <= 20_000, { message: 'progress value too large' });

/** A file imported into a project (copied in: where it came from does not matter). */
export interface SourceDTO {
  readonly id: string;
  readonly name: string;
  readonly kind: 'text' | 'markdown' | 'html' | 'code' | 'pdf' | 'image' | 'other';
  readonly size: number;
  readonly chars: number;
  readonly pages?: number;
  readonly note?: string;
  readonly addedAt: string;
}

/** A path inside the project's workspace, relative, with forward slashes. */
const workspacePath = z.string().max(500).regex(/^[^\0\\]*$/, { message: 'use forward slashes' });

export interface WorkspaceEntryDTO {
  readonly name: string;
  readonly kind: 'file' | 'dir';
}

/**
 * Where the learner was, restored after a restart or a crash. Every key is optional: a place is
 * only a hint, checked against what exists when it is restored.
 */
export const placeSchema = z.strictObject({
  profileId: z.string().max(80).optional(),
  projectId: slugId.optional(),
  brain: z.boolean().optional(),
  view: z.enum(['session', 'lesson', 'review', 'path']).optional(),
  lessonId: slugId.optional(),
  margin: z.enum(['none', 'tutor', 'history', 'me', 'project']).optional(),
  editor: z.boolean().optional(),
  file: workspacePath.min(1).optional(),
  /** The workspace layout, the same in every project: panel widths in pixels, and the contents folded to a rail. */
  layout: z
    .strictObject({
      contents: z.int().min(0).max(10_000).optional(),
      margin: z.int().min(0).max(10_000).optional(),
      editor: z.int().min(0).max(10_000).optional(),
      folded: z.boolean().optional(),
    })
    .optional(),
});
export type Place = z.output<typeof placeSchema>;
export type Layout = NonNullable<Place['layout']>;
const placeChange = z.strictObject(
  Object.fromEntries(Object.entries(placeSchema.shape).map(([k, v]) => [k, v.unwrap().nullable().optional()])) as {
    [K in keyof typeof placeSchema.shape]: z.ZodOptional<z.ZodNullable<ReturnType<(typeof placeSchema.shape)[K]['unwrap']>>>;
  },
);

/** Unsaved text in the embedded editor, kept until it is saved or discarded. */
export interface DraftDTO {
  readonly path: string;
  readonly content: string;
  readonly baseVersion?: string | undefined;
  readonly at: string;
}

/** The hints given on one task (the hint ladder, pedagogy-model §6). */
export interface TaskHintsDTO {
  /** Each hint given, oldest first: its level, the level's name ("Question"), and what it was about. */
  readonly levels: readonly { readonly level: number; readonly name: string; readonly summary?: string; readonly at: string }[];
  readonly max: number;
  /** The learner tried again since the last hint (ran the checkpoint or wrote an attempt). */
  readonly attemptSince: boolean;
  /** The next level up needs a new attempt first (L4 and above). */
  readonly nextNeedsAttempt: boolean;
}

/** Every method: params schema + result type. */
export const methods = {
  'app.info': z.strictObject({}),
  'profiles.list': z.strictObject({}),
  'profiles.create': z.strictObject({ displayName: z.string().trim().min(1).max(60) }),
  'profiles.open': z.strictObject({ profileId: z.string().max(80) }),
  'profiles.updateSettings': z.strictObject({ changeMode: changeModeSchema.optional(), sessionMode: sessionModeSchema.optional(), reviewQuestions: reviewQuestionsSchema.optional() }),
  'projects.list': z.strictObject({}),
  'projects.create': projectInput,
  'projects.update': projectUpdate,
  'lessons.list': z.strictObject({ projectId: slugId }),
  'lessons.get': z.strictObject({ projectId: slugId, lessonId: slugId }),
  'learner.summary': z.strictObject({}),
  'answers.record': answerInput,
  'reviews.queue': z.strictObject({ projectId: slugId }),
  'reviews.answer': z.strictObject({
    projectId: slugId,
    /** As in the queue: `~reviews/<id>` or `lesson/item`. */
    questionId: z.string().max(130),
    evidenceType: z.enum(['production', 'recognition']),
    outcome: z.number().min(0).max(1),
    confidence: z.enum(['sure', 'think', 'guess']).optional(),
  }),
  /** "Doesn't make sense without the lesson": never asked again, and an answer already given is withdrawn. */
  'reviews.flag': z.strictObject({ projectId: slugId, questionId: z.string().max(130), evidenceId: z.string().max(80).optional() }),
  'curriculum.get': z.strictObject({ projectId: slugId }),
  'roadmap.setStatus': z.strictObject({ projectId: slugId, milestoneId: slugId, status: z.enum(['planned', 'active', 'done']) }),
  'brain.get': z.strictObject({}),
  'reviews.summary': z.strictObject({}),
  'progress.get': z.strictObject({ projectId: slugId, lessonId: slugId }),
  'progress.set': z.strictObject({ projectId: slugId, lessonId: slugId, key: z.string().min(1).max(200), value: progressValue }),
  'conversations.get': z.strictObject({ projectId: slugId, thread: z.enum(['chat', 'session']) }),
  'conversations.running': z.strictObject({ projectId: slugId, thread: z.enum(['chat', 'session']) }),
  'checkpoints.list': z.strictObject({ projectId: slugId, lessonId: slugId }),
  'hints.get': z.strictObject({ projectId: slugId, lessonId: slugId }),
  'hints.attempt': z.strictObject({ projectId: slugId, lessonId: slugId, taskId: slugId, text: z.string().trim().min(1).max(4000) }),
  'checkpoints.run': z.strictObject({ projectId: slugId, lessonId: slugId, taskId: slugId }),
  'checkpoints.cancel': z.strictObject({ projectId: slugId }),
  'history.list': z.strictObject({ filter: historyFilter.default({}) }),
  'history.undo': z.strictObject({ id: z.string().max(80), withDependants: z.boolean().default(false) }),
  'history.redo': z.strictObject({ id: z.string().max(80) }),
  'history.accept': z.strictObject({ id: z.string().max(80) }),
  'history.reject': z.strictObject({ id: z.string().max(80) }),
  'history.undoWhere': z.strictObject({ filter: historyFilter }),
  'history.diff': z.strictObject({ id: z.string().max(80) }),
  ask: askInput,
  'ask.cancel': z.strictObject({ askId: z.string().max(80) }),
  'agent.status': z.strictObject({}),
  'agent.check': z.strictObject({}),
  'sources.list': z.strictObject({ projectId: slugId }),
  'sources.begin': z.strictObject({ projectId: slugId, name: z.string().min(1).max(1000), size: z.int().min(0).max(50 * 1024 * 1024) }),
  'sources.chunk': z.strictObject({ uploadId: z.string().max(64), index: z.int().min(0).max(100), data: z.base64().max(1_400_000) }),
  'sources.finish': z.strictObject({ uploadId: z.string().max(64) }),
  'sources.remove': z.strictObject({ projectId: slugId, sourceId: z.string().max(80) }),
  'sources.text': z.strictObject({ projectId: slugId, sourceId: z.string().max(80) }),
  'folders.list': z.strictObject({ path: z.string().max(1000).optional() }),
  'workspace.list': z.strictObject({ projectId: slugId, dir: workspacePath.default('') }),
  'workspace.read': z.strictObject({ projectId: slugId, path: workspacePath.min(1) }),
  'workspace.write': z.strictObject({ projectId: slugId, path: workspacePath.min(1), content: z.string().max(2_200_000), baseVersion: z.string().max(64).optional() }),
  'place.get': z.strictObject({}),
  'place.set': placeChange,
  'drafts.list': z.strictObject({ projectId: slugId }),
  'drafts.set': z.strictObject({ projectId: slugId, path: workspacePath.min(1), content: z.string().max(2_200_000).nullable(), baseVersion: z.string().max(64).optional() }),
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
  'projects.update': ProjectDTO;
  'lessons.list': LessonSummaryDTO[];
  'lessons.get': unknown;
  'learner.summary': LearnerDTO;
  'answers.record': { id: string };
  'reviews.queue': ReviewQueueDTO;
  'reviews.answer': { id: string };
  'reviews.flag': { ok: true };
  'curriculum.get': CurriculumDTO;
  'roadmap.setStatus': { ok: true };
  'brain.get': BrainDTO;
  'reviews.summary': Record<string, { due: number; nextDue?: string }>;
  'progress.get': Record<string, JsonValue>;
  'progress.set': { saved: boolean };
  'conversations.get': TranscriptEntry[];
  /** Ids of the turns still in progress (the page was reloaded while the tutor worked). */
  'conversations.running': string[];
  'checkpoints.list': CheckpointsDTO;
  /** By task id. */
  'hints.get': Record<string, TaskHintsDTO>;
  'hints.attempt': { recorded: boolean };
  'checkpoints.run': CheckpointRunDTO & { output: string; truncated: boolean };
  'checkpoints.cancel': { cancelled: boolean };
  'history.list': HistoryItemDTO[];
  'history.undo': { undone: string[] };
  'history.redo': { id: string };
  'history.accept': { id: string };
  'history.reject': { id: string };
  'history.undoWhere': { undone: string[] };
  'history.diff': ChangeDiffDTO;
  ask: { askId: string };
  'ask.cancel': { ok: true };
  'agent.status': AgentStatusDTO;
  'agent.check': AgentStatusDTO;
  'sources.list': SourceDTO[];
  'sources.begin': { uploadId: string };
  'sources.chunk': { received: number };
  'sources.finish': SourceDTO & { existed: boolean };
  'sources.remove': { ok: true };
  'sources.text': { text: string; truncated: boolean };
  'folders.list': { path: string; parent?: string; folders: string[] };
  'workspace.list': WorkspaceEntryDTO[];
  'workspace.read': { content: string; version: string };
  'workspace.write': { version: string };
  'place.get': Place;
  'place.set': Place;
  'drafts.list': DraftDTO[];
  'drafts.set': { saved: boolean };
}

/** Agent turn events forwarded to the UI (mirrors the agent host's HostEvent). */
/**
 * One line of a saved conversation. The UI replays these through the same code that handles
 * live events, so a restored conversation looks exactly like it did.
 */
export type TranscriptEntry =
  | { t: 'ask'; askId: string; at: string; question: string; shown?: AskShown; selection?: string; answersTo?: string; lessonId?: string }
  | { t: 'event'; askId: string; event: AskEvent }
  | { t: 'submitted'; askId: string; form: number; answers: Record<string, unknown> }
  | { t: 'end'; askId: string; state: 'done' | 'cancelled' | 'error'; error?: string };

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
  'agent.status': AgentStatusDTO;
  /** Something changed: the UI refreshes what it shows. */
  changed: { what: 'profiles' | 'projects' | 'lessons' | 'history' | 'learner' | 'progress' | 'checkpoints' | 'reviews' | 'sources' | 'hints' };
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
