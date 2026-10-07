import { describe, expect, it } from 'vitest';
import { Checkpoints, GATED_FROM, HINT_LEVELS, Hints, Journal, ManualClock, checkHint, hintStates, maxHintLevel, type CheckpointRun, type HintState } from '../src/index.ts';
import { agent, learner, tempDir } from './helpers.ts';

const state = (over: Partial<HintState> = {}): HintState => ({ lessonId: 'l', taskId: 't', levels: [1], max: 1, attemptSince: false, files: [], ...over });

describe('the hint ladder rules', () => {
  it('names six levels and gates the top two', () => {
    expect(HINT_LEVELS.map((l) => l.name)).toEqual(['Reflect', 'Point', 'Question', 'Analogy', 'Structure', 'Principle']);
    expect(GATED_FROM).toBe(4);
  });

  it('starts low, climbs one level at a time, and may always go back down', () => {
    expect(checkHint(undefined, 0, false)).toEqual({ ok: true });
    expect(checkHint(undefined, 1, false)).toEqual({ ok: true });
    expect(checkHint(undefined, 3, true)).toMatchObject({ ok: false, allowed: 1, reason: expect.stringMatching(/first hint/) });
    expect(checkHint(state({ max: 1 }), 2, false)).toEqual({ ok: true });
    expect(checkHint(state({ max: 1 }), 3, false)).toMatchObject({ ok: false, allowed: 2, reason: expect.stringMatching(/one level at a time.*L1/i) });
    expect(checkHint(state({ max: 3 }), 0, false)).toEqual({ ok: true });
  });

  it('gives L4 and L5 only after a new attempt: a run, a written attempt, or changed code', () => {
    const at3 = state({ levels: [1, 2, 3], max: 3 });
    expect(checkHint(at3, 4, false)).toMatchObject({ ok: false, allowed: 3, reason: expect.stringMatching(/new attempt/) });
    expect(checkHint({ ...at3, attemptSince: true }, 4, false)).toEqual({ ok: true });
    expect(checkHint(at3, 4, true)).toEqual({ ok: true });
    // A second L4 needs another attempt too.
    expect(checkHint(state({ levels: [1, 2, 3, 4], max: 4 }), 4, false)).toMatchObject({ ok: false });
  });
});

describe('hints and attempts in the journal', () => {
  it('track each task: levels, the files then, and attempts since', async () => {
    const journal = await Journal.open(await tempDir(), new ManualClock('2026-10-08T10:00:00.000Z'));
    const hints = new Hints(journal);
    const checkpoints = new Checkpoints(journal);
    const files = [{ path: 'physics/Joint.cpp', sha: 'aaa' }];
    await hints.record(agent, { projectId: 'p', lessonId: 'l', taskId: 't', level: 1, summary: 'the force rule', files });
    await hints.record(agent, { projectId: 'p', lessonId: 'l', taskId: 't', level: 2 });
    await hints.record(agent, { projectId: 'p', lessonId: 'other', taskId: 't', level: 0 });
    await hints.record(agent, { projectId: 'q', lessonId: 'l', taskId: 't', level: 0 });
    // An attempt on a task with no hint yet changes nothing.
    await hints.attempt(learner, { projectId: 'p', lessonId: 'l', taskId: 'fresh', text: 'tried x' });

    let s = hintStates(journal.events, 'p', 'l');
    expect([...s.keys()]).toEqual(['l/t']);
    expect(s.get('l/t')).toMatchObject({ levels: [1, 2], max: 2, attemptSince: false, files: [] });
    expect(hintStates(journal.events, 'p').size).toBe(2);

    await hints.attempt(learner, { projectId: 'p', lessonId: 'l', taskId: 't', text: 'I normalised after the product' });
    expect(hintStates(journal.events, 'p', 'l').get('l/t')!.attemptSince).toBe(true);
    await hints.record(agent, { projectId: 'p', lessonId: 'l', taskId: 't', level: 3, files });
    s = hintStates(journal.events, 'p', 'l');
    expect(s.get('l/t')).toMatchObject({ attemptSince: false, files });

    // A checkpoint run counts as an attempt, and reaching it records evidence with the hint level.
    const run: CheckpointRun = { projectId: 'p', lessonId: 'l', taskId: 't', suite: 'Joint.*', expect: { passed: 3, of: 3 }, reached: true, exitCode: 0, timedOut: false, durationMs: 10, failures: [] };
    await checkpoints.record(learner, run, ['quaternion.unit']);
    expect(hintStates(journal.events, 'p', 'l').get('l/t')!.attemptSince).toBe(true);
    expect(journal.events.findLast((e) => e.type === 'evidence')).toMatchObject({ hintLevel: 3, outcome: 1 });
    expect(maxHintLevel(journal.events, 'p', 'l', 't')).toBe(3);
    expect(maxHintLevel(journal.events, 'p', 'l', 'none')).toBe(0);
  });
});
