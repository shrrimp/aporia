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

export class AgentHostError extends Error {
  override readonly name = 'AgentHostError';
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

  private constructor(spec?: AgentSpec) {
    this.#spec = spec;
  }

  /** Start an agent process and connect to it over stdio. */
  static async spawn(spec: AgentSpec): Promise<AgentHost> {
    const launch = spec.launch();
    const child = spawn(launch.command, [...launch.args], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, ...launch.env },
    });
    const host = new AgentHost(spec);
    host.#child = child;
    child.stderr?.resume(); // agent logs are not protocol traffic
    const stream = acp.ndJsonStream(
      Writable.toWeb(child.stdin!) as WritableStream<Uint8Array>,
      Readable.toWeb(child.stdout!) as ReadableStream<Uint8Array>,
    );
    host.#connection = host.#app().connect(stream);
    child.once('exit', () => host.#connection?.close(new AgentHostError('agent process exited')));
    await host.#initialize();
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
      .onNotification(acp.methods.client.session.update, async ({ params }) => this.#onUpdate(params));
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
