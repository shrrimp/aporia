import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AgentHost, genericAgent } from '@app/agent-host';
import { DAY_MS, ManualClock } from '@app/core';
import { fourNumbers } from '../../catalog/fixtures/four-numbers.ts';
import { AppService } from '../src/index.ts';
import { nextStep } from '../src/maps.ts';
import { fakeTeacherAgent, type FakeLog } from './fake-teacher-agent.ts';

let root: string;
let app: AppService;
let clock: ManualClock;
let log: FakeLog;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'curriculum-'));
  clock = new ManualClock('2026-10-06T10:00:00.000Z');
  log = { prompts: [], sessions: 0 };
  app = new AppService({
    dataRoot: root,
    clock,
    agent: genericAgent('fake', 'Fake Tutor', { command: 'unused', args: [] }),
    hostFactory: (spec) => AgentHost.inProcess(fakeTeacherAgent(log), spec),
  });
});

afterEach(async () => {
  await app.close();
  await rm(root, { recursive: true, force: true });
});

async function ask(projectId: string, question: string, answers?: { askId: string; form: number; title: string; values: Record<string, unknown> }): Promise<string> {
  let id = '';
  const done = new Promise<void>((resolve) => app.subscribe((e, d) => e === 'ask.done' && (d as { askId: string }).askId === id && resolve()));
  id = (await app.call('ask', { projectId, question, thread: 'session', ...(answers ? { answers } : {}) })).askId;
  await done;
  return id;
}

async function setup() {
  const p = await app.call('profiles.create', { displayName: 'Ada' });
  await app.call('profiles.open', { profileId: p.id });
  await app.call('profiles.updateSettings', { changeMode: 'auto' });
  return (await app.call('projects.create', { title: 'HMP', goal: 'Featherstone' })).id;
}

describe('the interview', () => {
  it('scores probes from the saved form, once, and tells the tutor', async () => {
    const projectId = await setup();
    expect((await app.call('curriculum.get', { projectId })).next).toMatchObject({ kind: 'interview' });
    const interview = await ask(projectId, 'Interview me briefly');
    const values = { norm: { choice: '1' }, bug: { line: 3 }, self: { scale: 4 }, probe: { text: 'it scales' }, background: { choice: 'Never really' } };
    await ask(projectId, 'Answers to the form "Where you are starting from": ... [plan]', { askId: interview, form: 0, title: 'Where you are starting from', values });
    const prompt = log.prompts.at(-1)!;
    expect(prompt).toContain('<scored-by-the-app>');
    expect(prompt).toContain('- [norm] right');
    expect(prompt).toContain('- [bug] wrong');
    expect(prompt).toContain('- [self] self-rating 4/5 (a prior only)');
    expect(prompt).not.toContain('[probe]');

    const history = await app.call('history.list', {});
    const probes = history.filter((h) => h.kind === 'observation' && h.author.kind === 'system');
    expect(probes.map((h) => h.summary).sort()).toEqual([
      'Evidence on quaternion.unit: 0% (probe)',
      'Evidence on quaternion.unit: 100% (probe)',
      'Evidence on quaternion.unit: 75% (self-rating)',
    ]);

    // Sent again (or with another form index, or a malformed answer): nothing is recorded twice.
    await ask(projectId, 'Answers again', { askId: interview, form: 0, title: 'x', values });
    await ask(projectId, 'Answers to a form that does not exist', { askId: interview, form: 3, title: 'x', values });
    await ask(projectId, 'Answers to the form, malformed', { askId: 'other-ask', form: 0, title: 'x', values: { norm: 5 } });
    expect(log.prompts.slice(-3).some((p) => p.includes('<scored-by-the-app>'))).toBe(false);
    expect((await app.call('history.list', {})).filter((h) => h.kind === 'observation' && h.author.kind === 'system')).toHaveLength(3);
  });
});

describe('the path', () => {
  it('lays out the skills, places them by evidence, and follows the plan', async () => {
    const projectId = await setup();
    const interview = await ask(projectId, 'Interview me briefly');
    await ask(projectId, 'Answers to the form [plan]', { askId: interview, form: 0, title: 't', values: { norm: { choice: '1' } } });

    let c = await app.call('curriculum.get', { projectId });
    expect(c.goals).toEqual(['quaternion.exp-map-side']);
    expect(c.nodes.map((n) => [n.id, n.layer, n.state, n.goal])).toEqual([
      ['linalg.vectors', 0, 'available', false],
      ['quaternion.unit', 1, 'in-progress', false],
      ['quaternion.exp-map-side', 2, 'locked', true],
    ]);
    expect(c.nodes[2]).toMatchObject({ title: 'Which side the exponential goes', group: 'rotations', needs: ['Unit quaternions'], mastery: 'unseen', confidence: 0, evidence: 0 });
    expect(c.nodes[1]).toMatchObject({ mastery: 'practising', evidence: 2 }); // the app's scored probe and the tutor's own
    expect(c.nodes[1]!.band).toBeDefined();
    expect(c.edges).toEqual([
      { from: 'linalg.vectors', to: 'quaternion.unit' },
      { from: 'quaternion.unit', to: 'quaternion.exp-map-side' },
    ]);
    expect(c.plan.map((p) => p.status)).toEqual(['planned', 'planned']);
    expect(c.next).toMatchObject({ kind: 'draft', planId: 'four', title: 'Four Numbers, Three Speeds' });
    expect(c.assessment).toMatchObject({ summary: expect.stringMatching(/unit length/), gaps: [{ text: 'unit length', kcs: ['quaternion.unit'] }] });

    await ask(projectId, 'lesson please');
    c = await app.call('curriculum.get', { projectId });
    expect(c.nodes.map((n) => n.id)).toEqual(['cpp.std-span', 'joint.nq-nv', 'linalg.vectors', 'quaternion.unit', 'quaternion.exp-map-side']);
    expect(c.plan[0]).toMatchObject({ status: 'written', lessonId: fourNumbers.id, progress: { done: 0 } });
    expect(c.next).toMatchObject({ kind: 'lesson', lessonId: fourNumbers.id });

    await app.call('progress.set', { projectId, lessonId: fourNumbers.id, key: 'item:w1', value: { result: 1 } });
    expect((await app.call('curriculum.get', { projectId })).plan[0]!.status).toBe('in-progress');
    for (const key of ['block:why-not-derivative/2', 'block:side/0', 'task:step-2', 'block:exit/0'])
      await app.call('progress.set', { projectId, lessonId: fourNumbers.id, key, value: { done: true } });
    c = await app.call('curriculum.get', { projectId });
    expect(c.plan.map((p) => p.status)).toEqual(['done', 'planned']);
    expect(c.next).toMatchObject({ kind: 'draft', planId: 'next' });
    await expect(app.call('curriculum.get', { projectId: 'nope' })).rejects.toMatchObject({ code: 'not_found' });
  });
});

describe('what comes next', () => {
  const lesson = { id: 'l', title: 'L' } as never;
  const base = { plan: [] as never[], lessons: [] as never[], completion: () => ({ done: 0, total: 1 }), due: 0, interviewed: true, planned: true };
  const next = (o: Partial<typeof base>) => {
    const x = { ...base, ...o };
    return nextStep(x.plan, x.lessons, x.completion, x.due, x.interviewed, x.planned);
  };

  it('reviews first when enough is due, then continues, drafts, or plans', () => {
    expect(next({ interviewed: false, planned: false })).toMatchObject({ kind: 'interview' });
    expect(next({ due: 3, lessons: [lesson] })).toMatchObject({ kind: 'review', due: 3 });
    expect(next({ due: 2, lessons: [lesson] })).toMatchObject({ kind: 'lesson', lessonId: 'l' });
    expect(next({ lessons: [lesson], completion: () => ({ done: 1, total: 1 }) })).toMatchObject({ kind: 'plan', text: expect.stringMatching(/^Everything planned is done\. Plan/) });
    expect(next({ due: 1 })).toMatchObject({ kind: 'plan', text: expect.stringMatching(/Review 1 item/) });
  });
});

describe('the brain', () => {
  it('shows every skill of the profile with its level, what slips, and suggestions', async () => {
    const projectId = await setup();
    const other = (await app.call('projects.create', { title: 'Other', goal: 'g' })).id;
    const interview = await ask(projectId, 'Interview me briefly');
    await ask(projectId, 'Answers to the form [plan]', { askId: interview, form: 0, title: 't', values: { norm: { choice: '1' }, bug: { line: 1 } } });
    await ask(projectId, 'lesson please');
    // Answered in the lesson, then left long enough to fade.
    await app.call('answers.record', { projectId, lessonId: fourNumbers.id, itemId: 'w1', kcs: ['quaternion.unit'], difficulty: 2, evidenceType: 'recognition', outcome: 0 });
    clock.advance(30 * DAY_MS);
    // Evidence on a skill the map does not describe still shows.
    await app.call('answers.record', { projectId: other, lessonId: 'x', itemId: 'y', kcs: ['misc.thing'], difficulty: 3, evidenceType: 'production', outcome: 1 });

    const b = await app.call('brain.get', {});
    expect(b.groups).toEqual([{ id: 'maths', title: 'Mathematics' }, { id: 'rotations', title: 'Rotations', parent: 'maths' }]);
    expect(b.edges).toContainEqual({ from: 'quaternion.exp-map-side', to: 'dyn.featherstone', kind: 'prereq' });
    const node = (id: string) => b.nodes.find((n) => n.id === id)!;
    expect(node('dyn.featherstone')).toMatchObject({ suggested: true, discovered: false, why: 'Builds on the rotations you know', mastery: 'unseen', projects: [] });
    expect(node('quaternion.unit')).toMatchObject({ title: 'Unit quaternions', group: 'rotations', discovered: true, projects: [projectId] });
    expect(node('quaternion.unit').struggling).toEqual(['2 of the last 4 answers missed', 'fading: due for review']);
    expect(node('misc.thing')).toMatchObject({ title: 'misc.thing', discovered: true, suggested: false, struggling: [] });
    expect(node('cpp.std-span').projects).toEqual([projectId]);
  });
});
