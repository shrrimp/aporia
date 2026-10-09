import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AgentHost, AgentHostError, genericAgent, type AgentSpec } from '@app/agent-host';
import { ManualClock } from '@app/core';
import { AppService, type HostFactory } from '../src/index.ts';
import { loginHelp, type TurnLimits } from '../src/agent-sessions.ts';
import type { AgentStatusDTO } from '../src/protocol.ts';
import { fakeTeacherAgent } from './fake-teacher-agent.ts';

let root: string;
let app: AppService | undefined;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'agent-status-'));
});

afterEach(async () => {
  await app?.close();
  app = undefined;
  await rm(root, { recursive: true, force: true });
});

const spec = genericAgent('fake', 'Fake Tutor', { command: 'unused', args: [] });

async function start(hostFactory: HostFactory, turnLimits?: Partial<TurnLimits>) {
  app = new AppService({ dataRoot: root, clock: new ManualClock('2026-10-06T10:00:00.000Z'), agent: spec, hostFactory, ...(turnLimits ? { turnLimits } : {}) });
  const statuses: AgentStatusDTO[] = [];
  app.subscribe((e, d) => e === 'agent.status' && statuses.push(d as AgentStatusDTO));
  const p = await app.call('profiles.create', { displayName: 'Ada' });
  await app.call('profiles.open', { profileId: p.id });
  const project = await app.call('projects.create', { title: 'P', goal: 'g' });
  return { app, statuses, projectId: project.id };
}

async function askAndWait(a: AppService, projectId: string, question: string): Promise<{ event: string; data: unknown }> {
  let id = '';
  const ended = new Promise<{ event: string; data: unknown }>((resolve) =>
    a.subscribe((event, data) => (event === 'ask.done' || event === 'ask.error') && (data as { askId: string }).askId === id && resolve({ event, data })),
  );
  id = (await a.call('ask', { projectId, question })).askId;
  return ended;
}

describe('agent status', () => {
  it('is unknown until checked, then ready with the kind of login', async () => {
    const { app, statuses } = await start((s) => AgentHost.inProcess(fakeTeacherAgent(undefined, { auth: 'claude-subscription' }), s));
    expect(await app.call('agent.status', {})).toEqual({ agent: 'Fake Tutor', state: 'unknown' });
    expect(await app.call('agent.check', {})).toEqual({ agent: 'Fake Tutor', state: 'ready', account: 'Claude Pro' });
    expect(statuses.map((s) => s.state)).toEqual(['starting', 'ready']);
  });

  it('is ready without an account when the agent does not report its login', async () => {
    const { app } = await start((s) => AgentHost.inProcess(fakeTeacherAgent(), s));
    expect(await app.call('agent.check', {})).toEqual({ agent: 'Fake Tutor', state: 'ready' });
  });

  it('says how to log in, before and at the first question', async () => {
    const { app, statuses, projectId } = await start((s) => AgentHost.inProcess(fakeTeacherAgent(undefined, { auth: 'none' }), s));
    expect(await app.call('agent.check', {})).toMatchObject({ state: 'login', message: loginHelp(spec) });
    const r = await askAndWait(app, projectId, 'logged out');
    expect(r).toMatchObject({ event: 'ask.error', data: { message: expect.stringMatching(/is not logged in, so your tutor cannot answer\. Log in to Fake Tutor/) } });
    expect(statuses.at(-1)!.state).toBe('login');
    expect(loginHelp({ id: 'claude', displayName: 'Claude Code' })).toMatch(/run `claude`, type `\/login`/);
  });

  it('says the agent is missing, and checks again on request', async () => {
    let installed = false;
    const { app, projectId } = await start((s: AgentSpec) => (installed ? AgentHost.inProcess(fakeTeacherAgent(), s) : Promise.reject(new AgentHostError('Fake Tutor could not be started (ENOENT). Is it installed?', 'missing'))));
    expect(await app.call('agent.check', {})).toMatchObject({ state: 'missing', message: expect.stringMatching(/ENOENT/) });
    const r = await askAndWait(app, projectId, 'hello');
    expect(r).toMatchObject({ event: 'ask.error', data: { message: expect.stringMatching(/^Fake Tutor could not be started, so your tutor cannot answer\./) } });
    installed = true;
    expect(await app.call('agent.check', {})).toMatchObject({ state: 'ready' });
    expect(await askAndWait(app, projectId, 'hello')).toMatchObject({ event: 'ask.done' });
  });

  it('starts a new agent after it stopped', async () => {
    let spawned = 0;
    const { app, statuses, projectId } = await start(async (s) => {
      spawned++;
      const host = await AgentHost.inProcess(fakeTeacherAgent(), s);
      if (spawned === 1) host.prompt = () => Promise.reject(new AgentHostError('Fake Tutor stopped (exit code 1)', 'stopped'));
      return host;
    });
    expect(await askAndWait(app, projectId, 'hello')).toMatchObject({ event: 'ask.error', data: { message: 'Fake Tutor stopped (exit code 1)' } });
    expect(statuses.at(-1)).toMatchObject({ state: 'stopped' });
    expect(await askAndWait(app, projectId, 'hello')).toMatchObject({ event: 'ask.done' });
    expect(spawned).toBe(2);
    expect(statuses.at(-1)).toMatchObject({ state: 'ready' });
  });

  it('picks the conversation up in the new agent when the learner tries again after an error', async () => {
    const hosts: AgentHost[] = [];
    let closed = 0;
    const { app, projectId } = await start(async (s) => {
      const host = await AgentHost.inProcess(fakeTeacherAgent(), s);
      const close = host.close.bind(host);
      host.close = () => (closed++, close());
      hosts.push(host);
      return host;
    });
    expect(await askAndWait(app, projectId, 'hello')).toMatchObject({ event: 'ask.done' });
    expect(await askAndWait(app, projectId, 'crash')).toMatchObject({ event: 'ask.error' });
    expect(await app.call('agent.check', {})).toMatchObject({ state: 'ready' });
    expect(hosts).toHaveLength(2);
    expect(closed).toBe(1); // the replaced agent is stopped, not left running
    // The conversation's session lived in the replaced agent: it is opened again in the new one.
    expect(await askAndWait(app, projectId, 'hello again')).toMatchObject({ event: 'ask.done' });
    expect(await app.call('agent.status', {})).toMatchObject({ state: 'ready' });
  });

  it('reports other failures as errors, and a login that runs out while waiting', async () => {
    const { app, projectId } = await start((s) => AgentHost.inProcess(fakeTeacherAgent(), s));
    expect(await askAndWait(app, projectId, 'crash')).toMatchObject({ event: 'ask.error' });
    expect(await app.call('agent.status', {})).toMatchObject({ state: 'error', message: 'Internal error' });
  });

  it('stops waiting for a login report after a while', async () => {
    app = new AppService({ dataRoot: root, agent: spec, loginWaitMs: 50, hostFactory: (s) => AgentHost.inProcess(fakeTeacherAgent(undefined, { auth: 'silent' }), s) });
    const p = await app.call('profiles.create', { displayName: 'Ada' });
    await app.call('profiles.open', { profileId: p.id });
    expect(await app.call('agent.check', {})).toEqual({ agent: 'Fake Tutor', state: 'ready' });
  });
});

describe('a tutor that goes quiet', () => {
  const limits = { quietMs: 80, toolMs: 1000, stopMs: 500 };
  const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

  it('has the question stopped, saying why, and answers the next one', async () => {
    let spawned = 0;
    const { app, statuses, projectId } = await start(async (s) => {
      spawned++;
      const host = await AgentHost.inProcess(fakeTeacherAgent(), s);
      // A question about silence gets none: the turn only ends when it is cancelled.
      const prompt = host.prompt.bind(host);
      let cancelled: (() => void) | undefined;
      host.prompt = (id, p, onEvent) =>
        JSON.stringify(p).includes('silence') ? new Promise<void>((r) => (cancelled = r)).then(() => 'cancelled' as const) : prompt(id, p, onEvent);
      host.cancel = async () => cancelled?.();
      return host;
    }, limits);
    expect(await askAndWait(app, projectId, 'silence?')).toMatchObject({
      event: 'ask.error',
      data: { message: expect.stringMatching(/^Fake Tutor said nothing for \d+ seconds?, so the question was stopped\. Ask again\.$/) },
    });
    expect(statuses.at(-1)).toMatchObject({ state: 'error' });
    expect(await askAndWait(app, projectId, 'hello')).toMatchObject({ event: 'ask.done' });
    expect(spawned).toBe(1); // it stopped when asked, so it was kept
    expect(statuses.at(-1)).toMatchObject({ state: 'ready' });
  });

  it('closes a tutor that does not stop when asked, and starts a new one for the next question', async () => {
    let spawned = 0;
    let closed = 0;
    const { app, statuses, projectId } = await start(async (s) => {
      const host = await AgentHost.inProcess(fakeTeacherAgent(), s);
      if (++spawned === 1) host.prompt = () => new Promise(() => undefined); // never answers, not even a cancel
      const close = host.close.bind(host);
      host.close = () => (closed++, close());
      return host;
    }, { ...limits, stopMs: 50 });
    expect(await askAndWait(app, projectId, 'hello')).toMatchObject({
      event: 'ask.error',
      data: { message: expect.stringMatching(/did not stop when asked, so it was closed\. Ask again to start it afresh\.$/) },
    });
    expect(statuses.at(-1)).toMatchObject({ state: 'stopped' });
    expect(closed).toBe(1);
    expect(await askAndWait(app, projectId, 'hello')).toMatchObject({ event: 'ask.done' });
    expect(spawned).toBe(2);
  });

  it('shrugs off a stuck tutor that fails to cancel and to close', async () => {
    let spawned = 0;
    const { app, projectId } = await start(async (s) => {
      const host = await AgentHost.inProcess(fakeTeacherAgent(), s);
      if (++spawned === 1) {
        host.prompt = () => new Promise(() => undefined);
        host.cancel = () => Promise.reject(new Error('no answer'));
        const close = host.close.bind(host);
        host.close = () => close().then(() => Promise.reject(new Error('already gone')));
      }
      return host;
    }, { ...limits, stopMs: 50 });
    expect(await askAndWait(app, projectId, 'hello')).toMatchObject({ event: 'ask.error' });
    expect(await askAndWait(app, projectId, 'hello')).toMatchObject({ event: 'ask.done' });
    expect(spawned).toBe(2);
  });

  it('is given longer while one of its tools runs, and not after', async () => {
    const { app, projectId } = await start(async (s) => {
      const host = await AgentHost.inProcess(fakeTeacherAgent(), s);
      host.prompt = async (_id, prompt, onEvent) => {
        onEvent({ kind: 'tool', id: 't1', title: 'Run the tests', status: 'in_progress' });
        await pause(250); // longer than quietMs, well within toolMs
        onEvent({ kind: 'tool', id: 't1', status: 'completed' });
        if (JSON.stringify(prompt).includes('then think')) await pause(300); // quiet again, without a tool
        onEvent({ kind: 'stop', reason: 'end_turn' });
        return 'end_turn';
      };
      return host;
    }, { ...limits, stopMs: 50 });
    expect(await askAndWait(app, projectId, 'run the tests')).toMatchObject({ event: 'ask.done' });
    expect(await askAndWait(app, projectId, 'run the tests then think')).toMatchObject({ event: 'ask.error', data: { message: expect.stringMatching(/said nothing/) } });
  });
});
