import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { execa } from 'execa';
import type { LanguageProfile, TestRun } from '../languages/profile.ts';
import { runTests } from '../languages/run.ts';
import type { Sandbox } from '../sandbox/sandbox.ts';
import { diffLines } from '../verify/diff.ts';
import { isAttemptBookkeeping, saveAttempt, type Attempt } from '../workouts/attempts.ts';
import type { WorkoutRecord } from '../workouts/save.ts';
import { recordOutcome, type Outcome } from '../workouts/store.ts';
import type { WorkspacePaths } from '../workspace.ts';

export type RunVerdict =
  | { kind: 'not-run' }
  | { kind: 'failing' }
  /** Every test passes, but the tests themselves were edited, so it doesn't count. */
  | { kind: 'tests-edited' }
  | { kind: 'completed' };

export interface SessionRun {
  run: TestRun;
  verdict: RunVerdict;
  /** Save-triggered runs in this Attempt so far (initial runs don't count). */
  runs: number;
}

export interface TrainingSessionOptions {
  paths: WorkspacePaths;
  /** The immutable Workout definition. */
  workout: { record: WorkoutRecord; dir: string };
  /** Where the human works. A resumed Attempt keeps its runs and Hints. */
  attempt: Attempt;
  profile: LanguageProfile;
  sandbox: Sandbox;
  cacheRoot?: string;
  now?: () => Date;
}

/**
 * One sitting with one Attempt at a Workout. Holds no terminal state, so it can be driven by tests as
 * well as by `kin train`. Progress is saved to the Attempt as it happens.
 */
export class TrainingSession {
  readonly #options: TrainingSessionOptions;
  #finished = false;

  constructor(options: TrainingSessionOptions) {
    this.#options = options;
  }

  get workout(): { record: WorkoutRecord; dir: string } {
    return this.#options.workout;
  }

  get attempt(): Attempt {
    return this.#options.attempt;
  }

  get hintsUsed(): number {
    return this.#options.attempt.record.hintsUsed;
  }

  /** Runs the tests in the Attempt, in the sandbox. `save` runs count; the initial run doesn't. */
  async runTests(trigger: 'start' | 'save'): Promise<SessionRun> {
    const { profile, sandbox, attempt, cacheRoot } = this.#options;
    if (trigger === 'save') {
      attempt.record.runs++;
      await saveAttempt(attempt);
    }
    const run = await runTests(sandbox, profile, attempt.dir, cacheRoot);
    return { run, verdict: await this.#verdict(run), runs: attempt.record.runs };
  }

  async #verdict(run: TestRun): Promise<RunVerdict> {
    if (!run.ran) return { kind: 'not-run' };
    if (run.tests.length === 0 || run.tests.some((t) => t.outcome !== 'pass')) return { kind: 'failing' };
    return (await this.testsEdited()) ? { kind: 'tests-edited' } : { kind: 'completed' };
  }

  /** True when the Attempt's test file differs from the one the Workout was Verified with. */
  async testsEdited(): Promise<boolean> {
    const { workout, attempt } = this.#options;
    // The Workout's own test file is the original: Workouts are never edited.
    const original = join(workout.dir, workout.record.files.test);
    if (!existsSync(original)) return false;
    const current = await readFile(join(attempt.dir, workout.record.files.test), 'utf8').catch(() => '');
    return diffLines(await readFile(original, 'utf8'), current).length > 0;
  }

  /** The next Hint, or undefined when all have been shown. Each one revealed counts, across resumes. */
  async nextHint(): Promise<{ hint: string; number: number; total: number } | undefined> {
    const { hints } = this.#options.workout.record;
    const { attempt } = this.#options;
    if (attempt.record.hintsUsed >= hints.length) return undefined;
    const number = ++attempt.record.hintsUsed;
    await saveAttempt(attempt);
    return { hint: hints[number - 1]!, number, total: hints.length };
  }

  /** What the human's current code would need to change to become the Reference Solution. */
  async solutionDiff(): Promise<string> {
    const { workout, attempt } = this.#options;
    const current = await readFile(join(attempt.dir, workout.record.files.code), 'utf8').catch(() => '');
    const solution = await readFile(join(workout.dir, workout.record.files.solution), 'utf8');
    const hunks = diffLines(current, solution);
    if (hunks.length === 0) return 'Your code already matches the Reference Solution.';
    return hunks
      .map((hunk) => [`@@ line ${hunk.line} @@`, ...hunk.removed.map((l) => `- ${l}`), ...hunk.added.map((l) => `+ ${l}`)].join('\n'))
      .join('\n');
  }

  /** True when the drilled source file has changed since the commit the Source Anchors point into. */
  async sourceChanged(): Promise<boolean> {
    const { source } = this.#options.workout.record;
    if (!source.commit) return false;
    const repoRoot = this.#options.paths.repoRoot;
    if (!existsSync(join(repoRoot, source.path))) return true;
    const diff = await execa('git', ['diff', '--quiet', source.commit, '--', source.path], { cwd: repoRoot, reject: false });
    return diff.exitCode !== 0;
  }

  /** Finishes the Attempt: its outcome goes into the Attempt and into state.json. The Workout stays as it is. */
  async finish(outcome: Outcome['outcome'], rating?: Outcome['rating']): Promise<void> {
    if (this.#finished) throw new Error('This session has already finished.');
    this.#finished = true;
    const { attempt, paths } = this.#options;
    const at = (this.#options.now?.() ?? new Date()).toISOString();
    Object.assign(attempt.record, { outcome, finishedAt: at, ...(rating ? { rating } : {}) });
    await saveAttempt(attempt);
    await recordOutcome(paths, {
      workoutId: attempt.record.workoutId,
      attempt: attempt.record.number,
      outcome,
      at,
      runs: attempt.record.runs,
      hintsUsed: attempt.record.hintsUsed,
      ...(rating ? { rating } : {}),
    });
  }
}

/** Paths in an Attempt directory whose changes don't trigger a test run. */
export function ignoredByWatcher(profile: LanguageProfile): (path: string) => boolean {
  return (path) =>
    isAttemptBookkeeping(path) ||
    path === profile.resultFile ||
    path.split('/').some((part) => part === '__pycache__' || part === 'node_modules' || part.startsWith('.#')) ||
    /(~|\.swp|\.swx|\.tmp)$/.test(path);
}
