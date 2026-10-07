import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  AgentHost,
  AgentHostError,
  agentProblem,
  CLAUDE_READ_ONLY_TOOLS,
  CLAUDE_WRITE_TOOLS,
  claudeAgent,
  genericAgent,
  type HostEvent,
  type SessionScope,
} from '../src/index.ts';
import { fakeAgent, type FakeAgentLog } from './fake-agent.ts';

let root: string;
let workspace: string;
let outside: string;
let scope: SessionScope;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'agent-host-'));
  workspace = path.join(root, 'workspace');
  outside = path.join(root, 'outside');
  await mkdir(workspace);
  await mkdir(outside);
  await writeFile(path.join(workspace, 'Joint.cpp'), 'line1\nline2\nline3\nline4');
  await writeFile(path.join(outside, 'secret.txt'), 'secret');
  await symlink(outside, path.join(workspace, 'escape'));
  scope = { readRoots: [workspace], trustedMcpServers: ['aporia'] };
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const opts = () => ({ cwd: workspace, additionalDirectories: [], mcpServers: [] });

async function run(host: AgentHost, sessionId: string, prompt: string): Promise<HostEvent[]> {
  const events: HostEvent[] = [];
  await host.prompt(sessionId, prompt, (e) => events.push(e));
  return events;
}

const textOf = (events: HostEvent[]) =>
  events.flatMap((e) => (e.kind === 'text' ? [e.text] : [])).join('');

describe('AgentHost (in-process fake agent)', () => {
  async function setup(log?: FakeAgentLog) {
    const host = await AgentHost.inProcess(fakeAgent(log));
    const sessionId = await host.newSession(opts(), scope);
    return { host, sessionId };
  }

  it('initialises and streams normalised events', async () => {
    const { host, sessionId } = await setup();
    expect(host.agentInfo.agentInfo?.name).toBe('fake');
    const events = await run(host, sessionId, 'hello');
    expect(events).toEqual([
      { kind: 'thought', text: 'hmm' },
      { kind: 'tool', id: 't1', title: 'Read', status: 'pending', toolKind: 'read' },
      { kind: 'tool', id: 't1' },
      { kind: 'text', text: 'hi' },
      { kind: 'stop', reason: 'end_turn' },
    ]);
    await host.close();
  });

  it('refuses edit permissions inside the workspace and never picks "always"', async () => {
    const { host, sessionId } = await setup();
    const events = await run(host, sessionId, `edit ${path.join(workspace, 'Joint.cpp')}`);
    expect(textOf(events)).toBe('permission:no');
    expect(events.find((e) => e.kind === 'permission')).toMatchObject({ decision: { allow: false } });
    expect(textOf(await run(host, sessionId, 'nooptions'))).toBe('permission:cancelled');
  });

  it('allows read-only tools inside the readable roots only (symlinks included)', async () => {
    const { host, sessionId } = await setup();
    expect(textOf(await run(host, sessionId, `search ${workspace}`))).toBe('permission:yes');
    expect(textOf(await run(host, sessionId, `search ${path.join(workspace, 'Joint.cpp')}`))).toBe('permission:yes');
    expect(textOf(await run(host, sessionId, `search ${path.join(outside, 'secret.txt')}`))).toBe('permission:no');
    expect(textOf(await run(host, sessionId, `search ${path.join(workspace, 'escape', 'secret.txt')}`))).toBe('permission:no');
    expect(textOf(await run(host, sessionId, 'search relative/path'))).toBe('permission:no');
  });

  it('allows only the trusted MCP server', async () => {
    const { host, sessionId } = await setup();
    expect(textOf(await run(host, sessionId, 'mcp aporia'))).toBe('permission:yes');
    expect(textOf(await run(host, sessionId, 'mcp evil'))).toBe('permission:no');
    expect(textOf(await run(host, sessionId, 'mcpname mcp__aporia__record_evidence'))).toBe('permission:yes');
    expect(textOf(await run(host, sessionId, 'mcpname mcp__other_server__x'))).toBe('permission:no');
    expect(textOf(await run(host, sessionId, 'mcpname Edit'))).toBe('permission:no');
  });

  it('refuses every file write, inside or outside the workspace', async () => {
    const { host, sessionId } = await setup();
    const events = await run(host, sessionId, `write ${path.join(workspace, 'Joint.cpp')}`);
    expect(textOf(events)).toMatch(/^write:error:/);
    expect(events).toContainEqual({ kind: 'blocked-fs', op: 'write', path: path.join(workspace, 'Joint.cpp') });
  });

  it('serves scoped reads with line ranges and refuses the rest', async () => {
    const { host, sessionId } = await setup();
    const file = path.join(workspace, 'Joint.cpp');
    expect(textOf(await run(host, sessionId, `read ${file}`))).toBe('read:line1\nline2\nline3\nline4');
    expect(textOf(await run(host, sessionId, `read ${file}:2:2`))).toBe('read:line2\nline3');
    const blocked = await run(host, sessionId, `read ${path.join(workspace, 'escape', 'secret.txt')}`);
    expect(textOf(blocked)).toMatch(/^read:error:/);
    expect(blocked).toContainEqual({ kind: 'blocked-fs', op: 'read', path: path.join(workspace, 'escape', 'secret.txt') });
  });

  it('ignores a missing read root and rethrows unexpected fs errors', async () => {
    const host = await AgentHost.inProcess(fakeAgent());
    const file = path.join(workspace, 'Joint.cpp');
    const s1 = await host.newSession(opts(), { readRoots: [path.join(root, 'gone'), workspace], trustedMcpServers: [] });
    expect(textOf(await run(host, s1, `search ${file}`))).toBe('permission:yes');
    const s2 = await host.newSession(opts(), { readRoots: [file], trustedMcpServers: [] });
    // A file used as a root: resolving below it fails with ENOTDIR, which must surface.
    expect(textOf(await run(host, s2, `read ${path.join(file, 'x')}`))).toMatch(/^read:error:/);
  });

  it('cancels, rejects unknown sessions, and closes cleanly', async () => {
    const log: FakeAgentLog = { sessions: [], cancelled: [] };
    const { host, sessionId } = await setup(log);
    await host.cancel(sessionId);
    await new Promise((r) => setTimeout(r, 10));
    expect(log.cancelled).toEqual([sessionId]);
    await expect(host.prompt('nope', 'hello', () => undefined)).rejects.toThrow(AgentHostError);
    await expect(host.cancel('nope')).rejects.toThrow(AgentHostError);
    await host.close();
  });

  it('reports the login the agent pushes, without personal details', async () => {
    const { host, sessionId } = await setup();
    expect(host.authStatus).toBeUndefined();
    const seen: unknown[] = [];
    const off = host.onAuthStatus((a) => seen.push(a));
    await run(host, sessionId, 'auth none');
    expect(host.authStatus).toEqual({ kind: 'apiKey', label: 'apiKey' });
    expect(seen).toEqual([{ kind: 'none', label: 'Not logged in' }, { kind: 'apiKey', label: 'apiKey' }]);
    off();
    await run(host, sessionId, 'auth claude-subscription');
    expect(seen).toHaveLength(2);
  });

  it('names the problem behind a failure', async () => {
    const { host, sessionId } = await setup();
    const err = await host.prompt(sessionId, 'login', () => undefined).catch((e: unknown) => e);
    expect(agentProblem(err)).toBe('login');
    expect(agentProblem({ code: -32000 })).toBe('login');
    expect(agentProblem(Object.assign(new Error('x'), { code: 'EACCES' }))).toBe('missing');
    expect(agentProblem(new AgentHostError('x', 'stopped'))).toBe('stopped');
    expect(agentProblem(new AgentHostError('x'))).toBe('other');
    expect(agentProblem(new Error('x'))).toBe('other');
    expect(agentProblem(null)).toBe('other');
  });

  it('passes agent-specific session options', async () => {
    const log: FakeAgentLog = { sessions: [], cancelled: [] };
    const host = await AgentHost.inProcess(fakeAgent(log), claudeAgent);
    await host.newSession({ ...opts(), systemPrompt: 'Teach, never solve.' }, scope);
    await host.newSession(opts(), scope);
    const options = (log.sessions[0]!._meta as { claudeCode: { options: Record<string, unknown> } }).claudeCode.options;
    expect(options).toEqual({
      tools: [...CLAUDE_READ_ONLY_TOOLS],
      disallowedTools: [...CLAUDE_WRITE_TOOLS],
      settingSources: [],
      strictMcpConfig: true,
      systemPrompt: 'Teach, never solve.',
    });
    expect((log.sessions[1]!._meta as { claudeCode: { options: Record<string, unknown> } }).claudeCode.options).not.toHaveProperty('systemPrompt');
    expect(options['tools']).not.toContain('Edit');
  });

  it('resumes a session from an earlier run, with the same options and policy', async () => {
    const log: FakeAgentLog = { sessions: [], cancelled: [] };
    const host = await AgentHost.inProcess(fakeAgent(log, { resume: true }), claudeAgent);
    expect(host.canResume).toBe(true);
    await host.resumeSession('s7', { ...opts(), systemPrompt: 'Teach.' }, scope);
    expect(log.resumed![0]).toMatchObject({ sessionId: 's7', cwd: workspace, _meta: { claudeCode: { options: { systemPrompt: 'Teach.' } } } });
    // The policy applies to the resumed session: a write is still refused.
    expect(textOf(await run(host, 's7', `write ${path.join(workspace, 'Joint.cpp')}`))).toMatch(/^write:error/);
    await expect(host.resumeSession('gone', opts(), scope)).rejects.toThrow();
    await expect(run(host, 'gone', 'hello')).rejects.toThrow(/unknown session/);

    const old = await AgentHost.inProcess(fakeAgent());
    expect(old.canResume).toBe(false);
    await expect(old.resumeSession('s1', opts(), scope)).rejects.toThrow(/cannot resume/);
  });
});

describe('AgentHost (subprocess)', () => {
  it('talks ACP over stdio to a spawned agent and stops it on close', async () => {
    const main = fileURLToPath(new URL('./fake-agent-main.ts', import.meta.url));
    const spec = genericAgent('fake', 'Fake', { command: process.execPath, args: [main] });
    expect(spec.sessionMeta(opts())).toBeUndefined();
    const host = await AgentHost.spawn(spec);
    const sessionId = await host.newSession(opts(), scope);
    expect(textOf(await run(host, sessionId, `write ${path.join(workspace, 'x')}`))).toMatch(/^write:error:/);
    await host.close();
    await host.close();
  });

  it('says the agent stopped when it dies before answering', async () => {
    const spec = genericAgent('dead', 'Dead', { command: process.execPath, args: ['-e', 'process.exit(0)'] });
    await expect(AgentHost.spawn(spec)).rejects.toMatchObject({ name: 'AgentHostError', problem: 'stopped', message: expect.stringMatching(/^Dead stopped \(exit code 0\)/) });
  });

  it('says what went wrong when a running agent refuses to start', async () => {
    const script = `process.stdin.once('data', (d) => { const id = JSON.parse(String(d).split('\\n')[0]).id; process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, error: { code: -32603, message: 'boom' } }) + '\\n'); }); setInterval(() => {}, 1000);`;
    const spec = genericAgent('grumpy', 'Grumpy', { command: process.execPath, args: ['-e', script] });
    await expect(AgentHost.spawn(spec)).rejects.toMatchObject({ problem: 'other', message: expect.stringMatching(/^Grumpy did not start: .*boom/) });
  });

  it('says the agent is missing instead of crashing when it cannot be started', async () => {
    const spec = genericAgent('none', 'Nothing', { command: 'no-such-agent-binary-xyz', args: [] });
    await expect(AgentHost.spawn(spec)).rejects.toMatchObject({ problem: 'missing', message: expect.stringMatching(/Nothing could not be started \(ENOENT\)/) });
    const broken = { ...spec, launch: () => { throw Object.assign(new Error('Cannot find module x'), { code: 'MODULE_NOT_FOUND' }); } };
    await expect(AgentHost.spawn(broken)).rejects.toMatchObject({ problem: 'missing', message: expect.stringMatching(/could not be found/) });
    const odd = { ...spec, launch: () => { throw new Error('bad config'); } };
    await expect(AgentHost.spawn(odd)).rejects.toMatchObject({ problem: 'other' });
  });

  it('claude spec launches the official adapter with the current Node', () => {
    const l = claudeAgent.launch();
    expect(l.command).toBe(process.execPath);
    expect(l.args[0]).toMatch(/claude-agent-acp[/\\]dist[/\\]index\.js$/);
    expect(l.env).toEqual({ ELECTRON_RUN_AS_NODE: '1' });
  });
});

