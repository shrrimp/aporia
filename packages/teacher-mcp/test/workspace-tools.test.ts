import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { DEFAULT_PERMISSIONS, classifyWrite, describePermissions, workspaceRelative, type AgentPermissionsInput } from '@app/catalog';
import { ManualClock, ProfileStore, roadmapTarget, type Author, type ChangeMode, type JsonValue, type OpenProfile } from '@app/core';
import { fourNumbers } from '../../catalog/fixtures/four-numbers.ts';
import {
  TeacherHttpServer,
  agentFileTarget,
  describeRoadmap,
  lessonTarget,
  projectAccess,
  projectTarget,
  readRoadmap,
  registerValidators,
  validateAgentFile,
  type Registration,
} from '../src/index.ts';

const agent: Author = { kind: 'agent', agent: 'claude-code', session: 's1' };
const learner: Author = { kind: 'learner' };

let root: string;
let ws: string;
let profile: OpenProfile;
let server: TeacherHttpServer;
let reg: Registration;
let client: Client;
let mode: ChangeMode;

const text = (r: unknown) => (r as { content: { text: string }[] }).content[0]!.text;
const call = async (name: string, args: Record<string, unknown> = {}) => client.callTool({ name, arguments: args });

async function setProject(agentPerms: AgentPermissionsInput | undefined, extra: Record<string, unknown> = {}) {
  const all = { schemaVersion: 1, id: 'hmp', title: 'HMP', goal: 'g', why: '', workspace: ws, createdAt: '', ...(agentPerms ? { agent: agentPerms } : {}), ...extra };
  const doc = Object.fromEntries(Object.entries(all).filter(([, v]) => v !== undefined));
  const exists = (await profile.changes.read(projectTarget('hmp'))) !== null;
  await profile.changes.propose({ author: learner, target: projectTarget('hmp'), patch: [{ op: exists ? 'replace' : 'add', path: '', value: doc as JsonValue }], reason: 'settings' }, 'auto');
}

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'teacher-ws-'));
  ws = path.join(root, 'engine');
  await mkdir(path.join(ws, 'physics'), { recursive: true });
  await writeFile(path.join(ws, 'physics', 'Joint.cpp'), '// mine\n');
  await writeFile(path.join(ws, 'CMakeLists.txt'), 'project(engine)\n');
  const store = new ProfileStore(root, new ManualClock('2026-10-07T10:00:00.000Z'));
  profile = await store.open((await store.create('Ada')).id);
  registerValidators(profile.changes);
  mode = 'auto';
  server = await TeacherHttpServer.start();
  reg = server.register({ profile, projectId: 'hmp', agent, changeMode: () => mode });
  client = new Client({ name: 'test', version: '0' });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(server.url), { requestInit: { headers: { Authorization: `Bearer ${reg.token}` } } }) as unknown as Parameters<Client['connect']>[0],
  );
});

afterEach(async () => {
  await client.close();
  await server.close();
  await profile.close();
  await rm(root, { recursive: true, force: true });
});

describe('permissions', () => {
  it('classify every path, refusing escapes and version control', () => {
    const p = { ...DEFAULT_PERMISSIONS, tools: true, toolDirs: ['viewer'] };
    expect(classifyWrite(p, 'aporia-tests/joint_test.cpp')).toMatchObject({ area: 'tests', allowed: true });
    expect(classifyWrite(p, 'viewer/main.cpp')).toMatchObject({ area: 'tools', allowed: true });
    expect(classifyWrite(p, 'physics/Joint.cpp')).toMatchObject({ area: 'mine', allowed: false, reason: expect.stringMatching(/Write tests in aporia-tests\/ or tools in viewer/) });
    expect(classifyWrite({ ...p, editMine: true }, 'physics/Joint.cpp')).toMatchObject({ area: 'mine', allowed: true });
    expect(classifyWrite({ ...p, tests: false }, 'aporia-tests/x.cpp')).toMatchObject({ allowed: false, reason: expect.stringMatching(/not allowed you to write tests/) });
    expect(classifyWrite({ ...p, tools: false }, 'viewer/x.cpp')).toMatchObject({ allowed: false, reason: expect.stringMatching(/not allowed you to write tools/) });
    expect(classifyWrite(DEFAULT_PERMISSIONS, 'physics/x.cpp').reason).not.toMatch(/tools in/);
    for (const bad of ['/etc/passwd', '../x', 'a/../../x', 'a\\b', 'C:/x', '', 'a//b', './']) expect(classifyWrite({ ...p, editMine: true }, bad).allowed, bad).toBe(false);
    expect(classifyWrite({ ...p, editMine: true }, '.git/config')).toMatchObject({ allowed: false, reason: expect.stringMatching(/version-control/) });
    expect(classifyWrite({ ...p, editMine: true }, 'sub/.git/HEAD').allowed).toBe(false);
    expect(workspaceRelative('./a/b.cpp')).toBe('a/b.cpp');
    expect(workspaceRelative('x'.repeat(401))).toBeUndefined();
  });

  it('read in words for the tutor', () => {
    expect(describePermissions(DEFAULT_PERMISSIONS)).toMatch(/write tests in `aporia-tests\/`[\s\S]*may not write supporting code[\s\S]*may not run anything[\s\S]*may not edit/);
    const all = describePermissions({ ...DEFAULT_PERMISSIONS, tests: false, tools: true, toolDirs: ['viewer', 'plots'], measure: true, commands: ['./bench'], editMine: true, notes: 'The viewer is yours.' });
    expect(all).toMatch(/may not write tests[\s\S]*`viewer\/`, `plots\/`[\s\S]*and these commands: `\.\/bench`[\s\S]*propose edits[\s\S]*The learner adds: The viewer is yours\./);
    expect(describePermissions({ ...DEFAULT_PERMISSIONS, measure: true })).toMatch(/run the project's tests, to measure/);
  });
});

describe('writing files', () => {
  it('writes tests where allowed, and every write can be undone, restoring the workspace', async () => {
    await setProject(undefined); // older project: the defaults (tests only)
    expect((await projectAccess(profile.changes, 'hmp')).permissions).toEqual(DEFAULT_PERMISSIONS);
    expect(text(await call('get_teaching_context'))).toMatch(/You may write tests in `aporia-tests\/`/);

    expect(text(await call('write_file', { path: 'aporia-tests/joint_test.cpp', content: '// v1\n', reason: 'a first test' }))).toMatch(/"aporia-tests\/joint_test\.cpp" written/);
    const file = path.join(ws, 'aporia-tests', 'joint_test.cpp');
    expect(await readFile(file, 'utf8')).toBe('// v1\n');
    expect(text(await call('write_file', { path: 'aporia-tests/joint_test.cpp', content: '// v1\n', reason: 'again' }))).toMatch(/already has this content/);
    await call('write_file', { path: './aporia-tests/joint_test.cpp', content: '// v2\n', reason: 'more cases' });
    expect(await readFile(file, 'utf8')).toBe('// v2\n');

    const [first, second] = profile.changes.list({ target: agentFileTarget('hmp', 'aporia-tests/joint_test.cpp') });
    expect(second!.reason).toBe('aporia-tests/joint_test.cpp: more cases');
    await profile.changes.revert(second!.changeId, learner);
    expect(await readFile(file, 'utf8')).toBe('// v1\n');
    await profile.changes.revert(first!.changeId, learner);
    await expect(stat(file)).rejects.toMatchObject({ code: 'ENOENT' }); // it did not exist before
    await profile.changes.redo(first!.changeId, learner);
    expect(await readFile(file, 'utf8')).toBe('// v1\n');
  });

  it("refuses what is not allowed, and never writes an open task's solution", async () => {
    await setProject({ tests: true, tools: true, toolDirs: ['viewer'] });
    expect(text(await call('write_file', { path: 'physics/Joint.cpp', content: 'x', reason: 'r' }))).toMatch(/^Not written: "physics\/Joint\.cpp" is one of the learner's own files/);
    expect(text(await call('write_file', { path: '../outside.txt', content: 'x', reason: 'r' }))).toMatch(/not a path inside the workspace/);
    await profile.changes.propose({ author: agent, target: lessonTarget('hmp', fourNumbers.id), patch: [{ op: 'add', path: '', value: fourNumbers as never }], reason: 'l' }, 'auto');
    const solution = 'void integratePosition(const Joint& j, std::span<double> q) {\n  q[0] = 1;\n  q[1] = 2;\n}\n';
    expect(text(await call('write_file', { path: 'viewer/helpers.cpp', content: solution, reason: 'r' }))).toMatch(/implements "integratePosition", which the learner is writing themselves/);
    expect(text(await call('write_file', { path: 'viewer/main.cpp', content: '// draw the chain\nint main() { return 0; }\n', reason: 'a viewer' }))).toMatch(/written/);
    await setProject(undefined, { workspace: undefined });
    expect(text(await call('write_file', { path: 'viewer/x.cpp', content: 'x', reason: 'r' }))).toMatch(/no workspace folder/);
  });

  it("proposes edits to the learner's files for review, and never overwrites their own changes", async () => {
    await setProject({ editMine: true });
    expect(text(await call('write_file', { path: 'CMakeLists.txt', content: 'project(engine)\nadd_subdirectory(aporia-tests)\n', reason: 'build the tests' }))).toMatch(/proposed for the learner's review/);
    expect(await readFile(path.join(ws, 'CMakeLists.txt'), 'utf8')).toBe('project(engine)\n'); // not yet
    const proposal = profile.changes.list({ status: 'proposed' })[0]!;
    // The learner edits the file meanwhile: accepting would clobber that, so it is refused.
    await writeFile(path.join(ws, 'CMakeLists.txt'), 'project(engine)\n# mine\n');
    await expect(profile.changes.accept(proposal.changeId, learner)).rejects.toThrow(/changed in the workspace since/);
    expect(profile.changes.get(proposal.changeId)!.status).toBe('proposed');
    await writeFile(path.join(ws, 'CMakeLists.txt'), 'project(engine)\n');
    await chmod(path.join(ws, 'CMakeLists.txt'), 0o640);
    await profile.changes.accept(proposal.changeId, learner);
    expect(await readFile(path.join(ws, 'CMakeLists.txt'), 'utf8')).toMatch(/add_subdirectory/);
    expect((await stat(path.join(ws, 'CMakeLists.txt'))).mode & 0o777).toBe(0o640);
    // Undo puts their original back, unless they changed it since.
    await writeFile(path.join(ws, 'CMakeLists.txt'), 'edited after\n');
    await expect(profile.changes.revert(proposal.changeId, learner)).rejects.toThrow(/changed in the workspace/);
    await writeFile(path.join(ws, 'CMakeLists.txt'), 'project(engine)\nadd_subdirectory(aporia-tests)\n');
    await profile.changes.revert(proposal.changeId, learner);
    expect(await readFile(path.join(ws, 'CMakeLists.txt'), 'utf8')).toBe('project(engine)\n');
    // Even in auto mode, the learner's own files wait for review.
    mode = 'auto';
    expect(text(await call('write_file', { path: 'physics/Joint.cpp', content: '// mine\n// note\n', reason: 'r' }))).toMatch(/proposed/);
  });

  it('keeps file records consistent and in the workspace', async () => {
    await setProject(undefined);
    const doc = { schemaVersion: 1, path: 'aporia-tests/a.cpp', content: 'x', original: null };
    expect(validateAgentFile(agentFileTarget('hmp', 'aporia-tests/a.cpp'), doc)).toEqual([]);
    expect(validateAgentFile(agentFileTarget('hmp', 'other.cpp'), doc)).toEqual(['the file record is stored under the wrong key']);
    expect(validateAgentFile(agentFileTarget('hmp', 'x'), { ...doc, path: '../x' })[0]).toMatch(/^path/);
    // A record whose project lost its workspace cannot be applied.
    await profile.changes.propose({ author: agent, target: agentFileTarget('hmp', 'aporia-tests/a.cpp'), patch: [{ op: 'add', path: '', value: doc }], reason: 'r' }, 'review');
    await setProject(undefined, { workspace: undefined });
    const pending = profile.changes.list({ status: 'proposed' })[0]!;
    await expect(profile.changes.accept(pending.changeId, learner)).rejects.toThrow(/no workspace folder any more/);
  });
});

describe('measuring', () => {
  const node = JSON.stringify(process.execPath);
  beforeEach(async () => {
    await writeFile(path.join(ws, 'suite.js'), `console.log('args:' + process.argv.slice(2).join(' ')); console.log('100% tests passed, 0 tests failed out of 3');`);
    await writeFile(path.join(ws, 'bench.js'), `console.log('step: 1.25 ms')`);
  });

  it('runs the tests and the listed commands only when allowed', async () => {
    await setProject({ measure: false }, { testCommand: `${node} suite.js -R {suite}` });
    expect(text(await call('run_tests', { suite: 'Joint' }))).toMatch(/not allowed you to run anything/);
    expect(text(await call('run_command', { command: 'x' }))).toMatch(/not allowed you to run anything/);

    await setProject({ measure: true, commands: [`${node} bench.js`, 'make && x', 'no-such-tool-xyz'] }, { testCommand: `${node} suite.js -R {suite}` });
    expect(text(await call('run_tests'))).toMatch(/give the suite/);
    const r = text(await call('run_tests', { suite: 'Joint' }));
    expect(r).toMatch(/^Exit code 0, \d+ ms\. Tests: 3 passed, 0 failed\.\n\nOutput:\nargs:-R Joint/);
    expect(text(await call('run_tests', { suite: '-S evil' }))).toMatch(/not a plain test name/);
    expect(text(await call('run_command', { command: `${node} bench.js` }))).toMatch(/Exit code 0[^\n]*\n\nOutput:\nstep: 1\.25 ms/);
    expect(text(await call('run_command', { command: 'rm -rf /' }))).toMatch(/Only the commands the learner listed can run/);
    expect(text(await call('run_command', { command: 'make && x' }))).toMatch(/only works in a shell/);
    expect(text(await call('run_command', { command: 'no-such-tool-xyz' }))).toMatch(/Could not run it: .*not found/);

    await setProject({ measure: true }, { testCommand: `${node} suite.js` });
    expect(text(await call('run_tests'))).toMatch(/Tests: 3 passed/);
    expect(text(await call('run_command', { command: 'x' }))).toMatch(/none yet/);
    await setProject({ measure: true, commands: ['x'] }, { workspace: undefined });
    expect(text(await call('run_tests'))).toMatch(/no workspace folder or no test command/);
    expect(text(await call('run_command', { command: 'x' }))).toMatch(/no workspace folder/);
  });

  it('never runs a test command a tutor changed', async () => {
    await setProject({ measure: true }, { testCommand: `${node} suite.js` });
    await profile.changes.propose({ author: agent, target: projectTarget('hmp'), patch: [{ op: 'replace', path: '/testCommand', value: 'rm -rf /' }], reason: 'x' }, 'auto');
    expect(text(await call('run_tests'))).toMatch(/changed by a tutor/);
  });
});

describe('the roadmap', () => {
  it('takes one change per milestone, each judged on its own', async () => {
    await setProject(undefined);
    expect(text(await call('get_teaching_context'))).toMatch(/No roadmap yet/);
    mode = 'review';
    const r = text(
      await call('update_roadmap', {
        milestones: [
          { id: 'stage-1', title: 'Rigid bodies', order: 1, goal: 'A free body integrates.', kcs: ['quaternion.unit'], capability: 'things fall' },
          { id: 'stage-2', title: 'Joints', order: 2 },
        ],
        reason: 'from your repo',
      }),
    );
    expect(r).toBe('Roadmap changes: stage-1 (waiting for review), stage-2 (waiting for review).');
    const [one, two] = profile.changes.list({ target: roadmapTarget('hmp'), status: 'proposed' });
    await profile.changes.accept(two!.changeId, learner); // in any order
    await profile.changes.reject(one!.changeId, learner);
    expect(Object.keys((await readRoadmap(profile.changes, 'hmp')).milestones)).toEqual(['stage-2']);

    mode = 'auto';
    await call('update_roadmap', { milestones: [{ id: 'stage-2', status: 'active' }, { id: 'stage-0', title: 'Basics', order: 0 }], reason: 'started' });
    const rm = await readRoadmap(profile.changes, 'hmp');
    expect(rm.milestones['stage-2']).toMatchObject({ title: 'Joints', status: 'active', order: 2 });
    expect(describeRoadmap(rm)).toMatch(/^1\. \[planned\] Basics \(id stage-0, order 0\)\n2\. \[active\] Joints/);
    expect(text(await call('get_teaching_context'))).toMatch(/# Roadmap[^\n]*\n1\. \[planned\] Basics/);

    expect(text(await call('update_roadmap', { milestones: [{ id: 'stage-9', title: 'No order' }], remove: ['nope'], reason: 'x' }))).toMatch(/needs a title and an order[\s\S]*no milestone "nope"/);
    expect(text(await call('update_roadmap', { reason: 'x' }))).toBe('Nothing to change.');
    expect(text(await call('update_roadmap', { remove: ['stage-0'], reason: 'merged' }))).toMatch(/stage-0 \(applied\)/);
    expect(describeRoadmap(await readRoadmap(profile.changes, 'hmp'))).toMatch(/^1\. \[active\] Joints/);
    expect(describeRoadmap({ schemaVersion: 1, milestones: { a: { title: 'A', goal: 'x\ny', kcs: ['k'], order: 1, status: 'done', capability: 'c' } } })).toBe(
      '1. [done] A (id a, order 1); skills: k; unlocks: c\n   x y',
    );
  });
});

describe('claims', () => {
  it('are shown to the tutor as claims to verify, until evidence exists', async () => {
    await call('update_skill_map', {
      skills: [{ id: 'quat.slerp', title: 'Slerp', claim: { from: 'workspace', basis: 'math/Quat.cpp implements slerp' } }],
      reason: 'explored the repo',
    });
    expect(text(await call('get_skill_map'))).toMatch(/quat\.slerp: Slerp \(CLAIMED, NOT VERIFIED: probe it\)\. Claimed from workspace: math\/Quat\.cpp implements slerp/);
    await profile.observations.recordEvidence({ author: { kind: 'system' }, itemId: 'p', kcs: [{ kc: 'quat.slerp', weight: 1 }], difficulty: 0, evidenceType: 'probe', outcome: 1 });
    expect(text(await call('get_skill_map'))).toMatch(/quat\.slerp: Slerp \(\w+, practising/);
  });
});
