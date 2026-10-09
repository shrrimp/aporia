import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { pickVars, reviewQuestion, templateProblems, type DrillItem, type ReviewQuestion } from '@app/catalog';
import { DAY_MS, ManualClock, ProfileStore, skillMemories, type Answered, type Author, type OpenProfile } from '@app/core';
import { fourNumbers } from '../../catalog/fixtures/four-numbers.ts';
import {
  BANK_PREFIX,
  TeacherHttpServer,
  chooseQuestion,
  lessonTarget,
  projectReviews,
  questionsNeeded,
  readBank,
  registerValidators,
  reviewQuestionsBrief,
  reviewsTarget,
  type Candidate,
  type Registration,
} from '../src/index.ts';

const agent: Author = { kind: 'agent', agent: 'claude-code', session: 'sess-1' };
const system: Author = { kind: 'system' };

let root: string;
let clock: ManualClock;
let profile: OpenProfile;
let server: TeacherHttpServer;
let reg: Registration;
let client: Client;

const text = (r: unknown) => (r as { content: { text: string }[] }).content[0]!.text;
const call = async (name: string, args: Record<string, unknown> = {}) => client.callTool({ name, arguments: args });

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'reviews-'));
  clock = new ManualClock('2026-10-05T10:00:00.000Z');
  const store = new ProfileStore(root, clock);
  profile = await store.open((await store.create('Jules')).id);
  registerValidators(profile.changes);
  server = await TeacherHttpServer.start();
  // Lessons wait for review in this profile; review questions never do.
  reg = server.register({ profile, projectId: 'hmp', agent, changeMode: () => 'review' });
  client = new Client({ name: 'test', version: '0' });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(server.url), { requestInit: { headers: { Authorization: `Bearer ${reg.token}` } } }) as unknown as Parameters<Client['connect']>[0],
  );
  await profile.changes.propose({ author: agent, target: lessonTarget('hmp', fourNumbers.id), patch: [{ op: 'add', path: '', value: fourNumbers as never }], reason: 'l' }, 'auto');
});

afterEach(async () => {
  await client.close();
  await server.close();
  await profile.close();
  await rm(root, { recursive: true, force: true });
});

const answer = (itemId: string, kcs: string[], outcome = 1) =>
  profile.observations.recordEvidence({ author: system, itemId, projectId: 'hmp', kcs: kcs.map((kc) => ({ kc, weight: 1 })), difficulty: 0, evidenceType: 'recognition', outcome });

const question = (prompt: string, extra: Record<string, unknown> = {}) => ({
  kind: 'mcq',
  angle: 'apply',
  kcs: ['quaternion.unit'],
  difficulty: 2,
  why: 'Its parts squared add up to 1.',
  context: 'A unit quaternion has $w^2 + x^2 + y^2 + z^2 = 1$.',
  prompt,
  options: ['$(1, 0, 0, 0)$', '$(1, 1, 0, 0)$'],
  answer: 0,
  ...extra,
});

describe('write_review_questions', () => {
  it('saves questions that stand on their own, at once, and returns the others to fix', async () => {
    await answer(`${fourNumbers.id}/w1`, ['quaternion.unit']);
    const r = await call('write_review_questions', {
      questions: [
        question('Which of these is a unit quaternion?'),
        question('Which one, as we saw in the lesson?'),
        question('Which of these is a unit quaternion'), // the same as the first
        question('Is a rotation a unit quaternion?', { kcs: ['made.up'] }),
        { kind: 'short', angle: 'explain', prompt: 'Why?', kcs: ['quaternion.unit'], difficulty: 2, why: 'x', answer: 'x' },
        question(fourNumbers.sections[0]!.blocks.find((b) => b.type === 'drill')!.items[0]!.prompt), // a lesson item
      ],
      reason: 'first questions',
    });
    expect(text(r)).toMatch(/^Saved 1 review question\(s\) \(change chg_/);
    expect(text(r)).toMatch(/- 1: prompt: "in the lesson" points back/);
    expect(text(r)).toMatch(/- 2: this question was already asked/);
    expect(text(r)).toMatch(/- 3: kcs: "made\.up" is neither in the skill map nor tested yet/);
    expect(text(r)).toMatch(/- 4: kind: /);
    expect(text(r)).toMatch(/- 5: this question was already asked/);
    const bank = await readBank(profile.changes, 'hmp');
    expect(Object.values(bank.questions).map((e) => e.question.prompt)).toEqual(['Which of these is a unit quaternion?']);
    expect(profile.changes.list({ target: reviewsTarget('hmp') }).map((c) => c.status)).toEqual(['applied']);

    // More are added to the bank; none at all is an error.
    expect(text(await call('write_review_questions', { questions: [question('Is $(0, 0, 0, 1)$ a unit quaternion?', { angle: 'recall' })], reason: 'more' }))).toMatch(/^Saved 1/);
    expect(Object.keys((await readBank(profile.changes, 'hmp')).questions)).toHaveLength(2);
    const none = await call('write_review_questions', { questions: [question('Which of these is a unit quaternion?')], reason: 'again' });
    expect(none.isError).toBe(true);
    expect(text(none)).toMatch(/^No question saved\./);
  });

  it('takes skills from the skill map too, and the bank is checked on every change', async () => {
    await call('update_skill_map', { skills: [{ id: 'spatial.force', title: 'Spatial forces' }], reason: 'map' });
    expect(text(await call('write_review_questions', { questions: [question('Torque or force: which one moves with the frame?', { kcs: ['spatial.force'] })], reason: 'r' }))).toMatch(/^Saved 1/);
    await expect(
      profile.changes.propose({ author: agent, target: reviewsTarget('hmp'), patch: [{ op: 'add', path: '/questions/bad', value: { question: question('As we saw?'), at: 'x' } as never }], reason: 'x' }, 'auto'),
    ).rejects.toThrow(/points back/);
  });
});

/** A bank candidate, for choosing. */
const bank = (id: string, angle: ReviewQuestion['angle'], extra: Record<string, unknown> = {}, kcs = ['k']): Candidate => ({
  source: 'bank',
  id: `${BANK_PREFIX}${id}`,
  qid: id,
  kcs,
  question: reviewQuestion.parse({ ...question(`Question ${id}?`), angle, kcs, ...extra }),
  at: `2026-10-0${id.length}`,
});
const fromLesson = (id: string): Candidate => ({ source: 'lesson', id: `l/${id}`, kcs: ['k'], item: { id } as DrillItem, lessonTitle: 'L', at: '' });
const answeredOn = (...ids: [string, string][]) => new Map<string, Answered>(ids.map(([id, lastAt]) => [id, { count: 1, lastAt }]));

describe('choosing a question for a due skill', () => {
  it('asks something new: a review question first, from another angle than last time', () => {
    const pool = [fromLesson('w1'), bank('a', 'apply'), bank('b', 'predict'), bank('c', 'apply', {}, ['other'])];
    expect(chooseQuestion('k', pool, new Map(), new Set())).toMatchObject({ candidate: { id: `${BANK_PREFIX}a` }, seen: 'new' });
    const lastApply = answeredOn([`${BANK_PREFIX}a`, '2026-10-01']);
    expect(chooseQuestion('k', [...pool, bank('d', 'apply')], lastApply, new Set())).toMatchObject({ candidate: { id: `${BANK_PREFIX}b` }, seen: 'new' });
    // A lesson's own item only when no review question is new.
    expect(chooseQuestion('k', pool, answeredOn([`${BANK_PREFIX}a`, '1'], [`${BANK_PREFIX}b`, '2']), new Set())).toMatchObject({ candidate: { id: 'l/w1' }, seen: 'new' });
    expect(chooseQuestion('nothing', pool, new Map(), new Set())).toBeUndefined();
    expect(chooseQuestion('k', pool, new Map(), new Set([`${BANK_PREFIX}a`, `${BANK_PREFIX}b`, 'l/w1']))).toBeUndefined();
  });

  it('then a template with new numbers, then the question answered longest ago, never the last one', () => {
    const template: Candidate = {
      ...bank('t', 'apply'),
      question: reviewQuestion.parse({ kind: 'numeric', angle: 'apply', kcs: ['k'], difficulty: 2, why: 'x', prompt: 'At {{a}}?', answer: '{{a}}', vars: { a: { min: 1, max: 9, step: 1 } } }),
    } as Candidate;
    const all = answeredOn([`${BANK_PREFIX}a`, '2026-10-02'], [`${BANK_PREFIX}t`, '2026-10-03'], ['l/w1', '2026-10-01']);
    expect(chooseQuestion('k', [bank('a', 'apply'), template, fromLesson('w1')], all, new Set())).toMatchObject({ candidate: { id: `${BANK_PREFIX}t` }, seen: 'new-numbers' });
    expect(chooseQuestion('k', [bank('a', 'apply'), fromLesson('w1')], all, new Set())).toMatchObject({ candidate: { id: 'l/w1' }, seen: 'again' });
    expect(chooseQuestion('k', [bank('a', 'apply'), fromLesson('w1')], answeredOn([`${BANK_PREFIX}a`, '1'], ['l/w1', '2']), new Set())).toMatchObject({ candidate: { id: `${BANK_PREFIX}a` } });
    expect(chooseQuestion('k', [bank('a', 'apply')], all, new Set())).toMatchObject({ candidate: { id: `${BANK_PREFIX}a` }, seen: 'again' });
  });
});

describe('what needs writing', () => {
  it('depends on the setting', async () => {
    await answer('l/a', ['k']);
    await answer('l/b', ['j']);
    const memories = skillMemories(profile.journal.events, 'hmp');
    const answered = answeredOn([`${BANK_PREFIX}a`, '1']);
    const pool = [bank('a', 'apply'), bank('b', 'apply')];
    // A pool keeps two unseen questions on every skill answered.
    expect(questionsNeeded('pool', memories, [], pool, answered).sort()).toEqual(['j', 'k']);
    expect(questionsNeeded('pool', memories, [], [...pool, bank('c', 'recall')], answered)).toEqual(['j']);
    // Numbers only: once per skill.
    expect(questionsNeeded('numbers', memories, [], pool, answered)).toEqual(['j']);
    // When due: the due skills with nothing new to ask.
    const slot = (kc: string, seen?: 'new' | 'again') => ({ kc, title: kc, retrievability: 0.5, reviews: 1, ...(seen ? { question: { id: 'x', kcs: [kc], item: {} as DrillItem, seen } } : {}) });
    expect(questionsNeeded('when-due', memories, [slot('k', 'new'), slot('j', 'again'), slot('z')], pool, answered)).toEqual(['j', 'z']);
  });
});

describe('the review page’s questions', () => {
  it('asks one question per due skill; a question on two due skills reviews both', async () => {
    await answer('l/a', ['quaternion.unit'], 0);
    await answer('l/b', ['quaternion.exp-map'], 0);
    await call('write_review_questions', {
      questions: [question('Which is a unit quaternion, and which rotation does it make?', { kcs: ['quaternion.unit', 'quaternion.exp-map'] })],
      reason: 'r',
    });
    clock.advance(30 * DAY_MS);
    const r = await projectReviews(profile, 'hmp', clock.now(), 20, 'pool');
    expect(r.dueCount).toBe(2);
    expect(r.due).toHaveLength(1);
    expect(r.due[0]!.question).toMatchObject({ seen: 'new', kcs: ['quaternion.unit', 'quaternion.exp-map'], context: expect.stringContaining('unit quaternion') });
  });

  it('skips a template whose numbers do not work out this time, and says when nothing can be asked', async () => {
    const vars = { a: { min: 0, max: 99, step: 1 } };
    const q = reviewQuestion.parse({ kind: 'numeric', angle: 'apply', kcs: ['k'], difficulty: 2, why: 'x', prompt: 'One over {{a}}?', answer: '{{ 1 / a }}', vars, tolerance: 0.01 });
    expect(templateProblems(q)).toEqual([]);
    // An id whose first showing draws a = 0.
    let qid = '';
    for (let i = 0; !qid; i++) if (pickVars(vars, `r-${i}#0`).a === 0) qid = `r-${i}`;
    await profile.changes.propose({ author: agent, target: reviewsTarget('hmp'), patch: [{ op: 'add', path: '', value: { questions: { [qid]: { question: q, at: 'x' } }, retiredItems: [] } as never }], reason: 'x' }, 'auto');
    await answer('l/a', ['k'], 0);
    await answer('l/b', ['lonely'], 0);
    clock.advance(30 * DAY_MS);
    const r = await projectReviews(profile, 'hmp', clock.now());
    expect(r.due.map((s) => [s.kc, s.question?.id])).toEqual([
      ['k', undefined],
      ['lonely', undefined],
    ]);
  });
});

describe('the brief for writing questions', () => {
  it('says what the skill is, how it was taught, and what was asked or flagged', async () => {
    await call('update_skill_map', { skills: [{ id: 'quaternion.unit', title: 'Unit quaternions', summary: 'Rotations as four numbers of length one.' }], reason: 'map' });
    for (const c of profile.changes.list({ status: 'proposed' })) await profile.changes.accept(c.changeId, { kind: 'learner' });
    await answer(`${fourNumbers.id}/w1`, ['quaternion.unit']);
    await call('write_review_questions', { questions: [question('Which of these is a unit quaternion?'), question('Is $(0, 1, 0, 0)$ a unit quaternion?', { angle: 'recall' })], reason: 'r' });
    const [first] = Object.keys((await readBank(profile.changes, 'hmp')).questions);
    await profile.changes.propose({ author: { kind: 'learner' }, target: reviewsTarget('hmp'), patch: [{ op: 'add', path: `/questions/${first}/retired`, value: { at: 'x', reason: 'r' } }], reason: 'flag' }, 'auto');
    const brief = await reviewQuestionsBrief(profile, 'hmp', ['quaternion.unit', 'unknown.skill'], 'pool');
    expect(brief).toMatch(/^<review-questions>\nWrite 3 new review questions for each skill/);
    expect(brief).toContain('## quaternion.unit: Unit quaternions\nWhat it is: Rotations as four numbers of length one.\nAnswered 1 time(s) so far.');
    expect(brief).toMatch(/How the lesson tested it:\n- /);
    expect(brief).toContain('Review questions already written (never repeat or reword these):\n- (recall) Is $(0, 1, 0, 0)$ a unit quaternion?');
    expect(brief).toContain('made no sense without the lesson (ask the idea again, with the context it needs):\n- Which of these is a unit quaternion?');
    expect(brief).toContain('## unknown.skill: unknown.skill\n');
    expect(brief).toContain('comes back with new numbers each time');
    expect(await reviewQuestionsBrief(profile, 'hmp', ['quaternion.unit'], 'numbers', 5)).toMatch(/Write 5 new[\s\S]*make each a template/);
  });
});
