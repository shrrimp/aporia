import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import type { AgentHost, AgentSpec, HostEvent } from '@app/agent-host';
import { resolveInside, type OpenProfile } from '@app/core';
import { systemPrompt, type Registration, type TeacherHttpServer } from '@app/teacher-mcp';
import { brand } from '@app/brand';
import type { LearnerForm } from '@app/catalog';
import type { ProfileDTO, ProjectDTO } from './protocol.ts';

/** Everything a turn can produce for the UI: the agent's own events, plus forms shown via the teaching tools. */
export type TurnEvent = HostEvent | { readonly kind: 'form'; readonly form: LearnerForm };

export type HostFactory = (spec: AgentSpec) => Promise<AgentHost>;

interface Live {
  readonly sessionId: string;
  readonly reg: Registration;
  /** Where forms from `ask_learner` go during the current turn. */
  sink: ((e: TurnEvent) => void) | undefined;
}

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
  readonly #live = new Map<string, Live>();

  constructor(spec: AgentSpec, factory: HostFactory, teacher: TeacherHttpServer, profile: OpenProfile, settings: () => ProfileDTO['settings']) {
    this.#spec = spec;
    this.#factory = factory;
    this.#teacher = teacher;
    this.#profile = profile;
    this.#settings = settings;
  }

  #key(project: ProjectDTO, lessonId: string | undefined): string | undefined {
    switch (this.#settings().sessionMode) {
      case 'interaction':
        return undefined;
      case 'lesson':
        return `${project.id}/${lessonId ?? '-'}`;
      case 'permanent':
        return project.id;
    }
  }

  async #hostOnce(): Promise<AgentHost> {
    this.#host ??= this.#factory(this.#spec).catch((err: unknown) => {
      this.#host = undefined;
      throw err;
    });
    return this.#host;
  }

  async #open(project: ProjectDTO): Promise<Live> {
    const host = await this.#hostOnce();
    const session = randomUUID();
    const live: { sink: Live['sink'] } = { sink: undefined };
    const reg = this.#teacher.register({
      profile: this.#profile,
      projectId: project.id,
      agent: { kind: 'agent', agent: this.#spec.id, session },
      changeMode: () => this.#settings().changeMode,
      present: (form) => live.sink?.({ kind: 'form', form }),
    });
    // Code projects run in their workspace; others in their own project folder.
    const cwd = project.workspace ?? resolveInside(this.#profile.dir, 'projects', project.id);
    await mkdir(cwd, { recursive: true });
    const sessionId = await host.newSession(
      { cwd, additionalDirectories: [], mcpServers: [reg.acpServer], systemPrompt: systemPrompt() },
      { readRoots: [cwd], trustedMcpServers: [brand.id] },
    );
    return Object.assign(live, { sessionId, reg });
  }

  /** Run one learner question through the agent. */
  async ask(
    project: ProjectDTO,
    lessonId: string | undefined,
    prompt: string,
    onEvent: (e: TurnEvent) => void,
    onStart: (cancel: () => Promise<void>) => void,
  ): Promise<string> {
    const key = this.#key(project, lessonId);
    let live = key ? this.#live.get(key) : undefined;
    if (!live) {
      live = await this.#open(project);
      if (key) this.#live.set(key, live);
    }
    const host = await this.#hostOnce();
    const sessionId = live.sessionId;
    onStart(() => host.cancel(sessionId));
    live.sink = onEvent;
    try {
      return await host.prompt(sessionId, prompt, onEvent);
    } finally {
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

/** The prompt sent for one question: the question plus where it was asked. */
export function buildAskPrompt(q: {
  question: string;
  lessonId?: string | undefined;
  anchor?: string | undefined;
  selection?: string | undefined;
}): string {
  const ctx: string[] = [];
  if (q.lessonId) ctx.push(`Lesson: ${q.lessonId}${q.anchor ? ` (at ${q.anchor})` : ''}`);
  if (q.selection) ctx.push(`The learner selected this passage:\n"""\n${q.selection}\n"""`);
  return [
    'If you have not yet called get_teaching_context in this session, call it first.',
    ctx.length ? `<context>\n${ctx.join('\n')}\n</context>` : '',
    `The learner asks:\n${q.question}`,
  ]
    .filter(Boolean)
    .join('\n\n');
}
