import { spawn, type ChildProcess } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { Readable, Writable } from 'node:stream';
import * as acp from '@agentclientprotocol/sdk';
import type {
  ContentBlock,
  InitializeResponse,
  RequestPermissionRequest,
  SessionNotification,
  StopReason,
} from '@agentclientprotocol/sdk';
import { decidePermission, isInsideRoots, toResponse, type Decision, type SessionScope } from './policy.ts';
import type { AgentSpec, SessionOptions } from './agents.ts';

/** Normalised events the UI consumes. */
export type HostEvent =
  | { readonly kind: 'text'; readonly text: string }
  | { readonly kind: 'thought'; readonly text: string }
  | { readonly kind: 'tool'; readonly id: string; readonly title?: string; readonly status?: string; readonly toolKind?: string }
  | { readonly kind: 'permission'; readonly title: string; readonly decision: Decision }
  | { readonly kind: 'blocked-fs'; readonly op: 'read' | 'write'; readonly path: string }
  | { readonly kind: 'stop'; readonly reason: StopReason };

/**
 * Why the agent could not do what was asked, in terms the learner can act on: the agent is
 * not installed (or cannot start), it is not logged in, it stopped, or something else.
 */
export type AgentProblem = 'missing' | 'login' | 'stopped' | 'other';

export class AgentHostError extends Error {
  override readonly name = 'AgentHostError';
  readonly problem: AgentProblem;
  constructor(message: string, problem: AgentProblem = 'other') {
    super(message);
    this.problem = problem;
  }
}

/** ACP's "authentication required" error code. */
const AUTH_REQUIRED = acp.RequestError.authRequired().code;

/** Map any failure from starting or talking to the agent to a problem the learner can act on. */
export function agentProblem(err: unknown): AgentProblem {
  if (err instanceof AgentHostError) return err.problem;
  if (err instanceof acp.RequestError && err.code === AUTH_REQUIRED) return 'login';
  const code = (err as { code?: unknown } | null)?.code;
  if (code === AUTH_REQUIRED) return 'login';
  if (code === 'ENOENT' || code === 'EACCES' || code === 'MODULE_NOT_FOUND') return 'missing';
  return 'other';
}

/**
 * Who the agent is logged in as, reduced to what the app shows: the kind ("none" = not logged
 * in) and a label such as "Claude Pro". Never an email or an organisation (P5).
 */
export interface AuthStatus {
  readonly kind: string;
  readonly label: string;
}

/** The Claude adapter pushes its login state on this extension notification (`_meta.authStatus`). */
export const AUTH_STATUS_METHOD = '_auth/status_update';

function parseAuthStatus(params: unknown): AuthStatus | undefined {
  const a = (params as { authStatus?: { kind?: unknown; label?: unknown } } | null)?.authStatus;
  if (typeof a?.kind !== 'string') return undefined;
  return { kind: a.kind.slice(0, 40), label: typeof a.label === 'string' ? a.label.slice(0, 80) : a.kind.slice(0, 40) };
}

interface SessionEntry {
  readonly scope: SessionScope;
  readonly listeners: Set<(e: HostEvent) => void>;
}

/**
 * The app's side of ACP. Spawns (or connects to) an agent, answers every permission and
 * file-system request with the app's policy, and turns session updates into HostEvents.
 */
export class AgentHost {
  readonly #sessions = new Map<string, SessionEntry>();
  readonly #spec: AgentSpec | undefined;
  #connection: acp.ClientConnection | undefined;
  #child: ChildProcess | undefined;
  #init: InitializeResponse | undefined;
  #auth: AuthStatus | undefined;
  readonly #authListeners = new Set<(s: AuthStatus) => void>();

  private constructor(spec?: AgentSpec) {
    this.#spec = spec;
  }

  /**
   * Start an agent process and connect to it over stdio. A program that is not installed, or a
   * process that dies before answering, rejects with an {@link AgentHostError} saying which.
   */
  static async spawn(spec: AgentSpec): Promise<AgentHost> {
    let launch;
    try {
      launch = spec.launch();
    } catch (err) {
      throw new AgentHostError(`${spec.displayName} could not be found: ${(err as Error).message}`, agentProblem(err) === 'missing' ? 'missing' : 'other');
    }
    const child = spawn(launch.command, [...launch.args], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, ...launch.env },
    });
    const host = new AgentHost(spec);
    host.#child = child;
    child.stderr?.resume(); // agent logs are not protocol traffic
    // Without a listener, a failed spawn (e.g. ENOENT) is an uncaught exception that takes the
    // whole core down. It becomes a rejection of whatever is waiting instead.
    const failed = new Promise<never>((_, reject) => {
      child.once('error', (err: NodeJS.ErrnoException) => {
        const e = new AgentHostError(`${spec.displayName} could not be started (${err.code ?? err.message}). Is it installed?`, agentProblem(err) === 'missing' ? 'missing' : 'other');
        host.#connection?.close(e);
        reject(e);
      });
      child.once('exit', (code, signal) => {
        const e = new AgentHostError(`${spec.displayName} stopped (${signal ?? `exit code ${code}`})`, 'stopped');
        host.#connection?.close(e);
        reject(e);
      });
    });
    failed.catch(() => undefined); // only awaited during start-up
    const stream = acp.ndJsonStream(
      Writable.toWeb(child.stdin!) as WritableStream<Uint8Array>,
      Readable.toWeb(child.stdout!) as ReadableStream<Uint8Array>,
    );
    host.#connection = host.#app().connect(stream);
    try {
      await Promise.race([host.#initialize(), failed]);
    } catch (err) {
      // The connection usually closes a moment before the process says why: wait briefly for it.
      const reason = await Promise.race([failed.catch((e: unknown) => e), new Promise((r) => setTimeout(r, 250))]);
      await host.close();
      if (reason instanceof AgentHostError) throw reason;
      throw new AgentHostError(`${spec.displayName} did not start: ${(err as Error).message}`, agentProblem(err));
    }
    return host;
  }

  /** Connect to an in-process agent (tests, embedded agents). */
  static async inProcess(agent: acp.AgentApp, spec?: AgentSpec): Promise<AgentHost> {
    const host = new AgentHost(spec);
    host.#connection = host.#app().connect(agent);
    await host.#initialize();
    return host;
  }

  /** What the agent reported at initialisation (both factories initialise before returning). */
  get agentInfo(): InitializeResponse {
    return this.#init!;
  }

  /** The agent's login, if it reports one (undefined: not reported, which is not "logged out"). */
  get authStatus(): AuthStatus | undefined {
    return this.#auth;
  }

  /** Be told when the agent's login changes. Returns an unsubscribe function. */
  onAuthStatus(listener: (s: AuthStatus) => void): () => void {
    this.#authListeners.add(listener);
    return () => void this.#authListeners.delete(listener);
  }

  /** Open a session. `scope` is enforced on every request the agent makes in it. */
  async newSession(opts: SessionOptions, scope: SessionScope): Promise<string> {
    const meta = this.#spec?.sessionMeta(opts);
    const res = await this.#ctx().request(acp.methods.agent.session.new, {
      cwd: opts.cwd,
      additionalDirectories: [...opts.additionalDirectories],
      mcpServers: [...opts.mcpServers],
      ...(meta === undefined ? {} : { _meta: meta }),
    });
    this.#sessions.set(res.sessionId, { scope, listeners: new Set() });
    return res.sessionId;
  }

  /** Whether the agent can pick up a session from an earlier run (ACP `sessionCapabilities.resume`). */
  get canResume(): boolean {
    return this.#init?.agentCapabilities?.sessionCapabilities?.resume != null;
  }

  /**
   * Reopen a session from an earlier run of the agent, with its memory (the agent keeps its own
   * transcript). The options are the session's, as when it was created; `scope` is enforced
   * again. Rejects when the agent cannot resume it (unknown id, no support): start a new one.
   */
  async resumeSession(sessionId: string, opts: SessionOptions, scope: SessionScope): Promise<void> {
    if (!this.canResume) throw new AgentHostError('this agent cannot resume sessions');
    const meta = this.#spec?.sessionMeta(opts);
    await this.#ctx().request(acp.methods.agent.session.resume, {
      sessionId,
      cwd: opts.cwd,
      additionalDirectories: [...opts.additionalDirectories],
      mcpServers: [...opts.mcpServers],
      ...(meta === undefined ? {} : { _meta: meta }),
    });
    this.#sessions.set(sessionId, { scope, listeners: new Set() });
  }

  /** Send a prompt; events stream to `onEvent` until the turn stops. */
  async prompt(sessionId: string, prompt: string | ContentBlock[], onEvent: (e: HostEvent) => void): Promise<StopReason> {
    const entry = this.#entry(sessionId);
    entry.listeners.add(onEvent);
    try {
      const blocks: ContentBlock[] = typeof prompt === 'string' ? [{ type: 'text', text: prompt }] : prompt;
      const res = await this.#ctx().request(acp.methods.agent.session.prompt, { sessionId, prompt: blocks });
      // The SDK resolves responses synchronously but dispatches notifications through an async
      // handler chain, so updates sent just before the response may still be in flight. They
      // were already read from the stream, and their handlers only await microtasks: one
      // macrotask turn lets them all land before we report the stop.
      await new Promise<void>((resolve) => setImmediate(resolve));
      onEvent({ kind: 'stop', reason: res.stopReason });
      return res.stopReason;
    } finally {
      entry.listeners.delete(onEvent);
    }
  }

  async cancel(sessionId: string): Promise<void> {
    this.#entry(sessionId);
    await this.#ctx().notify(acp.methods.agent.session.cancel, { sessionId });
  }

  async close(): Promise<void> {
    this.#connection?.close();
    const child = this.#child;
    if (child && child.exitCode === null && child.signalCode === null) {
      const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
      child.kill();
      await exited;
    }
  }

  #ctx(): acp.ClientContext {
    return this.#connection!.agent;
  }

  #entry(sessionId: string): SessionEntry {
    const entry = this.#sessions.get(sessionId);
    if (!entry) throw new AgentHostError(`unknown session ${sessionId}`);
    return entry;
  }

  #emit(sessionId: string, event: HostEvent): void {
    this.#sessions.get(sessionId)?.listeners.forEach((l) => l(event));
  }

  async #initialize(): Promise<void> {
    this.#init = await this.#ctx().request(acp.methods.agent.initialize, {
      protocolVersion: acp.PROTOCOL_VERSION,
      // Reads are served (scoped); writes are advertised so agents route them to us
      // instead of the disk, where they are refused.
      clientCapabilities: { fs: { readTextFile: true, writeTextFile: true }, terminal: false },
    });
  }

  #app(): acp.ClientApp {
    return acp
      .client({ name: 'app-agent-host' })
      .onRequest(acp.methods.client.session.requestPermission, async ({ params }) => this.#onPermission(params))
      .onRequest(acp.methods.client.fs.readTextFile, async ({ params }) => {
        const entry = this.#entry(params.sessionId);
        if (!(await isInsideRoots(params.path, entry.scope.readRoots))) {
          this.#emit(params.sessionId, { kind: 'blocked-fs', op: 'read', path: params.path });
          throw acp.RequestError.invalidParams({ path: params.path }, 'path is outside the readable roots');
        }
        const text = await readFile(params.path, 'utf8');
        const lines = text.split('\n');
        const start = params.line ? params.line - 1 : 0;
        const end = params.limit ? start + params.limit : undefined;
        return { content: lines.slice(start, end).join('\n') };
      })
      .onRequest(acp.methods.client.fs.writeTextFile, async ({ params }) => {
        this.#entry(params.sessionId);
        this.#emit(params.sessionId, { kind: 'blocked-fs', op: 'write', path: params.path });
        throw acp.RequestError.invalidParams(
          { path: params.path },
          'this app never lets the agent write files; use the teaching tools to propose changes',
        );
      })
      .onNotification(acp.methods.client.session.update, async ({ params }) => this.#onUpdate(params))
      .onNotification(AUTH_STATUS_METHOD, (p: unknown) => p, async ({ params }) => {
        const status = parseAuthStatus(params);
        if (!status) return;
        this.#auth = status;
        this.#authListeners.forEach((l) => l(status));
      });
  }

  async #onPermission(params: RequestPermissionRequest) {
    const entry = this.#entry(params.sessionId);
    const decision = await decidePermission(params, entry.scope);
    this.#emit(params.sessionId, { kind: 'permission', title: params.toolCall.title ?? params.toolCall.toolCallId, decision });
    return toResponse(decision, params.options);
  }

  #onUpdate(n: SessionNotification): void {
    const u = n.update;
    switch (u.sessionUpdate) {
      case 'agent_message_chunk':
      case 'agent_thought_chunk':
        if (u.content.type === 'text') {
          this.#emit(n.sessionId, { kind: u.sessionUpdate === 'agent_message_chunk' ? 'text' : 'thought', text: u.content.text });
        }
        return;
      case 'tool_call':
      case 'tool_call_update':
        this.#emit(n.sessionId, {
          kind: 'tool',
          id: u.toolCallId,
          ...(u.title ? { title: u.title } : {}),
          ...(u.status ? { status: u.status } : {}),
          ...(u.kind ? { toolKind: u.kind } : {}),
        });
        return;
      default:
        return;
    }
  }
}
