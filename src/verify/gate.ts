import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { LanguageProfile, TestResult, TestRun } from '../languages/profile.ts';
import { runTests } from '../languages/run.ts';
import type { Sandbox } from '../sandbox/sandbox.ts';
import type { DiagnosisCause, PredictionOption, WorkoutKind } from '../synthesis/schema.ts';
import { matchSource, unanchoredRegions } from './defect.ts';
import { diffLines, type Hunk } from './diff.ts';

/** The parts of a generated Workout the gate checks. */
export interface Candidate {
  kind: WorkoutKind;
  /** A Quick Workout: for a Kata, the gap must be 5–12 lines. */
  quick?: boolean;
  /** Drill and Kata only. */
  startingCode?: string;
  referenceSolution: string;
  testSuiteCode: string;
  /** Drill only: the test that exposes the injected bug. */
  regressionTestName?: string;
  /** Prediction only: its four options, each pinned by its own test. */
  options?: PredictionOption[];
  /** Diagnosis only: its four Causes, each a Variant with a test for its Symptom. */
  causes?: DiagnosisCause[];
  /** Prediction and Diagnosis: the source file, where a Variant must not be found (it would be what the code really does). */
  source?: string;
  lineComment?: string;
  /** Prediction from a commit only: the unit before the commit, the old-behaviour option's code. */
  previous?: string;
  /** Prediction from a commit only: the source file before the commit, where the Previous Version is anchored. */
  sourceBefore?: string;
}

export type Check = 'reference-passes' | 'starting-code-fails' | 'regression-test' | 'minimal-diff' | 'option-tests' | 'outcomes' | 'real-variant' | 'previous';

export interface CheckFailure {
  check: Check;
  message: string;
  /** The test runner's output, when the failure came from a test run. */
  output?: string;
}

export type Verification =
  /** `startingRun` for a Drill or Kata; `variantRuns` for a Prediction, one per wrong option in order. */
  | { verified: true; referenceRun: TestRun; startingRun?: TestRun; variantRuns?: TestRun[] }
  | { verified: false; failures: CheckFailure[] };

export const DRILL_MAX_CHANGED_LINES = 3;
export const KATA_MAX_GAP_LINES = 3;
export const QUICK_KATA_REMOVED_LINES = { min: 5, max: 12 };
/** A Kata's gap is one mechanism: fewer lines is trivia, more is rebuilding a module. */
export const KATA_REMOVED_LINES = { min: 5, max: 25 };

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
  if (candidate.kind === 'prediction') return verifyPrediction(candidate, profile, sandbox, cacheRoot);
  if (candidate.kind === 'diagnosis') return verifyDiagnosis(candidate, profile, sandbox, cacheRoot);
  const referenceRun = await runInTempWorkout(candidate.referenceSolution, candidate.testSuiteCode, profile, sandbox, cacheRoot);
  const startingRun = await runInTempWorkout(candidate.startingCode ?? '', candidate.testSuiteCode, profile, sandbox, cacheRoot);

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
  const hunks = diffLines(candidate.referenceSolution, candidate.startingCode ?? '');
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
  const { min, max } = candidate.quick ? QUICK_KATA_REMOVED_LINES : KATA_REMOVED_LINES;
  if (hunk.removed.length < min || hunk.removed.length > max) {
    return fail(`The gap removes ${hunk.removed.length} lines; a ${candidate.quick ? 'Quick ' : ''}Kata removes ${min} to ${max}.`);
  }
  return [];
}

/** A Variant: the Reference Solution with its one snippet replaced. */
export function buildVariant(referenceSolution: string, variant: PredictionOption['variant']): string {
  return referenceSolution.replace(variant.original, () => variant.changed);
}

/**
 * A Prediction's gate: against the Reference Solution only the true option's test passes, and against
 * each Variant only that option's test passes; every other test fails by assertion. Each Variant is one
 * small region, distinct from the others, and not what the source file itself does.
 */
async function verifyPrediction(candidate: Candidate, profile: LanguageProfile, sandbox: Sandbox, cacheRoot: string | undefined): Promise<Verification> {
  const options = candidate.options ?? [];
  const run = (code: string) => runInTempWorkout(code, candidate.testSuiteCode, profile, sandbox, cacheRoot);
  const referenceRun = await run(candidate.referenceSolution);
  // The old-behaviour option's code is the Previous Version itself, not a snippet Variant.
  const codeFor = (option: PredictionOption) => (option.previous ? (candidate.previous ?? '') : buildVariant(candidate.referenceSolution, option.variant));
  const wrong = options.flatMap((option, index) => (option.correct ? [] : [{ option, index, code: codeFor(option) }]));
  const variantRuns: TestRun[] = [];
  for (const { code } of wrong) variantRuns.push(await run(code));

  const failures = [
    ...checkOptionTests(options, referenceRun),
    ...checkOutcomes(options, options.findIndex((o) => o.correct), 'the Reference Solution', referenceRun),
    ...wrong.flatMap(({ option, index }, i) =>
      checkOutcomes(options, index, option.previous ? `option ${index + 1}'s previous (the code before the commit)` : `option ${index + 1}'s Variant`, variantRuns[i]!),
    ),
    ...wrong.flatMap(({ option, index, code }, i) =>
      option.previous ? checkPrevious(candidate, index, code, wrong.slice(0, i)) : checkVariantDiff(candidate, index, code, wrong.slice(0, i)),
    ),
  ];
  return failures.length === 0 ? { verified: true, referenceRun, variantRuns } : { verified: false, failures };
}

/**
 * A Diagnosis's gate: against the healthy Reference Solution no Symptom test passes, and against each
 * Cause's Variant only that Cause's test passes; every other test fails by assertion. Each Variant is one
 * small region, distinct from the others. A wrong Cause isn't what the source does; the true one may be,
 * which is the notice that the bug may be real (§11.7).
 */
async function verifyDiagnosis(candidate: Candidate, profile: LanguageProfile, sandbox: Sandbox, cacheRoot: string | undefined): Promise<Verification> {
  const causes = candidate.causes ?? [];
  const run = (code: string) => runInTempWorkout(code, candidate.testSuiteCode, profile, sandbox, cacheRoot);
  const referenceRun = await run(candidate.referenceSolution);
  const codes = causes.map((cause) => buildVariant(candidate.referenceSolution, cause.variant));
  const variantRuns: TestRun[] = [];
  for (const code of codes) variantRuns.push(await run(code));

  const failures = [
    ...checkOptionTests(causes, referenceRun),
    ...checkNoSymptom(causes, referenceRun),
    ...causes.flatMap((_, i) => checkOutcomes(causes, i, `Cause ${i + 1}'s Variant`, variantRuns[i]!)),
    // The source check below is the Diagnosis's own: a true Cause found in the source isn't a failure.
    ...codes.flatMap((code, i) =>
      checkVariantDiff({ ...candidate, source: undefined }, i, code, codes.slice(0, i).map((earlier, index) => ({ index, code: earlier }))),
    ),
    ...codes.flatMap((code, i): CheckFailure[] =>
      !causes[i]!.correct && candidate.source !== undefined && matchSource({ referenceSolution: candidate.referenceSolution, startingCode: code }, candidate.source, candidate.lineComment)
        ? [{ check: 'real-variant', message: `Cause ${i + 1} is what the source does, so it can't be a wrong Cause: the Reference Solution must behave like the healthy code, and if the source has this bug, say so in originalDefect.` }]
        : [],
    ),
  ];
  return failures.length === 0 ? { verified: true, referenceRun, variantRuns } : { verified: false, failures };
}

/** Against the healthy code, every Symptom test fails by assertion. */
function checkNoSymptom(causes: DiagnosisCause[], run: TestRun): CheckFailure[] {
  const fail = (message: string): CheckFailure[] => [{ check: 'outcomes', message, output: run.output }];
  if (!run.ran) return fail('The tests did not run against the Reference Solution.');
  const problems: string[] = [];
  causes.forEach((cause, i) => {
    const [test] = findTests(cause.testName, run.tests);
    if (test?.outcome === 'pass') problems.push(`Cause ${i + 1}'s test passes`);
    else if (test?.outcome === 'error') problems.push(`Cause ${i + 1}'s test crashes`);
  });
  return problems.length === 0 ? [] : fail(`The Reference Solution is the healthy code, so every Symptom test must fail against it by assertion: ${problems.join('; ')}.`);
}

/** Each option names exactly one test, and every test belongs to an option. */
export function checkOptionTests(options: Pick<PredictionOption, 'testName'>[], run: TestRun): CheckFailure[] {
  if (!run.ran) return [];
  const fail = (message: string): CheckFailure[] => [{ check: 'option-tests', message }];
  const known = run.tests.map((t) => t.name).join(', ');
  const problems: string[] = [];
  const claimed = new Set<string>();
  options.forEach((option, i) => {
    const matches = findTests(option.testName, run.tests);
    if (matches.length === 0) problems.push(`option ${i + 1}'s test "${option.testName}" doesn't exist`);
    else if (matches.length > 1) problems.push(`option ${i + 1}'s test "${option.testName}" matches several tests (${describe(matches)})`);
    else claimed.add(matches[0]!.name);
  });
  const extra = run.tests.filter((t) => !claimed.has(t.name));
  if (problems.length === 0 && extra.length > 0) problems.push(`these tests belong to no option: ${describe(extra)}; there is exactly one test per option`);
  return problems.length === 0 ? [] : fail(`${problems.join('; ')}. The tests are: ${known}.`);
}

/** Against one version of the code, only the expected option's test passes; the others fail by assertion. */
export function checkOutcomes(options: Pick<PredictionOption, 'testName'>[], expected: number, label: string, run: TestRun): CheckFailure[] {
  const fail = (message: string): CheckFailure[] => [{ check: 'outcomes', message, output: run.output }];
  if (!run.ran) return fail(`The tests did not run against ${label}.`);
  const problems: string[] = [];
  options.forEach((option, i) => {
    const [test] = findTests(option.testName, run.tests);
    if (!test) return; // Reported by the option-tests check.
    if (test.outcome === 'error') problems.push(`option ${i + 1}'s test crashes`);
    else if (i === expected && test.outcome !== 'pass') problems.push(`option ${i + 1}'s test fails, but it must pass`);
    else if (i !== expected && test.outcome === 'pass') problems.push(`option ${i + 1}'s test passes too`);
  });
  if (problems.length === 0) return [];
  return fail(`Against ${label}, only option ${expected + 1}'s test may pass and the others must fail by assertion: ${problems.join('; ')}.`);
}

/** The Previous Version: any size, but different from the others, and anchored to the file before and after the commit. */
function checkPrevious(candidate: Candidate, index: number, code: string, earlier: { index: number; code: string }[]): CheckFailure[] {
  const which = `Option ${index + 1}'s previous (the code before the commit)`;
  if (diffLines(candidate.referenceSolution, code).length === 0) return [{ check: 'previous', message: `${which} is identical to the Reference Solution: the commit must change the outcome.` }];
  const failures: CheckFailure[] = [];
  const twin = earlier.find((e) => diffLines(e.code, code).length === 0);
  if (twin) failures.push({ check: 'previous', message: `${which} is identical to option ${twin.index + 1}'s Variant.` });
  // A fetched Prediction has no sharer's source to compare with: that check ran when it was made.
  if (candidate.source !== undefined && candidate.sourceBefore !== undefined) {
    const loose = unanchoredRegions(candidate.referenceSolution, code, candidate.sourceBefore, candidate.source, candidate.lineComment);
    if (loose.length > 0) {
      const regions = loose.map(({ line, missing }) => `line ${line} ("${missing}" is not in the file before the commit)`).join('; ');
      failures.push({
        check: 'previous',
        message:
          `${which} differs from the Reference Solution in ways the old file doesn't have: ${regions}. ` +
          'It must be the same unit as the referenceSolution, differing only where the commit changed it, with those changed lines copied from the file before the commit as they were, even where the rest of the unit uses fakes.',
      });
    }
  }
  return failures;
}

/** One small region per Variant, no two alike, and none of them what the source file itself does. */
function checkVariantDiff(candidate: Candidate, index: number, code: string, earlier: { index: number; code: string }[]): CheckFailure[] {
  const failures: CheckFailure[] = [];
  const which = `Option ${index + 1}'s Variant`;
  const hunks = diffLines(candidate.referenceSolution, code);
  if (hunks.length === 0) failures.push({ check: 'minimal-diff', message: `${which} is identical to the Reference Solution.` });
  else if (hunks.length > 1) failures.push({ check: 'minimal-diff', message: `${which} differs from the Reference Solution in ${hunks.length} places; it must be one region.` });
  else {
    const changed = Math.max(hunks[0]!.removed.length, hunks[0]!.added.length);
    if (changed > DRILL_MAX_CHANGED_LINES) failures.push({ check: 'minimal-diff', message: `${which} changes ${changed} lines; it must change at most ${DRILL_MAX_CHANGED_LINES}.` });
  }
  const twin = earlier.find((e) => diffLines(e.code, code).length === 0);
  if (twin) failures.push({ check: 'minimal-diff', message: `${which} is identical to option ${twin.index + 1}'s.` });
  if (candidate.source !== undefined && matchSource({ referenceSolution: candidate.referenceSolution, startingCode: code }, candidate.source, candidate.lineComment)) {
    failures.push({
      check: 'real-variant',
      message: `Option ${index + 1}'s code is what the source does: the Reference Solution must behave like the source, and that option is then the true one.`,
    });
  }
  return failures;
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
