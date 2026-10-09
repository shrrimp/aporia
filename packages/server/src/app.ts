import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
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
  applyPatch,
  roadmapTarget,
  activeObservations,
  band,
  deriveLearnerState,
  difficultyFromLevel,
  isObservation,
  lessonProgress,
  projectProgress,
  matchesFilter,
  ratingConfidence,
  systemClock,
  GATED_FROM,
  HINT_LEVELS,
  hintStates,
  type Author,
  type Clock,
  type HintEvent,
  type HistoryFilter,
  type JsonValue,
  type LogEvent,
  type OpenProfile,
  type PatchOp,
  type ProfileFile,
  splitCommand,
} from '@app/core';
import { agentPermissions, formAnswer, lessonCompletion, scoreProbe, type LearnerForm } from '@app/catalog';
import { TeacherHttpServer, lessonTarget, projectLessons, projectReviews, projectTarget, readRoadmap, readSources, registerValidators, sourceText, isAgentFileTarget, type AgentFileDoc, type SourceEntry } from '@app/teacher-mcp';
import { AgentSessions, buildAskPrompt, type HostFactory, type TurnEvent, type TurnLimits } from './agent-sessions.ts';
import { AppError } from './errors.ts';
import { cutOff, recap, Transcripts, type TranscriptEntry } from './transcripts.ts';
import { CheckpointRunner } from './checkpoint-runner.ts';
import { brain, projectCurriculum } from './maps.ts';
import { listDir, listFolders, readText, writeText } from './workspace.ts';
import { addSource, removeSource, Uploads } from './sources.ts';
import { Drafts, PlaceStore } from './place.ts';
import { askInput, methods, type AskEvent, type HistoryItemDTO, type Method, type Params, type ProfileDTO, type ProjectDTO, type Results, type ServerEvents, type SourceDTO, type TaskHintsDTO } from './protocol.ts';

const LEARNER: Author = { kind: 'learner' };
const SYSTEM: Author = { kind: 'system' };

/** Streamed text is saved at least this often during a turn. */
const TEXT_SAVE_MS = 2000;
const TEXT_SAVE_CHARS = 4000;

export interface AppOptions {
  readonly dataRoot: string;
  readonly clock?: Clock;
  readonly agent?: AgentSpec;
  readonly hostFactory?: HostFactory;
  /** How long a check waits for an agent to report its login (tests shorten it). */
  readonly loginWaitMs?: number;
  /** How long a turn may go without a word from the agent before it is stopped (tests shorten it). */
  readonly turnLimits?: Partial<TurnLimits>;
}

type Emit = <E extends keyof ServerEvents>(event: E, data: ServerEvents[E]) => void;

interface OpenState {
  readonly profile: OpenProfile;
  settings: ProfileDTO['settings'];
  agents: AgentSessions;
  transcripts: Transcripts;
  drafts: Drafts;
  checkpoints: CheckpointRunner;
}

const projectFile = z.strictObject({
  schemaVersion: z.literal(1),
  id: z.string(),
  title: z.string(),
  goal: z.string(),
  why: z.string(),
  workspace: z.string().optional(),
  testCommand: z.string().optional(),
  /** What the tutor may do in the workspace (absent on older projects: the defaults apply). */
  agent: agentPermissions.optional(),
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
  readonly #place: PlaceStore;
  readonly #spec: AgentSpec;
  readonly #factory: HostFactory;
  readonly #loginWaitMs: number | undefined;
  readonly #turnLimits: Partial<TurnLimits> | undefined;
  readonly #emitters = new Set<Emit>();
  readonly #asks = new Map<string, () => Promise<void>>();
  /** Turns in progress, by ask id: where they are saved, and how to save their streamed text now. */
  readonly #running = new Map<string, { readonly projectId: string; readonly thread: 'chat' | 'session'; readonly flush: () => void }>();
  readonly #uploads = new Uploads();
  #teacher: TeacherHttpServer | undefined;
  #open: OpenState | undefined;

  constructor(opts: AppOptions) {
    this.#store = new ProfileStore(opts.dataRoot, opts.clock ?? systemClock);
    this.#place = new PlaceStore(opts.dataRoot);
    this.#spec = opts.agent ?? claudeAgent;
    this.#loginWaitMs = opts.loginWaitMs;
    this.#turnLimits = opts.turnLimits;
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
    const { profile, agents, transcripts, checkpoints } = this.#open;
    this.#open = undefined;
    checkpoints.cancelAll();
    await agents.close();
    await transcripts.flush();
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
      registerValidators(profile.changes);
      this.#teacher ??= await TeacherHttpServer.start();
      const state = {
        profile,
        settings: profile.profile.settings,
        agents: undefined as unknown as AgentSessions,
        transcripts: new Transcripts(profile.dir),
        drafts: new Drafts(profile.dir),
        checkpoints: new CheckpointRunner(profile),
      };
      state.agents = new AgentSessions(
        this.#spec,
        this.#factory,
        this.#teacher,
        profile,
        () => state.settings,
        (status) => this.#emit('agent.status', status),
        this.#turnLimits,
      );
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
      checkTestCommand(input.testCommand);
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

    'projects.update': async ({ projectId, agent, ...fields }) => {
      const { profile } = this.#profile();
      const current = await this.#project(projectId);
      checkTestCommand(fields.testCommand);
      const patch: PatchOp[] = [];
      if (agent !== undefined && JSON.stringify(agent) !== JSON.stringify(current.agent)) {
        patch.push({ op: current.agent ? 'replace' : 'add', path: '/agent', value: agent as unknown as JsonValue });
      }
      for (const [key, value] of Object.entries(fields) as [keyof typeof fields, string | undefined][]) {
        if (value === undefined) continue;
        const has = current[key] !== undefined;
        if (value === '' && (key === 'workspace' || key === 'testCommand')) {
          if (has) patch.push({ op: 'remove', path: `/${key}` });
        } else if (value !== current[key]) {
          patch.push({ op: has ? 'replace' : 'add', path: `/${key}`, value });
        }
      }
      if (patch.length > 0) {
        await profile.changes.propose({ author: LEARNER, target: projectTarget(projectId), patch, reason: 'project settings' }, 'auto');
        this.#emit('changed', { what: 'projects' });
        this.#emit('changed', { what: 'checkpoints' });
      }
      return this.#project(projectId);
    },

    'lessons.list': async ({ projectId }) => {
      const { profile } = this.#profile();
      const progress = projectProgress(profile.journal.events, projectId);
      return (await projectLessons(profile, projectId)).map((l) => ({
        id: l.id,
        title: l.title,
        kind: l.kind,
        estimateMin: l.estimateMin,
        progress: lessonCompletion(l, progress[l.id] ?? {}),
      }));
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
        itemId: a.reviewOf ?? `${a.lessonId}/${a.itemId}`,
        projectId: a.projectId,
        kcs: a.kcs.map((kc) => ({ kc, weight: 1 })),
        difficulty: difficultyFromLevel(a.difficulty),
        evidenceType: a.evidenceType,
        outcome: a.outcome,
        transfer: a.transfer,
        ...(a.confidence ? { confidence: a.confidence } : {}),
      });
      this.#emit('changed', { what: 'learner' });
      this.#emit('changed', { what: 'reviews' });
      return { id: e.id };
    },

    'reviews.queue': async ({ projectId }) => {
      const { profile } = this.#profile();
      await this.#project(projectId);
      const r = await projectReviews(profile, projectId, profile.journal.now());
      return {
        items: r.due.map((d) => ({ itemId: d.itemId, lessonId: d.lessonId, lessonTitle: d.lessonTitle, item: d.item, retrievability: d.retrievability, reviews: d.reviews })),
        dueCount: r.dueCount,
        ...(r.nextDue ? { nextDue: r.nextDue } : {}),
      };
    },

    'curriculum.get': async ({ projectId }) => projectCurriculum(this.#profile().profile, await this.#project(projectId)),

    'roadmap.setStatus': async ({ projectId, milestoneId, status }) => {
      const { profile } = this.#profile();
      await this.#project(projectId);
      const roadmap = await readRoadmap(profile.changes, projectId);
      if (!roadmap.milestones[milestoneId]) throw new AppError('not_found', `no milestone ${milestoneId}`);
      if (roadmap.milestones[milestoneId].status !== status) {
        await profile.changes.propose(
          { author: LEARNER, target: roadmapTarget(projectId), patch: [{ op: 'replace', path: `/milestones/${milestoneId}/status`, value: status }], reason: `roadmap, ${milestoneId}: marked ${status}` },
          'auto',
        );
        this.#emitMany(['history', 'lessons']);
      }
      return { ok: true as const };
    },

    'brain.get': async () => brain(this.#profile().profile, await this.#handlers['projects.list']({})),

    'reviews.summary': async () => {
      const { profile } = this.#profile();
      const now = profile.journal.now();
      const out: Results['reviews.summary'] = {};
      for (const p of await this.#handlers['projects.list']({})) {
        const r = await projectReviews(profile, p.id, now, 0);
        out[p.id] = { due: r.dueCount, ...(r.nextDue ? { nextDue: r.nextDue } : {}) };
      }
      return out;
    },

    'progress.get': async ({ projectId, lessonId }) => ({ ...lessonProgress(this.#profile().profile.journal.events, projectId, lessonId) }),

    'progress.set': async ({ projectId, lessonId, key, value }) => {
      const e = await this.#profile().profile.progress.set(LEARNER, projectId, lessonId, key, value as JsonValue);
      if (e) this.#emit('changed', { what: 'progress' });
      return { saved: e !== undefined };
    },

    'conversations.get': async ({ projectId, thread }) => {
      // Text streamed but not saved yet is saved first, so a reloaded page misses nothing.
      for (const r of this.#running.values()) if (r.projectId === projectId && r.thread === thread) r.flush();
      return this.#profile().transcripts.read(projectId, thread);
    },

    'conversations.running': async ({ projectId, thread }) =>
      [...this.#running].filter(([, r]) => r.projectId === projectId && r.thread === thread).map(([askId]) => askId),

    'checkpoints.list': async ({ projectId, lessonId }) => this.#profile().checkpoints.list(await this.#project(projectId), lessonId),

    'hints.get': async ({ projectId, lessonId }) => {
      await this.#project(projectId);
      const { events } = this.#profile().profile.journal;
      const out: Record<string, TaskHintsDTO> = {};
      for (const [, h] of hintStates(events, projectId, lessonId)) {
        const given = events.filter((e): e is HintEvent => e.type === 'hint' && e.projectId === projectId && e.lessonId === lessonId && e.taskId === h.taskId);
        out[h.taskId] = {
          levels: given.map((e) => ({ level: e.level, name: HINT_LEVELS[e.level]!.name, ...(e.summary ? { summary: e.summary } : {}), at: e.at })),
          max: h.max,
          attemptSince: h.attemptSince,
          nextNeedsAttempt: h.max + 1 >= GATED_FROM && h.max < 5 && !h.attemptSince,
        };
      }
      return out;
    },

    'hints.attempt': async ({ projectId, lessonId, taskId, text }) => {
      await this.#project(projectId);
      await this.#profile().profile.hints.attempt(LEARNER, { projectId, lessonId, taskId, text });
      this.#emit('changed', { what: 'hints' });
      return { recorded: true };
    },

    'checkpoints.run': async ({ projectId, lessonId, taskId }) => {
      const open = this.#profile();
      const project = await this.#project(projectId);
      this.#emit('changed', { what: 'checkpoints' });
      try {
        const result = await open.checkpoints.run(project, lessonId, taskId);
        if (!result.cancelled) this.#emit('changed', { what: 'learner' });
        return result;
      } finally {
        this.#emit('changed', { what: 'checkpoints' });
      }
    },

    'checkpoints.cancel': async ({ projectId }) => ({ cancelled: this.#profile().checkpoints.cancel(projectId) }),

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

    'history.diff': async ({ id }) => {
      const { profile } = this.#profile();
      const c = profile.changes.get(id);
      if (!c) throw new AppError('not_found', `no change ${id}`);
      if (c.status !== 'proposed') throw new AppError('conflict', 'only a change waiting for review can be compared');
      const before = await profile.changes.read(c.target);
      let after: JsonValue;
      try {
        after = applyPatch(before, c.patch).doc;
      } catch (err) {
        throw new AppError('conflict', `this change no longer applies: ${(err as Error).message}`);
      }
      if (isAgentFileTarget(c.target)) {
        const b = before as AgentFileDoc | null;
        const a = after as AgentFileDoc | null;
        return { kind: 'file' as const, path: (a ?? b)!.path, before: b ? b.content : a!.original, after: a ? a.content : b!.original };
      }
      return { kind: 'document' as const, target: c.target, before, after };
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
      const project = await this.#project(q.projectId);
      const askId = randomUUID();
      // Everything shown is also saved, so the conversation is still there after a restart.
      // Streamed text is gathered and written between other events, not chunk by chunk.
      // Only for the recap and probes: an unreadable history must not stop the learner from asking.
      const earlier = await open.transcripts.read(project.id, q.thread).catch(() => []);
      const scored = q.answers ? await this.#scoreProbes(open, project.id, earlier, q.answers) : '';
      const cut = cutOff(earlier, new Set(this.#running.keys()));
      const prompt = [cut, buildAskPrompt(q), scored].filter(Boolean).join('\n\n');
      const save = (entries: TranscriptEntry[]) =>
        void open.transcripts.append(project.id, q.thread, entries).catch((err: unknown) => console.error(`could not save the conversation: ${(err as Error).message}`));
      let text = '';
      let savedAt = Date.now();
      const flush = () => {
        if (text) save([{ t: 'event', askId, event: { kind: 'text', text } }]);
        text = '';
        savedAt = Date.now();
      };
      this.#running.set(askId, { projectId: project.id, thread: q.thread, flush });
      save([
        ...(q.answers ? [{ t: 'submitted' as const, askId: q.answers.askId, form: q.answers.form, answers: q.answers.values }] : []),
        {
          t: 'ask',
          askId,
          at: open.profile.journal.now().toISOString(),
          question: q.question,
          ...(q.selection ? { selection: q.selection } : {}),
          ...(q.answers ? { answersTo: q.answers.title } : {}),
          ...(q.lessonId ? { lessonId: q.lessonId } : {}),
        },
      ]);
      const onEvent = (event: TurnEvent) => {
        this.#emit('ask.event', { askId, event: event as AskEvent });
        if (event.kind === 'text') {
          text += event.text;
          // A long answer is saved as it streams: a crash loses a few seconds of it at most.
          if (Date.now() - savedAt > TEXT_SAVE_MS || text.length > TEXT_SAVE_CHARS) flush();
        } else if (event.kind !== 'thought') {
          flush();
          save([{ t: 'event', askId, event: event as AskEvent }]);
        }
      };
      void open.agents
        .ask(project, q.lessonId, q.thread, prompt, onEvent, (cancel) => this.#asks.set(askId, cancel), () => recap(earlier))
        .then(
          (stopReason) => {
            flush();
            this.#running.delete(askId); // before anyone hears it is done
            save([{ t: 'end', askId, state: stopReason === 'cancelled' ? 'cancelled' : 'done' }]);
            this.#emit('ask.done', { askId, stopReason });
          },
          (err: unknown) => {
            flush();
            this.#running.delete(askId);
            save([{ t: 'end', askId, state: 'error', error: (err as Error).message }]);
            this.#emit('ask.error', { askId, message: (err as Error).message });
          },
        )
        .finally(() => {
          this.#asks.delete(askId);
          this.#changedAll();
        });
      return { askId };
    },

    'sources.list': async ({ projectId }) => {
      const { profile } = this.#profile();
      await this.#project(projectId);
      return Object.entries(await readSources(profile, projectId))
        .map(([id, e]) => sourceDTO(id, e))
        .sort((a, b) => a.addedAt.localeCompare(b.addedAt));
    },

    'sources.begin': async ({ projectId, name, size }) => {
      await this.#project(projectId);
      return { uploadId: this.#uploads.begin(projectId, name, size) };
    },

    'sources.chunk': async ({ uploadId, index, data }) => ({ received: this.#uploads.chunk(uploadId, index, data) }),

    'sources.finish': async ({ uploadId }) => {
      const { profile } = this.#profile();
      const file = this.#uploads.finish(uploadId);
      const { id, entry, existed } = await addSource(profile, file.projectId, file.name, file.data, LEARNER);
      if (!existed) this.#emitMany(['sources', 'history']);
      return { ...sourceDTO(id, entry), existed };
    },

    'sources.remove': async ({ projectId, sourceId }) => {
      await removeSource(this.#profile().profile, projectId, sourceId, LEARNER);
      this.#emitMany(['sources', 'history']);
      return { ok: true as const };
    },

    'sources.text': async ({ projectId, sourceId }) => {
      const text = await sourceText(this.#profile().profile, projectId, sourceId);
      if (text === undefined) throw new AppError('not_found', `no source ${sourceId}`);
      const shown = 200_000;
      return { text: text.slice(0, shown), truncated: text.length > shown };
    },

    'folders.list': async ({ path: at }) => {
      const r = await listFolders(at ?? homedir());
      return { path: r.path, folders: r.folders, ...(r.parent ? { parent: r.parent } : {}) };
    },

    'workspace.list': async ({ projectId, dir }) => listDir(await this.#workspace(projectId), dir),

    'workspace.read': async ({ projectId, path }) => readText(await this.#workspace(projectId), path),

    'workspace.write': async ({ projectId, path, content, baseVersion }) => writeText(await this.#workspace(projectId), path, content, baseVersion),

    'place.get': async () => this.#place.get(),

    'place.set': async (change) => this.#place.set(change),

    'drafts.list': async ({ projectId }) => {
      await this.#project(projectId);
      return this.#profile().drafts.list(projectId);
    },

    'drafts.set': async ({ projectId, path, content, baseVersion }) => {
      await this.#project(projectId);
      const open = this.#profile();
      await open.drafts.set(projectId, path, content, baseVersion, open.profile.journal.now().toISOString());
      return { saved: true };
    },

    'agent.status': async () => this.#profile().agents.status,

    'agent.check': async () => this.#profile().agents.check(this.#loginWaitMs),

    'ask.cancel': async ({ askId }) => {
      const cancel = this.#asks.get(askId);
      if (!cancel) throw new AppError('not_found', `no running question ${askId}`);
      await cancel();
      return { ok: true };
    },
  };

  /**
   * Probes in a form the learner just answered are scored by the app (P3): the form is taken
   * from the saved conversation, not from the learner's app, and each answer is checked before
   * it is read. Evidence is recorded once per question. Returns a note for the tutor.
   */
  async #scoreProbes(open: OpenState, projectId: string, earlier: readonly TranscriptEntry[], answers: NonNullable<z.output<typeof askInput>['answers']>): Promise<string> {
    const form = earlier.filter((e) => e.t === 'event' && e.askId === answers.askId && e.event.kind === 'form').map((e) => (e as { event: { form: LearnerForm } }).event.form)[answers.form];
    if (!form) return '';
    const { observations, journal } = open.profile;
    const lines: string[] = [];
    for (const question of form.questions) {
      if (!question.probe) continue;
      const parsed = formAnswer.safeParse(answers.values[question.id]);
      const outcome = parsed.success ? scoreProbe(question, parsed.data) : undefined;
      if (outcome === undefined) continue;
      const itemId = `probe/${answers.askId.slice(0, 36)}/${question.id}`;
      if (journal.events.some((e) => e.type === 'evidence' && e.itemId === itemId)) continue;
      const selfRating = question.kind === 'scale';
      await observations.recordEvidence({
        author: SYSTEM,
        itemId,
        projectId,
        kcs: question.probe.kcs.map((kc) => ({ kc, weight: 1 })),
        difficulty: difficultyFromLevel(question.probe.difficulty),
        evidenceType: selfRating ? 'self-rating' : 'probe',
        outcome,
      });
      lines.push(`- [${question.id}] ${selfRating ? `self-rating ${Math.round(outcome * 4) + 1}/5 (a prior only)` : outcome === 1 ? 'right' : outcome === 0 ? 'wrong' : `${Math.round(outcome * 100)}% right`}`);
    }
    if (lines.length === 0) return '';
    this.#emit('changed', { what: 'learner' });
    return `<scored-by-the-app>\nThe app scored these probes and recorded the evidence; do not record them again:\n${lines.join('\n')}\n</scored-by-the-app>`;
  }

  async #workspace(projectId: string): Promise<string> {
    const project = await this.#project(projectId);
    if (!project.workspace) throw new AppError('conflict', 'This project has no workspace folder. Set one in the project settings.');
    return project.workspace;
  }

  async #project(projectId: string): Promise<ProjectDTO> {
    const project = (await this.#handlers['projects.list']({})).find((p) => p.id === projectId);
    if (!project) throw new AppError('not_found', `no project ${projectId}`);
    return project;
  }

  #emitMany(whats: readonly ServerEvents['changed']['what'][]): void {
    for (const what of whats) this.#emit('changed', { what });
  }

  #changedAll(): void {
    for (const what of ['lessons', 'history', 'learner', 'projects', 'reviews', 'hints'] as const) this.#emit('changed', { what });
  }
}

/** A test command that can never run is refused when it is set, not when it is first run. */
function checkTestCommand(command: string | undefined): void {
  if (!command) return;
  try {
    splitCommand(command);
  } catch (err) {
    throw new AppError('invalid_params', (err as Error).message);
  }
}

const sourceDTO = (id: string, e: SourceEntry): SourceDTO => ({
  id,
  name: e.name,
  kind: e.kind,
  size: e.size,
  chars: e.chars,
  addedAt: e.addedAt,
  ...(e.pages !== undefined ? { pages: e.pages } : {}),
  ...(e.note ? { note: e.note } : {}),
});

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
