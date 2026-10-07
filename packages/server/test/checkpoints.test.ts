import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AgentHost, genericAgent } from '@app/agent-host';
import { ManualClock, ProfileStore, type JsonValue } from '@app/core';
import { lessonTarget, projectTarget } from '@app/teacher-mcp';
import { fourNumbers } from '../../catalog/fixtures/four-numbers.ts';
import { AppService } from '../src/index.ts';
import { CheckpointRunner } from '../src/checkpoint-runner.ts';
import { fakeTeacherAgent } from './fake-teacher-agent.ts';

let root: string;
let workspace: string;
let app: AppService;

/** A pretend test suite: prints a CTest summary with as many passes as PASSES says (default 119 of 148). */
const SUITE = `
const fs = require('fs');
const passed = Number(fs.existsSync('PASSES') ? fs.readFileSync('PASSES', 'utf8') : 119);
console.log('args:', process.argv.slice(2).join(' '));
if (fs.existsSync('HANG')) setTimeout(() => {}, 60000);
else if (fs.existsSync('JUNK')) console.log('Segmentation fault');
else {
  console.log(Math.round(passed / 148 * 100) + '% tests passed, ' + (148 - passed) + ' tests failed out of 148');
  console.log('The following tests FAILED:');
  console.log('\\t  3 - MultiDof.ball (Failed)');
  process.exitCode = passed === 148 ? 0 : 8;
}`;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'checkpoints-'));
  workspace = await mkdtemp(path.join(tmpdir(), 'workspace-'));
  await writeFile(path.join(workspace, 'suite.js'), SUITE);
  app = new AppService({
    dataRoot: root,
    clock: new ManualClock('2026-10-06T10:00:00.000Z'),
    agent: genericAgent('fake', 'Fake Tutor', { command: 'unused', args: [] }),
    hostFactory: (spec) => AgentHost.inProcess(fakeTeacherAgent(), spec),
  });
});

afterEach(async () => {
  await app.close();
  await rm(root, { recursive: true, force: true });
  await rm(workspace, { recursive: true, force: true });
});

async function setup(testCommand?: string) {
  const p = await app.call('profiles.create', { displayName: 'Ada' });
  await app.call('profiles.open', { profileId: p.id });
  await app.call('profiles.updateSettings', { changeMode: 'auto' });
  const project = await app.call('projects.create', {
    title: 'HMP',
    goal: 'Featherstone',
    workspace,
    ...(testCommand === undefined ? {} : { testCommand }),
  });
  const done = new Promise<void>((resolve) => app.subscribe((e) => e === 'ask.done' && resolve()));
  await app.call('ask', { projectId: project.id, question: 'lesson please', thread: 'session' });
  await done;
  return { profileId: p.id, projectId: project.id, lessonId: fourNumbers.id };
}

const node = JSON.stringify(process.execPath);

describe('running checkpoints', () => {
  it('runs the learner command, reads the counts, and records evidence when the step is reached', async () => {
    const { projectId, lessonId } = await setup(`${node} suite.js -R {suite}`);
    expect(await app.call('checkpoints.list', { projectId, lessonId })).toEqual({ runnable: true, tasks: {} });

    await writeFile(path.join(workspace, 'PASSES'), '100');
    const first = await app.call('checkpoints.run', { projectId, lessonId, taskId: 'step-2' });
    expect(first).toMatchObject({ counts: { passed: 100, failed: 48, total: 148 }, expect: { passed: 119, of: 148 }, reached: false, exitCode: 8, failures: ['MultiDof.ball'] });
    expect(first.output).toContain('args: -R MultiDof');
    expect((await app.call('learner.summary', {})).kcs).toEqual([]); // work in progress is not a failure

    await writeFile(path.join(workspace, 'PASSES'), '121');
    expect(await app.call('checkpoints.run', { projectId, lessonId, taskId: 'step-2' })).toMatchObject({ reached: true });
    const kcs = (await app.call('learner.summary', {})).kcs.map((k) => k.kc);
    expect(kcs).toEqual(['cpp.std-span', 'quaternion.exp-map-side']);

    const list = await app.call('checkpoints.list', { projectId, lessonId });
    expect(list.tasks['step-2']).toMatchObject({ reached: true, runs: 2 });
    expect(list.tasks['step-2']!.recent.map((r) => r.counts?.passed)).toEqual([100, 121]);
  });

  it('keeps going when the output has no summary, or the command hangs and is stopped', async () => {
    const { projectId, lessonId } = await setup(`${node} suite.js`);
    await writeFile(path.join(workspace, 'JUNK'), '');
    const r = await app.call('checkpoints.run', { projectId, lessonId, taskId: 'step-2' });
    expect(r.counts).toBeUndefined();
    expect(r).toMatchObject({ reached: false, exitCode: 0 });

    await writeFile(path.join(workspace, 'HANG'), '');
    const running = app.call('checkpoints.run', { projectId, lessonId, taskId: 'step-2' });
    await new Promise((res) => setTimeout(res, 150));
    expect((await app.call('checkpoints.list', { projectId, lessonId })).running).toBe('step-2');
    await expect(app.call('checkpoints.run', { projectId, lessonId, taskId: 'step-2' })).rejects.toMatchObject({ code: 'conflict' });
    expect(await app.call('checkpoints.cancel', { projectId })).toEqual({ cancelled: true });
    expect(await running).toMatchObject({ cancelled: true, reached: false });
    expect(await app.call('checkpoints.cancel', { projectId })).toEqual({ cancelled: false });
    // A cancelled run is not recorded.
    expect((await app.call('checkpoints.list', { projectId, lessonId })).tasks['step-2']!.runs).toBe(1);
  });

  it('explains why it cannot run', async () => {
    const none = await setup();
    expect(await app.call('checkpoints.list', { projectId: none.projectId, lessonId: none.lessonId })).toMatchObject({ runnable: false, reason: expect.stringMatching(/no test command/) });
    await expect(app.call('checkpoints.run', { projectId: none.projectId, lessonId: none.lessonId, taskId: 'step-2' })).rejects.toMatchObject({ code: 'conflict' });

    await expect(app.call('projects.create', { title: 'Shell', goal: 'g', workspace, testCommand: 'make && ./test' })).rejects.toMatchObject({ code: 'invalid_params' });

    const missing = await app.call('projects.create', { title: 'Missing', goal: 'g', workspace, testCommand: 'no-such-test-runner-xyz' });
    await expect(app.call('checkpoints.run', { projectId: missing.id, lessonId: 'x', taskId: 'step-2' })).rejects.toMatchObject({ code: 'not_found' });
    await expect(app.call('checkpoints.list', { projectId: 'nope', lessonId: 'x' })).rejects.toMatchObject({ code: 'not_found' });
  });
});

describe('project settings', () => {
  it('lets the learner set, change and remove the workspace and test command', async () => {
    const { projectId, lessonId } = await setup();
    const updated = await app.call('projects.update', { projectId, testCommand: `${node} suite.js`, why: 'my engine' });
    expect(updated).toMatchObject({ workspace, testCommand: `${node} suite.js`, why: 'my engine' });
    expect((await app.call('checkpoints.list', { projectId, lessonId })).runnable).toBe(true);
    expect(await app.call('projects.update', { projectId, testCommand: `${node} suite.js` })).toEqual(updated); // nothing changed
    const cleared = await app.call('projects.update', { projectId, workspace: '', testCommand: '' });
    expect(cleared.workspace).toBeUndefined();
    expect(cleared.testCommand).toBeUndefined();
    expect(await app.call('projects.update', { projectId, workspace: '' })).toEqual(cleared);
    await expect(app.call('projects.update', { projectId, testCommand: 'make; ./test' })).rejects.toMatchObject({ code: 'invalid_params', message: expect.stringMatching(/shell/) });
    await expect(app.call('projects.update', { projectId, workspace: 'relative/path' })).rejects.toMatchObject({ code: 'invalid_params' });
    await expect(app.call('projects.create', { title: 'x', goal: 'g', testCommand: 'a | b' })).rejects.toMatchObject({ code: 'invalid_params' });
    await expect(app.call('projects.update', { projectId: 'nope', title: 'x' })).rejects.toMatchObject({ code: 'not_found' });
    expect((await app.call('projects.update', { projectId, workspace: 'C:\\dev\\engine' })).workspace).toBe('C:\\dev\\engine');
  });
});

describe('CheckpointRunner', () => {
  async function open() {
    const store = new ProfileStore(root, new ManualClock('2026-10-06T10:00:00.000Z'));
    const p = await store.create('Ada');
    const profile = await store.open(p.id);
    const project = { id: 'hmp', title: 'HMP', goal: 'g', why: '', workspace, testCommand: `${node} suite.js -R {suite}`, createdAt: '' };
    const learner = { kind: 'learner' as const };
    await profile.changes.propose({ author: learner, target: projectTarget('hmp'), patch: [{ op: 'add', path: '', value: { ...project } as JsonValue }], reason: 'new' }, 'auto');
    return { profile, project, runner: new CheckpointRunner(profile), learner };
  }

  it('refuses a test command the tutor changed, and suites that are not plain names', async () => {
    const { profile, project, runner, learner } = await open();
    const lesson = structuredClone(fourNumbers) as unknown as { id: string; sections: { blocks: { checkpoint?: { suite: string } }[] }[] };
    const task = lesson.sections.flatMap((s) => s.blocks).find((b) => b.checkpoint)!;
    task.checkpoint!.suite = '-S evil.cmake';
    await profile.changes.propose({ author: learner, target: lessonTarget('hmp', lesson.id), patch: [{ op: 'add', path: '', value: lesson as unknown as JsonValue }], reason: 'l' }, 'auto');
    await expect(runner.run(project, lesson.id, 'step-2')).rejects.toMatchObject({ code: 'invalid_params', message: expect.stringMatching(/not a plain test name/) });
    await expect(runner.run(project, lesson.id, 'nope')).rejects.toMatchObject({ code: 'not_found' });
    await expect(runner.run({ ...project, testCommand: 'make && ./test' }, lesson.id, 'step-2')).rejects.toMatchObject({
      code: 'invalid_params',
      message: expect.stringMatching(/only works in a shell/),
    });
    await expect(runner.run({ ...project, testCommand: JSON.stringify(workspace) }, lesson.id, 'step-2')).rejects.toThrow(/EACCES/);

    const agent = { kind: 'agent' as const, agent: 'fake' };
    await profile.changes.propose({ author: agent, target: projectTarget('hmp'), patch: [{ op: 'replace', path: '/testCommand', value: 'rm -rf /' }], reason: 'x' }, 'auto');
    expect(runner.blocker(project)).toMatch(/changed by the tutor/);
    expect(runner.blocker({ ...project, workspace: 'relative/dir' })).toMatch(/absolute/);
    expect(runner.blocker({ ...project, workspace: undefined as never })).toMatch(/no workspace/);
    await profile.close();
  });

  it('rejects tasks without a checkpoint, unreadable lessons and a missing workspace', async () => {
    const { profile, project, runner, learner } = await open();
    const lesson = structuredClone(fourNumbers) as unknown as { id: string; sections: { blocks: Record<string, unknown>[] }[] };
    const task = lesson.sections.flatMap((s) => s.blocks).find((b) => b['checkpoint'])!;
    delete task['checkpoint'];
    await profile.changes.propose({ author: learner, target: lessonTarget('hmp', lesson.id), patch: [{ op: 'add', path: '', value: lesson as unknown as JsonValue }], reason: 'l' }, 'auto');
    await expect(runner.run(project, lesson.id, 'step-2')).rejects.toMatchObject({ code: 'invalid_params', message: expect.stringMatching(/no checkpoint/) });
    await expect(runner.run({ ...project, workspace: path.join(workspace, 'gone') }, lesson.id, 'step-2')).rejects.toMatchObject({ code: 'invalid_params' });
    // A lesson file that no longer matches the catalog.
    await writeFile(path.join(profile.dir, 'projects', 'hmp', 'lessons', `${lesson.id}.json`), '{"broken":true}');
    await expect(runner.run(project, lesson.id, 'step-2')).rejects.toMatchObject({ code: 'conflict' });
    await profile.close();
  });
});
