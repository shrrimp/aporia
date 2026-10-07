import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AgentHost, genericAgent } from '@app/agent-host';
import { DEFAULT_PERMISSIONS } from '@app/catalog';
import { ManualClock } from '@app/core';
import { AppService } from '../src/index.ts';
import { fakeTeacherAgent } from './fake-teacher-agent.ts';

let root: string;
let ws: string;
let app: AppService;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'existing-'));
  ws = path.join(root, 'engine');
  await mkdir(path.join(ws, 'physics'), { recursive: true });
  await writeFile(path.join(ws, 'CMakeLists.txt'), 'project(engine)\n');
  app = new AppService({
    dataRoot: path.join(root, 'data'),
    clock: new ManualClock('2026-10-07T10:00:00.000Z'),
    agent: genericAgent('fake', 'Fake', { command: 'unused', args: [] }),
    hostFactory: (s) => AgentHost.inProcess(fakeTeacherAgent(), s),
  });
  const p = await app.call('profiles.create', { displayName: 'Ada' });
  await app.call('profiles.open', { profileId: p.id });
});

afterEach(async () => {
  await app.close();
  await rm(root, { recursive: true, force: true });
});

async function ask(projectId: string, question: string) {
  let id = '';
  const done = new Promise<void>((resolve) => app.subscribe((e, d) => (e === 'ask.done' || e === 'ask.error') && (d as { askId: string }).askId === id && resolve()));
  id = (await app.call('ask', { projectId, question, thread: 'session' })).askId;
  await done;
}

describe('what the tutor may do', () => {
  it('is set at creation, changed in the settings, and enforced', async () => {
    const project = await app.call('projects.create', { title: 'Engine', goal: 'g', workspace: ws, agent: { ...DEFAULT_PERMISSIONS, tests: false } });
    expect(project.agent).toMatchObject({ tests: false, testsDir: 'aporia-tests' });
    await ask(project.id, 'write a test');
    await expect(readFile(path.join(ws, 'aporia-tests', 'joint_test.cpp'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });

    // Allowed now; in review mode the write waits, and the learner can look at it first.
    const updated = await app.call('projects.update', { projectId: project.id, agent: { ...DEFAULT_PERMISSIONS, editMine: true } });
    expect(updated.agent).toMatchObject({ tests: true, editMine: true });
    expect(await app.call('projects.update', { projectId: project.id, agent: { ...DEFAULT_PERMISSIONS, editMine: true } })).toEqual(updated);
    await ask(project.id, 'write a test');
    const pending = (await app.call('history.list', {})).find((h) => h.status === 'proposed')!;
    expect(pending.summary).toBe('aporia-tests/joint_test.cpp: a first test');
    expect(await app.call('history.diff', { id: pending.id })).toEqual({ kind: 'file', path: 'aporia-tests/joint_test.cpp', before: null, after: '// checks the joint\n' });
    await app.call('history.accept', { id: pending.id });
    expect(await readFile(path.join(ws, 'aporia-tests', 'joint_test.cpp'), 'utf8')).toBe('// checks the joint\n');
    await expect(app.call('history.diff', { id: pending.id })).rejects.toMatchObject({ code: 'conflict' });

    // An edit to the learner's file shows the lines it changes; it conflicts if they edit meanwhile.
    await ask(project.id, 'edit my build');
    const edit = (await app.call('history.list', {})).find((h) => h.status === 'proposed')!;
    expect(await app.call('history.diff', { id: edit.id })).toEqual({ kind: 'file', path: 'CMakeLists.txt', before: 'project(engine)\n', after: 'project(engine)\nadd_subdirectory(aporia-tests)\n' });
    await writeFile(path.join(ws, 'CMakeLists.txt'), 'project(engine) # mine\n');
    await expect(app.call('history.accept', { id: edit.id })).rejects.toMatchObject({ code: 'conflict', message: expect.stringMatching(/changed in the workspace/) });
    await expect(app.call('history.diff', { id: 'chg_nope' })).rejects.toMatchObject({ code: 'not_found' });

    await expect(app.call('projects.update', { projectId: project.id, agent: { ...DEFAULT_PERMISSIONS, testsDir: '../escape' } })).rejects.toMatchObject({ code: 'invalid_params' });
  });
});

describe('starting from existing work', () => {
  it('records claims, shows them as to verify, and proposes a roadmap the learner judges', async () => {
    const project = await app.call('projects.create', { title: 'Engine', goal: 'g', workspace: ws });
    expect((await app.call('curriculum.get', { projectId: project.id })).next).toMatchObject({ kind: 'interview', existing: true });
    const scratch = await app.call('projects.create', { title: 'Theory', goal: 'g' });
    expect((await app.call('curriculum.get', { projectId: scratch.id })).next).toMatchObject({ kind: 'interview', existing: false });

    await app.call('profiles.updateSettings', { changeMode: 'auto' });
    await ask(project.id, 'I already have work for this project');
    const brain = await app.call('brain.get', {});
    expect(brain.nodes.find((n) => n.id === 'quaternion.unit')).toMatchObject({ discovered: false, claim: { from: 'workspace', basis: 'physics/Quat.cpp normalises after each step' } });

    await app.call('profiles.updateSettings', { changeMode: 'review' });
    await ask(project.id, 'roadmap please');
    const proposals = (await app.call('history.list', {})).filter((h) => h.status === 'proposed');
    expect(proposals.map((p) => p.summary).sort()).toEqual(['roadmap, stage-1: from your repo', 'roadmap, stage-2: from your repo']);
    const diff = await app.call('history.diff', { id: proposals.find((p) => p.summary.includes('stage-2'))!.id });
    expect(diff).toMatchObject({ kind: 'document', after: { milestones: { 'stage-2': { title: 'Joints', status: 'planned' } } } });
    for (const p of proposals) await app.call(p.summary.includes('stage-1') ? 'history.accept' : 'history.reject', { id: p.id });

    let c = await app.call('curriculum.get', { projectId: project.id });
    expect(c.roadmap).toEqual([{ id: 'stage-1', title: 'Rigid bodies', goal: '', kcs: [], order: 1, status: 'planned', capability: 'things fall' }]);
    await app.call('roadmap.setStatus', { projectId: project.id, milestoneId: 'stage-1', status: 'active' });
    await app.call('roadmap.setStatus', { projectId: project.id, milestoneId: 'stage-1', status: 'active' });
    c = await app.call('curriculum.get', { projectId: project.id });
    expect(c.roadmap[0]!.status).toBe('active');
    const marked = (await app.call('history.list', {})).filter((h) => h.summary === 'roadmap, stage-1: marked active');
    expect(marked).toHaveLength(1);
    await app.call('history.undo', { id: marked[0]!.id });
    expect((await app.call('curriculum.get', { projectId: project.id })).roadmap[0]!.status).toBe('planned');
    await expect(app.call('roadmap.setStatus', { projectId: project.id, milestoneId: 'nope', status: 'done' })).rejects.toMatchObject({ code: 'not_found' });
  });
});

describe('choosing a folder', () => {
  it('lists folders only, from home by default', async () => {
    await mkdir(path.join(ws, '.hidden'));
    await mkdir(path.join(ws, 'node_modules'));
    expect(await app.call('folders.list', { path: ws })).toEqual({ path: ws, parent: root, folders: ['physics'] });
    expect((await app.call('folders.list', {})).path).toBe(path.resolve(homedir()));
    expect((await app.call('folders.list', { path: '/' })).parent).toBeUndefined();
    await expect(app.call('folders.list', { path: 'relative' })).rejects.toMatchObject({ code: 'invalid_params' });
    await expect(app.call('folders.list', { path: path.join(ws, 'nope') })).rejects.toMatchObject({ code: 'not_found' });
    await expect(app.call('folders.list', { path: path.join(ws, 'CMakeLists.txt') })).rejects.toMatchObject({ code: 'not_found' });
  });
});
