import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { LanguageProfile, TestResult, TestRun } from '../languages/profile.ts';
import { runTests } from '../languages/run.ts';
import type { Sandbox } from '../sandbox/sandbox.ts';
import { diffLines, type Hunk } from './diff.ts';

/** The parts of a generated Workout the gate checks. */
export interface Candidate {
  kind: 'kata' | 'drill';
  /** A Quick Workout: for a Kata, the gap must be 5–12 lines. */
  quick?: boolean;
  startingCode: string;
  referenceSolution: string;
  testSuiteCode: string;
  /** Drill only: the test that exposes the injected bug. */
  regressionTestName?: string;
}

export type Check = 'reference-passes' | 'starting-code-fails' | 'regression-test' | 'minimal-diff';

export interface CheckFailure {
  check: Check;
  message: string;
  /** The test runner's output, when the failure came from a test run. */
  output?: string;
}

export type Verification =
  | { verified: true; referenceRun: TestRun; startingRun: TestRun }
  | { verified: false; failures: CheckFailure[] };

export const DRILL_MAX_CHANGED_LINES = 3;
export const KATA_MAX_GAP_LINES = 3;
export const QUICK_KATA_REMOVED_LINES = { min: 5, max: 12 };

export interface VerifyOptions {
  /** Root for the profile's persistent cache directories (tests use a temp dir). */
  cacheRoot?: string;
}

/**
 * The Verified gate. Runs every check, rather than stopping at the first failure, so a retry can
 * be told everything that was wrong. Each test run happens in a fresh temp directory, in the sandbox.
 */
export async function verify(
  candidate: Candidate,
  profile: LanguageProfile,
  sandbox: Sandbox,
  { cacheRoot }: VerifyOptions = {},
): Promise<Verification> {
  const referenceRun = await runInTempWorkout(candidate.referenceSolution, candidate.testSuiteCode, profile, sandbox, cacheRoot);
  const startingRun = await runInTempWorkout(candidate.startingCode, candidate.testSuiteCode, profile, sandbox, cacheRoot);

  const failures = [
    ...checkReferencePasses(referenceRun),
    ...checkStartingCodeFails(startingRun),
    ...(candidate.kind === 'drill' ? checkRegressionTest(candidate.regressionTestName, startingRun) : []),
    ...checkMinimalDiff(candidate),
  ];
  return failures.length === 0 ? { verified: true, referenceRun, startingRun } : { verified: false, failures };
}

async function runInTempWorkout(
  code: string,
  tests: string,
  profile: LanguageProfile,
  sandbox: Sandbox,
  cacheRoot: string | undefined,
): Promise<TestRun> {
  const dir = await mkdtemp(join(tmpdir(), 'kintsugi-verify-'));
  try {
    const files = { ...profile.supportFiles, [profile.codeFilename]: code, [profile.testFilename]: tests };
    for (const [name, content] of Object.entries(files)) {
      await mkdir(dirname(join(dir, name)), { recursive: true });
      await writeFile(join(dir, name), content);
    }
    return await runTests(sandbox, profile, dir, cacheRoot);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

export function checkReferencePasses(run: TestRun): CheckFailure[] {
  if (!run.ran) {
    return [{ check: 'reference-passes', message: 'The tests did not run against the Reference Solution.', output: run.output }];
  }
  const failing = run.tests.filter((t) => t.outcome !== 'pass');
  if (failing.length === 0) return [];
  return [
    {
      check: 'reference-passes',
      message: `The Reference Solution fails its own tests: ${describe(failing)}.`,
      output: run.output,
    },
  ];
}

export function checkStartingCodeFails(run: TestRun): CheckFailure[] {
  const fail = (message: string): CheckFailure[] => [{ check: 'starting-code-fails', message, output: run.output }];
  if (!run.ran) return fail('The tests did not run against the Starting Code: it must load and run, then fail by assertion.');

  const problems: string[] = [];
  const errors = run.tests.filter((t) => t.outcome === 'error');
  if (errors.length > 0) {
    problems.push(`these tests crash instead of failing by assertion: ${describe(errors)}`);
  }
  if (!run.tests.some((t) => t.outcome === 'assertion-failure')) problems.push('no test fails by assertion');
  if (!run.tests.some((t) => t.outcome === 'pass')) problems.push('no test passes, so the Starting Code looks simply broken');
  return problems.length === 0 ? [] : fail(`Against the Starting Code, ${problems.join('; ')}.`);
}

export function checkRegressionTest(name: string | undefined, run: TestRun): CheckFailure[] {
  const fail = (message: string): CheckFailure[] => [{ check: 'regression-test', message }];
  if (!name) return fail('A Drill must name its Regression Test.');
  if (!run.ran) return []; // Already reported by the Starting Code check.

  const matches = findTests(name, run.tests);
  const known = run.tests.map((t) => t.name).join(', ');
  if (matches.length === 0) return fail(`No test is named "${name}". The tests are: ${known}.`);
  if (matches.length > 1) return fail(`"${name}" matches several tests (${describe(matches)}); name exactly one.`);
  if (matches[0]!.outcome !== 'assertion-failure') {
    return fail(`The Regression Test "${matches[0]!.name}" must fail by assertion against the Starting Code, but it ${outcomeVerb(matches[0]!)}.`);
  }
  return [];
}

/** A test name matches exactly, or as the last segment(s) of its path: `wrong` matches `add > wrong`. */
export function findTests(name: string, tests: TestResult[]): TestResult[] {
  const exact = tests.filter((t) => t.name === name);
  if (exact.length > 0) return exact;
  return tests.filter((t) => [' > ', '.', '/'].some((separator) => t.name.endsWith(`${separator}${name}`)));
}

export function checkMinimalDiff(candidate: Candidate): CheckFailure[] {
  const hunks = diffLines(candidate.referenceSolution, candidate.startingCode);
  const fail = (message: string): CheckFailure[] => [{ check: 'minimal-diff', message }];
  const what = candidate.kind === 'drill' ? 'injected bug' : 'gap';

  if (hunks.length === 0) return fail(`The Starting Code is identical to the Reference Solution: there is no ${what}.`);
  if (hunks.length > 1) {
    return fail(
      `The Starting Code differs from the Reference Solution in ${hunks.length} places (${hunks.map(where).join(', ')}); ` +
        `the ${what} must be a single contiguous region.`,
    );
  }

  const [hunk] = hunks as [Hunk];
  if (candidate.kind === 'drill') {
    const changed = Math.max(hunk.removed.length, hunk.added.length);
    if (changed > DRILL_MAX_CHANGED_LINES) {
      return fail(`The injected bug changes ${changed} lines (${where(hunk)}); it must change at most ${DRILL_MAX_CHANGED_LINES}.`);
    }
    return [];
  }

  if (hunk.removed.length === 0) return fail(`The gap removes nothing from the Reference Solution (${where(hunk)}).`);
  if (hunk.added.length > KATA_MAX_GAP_LINES) {
    return fail(`The gap is filled with ${hunk.added.length} placeholder lines; use at most ${KATA_MAX_GAP_LINES}.`);
  }
  const { min, max } = QUICK_KATA_REMOVED_LINES;
  if (candidate.quick && (hunk.removed.length < min || hunk.removed.length > max)) {
    return fail(`The gap removes ${hunk.removed.length} lines; a Quick Kata removes ${min} to ${max}.`);
  }
  return [];
}

/** Retry feedback for the LLM: each failed check, with the test output that shows why. */
export function describeFailures(failures: CheckFailure[], maxOutputChars = 4000): string {
  return failures
    .map((failure) => {
      const output = failure.output?.trim();
      const shown = output && output.length > maxOutputChars ? `…${output.slice(-maxOutputChars)}` : output;
      return [`[${failure.check}] ${failure.message}`, ...(shown ? ['Test output:', shown] : [])].join('\n');
    })
    .join('\n\n');
}

const describe = (tests: TestResult[]) => tests.map((t) => `"${t.name}" (${t.outcome})`).join(', ');

const outcomeVerb = (test: TestResult) => (test.outcome === 'pass' ? 'passes' : 'crashes');

function where(hunk: Hunk): string {
  const size = Math.max(hunk.removed.length, hunk.added.length);
  return size <= 1 ? `line ${hunk.line}` : `lines ${hunk.line}–${hunk.line + size - 1}`;
}
