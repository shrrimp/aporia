import { randomUUID } from 'node:crypto';
import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { AgentHostError, agentProblem, type AgentHost, type AgentSpec, type AuthStatus, type HostEvent } from '@app/agent-host';
import { Mutex, resolveInside, writeJsonAtomic, type OpenProfile } from '@app/core';
import { systemPrompt, type Registration, type TeacherHttpServer } from '@app/teacher-mcp';
import { brand } from '@app/brand';
import type { LearnerForm } from '@app/catalog';
import type { AgentStatusDTO, ProfileDTO, ProjectDTO } from './protocol.ts';

/** Everything a turn can produce for the UI: the agent's own events, plus forms shown via the teaching tools. */
export type TurnEvent = HostEvent | { readonly kind: 'form'; readonly form: LearnerForm };

export type HostFactory = (spec: AgentSpec) => Promise<AgentHost>;

/** How long a turn may go without a word from the agent before the app stops it. */
export interface TurnLimits {
  /** While it thinks or writes. */
  readonly quietMs: number;
  /** While one of its tools runs: a test run takes up to 5 minutes (teacher-mcp `measure`). */
  readonly toolMs: number;
  /** How long a stopped turn has to end before the agent is closed as hung. */
  readonly stopMs: number;
}

const TURN_LIMITS: TurnLimits = { quietMs: 3 * 60_000, toolMs: 6 * 60_000, stopMs: 15_000 };

interface Live {
  /** The agent the session lives in: any other agent, such as one started since, does not know it. */
  readonly host: AgentHost;
  readonly sessionId: string;
  readonly reg: Registration;
  /** Where forms from `ask_learner` go during the current turn. */
  sink: ((e: TurnEvent) => void) | undefined;
}

/** A conversation's agent session, remembered so a restart resumes it rather than starting over. */
const savedSession = z.strictObject({
  agent: z.string(),
  sessionId: z.string(),
  /** Who the session's changes are attributed to in the journal. */
  actor: z.string(),
  cwd: z.string(),
});
const savedSessions = z.record(z.string(), savedSession);
type SavedSession = z.output<typeof savedSession>;

/**
 * Owns the agent process and its sessions for the open profile. Session lifetime follows the
 * learner's setting (D18): one per question, per lesson, or one permanent session per project.
 */
export class AgentSessions {
  readonly #spec: AgentSpec;
  readonly #factory: HostFactory;
  readonly #teacher: TeacherHttpServer;
  readonly #profile: OpenProfile;
  readonly #settings: () => ProfileDTO['settings'];
  #host: Promise<AgentHost> | undefined;
  /** Bumped each time the agent is replaced: a failure in an earlier one says nothing about the current one. */
  #generation = 0;
  readonly #live = new Map<string, Live>();
  readonly #saved = new Mutex();
  readonly #onStatus: (s: AgentStatusDTO) => void;
  readonly #limits: TurnLimits;
  #status: AgentStatusDTO;

  constructor(
    spec: AgentSpec,
    factory: HostFactory,
    teacher: TeacherHttpServer,
    profile: OpenProfile,
    settings: () => ProfileDTO['settings'],
    onStatus: (s: AgentStatusDTO) => void,
    limits: Partial<TurnLimits> = {},
  ) {
    this.#spec = spec;
    this.#factory = factory;
    this.#teacher = teacher;
    this.#profile = profile;
    this.#settings = settings;
    this.#onStatus = onStatus;
    this.#limits = { ...TURN_LIMITS, ...limits };
    this.#status = { agent: spec.displayName, state: 'unknown' };
  }

  get status(): AgentStatusDTO {
    return this.#status;
  }

  #setStatus(next: Omit<AgentStatusDTO, 'agent'>): void {
    const s: AgentStatusDTO = { agent: this.#spec.displayName, ...next };
    if (JSON.stringify(s) === JSON.stringify(this.#status)) return;
    this.#status = s;
    this.#onStatus(s);
  }

  /** The agent's login, as it reported it: "none" means logged out. */
  #fromAuth(auth: AuthStatus | undefined): Omit<AgentStatusDTO, 'agent'> {
    if (auth?.kind === 'none') return { state: 'login', message: loginHelp(this.#spec) };
    return { state: 'ready', ...(auth ? { account: auth.label } : {}) };
  }

  #failed(err: unknown): void {
    const problem = agentProblem(err);
    const message = (err as Error)?.message ?? String(err);
    if (problem === 'login') this.#setStatus({ state: 'login', message: loginHelp(this.#spec) });
    else if (problem === 'missing') this.#setStatus({ state: 'missing', message });
    else if (problem === 'stopped') {
      // Start a fresh agent next time; its sessions died with it.
      this.#reset();
      this.#setStatus({ state: 'stopped', message });
    }
    else this.#setStatus({ state: 'error', message });
  }

  /**
   * Start the agent (if needed) and report whether it can teach: installed, running, and logged
   * in. An agent that reports its login (the Claude adapter does, shortly after starting) is
   * given a few seconds to say so; otherwise the login is known at the first question.
   */
  async check(waitForLoginMs = 6000): Promise<AgentStatusDTO> {
    if (this.#status.state === 'stopped' || this.#status.state === 'error' || this.#status.state === 'missing') this.#reset();
    this.#setStatus({ state: 'starting' });
    let host: AgentHost;
    try {
      host = await this.#hostOnce();
    } catch (err) {
      this.#failed(err);
      return this.#status;
    }
    const reports = (host.agentInfo.agentCapabilities?._meta as { authStatus?: unknown } | undefined)?.authStatus !== undefined;
    if (reports && host.authStatus === undefined) {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(done, waitForLoginMs);
        const off = host.onAuthStatus(done);
        function done() {
          clearTimeout(timer);
          off();
          resolve();
        }
      });
    }
    this.#setStatus(this.#fromAuth(host.authStatus));
    return this.#status;
  }

  #key(project: ProjectDTO, lessonId: string | undefined, thread: 'chat' | 'session'): string | undefined {
    const mode = this.#settings().sessionMode;
    if (mode === 'interaction') return undefined;
    if (thread === 'session') return `${project.id}/~session`;
    switch (mode) {
      case 'lesson':
        return `${project.id}/${lessonId ?? '-'}`;
      case 'permanent':
        return project.id;
    }
  }

  async #hostOnce(): Promise<AgentHost> {
    this.#host ??= this.#factory(this.#spec).then(
      (host) => {
        // Logging in or out in a terminal while the app runs updates the status.
        host.onAuthStatus((a) => this.#setStatus(this.#fromAuth(a)));
        return host;
      },
      (err: unknown) => {
        this.#host = undefined;
        throw err;
      },
    );
    return this.#host;
  }

  /**
   * Stop the agent and forget its sessions: the next question starts a new agent, which resumes
   * the saved sessions. The old agent is stopped, not left running beside the new one.
   */
  #reset(): void {
    const old = this.#host;
    this.#host = undefined;
    this.#generation++;
    for (const l of this.#live.values()) l.reg.revoke();
    this.#live.clear();
    void old?.then((h) => h.close()).catch(() => undefined);
  }

  get #sessionsFile(): string {
    return path.join(this.#profile.dir, 'agent-sessions.json');
  }

  async #readSaved(): Promise<Record<string, SavedSession>> {
    try {
      const parsed = savedSessions.safeParse(JSON.parse(await readFile(this.#sessionsFile, 'utf8')));
      return parsed.success ? parsed.data : {};
    } catch {
      return {};
    }
  }

  #remember(key: string, s: SavedSession | undefined): Promise<void> {
    return this.#saved.run(async () => {
      const all = await this.#readSaved();
      if (s) all[key] = s;
      else delete all[key];
      await writeJsonAtomic(this.#sessionsFile, all);
    });
  }

  /**
   * Open the agent session for a conversation: the one from an earlier run when the agent can
   * resume it (it keeps its memory, including a turn cut off by a crash), else a new one.
   * `resumed` says which: a new session needs a recap of the conversation.
   */
  async #open(host: AgentHost, project: ProjectDTO, key: string | undefined): Promise<Live & { resumed: boolean }> {
    const earlier = key ? (await this.#readSaved())[key] : undefined;
    // Code projects run in their workspace; others in their own project folder.
    const cwd = project.workspace ?? resolveInside(this.#profile.dir, 'projects', project.id);
    await mkdir(cwd, { recursive: true });
    const canResume = earlier !== undefined && earlier.agent === this.#spec.id && earlier.cwd === cwd && host.canResume;
    const actor = canResume ? earlier.actor : randomUUID();
    const live: { sink: Live['sink'] } = { sink: undefined };
    const reg = this.#teacher.register({
      profile: this.#profile,
      projectId: project.id,
      agent: { kind: 'agent', agent: this.#spec.id, session: actor },
      changeMode: () => this.#settings().changeMode,
      present: (form) => live.sink?.({ kind: 'form', form }),
    });
    const opts = { cwd, additionalDirectories: [], mcpServers: [reg.acpServer], systemPrompt: systemPrompt() };
    const scope = { readRoots: [cwd], trustedMcpServers: [brand.id] };
    try {
      if (canResume) {
        try {
          await host.resumeSession(earlier.sessionId, opts, scope);
          return Object.assign(live, { host, sessionId: earlier.sessionId, reg, resumed: true });
        } catch {
          // The agent no longer has it (deleted, another machine): start over with a recap.
        }
      }
      const sessionId = await host.newSession(opts, scope);
      if (key) await this.#remember(key, { agent: this.#spec.id, sessionId, actor, cwd });
      return Object.assign(live, { host, sessionId, reg, resumed: false });
    } catch (err) {
      reg.revoke();
      throw err;
    }
  }

  /** Run one learner question through the agent. */
  async ask(
    project: ProjectDTO,
    lessonId: string | undefined,
    thread: 'chat' | 'session',
    prompt: string,
    onEvent: (e: TurnEvent) => void,
    onStart: (cancel: () => Promise<void>) => void,
    /** For a reused conversation whose agent session is new (e.g. after a restart): what was said before. */
    recap?: () => string | undefined,
  ): Promise<string> {
    const key = this.#key(project, lessonId, thread);
    const generation = this.#generation;
    try {
      return await this.#ask(project, key, prompt, onEvent, onStart, recap);
    } catch (err) {
      if (generation === this.#generation) this.#failed(err);
      if (agentProblem(err) === 'login') throw new Error(loginHelp(this.#spec));
      if (agentProblem(err) === 'missing') throw new Error(`${this.#spec.displayName} could not be started, so your tutor cannot answer. ${(err as Error).message}`);
      throw err;
    }
  }

  /**
   * One turn the app asks for itself (e.g. writing review questions), in a session of its own
   * that ends with it. Nothing of it is shown in a conversation.
   */
  async background(project: ProjectDTO, prompt: string): Promise<string> {
    const generation = this.#generation;
    try {
      return await this.#ask(project, undefined, prompt, () => undefined, () => undefined);
    } catch (err) {
      if (generation === this.#generation) this.#failed(err);
      throw err;
    }
  }

  async #ask(
    project: ProjectDTO,
    key: string | undefined,
    prompt: string,
    onEvent: (e: TurnEvent) => void,
    onStart: (cancel: () => Promise<void>) => void,
    recap?: () => string | undefined,
  ): Promise<string> {
    const host = await this.#hostOnce();
    let live = key ? this.#live.get(key) : undefined;
    if (live && live.host !== host) {
      // Opened in an agent that has been replaced since: open it again in this one.
      live.reg.revoke();
      this.#live.delete(key!);
      live = undefined;
    }
    if (!live) {
      const opened = await this.#open(host, project, key);
      live = opened;
      if (key) {
        this.#live.set(key, opened);
        const earlier = opened.resumed ? undefined : recap?.();
        if (earlier) prompt = `${earlier}\n\n${prompt}`;
      }
    }
    const sessionId = live.sessionId;
    onStart(() => host.cancel(sessionId));
    const watch = watchTurn(this.#limits, this.#spec.displayName, () => host.cancel(sessionId));
    const events = (e: TurnEvent) => {
      if (watch.seen(e)) onEvent(e);
    };
    live.sink = events;
    try {
      const stop = await Promise.race([host.prompt(sessionId, prompt, events), watch.stuck]);
      // Stopped for its silence, not by the learner: the question ends saying why.
      if (watch.quiet && stop === 'cancelled') throw watch.quiet;
      if (this.#status.state !== 'ready') this.#setStatus(this.#fromAuth(host.authStatus));
      return stop;
    } finally {
      watch.done();
      live.sink = undefined;
      if (!key) live.reg.revoke();
    }
  }

  async close(): Promise<void> {
    for (const l of this.#live.values()) l.reg.revoke();
    this.#live.clear();
    const host = this.#host;
    this.#host = undefined;
    if (host) await (await host.catch(() => undefined))?.close();
  }
}

/**
 * Watch a turn for silence. An agent that says nothing for too long (stuck refreshing its login,
 * retrying an overloaded service) is asked to stop, and `quiet` says why the question ended. One
 * that does not stop either is hung: `stuck` rejects, and the agent is closed.
 */
function watchTurn(limits: TurnLimits, agent: string, cancel: () => Promise<void>) {
  const tools = new Set<string>();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let over = false;
  let hung!: (err: AgentHostError) => void;
  const watch = {
    quiet: undefined as AgentHostError | undefined,
    stuck: new Promise<never>((_, reject) => (hung = reject)),
    /** Note an event; false once the turn is over (a hung agent may still talk, to nobody). */
    seen(e: TurnEvent): boolean {
      if (over) return false;
      if (e.kind === 'tool') {
        if (e.status === 'completed' || e.status === 'failed') tools.delete(e.id);
        else tools.add(e.id);
      }
      if (!watch.quiet) arm();
      return true;
    },
    done(): void {
      over = true;
      clearTimeout(timer);
    },
  };
  function arm(): void {
    clearTimeout(timer);
    const ms = tools.size > 0 ? limits.toolMs : limits.quietMs;
    timer = setTimeout(() => {
      watch.quiet = new AgentHostError(`${agent} said nothing for ${duration(ms)}, so the question was stopped. Ask again.`);
      void cancel().catch(() => undefined);
      timer = setTimeout(
        () => hung(new AgentHostError(`${agent} said nothing for ${duration(ms)} and did not stop when asked, so it was closed. Ask again to start it afresh.`, 'stopped')),
        limits.stopMs,
      );
    }, ms);
  }
  arm();
  return watch;
}

function duration(ms: number): string {
  const [n, unit] = ms >= 60_000 ? [Math.round(ms / 60_000), 'minute'] : [Math.round(ms / 1000), 'second'];
  return `${n} ${unit}${n === 1 ? '' : 's'}`;
}

/** What to do when the agent is not logged in. The app never handles the login itself (architecture §1). */
export function loginHelp(spec: Pick<AgentSpec, 'id' | 'displayName'>): string {
  const how = spec.id === 'claude' ? 'Open a terminal, run `claude`, type `/login` and follow the steps' : `Log in to ${spec.displayName} the way its documentation describes`;
  return `${spec.displayName} is not logged in, so your tutor cannot answer. ${how}; then come back and try again.`;
}

/** The prompt sent for one question: the question plus where it was asked. */
export function buildAskPrompt(q: {
  question: string;
  lessonId?: string | undefined;
  anchor?: string | undefined;
  selection?: string | undefined;
  /** "chat": asked beside a lesson, so the answer hands back to it. */
  thread?: 'chat' | 'session' | undefined;
}): string {
  const ctx: string[] = [];
  if (q.lessonId) ctx.push(`Lesson: ${q.lessonId}${q.anchor ? ` (at ${q.anchor})` : ''}`);
  if (q.lessonId && q.thread === 'chat') {
    ctx.push('Asked from the lesson: help, then send the learner back to it with a #lesson: link. Practice goes in the lesson (add_to_lesson), not in the chat.');
  }
  if (q.selection) ctx.push(`The learner selected this passage:\n"""\n${q.selection}\n"""`);
  return [
    'If you have not yet called get_teaching_context in this session, call it first.',
    ctx.length ? `<context>\n${ctx.join('\n')}\n</context>` : '',
    `The learner asks:\n${q.question}`,
  ]
    .filter(Boolean)
    .join('\n\n');
}
