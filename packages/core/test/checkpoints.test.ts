import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import {
  CommandError,
  Checkpoints,
  Journal,
  ManualClock,
  checkpointArgv,
  checkpointRuns,
  deriveLearnerState,
  parseTestOutput,
  runCommand,
  splitCommand,
  stripAnsi,
  type CheckpointRun,
} from '../src/index.ts';
import { learner, tempDir } from './helpers.ts';

describe('splitCommand', () => {
  it('splits words and honours quotes and escapes', () => {
    expect(splitCommand('ctest --test-dir build')).toEqual(['ctest', '--test-dir', 'build']);
    expect(splitCommand(`pytest  'tests/a b.py'   -k "x \\"y\\" \\\\ z"`)).toEqual(['pytest', 'tests/a b.py', '-k', 'x "y" \\ z']);
    expect(splitCommand('run\\ me "" \'\'')).toEqual(['run me', '', '']);
    expect(splitCommand('"a"b\'c\'')).toEqual(['abc']);
    expect(splitCommand('say "\\n"')).toEqual(['say', '\\n']);
  });

  it('refuses what only a shell understands, and malformed lines', () => {
    for (const c of ['make test && ./run', 'a | b', 'a > out', 'echo $HOME', 'a; b', 'echo `id`', '(a)']) {
      expect(() => splitCommand(c), c).toThrow(CommandError);
    }
    expect(() => splitCommand('   ')).toThrow(/empty/);
    expect(() => splitCommand('a "b')).toThrow(/unclosed/);
    expect(() => splitCommand('a \\')).toThrow(/backslash/);
    // Quoted, they are just characters.
    expect(splitCommand(`grep 'a|b' "c;d"`)).toEqual(['grep', 'a|b', 'c;d']);
  });

  it('never lets a quoted or escaped metacharacter split a word (property)', () => {
    fc.assert(
      fc.property(fc.array(fc.string({ minLength: 1, maxLength: 12 }).filter((s) => !s.includes("'")), { minLength: 1, maxLength: 6 }), (words) => {
        expect(splitCommand(words.map((w) => `'${w}'`).join(' '))).toEqual(words);
      }),
    );
  });
});

describe('checkpointArgv', () => {
  it('runs the whole command when the learner gave no {suite} place', () => {
    expect(checkpointArgv('ctest --test-dir build', 'Joint.*')).toEqual(['ctest', '--test-dir', 'build']);
  });

  it('substitutes the suite where the learner put it', () => {
    expect(checkpointArgv('ctest --test-dir build -R {suite}', 'Joint.*')).toEqual(['ctest', '--test-dir', 'build', '-R', 'Joint.*']);
    expect(checkpointArgv('./tests --gtest_filter={suite}', 'Quat*:Joint.Integrate')).toEqual(['./tests', '--gtest_filter=Quat*:Joint.Integrate']);
  });

  it('refuses suites that could act as options or carry anything but a name', () => {
    for (const s of ['-S evil.cmake', '--build-and-test', 'a b', '', 'x;y', 'a$(id)', 'x'.repeat(201)]) {
      expect(() => checkpointArgv('ctest -R {suite}', s), s).toThrow(CommandError);
    }
  });
});

const SAMPLES: Record<string, [string, { passed: number; failed: number; failures?: string[] }]> = {
  ctest: [
    `Test project /w/build
    1/41 Test  #1: quat.norm ........   Passed    0.01 sec
95% tests passed, 2 tests failed out of 41

Total Test time (real) =   0.40 sec

The following tests FAILED:
\t  7 - joint.integrate (Failed)
\t  9 - joint.spherical (Subprocess aborted)
Errors while running CTest`,
    { passed: 39, failed: 2, failures: ['joint.integrate', 'joint.spherical'] },
  ],
  ctestAll: ['100% tests passed, 0 tests failed out of 12', { passed: 12, failed: 0, failures: [] }],
  gtest: [
    `[==========] 12 tests from 3 test suites ran. (4 ms total)
[  PASSED  ] 10 tests.
[  FAILED  ] 2 tests, listed below:
[  FAILED  ] Joint.Integrate
[  FAILED  ] Quat/Param.Norm/3, where GetParam() = 3

 2 FAILED TESTS`,
    { passed: 10, failed: 2, failures: ['Joint.Integrate', 'Quat/Param.Norm/3'] },
  ],
  gtestAll: ['[  PASSED  ] 1 test.', { passed: 1, failed: 0 }],
  catch2: ['test cases: 10 | 7 passed | 3 failed\nassertions: 40 | 35 passed | 5 failed', { passed: 7, failed: 3 }],
  catch2Fail: ['test cases: 2 | 2 failed\nassertions: 4 | 4 failed', { passed: 0, failed: 2 }],
  catch2All: ['All tests passed (25 assertions in 10 test cases)', { passed: 10, failed: 0 }],
  cargo: [
    `running 3 tests
test quat::norm ... ok
test joint::integrate ... FAILED

failures:

---- joint::integrate stdout ----
thread panicked

test result: FAILED. 2 passed; 1 failed; 0 ignored; 0 measured; 0 filtered out

running 4 tests
test result: ok. 4 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out`,
    { passed: 6, failed: 1, failures: ['joint::integrate'] },
  ],
  pytest: [
    `FAILED tests/test_joint.py::test_integrate - AssertionError
ERROR tests/test_io.py::test_load
===== 1 failed, 10 passed, 2 skipped, 1 error in 0.12s =====`,
    { passed: 10, failed: 2, failures: ['tests/test_joint.py::test_integrate', 'tests/test_io.py::test_load'] },
  ],
  pytestAll: ['============================== 5 passed in 0.03s (0:00:00) ==============================', { passed: 5, failed: 0 }],
  vitest: [
    ` × test/joint.test.ts > integrate 3ms
 Test Files  1 failed | 3 passed (4)
      Tests  2 failed | 10 passed | 1 skipped (13)`,
    { passed: 10, failed: 2, failures: ['test/joint.test.ts > integrate'] },
  ],
  vitestAll: ['      Tests  10 passed (10)', { passed: 10, failed: 0 }],
  jest: [
    `  ● Joint › integrates
Tests:       2 failed, 1 skipped, 10 passed, 13 total`,
    { passed: 10, failed: 2, failures: ['Joint › integrates'] },
  ],
  dotnet: ['  Failed Joint.Integrate [3 ms]\nFailed!  - Failed:     2, Passed:    8, Skipped:     0, Total:    10', { passed: 8, failed: 2, failures: ['Joint.Integrate'] }],
  junit: [
    `Tests run: 3, Failures: 0, Errors: 0, Skipped: 0, Time elapsed: 0.1 s - in a.ATest
Results:
Tests run: 12, Failures: 1, Errors: 1, Skipped: 1`,
    { passed: 9, failed: 2 },
  ],
  mocha: ['  10 passing (20ms)\n  2 failing', { passed: 10, failed: 2 }],
  mochaAll: ['  3 passing (2ms)', { passed: 3, failed: 0 }],
  go: [
    `=== RUN   TestNorm
--- PASS: TestNorm (0.00s)
--- FAIL: TestIntegrate (0.00s)
    --- PASS: TestIntegrate/small (0.00s)
FAIL`,
    { passed: 2, failed: 1, failures: ['TestIntegrate'] },
  ],
  tap: ['1..3\nok 1 - norm\nnot ok 2 - integrate\nok 3', { passed: 2, failed: 1, failures: ['integrate'] }],
};

describe('parseTestOutput', () => {
  for (const [name, [output, want]] of Object.entries(SAMPLES)) {
    it(`reads ${name}`, () => {
      const r = parseTestOutput(output)!;
      expect(r, name).toBeDefined();
      expect([r.passed, r.failed, r.total]).toEqual([want.passed, want.failed, want.passed + want.failed]);
      if (want.failures) expect(r.failures).toEqual(want.failures);
    });
  }

  it('reads coloured output and Windows line ends', () => {
    expect(parseTestOutput('\x1b[32m100% tests passed\x1b[0m, 0 tests failed out of 3\r\n')).toMatchObject({ format: 'ctest', passed: 3 });
    expect(stripAnsi('\x1b[1m\x1b[31mred\x1b[0m')).toBe('red');
  });

  it('says nothing when it cannot find a summary', () => {
    expect(parseTestOutput('Segmentation fault (core dumped)')).toBeUndefined();
    expect(parseTestOutput('')).toBeUndefined();
    expect(parseTestOutput(' Tests  (0)')).toBeUndefined();
  });

  it('stays fast on hostile output (no catastrophic backtracking)', () => {
    const big = `${'\n'.repeat(200_000)}${' '.repeat(100_000)}${'='.repeat(50_000)} passed${'-'.repeat(50_000)}`;
    const t = performance.now();
    parseTestOutput(big);
    expect(performance.now() - t).toBeLessThan(2000);
  });
});

describe('runCommand', () => {
  const node = process.execPath;

  it('runs without a shell in the workspace, keeping the end of the output', async () => {
    const cwd = await tempDir();
    await writeFile(path.join(cwd, 't.js'), 'process.stdout.write("x".repeat(5000)); console.error(process.cwd()); console.log("$HOME", process.env.NO_COLOR)');
    const r = await runCommand({ argv: [node, 't.js'], cwd, timeoutMs: 10_000, maxOutput: 600 });
    expect(r.exitCode).toBe(0);
    expect(r.truncated).toBe(true);
    expect(r.output.length).toBeLessThanOrEqual(600);
    expect(r.output).toContain('$HOME 1'); // not expanded: no shell
    expect(r.output).toContain(path.basename(cwd));
  });

  it('reports the exit code', async () => {
    const cwd = await tempDir();
    const r = await runCommand({ argv: [node, '-e', 'process.exit(3)'], cwd, timeoutMs: 10_000, maxOutput: 1000 });
    expect(r).toMatchObject({ exitCode: 3, timedOut: false, cancelled: false, truncated: false });
  });

  it('stops a command that runs too long, with what it started', async () => {
    const cwd = await tempDir();
    const script = `require('child_process').spawn(process.execPath, ['-e', 'setTimeout(()=>{}, 60000)'], { stdio: 'inherit' }); setTimeout(()=>{}, 60000)`;
    const r = await runCommand({ argv: [node, '-e', script], cwd, timeoutMs: 300, maxOutput: 1000 });
    expect(r.timedOut).toBe(true);
    expect(r.exitCode).toBeNull();
  });

  it('can be cancelled, also before it starts', async () => {
    const cwd = await tempDir();
    const ac = new AbortController();
    const p = runCommand({ argv: [node, '-e', 'setTimeout(()=>{}, 60000)'], cwd, timeoutMs: 60_000, maxOutput: 1000, signal: ac.signal });
    setTimeout(() => ac.abort(), 100);
    expect(await p).toMatchObject({ cancelled: true, exitCode: null });
    expect(await runCommand({ argv: [node], cwd, timeoutMs: 1000, maxOutput: 10, signal: ac.signal })).toMatchObject({ cancelled: true, durationMs: 0 });
  });

  it('explains a missing program, a missing workspace and an empty command', async () => {
    const cwd = await tempDir();
    await expect(runCommand({ argv: ['definitely-not-a-program-xyz'], cwd, timeoutMs: 1000, maxOutput: 10 })).rejects.toThrow(/not found/);
    await expect(runCommand({ argv: [node], cwd: path.join(cwd, 'nope'), timeoutMs: 1000, maxOutput: 10 })).rejects.toThrow(/does not exist/);
    await expect(runCommand({ argv: [node], cwd: 'relative', timeoutMs: 1000, maxOutput: 10 })).rejects.toThrow(/absolute/);
    await expect(runCommand({ argv: [], cwd, timeoutMs: 1000, maxOutput: 10 })).rejects.toThrow(/empty/);
    await expect(runCommand({ argv: [cwd], cwd, timeoutMs: 1000, maxOutput: 10 })).rejects.toThrow(/EACCES/);
  });
});

describe('Checkpoints', () => {
  const run = (over: Partial<CheckpointRun> = {}): CheckpointRun => ({
    projectId: 'p',
    lessonId: 'l',
    taskId: 't',
    suite: 'Joint.*',
    counts: { passed: 30, failed: 11, total: 41, format: 'ctest' },
    expect: { passed: 41, of: 41 },
    reached: false,
    exitCode: 1,
    timedOut: false,
    durationMs: 120,
    failures: [],
    ...over,
  });

  it('keeps every run and records evidence once, when the step is first reached', async () => {
    const dir = await tempDir();
    const journal = await Journal.open(dir, new ManualClock('2026-10-06T10:00:00.000Z'));
    const cp = new Checkpoints(journal);
    await cp.record(learner, run(), ['joint.integrate']);
    await cp.record(learner, run({ reached: true, counts: { passed: 41, failed: 0, total: 41, format: 'ctest' } }), ['joint.integrate']);
    await cp.record(learner, run({ reached: true }), ['joint.integrate']);
    await cp.record(learner, run({ taskId: 'u', reached: true, counts: undefined }), []);
    await cp.record(learner, run({ lessonId: 'other', reached: true }), ['quat.norm']);

    const evidence = journal.events.filter((e) => e.type === 'evidence');
    expect(evidence).toHaveLength(2);
    expect(evidence[0]).toMatchObject({ itemId: 'l/t', projectId: 'p', evidenceType: 'checkpoint', outcome: 1, kcs: [{ kc: 'joint.integrate', weight: 1 }] });
    expect((evidence[0] as { note: string }).note).toMatch(/41\/41 reached .* after 2 run/);
    expect(deriveLearnerState(journal.events, journal.now()).kcs.get('joint.integrate')?.history.evidence).toHaveLength(1);

    const runs = checkpointRuns(journal.events, 'p', 'l');
    expect(runs.get('t')).toMatchObject({ reached: true });
    expect(runs.get('t')!.runs).toHaveLength(3);
    expect(runs.get('u')!.runs[0]!.counts).toBeUndefined();
    expect([...checkpointRuns(journal.events, 'p').keys()]).toEqual(['l/t', 'l/u', 'other/t']);
    expect(checkpointRuns(journal.events, 'nope').size).toBe(0);
  });
});
