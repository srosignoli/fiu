import { homedir } from 'node:os';
import { join } from 'node:path';
import { loadRepoConfig, loadUserConfig, resolveConfig, type ConfigEnv } from '../config.ts';
import { describeCost } from '../cost/usage.ts';
import { watchForChanges } from '../runner/watch.ts';
import { formatRun } from '../runner/render.ts';
import { ignoredByWatcher, TrainingSession } from '../runner/session.ts';
import { verifySandbox } from '../sandbox/canary.ts';
import { openSandbox } from '../sandbox/sandbox.ts';
import { listPending, loadPending, type Outcome, type PendingWorkout } from '../workouts/store.ts';
import { findRepoRoot, workspacePaths } from '../workspace.ts';

/** The terminal, as `kin train` sees it. */
export interface TrainIo {
  print(text: string): void;
  /** The next key pressed; undefined if the read was aborted. */
  readKey(signal: AbortSignal): Promise<string | undefined>;
  /** Choose among several pending Workouts; undefined to cancel. */
  pick(workouts: PendingWorkout[]): Promise<PendingWorkout | undefined>;
  rate(): Promise<Outcome['rating']>;
  /** Open these files for editing, if the user has an editor configured. */
  openEditor?(files: string[]): void;
}

export interface TrainOptions {
  /** False with --no-sandbox: run the tests without isolation, for this invocation only. */
  sandbox: boolean;
}

export interface TrainDependencies {
  configEnv?: ConfigEnv;
  cacheRoot?: string;
  /** Quiet period before a save triggers a run (tests shorten it). */
  debounceMs?: number;
}

export type TrainResult =
  | { status: 'nothing-pending' }
  | { status: 'cancelled' }
  | { status: 'left-pending'; workoutId: string }
  | { status: Outcome['outcome']; workoutId: string; dir: string };

export class UnknownProfileError extends Error {}

export const KEYS_HELP = '[h] hint   [g] give up   [q] quit';

/** `kin train [id]`: run a Workout's tests on every save until it is Completed, Abandoned, or left for later. */
export async function train(
  cwd: string,
  id: string | undefined,
  options: TrainOptions,
  io: TrainIo,
  { configEnv = { env: process.env, home: homedir() }, cacheRoot, debounceMs }: TrainDependencies = {},
): Promise<TrainResult> {
  const repoRoot = await findRepoRoot(cwd);
  const paths = workspacePaths(repoRoot);

  let workout: PendingWorkout;
  if (id) {
    workout = await loadPending(paths, id);
  } else {
    const pending = await listPending(paths);
    if (pending.length === 0) return { status: 'nothing-pending' };
    const picked = pending.length === 1 ? pending[0] : await io.pick(pending);
    if (!picked) return { status: 'cancelled' };
    workout = picked;
  }

  const config = resolveConfig(await loadRepoConfig(paths.configFile), await loadUserConfig(configEnv));
  const profile = config.profiles.find((p) => p.id === workout.record.language);
  if (!profile) throw new UnknownProfileError(`No Language Profile "${workout.record.language}" is configured for ${workout.record.id}.`);

  const sandbox = await openSandbox({ repoRoot, allowUnsandboxed: !options.sandbox });
  try {
    if (!sandbox.isolated) io.print('Running the tests WITHOUT a sandbox (--no-sandbox). Only the environment is scrubbed.');
    await verifySandbox(sandbox, cacheRoot ? { cacheDir: cacheRoot } : {});
    const session = new TrainingSession({ paths, workout, profile, sandbox, cacheRoot });
    return await runSession(session, io, { debounceMs, ignore: ignoredByWatcher(profile) });
  } finally {
    await sandbox.dispose();
  }
}

async function runSession(
  session: TrainingSession,
  io: TrainIo,
  { debounceMs, ignore }: { debounceMs?: number; ignore: (path: string) => boolean },
): Promise<TrainResult> {
  const { record, dir } = session.workout;
  const files = [join(dir, 'README.md'), join(dir, record.files.code)];
  const header = [`${record.title} (${record.id})`, `  Incident report: ${files[0]}`, `  Fix the bug in:  ${files[1]}`];
  // Workouts saved before cost recording have none.
  if (record.cost) header.push(`  Generated for:   ${describeCost(record.cost)}`);
  io.print(header.join('\n'));
  if (await session.sourceChanged()) io.print('Source has changed since this Workout was made.');
  io.openEditor?.(files);

  let finish!: (outcome: Outcome['outcome'] | 'quit') => void;
  const finished = new Promise<Outcome['outcome'] | 'quit'>((resolve) => (finish = resolve));

  // Runs never overlap: a save during a run queues exactly one more.
  let running: Promise<void> | undefined;
  let rerun = false;
  const runTests = (trigger: 'start' | 'save') => {
    if (running) {
      rerun = true;
      return;
    }
    running = (async () => {
      let next: 'start' | 'save' | undefined = trigger;
      while (next) {
        rerun = false;
        const result = await session.runTests(next);
        io.print(formatRun(result));
        if (result.verdict.kind === 'completed') return finish('completed');
        next = rerun ? 'save' : undefined;
      }
      io.print(KEYS_HELP);
    })().finally(() => (running = undefined));
  };

  const watcher = await watchForChanges(dir, () => runTests('save'), { ignore, debounceMs });
  runTests('start');

  const keys = new AbortController();
  const outcome = await Promise.race([finished, readKeys(session, io, keys.signal, finish)]);
  keys.abort();
  watcher.close();
  // Let a run in progress finish before the Workout directory moves.
  await running;

  if (outcome === 'quit') {
    io.print(`Left pending. Resume with: kin train ${record.id}`);
    return { status: 'left-pending', workoutId: record.id };
  }
  io.print(outcome === 'completed' ? 'Completed. Well mended.' : 'Abandoned.');
  const rating = await io.rate();
  const doneDir = await session.finish(outcome, rating);
  return { status: outcome, workoutId: record.id, dir: doneDir };
}

async function readKeys(
  session: TrainingSession,
  io: TrainIo,
  signal: AbortSignal,
  finish: (outcome: Outcome['outcome'] | 'quit') => void,
): Promise<never> {
  for (;;) {
    const key = await io.readKey(signal);
    if (key === undefined) return new Promise<never>(() => {});
    if (key === 'h') {
      const next = session.nextHint();
      io.print(next ? `Hint ${next.number}/${next.total}: ${next.hint}` : 'No more hints.');
    } else if (key === 'g') {
      io.print(`Here is what the Reference Solution changes:\n${await session.solutionDiff()}`);
      finish('abandoned');
      return new Promise<never>(() => {});
    } else if (key === 'q') {
      finish('quit');
      return new Promise<never>(() => {});
    }
  }
}
