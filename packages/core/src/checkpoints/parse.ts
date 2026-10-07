/**
 * Pass counts from a test run's output. Plain functions over text, one per test framework;
 * the first one that recognises its summary wins. Skipped tests count in neither column.
 */
export interface TestCounts {
  readonly passed: number;
  readonly failed: number;
  /** passed + failed. */
  readonly total: number;
  /** Which summary was recognised, e.g. "ctest". */
  readonly format: string;
  /** Names of failing tests, when the output lists them (deduplicated, at most 50). */
  readonly failures: readonly string[];
}

const MAX_FAILURES = 50;
// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b[@-Z\\-_]/g;

export function stripAnsi(text: string): string {
  return text.replace(ANSI, '');
}

const num = (s: string | undefined) => (s === undefined ? 0 : Number(s));

function lastMatch(text: string, re: RegExp): RegExpExecArray | undefined {
  const g = new RegExp(re.source, `${re.flags}g`);
  let last: RegExpExecArray | undefined;
  for (let m = g.exec(text); m !== null; m = g.exec(text)) last = m;
  return last;
}

function names(text: string, re: RegExp): string[] {
  const g = new RegExp(re.source, `${re.flags}g`);
  const out = new Set<string>();
  for (let m = g.exec(text); m !== null && out.size < MAX_FAILURES; m = g.exec(text)) out.add(m[1]!.trim().slice(0, 300));
  return [...out];
}

type Parser = (text: string) => Omit<TestCounts, 'total'> | undefined;

const PARSERS: readonly Parser[] = [
  // CTest: "95% tests passed, 2 tests failed out of 41", then "The following tests FAILED:" and "  3 - name (Failed)".
  (t) => {
    const m = lastMatch(t, /(\d+)% tests passed, (\d+) tests? failed out of (\d+)/);
    if (!m) return undefined;
    const failed = num(m[2]);
    const listed = t.includes('The following tests FAILED:') ? names(t.slice(t.lastIndexOf('The following tests FAILED:')), /^[ \t]*\d+\s+-\s+(.+?)[ \t]+\([^)]*\)[ \t]*$/m) : [];
    return { format: 'ctest', passed: num(m[3]) - failed, failed, failures: listed };
  },
  // GoogleTest: "[  PASSED  ] 10 tests." and "[  FAILED  ] 2 tests, listed below:" + "[  FAILED  ] Suite.Name".
  (t) => {
    const pass = lastMatch(t, /^\[\s+PASSED\s+\]\s+(\d+) tests?\./m);
    if (!pass) return undefined;
    const fail = lastMatch(t, /^\[\s+FAILED\s+\]\s+(\d+) tests?, listed below/m);
    const failures = fail ? names(t.slice(fail.index), /^\[\s+FAILED\s+\]\s+([A-Za-z_][\w/.]*(?:\.[\w/]+)+)/m) : [];
    return { format: 'gtest', passed: num(pass[1]), failed: num(fail?.[1]), failures };
  },
  // Catch2: "test cases: 10 | 7 passed | 3 failed" or "All tests passed (25 assertions in 10 test cases)".
  (t) => {
    const all = lastMatch(t, /All tests passed \(\d+ assertions? in (\d+) test cases?\)/);
    const mixed = lastMatch(t, /test cases:\s*(\d+)\s*\|\s*(\d+) passed\s*\|\s*(\d+) failed/);
    const onlyFailed = lastMatch(t, /test cases:\s*(\d+)\s*\|\s*(\d+) failed/);
    if (mixed) return { format: 'catch2', passed: num(mixed[2]), failed: num(mixed[3]), failures: [] };
    if (onlyFailed) return { format: 'catch2', passed: 0, failed: num(onlyFailed[2]), failures: [] };
    if (all) return { format: 'catch2', passed: num(all[1]), failed: 0, failures: [] };
    return undefined;
  },
  // Cargo: one "test result: …. 5 passed; 2 failed;" per test binary: they add up.
  (t) => {
    const g = /test result: \w+\. (\d+) passed; (\d+) failed;/g;
    let passed = 0;
    let failed = 0;
    let seen = false;
    for (let m = g.exec(t); m !== null; m = g.exec(t)) {
      seen = true;
      passed += num(m[1]);
      failed += num(m[2]);
    }
    if (!seen) return undefined;
    return { format: 'cargo', passed, failed, failures: names(t, /^---- (\S+) stdout ----$/m) };
  },
  // pytest: "==== 2 failed, 10 passed, 1 skipped in 0.12s ====" (errors count as failures).
  (t) => {
    const m = lastMatch(t, /^=+ (.*\b(?:passed|failed|error|errors)\b.*) in [\d.]+s(?: \([^)]*\))? =+$/m);
    if (!m) return undefined;
    const count = (word: string) => num(new RegExp(`(\\d+) ${word}\\b`).exec(m[1]!)?.[1]);
    return {
      format: 'pytest',
      passed: count('passed'),
      failed: count('failed') + count('errors?'),
      failures: names(t, /^(?:FAILED|ERROR) (\S+)/m),
    };
  },
  // Vitest: " Tests  2 failed | 10 passed (12)".
  (t) => {
    const m = lastMatch(t, /^[ \t]*Tests[ \t]+(?:(\d+) failed\s*\|\s*)?(?:(\d+) passed)?.*\((\d+)\)[ \t]*$/m);
    if (!m || (m[1] === undefined && m[2] === undefined)) return undefined;
    return { format: 'vitest', passed: num(m[2]), failed: num(m[1]), failures: names(t, /^[ \t]*(?:×|✗|FAIL)\s+(.+?)(?:\s+\d+ms)?$/m) };
  },
  // Jest: "Tests:       2 failed, 10 passed, 12 total".
  (t) => {
    const m = lastMatch(t, /^Tests:\s+(.*), (\d+) total$/m);
    if (!m) return undefined;
    const count = (word: string) => num(new RegExp(`(\\d+) ${word}`).exec(m[1]!)?.[1]);
    return { format: 'jest', passed: count('passed'), failed: count('failed'), failures: names(t, /^[ \t]*● (.+)$/m) };
  },
  // .NET: "Failed!  - Failed:     2, Passed:    8, Skipped: 0, Total: 10".
  (t) => {
    const m = lastMatch(t, /(?:Passed|Failed)!\s+-\s+Failed:\s+(\d+),\s+Passed:\s+(\d+)/);
    if (!m) return undefined;
    return { format: 'dotnet', passed: num(m[2]), failed: num(m[1]), failures: names(t, /^[ \t]*Failed (\S+) \[/m) };
  },
  // JUnit / Maven / Gradle: "Tests run: 12, Failures: 1, Errors: 0, Skipped: 1" (the last one is the total).
  (t) => {
    const m = lastMatch(t, /Tests run: (\d+), Failures: (\d+), Errors: (\d+)(?:, Skipped: (\d+))?/);
    if (!m) return undefined;
    const failed = num(m[2]) + num(m[3]);
    return { format: 'junit', passed: num(m[1]) - failed - num(m[4]), failed, failures: [] };
  },
  // Mocha: "  10 passing (20ms)" and "  2 failing".
  (t) => {
    const pass = lastMatch(t, /^[ \t]*(\d+) passing\b/m);
    if (!pass) return undefined;
    return { format: 'mocha', passed: num(pass[1]), failed: num(lastMatch(t, /^[ \t]*(\d+) failing\b/m)?.[1]), failures: [] };
  },
  // Go: one "--- PASS: TestX" / "--- FAIL: TestX" per test (subtests included).
  (t) => {
    const passed = t.match(/^[ \t]*--- PASS: /gm)?.length ?? 0;
    const failed = t.match(/^[ \t]*--- FAIL: /gm)?.length ?? 0;
    if (passed + failed === 0) return undefined;
    return { format: 'go', passed, failed, failures: names(t, /^[ \t]*--- FAIL: (\S+)/m) };
  },
  // TAP: "ok 1 - name" / "not ok 2 - name".
  (t) => {
    const passed = t.match(/^ok \d+\b/gm)?.length ?? 0;
    const failed = t.match(/^not ok \d+\b/gm)?.length ?? 0;
    if (passed + failed === 0) return undefined;
    return { format: 'tap', passed, failed, failures: names(t, /^not ok \d+\s*-?\s*(.+)$/m) };
  },
];

/** Pass counts from a test run's output, or undefined when no known summary is found. */
export function parseTestOutput(output: string): TestCounts | undefined {
  const text = stripAnsi(output).replace(/\r\n?/g, '\n');
  for (const parse of PARSERS) {
    const r = parse(text);
    if (r && r.passed >= 0 && r.failed >= 0) return { ...r, total: r.passed + r.failed };
  }
  return undefined;
}
