import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { brand } from '@app/brand';
import { claudeAgent, type AgentSpec } from '@app/agent-host';
import { AgentHost } from '@app/agent-host';
import {
  ChangeConflictError,
  ChangeError,
  ChangeValidationError,
  DependantsError,
  ProfileNotFoundError,
  ProfileStore,
  activeObservations,
  band,
  deriveLearnerState,
  difficultyFromLevel,
  isObservation,
  matchesFilter,
  ratingConfidence,
  systemClock,
  type Author,
  type Clock,
  type HistoryFilter,
  type JsonValue,
  type LogEvent,
  type OpenProfile,
  type ProfileFile,
} from '@app/core';
import { lesson as lessonSchema } from '@app/catalog';
import { TeacherHttpServer, lessonTarget, lessonsDir, projectTarget, registerLessonValidator } from '@app/teacher-mcp';
import { AgentSessions, buildAskPrompt, type HostFactory, type TurnEvent } from './agent-sessions.ts';
import { AppError } from './errors.ts';
import { methods, type AskEvent, type HistoryItemDTO, type Method, type Params, type ProfileDTO, type ProjectDTO, type Results, type ServerEvents } from './protocol.ts';

const LEARNER: Author = { kind: 'learner' };
const SYSTEM: Author = { kind: 'system' };

export interface AppOptions {
  readonly dataRoot: string;
  readonly clock?: Clock;
  readonly agent?: AgentSpec;
  readonly hostFactory?: HostFactory;
}

type Emit = <E extends keyof ServerEvents>(event: E, data: ServerEvents[E]) => void;

interface OpenState {
  readonly profile: OpenProfile;
  settings: ProfileDTO['settings'];
  agents: AgentSessions;
}

const projectFile = z.strictObject({
  schemaVersion: z.literal(1),
  id: z.string(),
  title: z.string(),
  goal: z.string(),
  why: z.string(),
  workspace: z.string().optional(),
  testCommand: z.string().optional(),
  createdAt: z.string(),
});

const toProfileDTO = (p: ProfileFile): ProfileDTO => ({ id: p.id, displayName: p.displayName, createdAt: p.createdAt, settings: p.settings });

function slugify(title: string): string {
  const base = title.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
  return `${base || 'project'}-${randomUUID().slice(0, 6)}`;
}

/** The app service: everything the UI can do, independent of the transport. */
export class AppService {
  readonly #store: ProfileStore;
  readonly #spec: AgentSpec;
  readonly #factory: HostFactory;
  readonly #emitters = new Set<Emit>();
  readonly #asks = new Map<string, () => Promise<void>>();
  #teacher: TeacherHttpServer | undefined;
  #open: OpenState | undefined;

  constructor(opts: AppOptions) {
    this.#store = new ProfileStore(opts.dataRoot, opts.clock ?? systemClock);
    this.#spec = opts.agent ?? claudeAgent;
    // The real agent process; exercised by scripts/spike-*.ts rather than CI (it needs a login).
    /* v8 ignore next */
    this.#factory = opts.hostFactory ?? ((spec) => AgentHost.spawn(spec));
  }

  /** Subscribe to server events (one per connected UI). Returns an unsubscribe function. */
  subscribe(emit: Emit): () => void {
    this.#emitters.add(emit);
    return () => void this.#emitters.delete(emit);
  }

  #emit: Emit = (event, data) => this.#emitters.forEach((e) => e(event, data));

  async close(): Promise<void> {
    await this.#closeProfile();
    await this.#teacher?.close();
    this.#teacher = undefined;
  }

  async #closeProfile(): Promise<void> {
    if (!this.#open) return;
    const { profile, agents } = this.#open;
    this.#open = undefined;
    await agents.close();
    await profile.close();
  }

  #profile(): OpenState {
    if (!this.#open) throw new AppError('no_profile', 'open a profile first');
    return this.#open;
  }

  /** Dispatch one RPC call (params validated here). */
  async call<M extends Method>(method: M, rawParams: unknown): Promise<Results[M]> {
    const schema = methods[method] as z.ZodType;
    if (!schema) throw new AppError('unknown_method', `unknown method ${String(method)}`);
    const parsed = schema.safeParse(rawParams ?? {});
    if (!parsed.success) throw new AppError('invalid_params', parsed.error.message);
    try {
      return (await this.#handlers[method](parsed.data as never)) as Results[M];
    } catch (err) {
      throw translate(err);
    }
  }

  readonly #handlers: { [M in Method]: (p: z.output<(typeof methods)[M]>) => Promise<Results[M]> } = {
    'app.info': async () => ({ name: brand.displayName, id: brand.id, tagline: brand.tagline, agent: this.#spec.displayName }),

    'profiles.list': async () => (await this.#store.list()).map(toProfileDTO),

    'profiles.create': async ({ displayName }) => {
      const p = toProfileDTO(await this.#store.create(displayName));
      this.#emit('changed', { what: 'profiles' });
      return p;
    },

    'profiles.open': async ({ profileId }) => {
      if (this.#open?.profile.profile.id === profileId) return toProfileDTO(await this.#store.read(profileId));
      await this.#closeProfile();
      const profile = await this.#store.open(profileId);
      registerLessonValidator(profile.changes);
      this.#teacher ??= await TeacherHttpServer.start();
      const state = { profile, settings: profile.profile.settings, agents: undefined as unknown as AgentSessions };
      state.agents = new AgentSessions(this.#spec, this.#factory, this.#teacher, profile, () => state.settings);
      this.#open = state;
      return toProfileDTO(profile.profile);
    },

    'profiles.updateSettings': async (s) => {
      const open = this.#profile();
      const next = await this.#store.updateSettings(open.profile.profile.id, Object.fromEntries(Object.entries(s).filter(([, v]) => v !== undefined)));
      open.settings = next.settings;
      this.#emit('changed', { what: 'profiles' });
      return toProfileDTO(next);
    },

    'projects.list': async () => {
      const { profile } = this.#profile();
      const targets = new Set(profile.changes.list({ status: 'applied' }).map((c) => c.target).filter((t) => /^projects\/[^/]+\/project\.json$/.test(t)));
      const out: ProjectDTO[] = [];
      for (const t of [...targets].sort()) {
        const parsed = projectFile.safeParse(await profile.changes.read(t));
        if (parsed.success) {
          const { schemaVersion: _v, ...dto } = parsed.data;
          out.push(dto as ProjectDTO);
        }
      }
      return out.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    },

    'projects.create': async (input) => {
      const { profile } = this.#profile();
      const id = slugify(input.title);
      const doc = {
        schemaVersion: 1 as const,
        id,
        ...Object.fromEntries(Object.entries(input).filter(([, v]) => v !== undefined)),
        createdAt: profile.journal.now().toISOString(),
      };
      await profile.changes.propose(
        { author: LEARNER, target: projectTarget(id), patch: [{ op: 'add', path: '', value: doc as JsonValue }], reason: 'new project' },
        'auto',
      );
      this.#emit('changed', { what: 'projects' });
      const { schemaVersion: _v, ...dto } = doc;
      return dto as ProjectDTO;
    },

    'lessons.list': async ({ projectId }) => {
      const { profile } = this.#profile();
      const prefix = `${lessonsDir(projectId)}/`;
      const targets = [...new Set(profile.changes.list({ status: 'applied' }).map((c) => c.target))].filter((t) => t.startsWith(prefix)).sort();
      const out = [];
      for (const t of targets) {
        const l = lessonSchema.safeParse(await profile.changes.read(t));
        if (l.success) out.push({ id: l.data.id, title: l.data.title, kind: l.data.kind, estimateMin: l.data.estimateMin });
      }
      return out;
    },

    'lessons.get': async ({ projectId, lessonId }) => {
      const doc = await this.#profile().profile.changes.read(lessonTarget(projectId, lessonId));
      if (doc === null) throw new AppError('not_found', `no lesson ${lessonId}`);
      return doc;
    },

    'learner.summary': async () => {
      const { profile } = this.#profile();
      const s = deriveLearnerState(profile.journal.events, profile.journal.now());
      const recent = s.firstAttempts.slice(-12);
      return {
        kcs: [...s.kcs.values()]
          .sort((a, b) => a.kc.localeCompare(b.kc))
          .map((k) => ({ kc: k.kc, band: band(k.rating.theta), mastery: k.mastery, confidence: ratingConfidence(k.rating) })),
        insights: s.insights.map((i) => ({ id: i.id, text: i.text, trust: i.trust, scope: i.scope })),
        recentSuccess: { correct: recent.filter(Boolean).length, total: recent.length },
      };
    },

    'answers.record': async (a) => {
      const { profile } = this.#profile();
      const e = await profile.observations.recordEvidence({
        author: SYSTEM,
        itemId: `${a.lessonId}/${a.itemId}`,
        kcs: a.kcs.map((kc) => ({ kc, weight: 1 })),
        difficulty: difficultyFromLevel(a.difficulty),
        evidenceType: a.evidenceType,
        outcome: a.outcome,
        transfer: a.transfer,
        ...(a.confidence ? { confidence: a.confidence } : {}),
      });
      this.#emit('changed', { what: 'learner' });
      return { id: e.id };
    },

    'history.list': async ({ filter }) => historyOf(this.#profile().profile, filter),

    'history.undo': async ({ id, withDependants }) => {
      const { profile } = this.#profile();
      let undone: string[];
      if (id.startsWith('chg_')) undone = await profile.changes.revert(id, LEARNER, { withDependants });
      else {
        await profile.observations.revoke([id], LEARNER);
        undone = [id];
      }
      this.#changedAll();
      return { undone };
    },

    'history.redo': async ({ id }) => {
      const { profile } = this.#profile();
      if (id.startsWith('chg_')) await profile.changes.redo(id, LEARNER);
      else await profile.observations.restore([id], LEARNER);
      this.#changedAll();
      return { id };
    },

    'history.accept': async ({ id }) => {
      await this.#profile().profile.changes.accept(id, LEARNER);
      this.#changedAll();
      return { id };
    },

    'history.reject': async ({ id }) => {
      await this.#profile().profile.changes.reject(id, LEARNER);
      this.#emit('changed', { what: 'history' });
      return { id };
    },

    'history.undoWhere': async ({ filter }) => {
      const { profile } = this.#profile();
      const f = cleanFilter(filter);
      const changes = await profile.changes.revertWhere(f, LEARNER);
      const obs = await profile.observations.revokeWhere(f, LEARNER);
      this.#changedAll();
      return { undone: [...changes, ...obs] };
    },

    ask: async (q) => {
      const open = this.#profile();
      const project = (await this.#handlers['projects.list']({})).find((p) => p.id === q.projectId);
      if (!project) throw new AppError('not_found', `no project ${q.projectId}`);
      const askId = randomUUID();
      const prompt = buildAskPrompt(q);
      const onEvent = (event: TurnEvent) => this.#emit('ask.event', { askId, event: event as AskEvent });
      void open.agents
        .ask(project, q.lessonId, prompt, onEvent, (cancel) => this.#asks.set(askId, cancel))
        .then(
          (stopReason) => this.#emit('ask.done', { askId, stopReason }),
          (err: unknown) => this.#emit('ask.error', { askId, message: (err as Error).message }),
        )
        .finally(() => {
          this.#asks.delete(askId);
          this.#changedAll();
        });
      return { askId };
    },

    'ask.cancel': async ({ askId }) => {
      const cancel = this.#asks.get(askId);
      if (!cancel) throw new AppError('not_found', `no running question ${askId}`);
      await cancel();
      return { ok: true };
    },
  };

  #changedAll(): void {
    for (const what of ['lessons', 'history', 'learner', 'projects'] as const) this.#emit('changed', { what });
  }
}

function cleanFilter(f: Record<string, string | undefined>): HistoryFilter {
  return Object.fromEntries(Object.entries(f).filter(([, v]) => v !== undefined)) as HistoryFilter;
}

function summarize(e: LogEvent): string {
  switch (e.type) {
    case 'evidence':
      return `Evidence on ${e.kcs.map((k) => k.kc).join(', ')}: ${Math.round(e.outcome * 100)}%${e.hintLevel ? ` with hint L${e.hintLevel}` : ''} (${e.evidenceType})`;
    case 'instruction':
      return `Taught ${e.kcs.join(', ')}`;
    case 'insight':
      return e.stance === 'propose' ? `New insight: ${e.text}` : `${e.stance === 'support' ? 'Supported' : 'Contradicted'} insight ${e.insightId}`;
    default:
      return e.type;
  }
}

function historyOf(profile: OpenProfile, filter: Record<string, string | undefined>): HistoryItemDTO[] {
  const f = cleanFilter(filter);
  const changes: HistoryItemDTO[] = profile.changes
    .list(f)
    .map((c) => ({ id: c.changeId, kind: 'change', at: c.proposedAt, author: c.author, summary: c.reason, status: c.status, target: c.target }));
  const active = new Set(activeObservations(profile.journal.events).map((e) => e.id));
  const observations: HistoryItemDTO[] = profile.journal.events
    .filter(isObservation)
    .filter((e) => matchesFilter(e, f))
    .map((e) => ({ id: e.id, kind: 'observation', at: e.at, author: e.author, summary: summarize(e), status: active.has(e.id) ? 'active' : 'revoked' }));
  return [...changes, ...observations].sort((a, b) => (a.at === b.at ? b.id.localeCompare(a.id) : b.at.localeCompare(a.at)));
}

function translate(err: unknown): AppError {
  if (err instanceof AppError) return err;
  if (err instanceof DependantsError) return new AppError('dependants', err.message, { dependants: err.dependants });
  if (err instanceof ChangeValidationError) return new AppError('invalid_params', err.message, { problems: err.problems });
  if (err instanceof ChangeConflictError || err instanceof ChangeError) return new AppError('conflict', err.message);
  if (err instanceof ProfileNotFoundError) return new AppError('not_found', err.message);
  if ((err as Error)?.name === 'LockedError') return new AppError('conflict', (err as Error).message);
  if ((err as Error)?.name === 'UnknownEventError') return new AppError('not_found', (err as Error).message);
  return new AppError('internal', (err as Error)?.message ?? String(err));
}
