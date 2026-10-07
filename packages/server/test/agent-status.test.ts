import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AgentHost, AgentHostError, genericAgent, type AgentSpec } from '@app/agent-host';
import { ManualClock } from '@app/core';
import { AppService, type HostFactory } from '../src/index.ts';
import { loginHelp } from '../src/agent-sessions.ts';
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

async function start(hostFactory: HostFactory) {
  app = new AppService({ dataRoot: root, clock: new ManualClock('2026-10-06T10:00:00.000Z'), agent: spec, hostFactory });
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
