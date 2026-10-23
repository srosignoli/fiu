import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { execa } from 'execa';
import type { LanguageProfile, TestRun } from '../languages/profile.ts';
import { runTests } from '../languages/run.ts';
import type { Sandbox } from '../sandbox/sandbox.ts';
import { diffLines } from '../verify/diff.ts';
import { SOLUTION_DIRNAME } from '../workouts/save.ts';
import { finishWorkout, type Outcome, type PendingWorkout } from '../workouts/store.ts';
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
  /** Number of save-triggered runs so far (the initial run doesn't count). */
  attempts: number;
}

export interface TrainingSessionOptions {
  paths: WorkspacePaths;
  workout: PendingWorkout;
  profile: LanguageProfile;
  sandbox: Sandbox;
  cacheRoot?: string;
  now?: () => Date;
}

/** One sitting with one Workout. Holds no terminal state, so it can be driven by tests as well as by `kin train`. */
export class TrainingSession {
  readonly #options: TrainingSessionOptions;
  #attempts = 0;
  #hintsShown = 0;
  #finished = false;

  constructor(options: TrainingSessionOptions) {
    this.#options = options;
  }

  get workout(): PendingWorkout {
    return this.#options.workout;
  }

  get hintsUsed(): number {
    return this.#hintsShown;
  }

  /** Runs the tests in the sandbox. `save` runs count as attempts; the initial run doesn't. */
  async runTests(trigger: 'start' | 'save'): Promise<SessionRun> {
    const { profile, sandbox, workout, cacheRoot } = this.#options;
    if (trigger === 'save') this.#attempts++;
    const run = await runTests(sandbox, profile, workout.dir, cacheRoot);
    return { run, verdict: await this.#verdict(run), attempts: this.#attempts };
  }

  async #verdict(run: TestRun): Promise<RunVerdict> {
    if (!run.ran) return { kind: 'not-run' };
    if (run.tests.length === 0 || run.tests.some((t) => t.outcome !== 'pass')) return { kind: 'failing' };
    return (await this.testsEdited()) ? { kind: 'tests-edited' } : { kind: 'completed' };
  }

  /** True when the test file differs from the one the Workout was Verified with. */
  async testsEdited(): Promise<boolean> {
    const { dir, record } = this.#options.workout;
    const original = join(dir, record.files.originalTest ?? join(SOLUTION_DIRNAME, record.files.test));
    // Workouts saved before the original tests were kept can't be checked.
    if (!existsSync(original)) return false;
    const current = await readFile(join(dir, record.files.test), 'utf8').catch(() => '');
    return diffLines(await readFile(original, 'utf8'), current).length > 0;
  }

  /** The next Hint, or undefined when all have been shown. Each one revealed counts. */
  nextHint(): { hint: string; number: number; total: number } | undefined {
    const { hints } = this.#options.workout.record;
    if (this.#hintsShown >= hints.length) return undefined;
    return { hint: hints[this.#hintsShown]!, number: ++this.#hintsShown, total: hints.length };
  }

  /** What the human's current code would need to change to become the Reference Solution. */
  async solutionDiff(): Promise<string> {
    const { dir, record } = this.#options.workout;
    const current = await readFile(join(dir, record.files.code), 'utf8').catch(() => '');
    const solution = await readFile(join(dir, record.files.solution), 'utf8');
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

  /** Records the outcome in state.json and moves the Workout to done/. Returns its new directory. */
  async finish(outcome: Outcome['outcome'], rating?: Outcome['rating']): Promise<string> {
    if (this.#finished) throw new Error('This session has already finished.');
    this.#finished = true;
    const now = this.#options.now?.() ?? new Date();
    return finishWorkout(this.#options.paths, this.#options.workout, {
      workoutId: this.#options.workout.record.id,
      outcome,
      at: now.toISOString(),
      attempts: this.#attempts,
      hintsUsed: this.#hintsShown,
      ...(rating ? { rating } : {}),
    });
  }
}

/** Paths in a Workout directory whose changes don't trigger a test run. */
export function ignoredByWatcher(profile: LanguageProfile): (path: string) => boolean {
  return (path) =>
    path === 'README.md' ||
    path === 'workout.json' ||
    path.startsWith(`${SOLUTION_DIRNAME}/`) ||
    path === profile.resultFile ||
    path.split('/').some((part) => part === '__pycache__' || part === 'node_modules' || part.startsWith('.#')) ||
    /(~|\.swp|\.swx|\.tmp)$/.test(path);
}
