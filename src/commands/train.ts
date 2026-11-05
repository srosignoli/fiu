import { homedir } from 'node:os';
import { join } from 'node:path';
import { AUTO_DEFAULTS, loadRepoConfig, loadUserConfig, resolveConfig, type ConfigEnv, type RepoConfig } from '../config.ts';
import { expireStaleWorkouts } from '../background/refill.ts';
import { describeCost } from '../cost/usage.ts';
import { BackgroundCommand, describeDuration, reportResult, type CommandResult } from '../runner/background.ts';
import { watchForChanges } from '../runner/watch.ts';
import { formatRun } from '../runner/render.ts';
import { ignoredByWatcher, TrainingSession } from '../runner/session.ts';
import { verifySandbox } from '../sandbox/canary.ts';
import { openSandbox } from '../sandbox/sandbox.ts';
import { preflight } from '../languages/run.ts';
import { openAttempt } from '../workouts/attempts.ts';
import { nextQuickWorkout } from '../workouts/queue.ts';
import type { PredictionOption } from '../synthesis/schema.ts';
import type { Confidence } from '../workouts/attempts.ts';
import { incidentOf, PRACTICE_INCIDENT, WHAT_IF_LIMITS, whatIfLines, type WorkoutRecord } from '../workouts/save.ts';
import { listWorkouts, loadWorkout, nextInSeries, WorkoutDiscardedError, type Outcome, type StoredWorkout } from '../workouts/store.ts';
import { findRepoRoot, workspacePaths } from '../workspace.ts';

/** The terminal, as `fiu train` sees it. */
export interface TrainIo {
  print(text: string): void;
  /** The next key pressed; undefined if the read was aborted. */
  readKey(signal: AbortSignal): Promise<string | undefined>;
  /** Choose among several Workouts (open Attempts first, then the queue); undefined to cancel. */
  pick(workouts: StoredWorkout[]): Promise<StoredWorkout | undefined>;
  rate(): Promise<Outcome['rating']>;
  /** "Is it a real bug in your code?": true, false, or undefined to skip. */
  confirmDefect(): Promise<boolean | undefined>;
  /** Open these files for editing, if the user has an editor configured. */
  openEditor?(files: string[]): void;
  /** Show progress (e.g. a spinner with `status()`) until `until` settles. */
  wait?(status: () => string, until: Promise<unknown>): Promise<void>;
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
  /** `fiu quick --while`: the user's command running alongside, announced when it ends and shown on [s]. */
  background?: BackgroundCommand;
}

export type TrainResult =
  | { status: 'nothing-pending' }
  | { status: 'cancelled' }
  | { status: 'left-pending'; workoutId: string; attempt: number }
  | { status: Outcome['outcome']; workoutId: string; attempt: number; dir: string };

export class UnknownProfileError extends Error {}

/** `fiu quick`: straight into the queue's best Quick Workout, no picker, no prompts. */
export async function quick(
  cwd: string,
  options: TrainOptions,
  io: TrainIo,
  dependencies: TrainDependencies = {},
): Promise<TrainResult | { status: 'nothing-ready' }> {
  const paths = workspacePaths(await findRepoRoot(cwd));
  // A stale commit Workout shouldn't be served; expiring it also frees its queue slot.
  const repoConfig = await loadRepoConfig(paths.configFile);
  await expireStaleWorkouts(paths, { ...AUTO_DEFAULTS, ...repoConfig.auto }.expiryDays, new Date());
  const next = await nextQuickWorkout(paths, await preferredKinds(repoConfig, dependencies.configEnv));
  if (!next) return { status: 'nothing-ready' };
  return train(cwd, next.record.id, options, io, dependencies);
}

/** The kinds `fiu quick` serves first: the repository's `kinds`, else yours. */
async function preferredKinds(repoConfig: RepoConfig, configEnv: ConfigEnv = { env: process.env, home: homedir() }) {
  return resolveConfig(repoConfig, await loadUserConfig(configEnv)).kinds;
}

export const KEYS_HELP = '[h] hint   [g] give up   [q] quit';

/** `fiu train [id]`: run a Workout's tests on every save until it is Completed, Abandoned, or left for later. */
export async function train(
  cwd: string,
  id: string | undefined,
  options: TrainOptions,
  io: TrainIo,
  { configEnv = { env: process.env, home: homedir() }, cacheRoot, debounceMs, background }: TrainDependencies = {},
): Promise<TrainResult> {
  const repoRoot = await findRepoRoot(cwd);
  const paths = workspacePaths(repoRoot);

  let workout: StoredWorkout;
  if (id) {
    // Any Workout can be trained on again by id; redoing one is always this explicit.
    workout = await loadWorkout(paths, id);
    if (workout.status === 'discarded') throw new WorkoutDiscardedError(id);
  } else {
    const all = await listWorkouts(paths);
    const pending = [...all.filter((w) => w.status === 'in-progress'), ...all.filter((w) => w.status === 'queued')];
    // A Series is one row: its open question if it has one (pending lists those first), else its first unanswered one.
    const shownSeries = new Set<string>();
    const choices = pending.filter((w) => {
      const series = w.record.series;
      if (!series) return true;
      const first = w.status === 'in-progress' || !pending.some((o) => o.record.series?.id === series.id && o.status === 'queued' && o.record.series.index < series.index);
      if (!first || shownSeries.has(series.id)) return false;
      shownSeries.add(series.id);
      return true;
    });
    if (choices.length === 0) return { status: 'nothing-pending' };
    const picked = choices.length === 1 ? choices[0] : await io.pick(choices);
    if (!picked) return { status: 'cancelled' };
    workout = picked;
  }

  const config = resolveConfig(await loadRepoConfig(paths.configFile), await loadUserConfig(configEnv));
  const profile = config.profiles.find((p) => p.id === workout.record.language);
  if (!profile) throw new UnknownProfileError(`No Language Profile "${workout.record.language}" is configured for ${workout.record.id}.`);

  // A Prediction or Diagnosis runs nothing during its Attempt: every outcome was measured when it was Verified.
  if (workout.record.kind === 'diagnosis') {
    const { attempt, resumed } = await openAttempt(paths, workout, profile);
    return runDiagnosis(new TrainingSession({ paths, workout, attempt, profile, cacheRoot }), io, { resumed, background });
  }
  if (workout.record.kind === 'prediction') {
    for (;;) {
      const { attempt, resumed } = await openAttempt(paths, workout, profile);
      const result = await runPrediction(new TrainingSession({ paths, workout, attempt, profile, cacheRoot }), io, { resumed, background });
      // A Series offers its next question, one key away.
      const next = result.status === 'completed' || result.status === 'abandoned' ? await nextInSeries(paths, workout.record) : undefined;
      if (!next) return result;
      io.print(`[n] next question (${next.record.series!.index} of ${next.record.series!.of})   [any other key] stop here`);
      const read = new AbortController();
      if ((await io.readKey(read.signal)) !== 'n') {
        io.print(`The rest of the Series waits in the queue: fiu train ${next.record.id}`);
        return result;
      }
      workout = next;
    }
  }

  const sandbox = await openSandbox({ repoRoot, allowUnsandboxed: !options.sandbox });
  try {
    if (!sandbox.isolated) io.print('Running the tests WITHOUT a sandbox (--no-sandbox). Only the environment is scrubbed.');
    await verifySandbox(sandbox, cacheRoot ? { cacheDir: cacheRoot } : {});
    await preflight(sandbox, profile, cacheRoot);
    const { attempt, resumed } = await openAttempt(paths, workout, profile);
    const session = new TrainingSession({ paths, workout, attempt, profile, sandbox, cacheRoot });
    return await runSession(session, io, { debounceMs, resumed, ignore: ignoredByWatcher(profile), background });
  } finally {
    await sandbox.dispose();
  }
}

async function runSession(
  session: TrainingSession,
  io: TrainIo,
  {
    debounceMs,
    resumed,
    ignore,
    background,
  }: { debounceMs?: number; resumed: boolean; ignore: (path: string) => boolean; background?: BackgroundCommand },
): Promise<TrainResult> {
  const keysHelp = background ? `${KEYS_HELP}   [s] \`${background.command}\`` : KEYS_HELP;
  const { record } = session.workout;
  const attempt = session.attempt;
  const files = [join(session.workout.dir, 'README.md'), join(attempt.dir, record.files.code)];
  const header = [
    `${record.title} (${record.id}), attempt ${attempt.record.number}${resumed ? ', resumed' : ''}`,
    ...(record.kind === 'kata'
      ? [`  Brief:           ${files[0]}`, `  Fill in:         ${files[1]}`]
      : [`  Incident report: ${files[0]}`, `  Fix the bug in:  ${files[1]}`]),
  ];
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
        io.print(formatRun(result, next));
        if (result.verdict.kind === 'completed') return finish('completed');
        next = rerun ? 'save' : undefined;
      }
      io.print(keysHelp);
    })().finally(() => (running = undefined));
  };

  const watcher = await watchForChanges(attempt.dir, () => runTests('save'), { ignore, debounceMs });
  runTests('start');

  // The moment the user's command ends, say so (with a bell): the Workout itself carries on.
  let ended = false;
  void background?.done.then(async (result) => {
    if (ended || background.reported) return;
    const report = await reportResult(background, result);
    if (ended || background.reported) return;
    background.reported = true;
    io.print(`\x07${report}`);
  });

  const keys = new AbortController();
  const outcome = await Promise.race([finished, readKeys(session, io, keys.signal, finish, background)]);
  keys.abort();
  ended = true;
  watcher.close();
  // Let a run in progress finish before the Attempt is closed.
  await running;

  const number = attempt.record.number;
  if (outcome === 'quit') {
    io.print(`Attempt ${number} left open. Resume with: fiu train ${record.id}`);
    return { status: 'left-pending', workoutId: record.id, attempt: number };
  }
  io.print(outcome === 'completed' ? 'Completed. Well mended.' : 'Abandoned.');
  return closeAttempt(session, io, outcome);
}

/** After any finished Attempt: the source-bug notice and question, the rating, and the outcome recorded. */
async function closeAttempt(session: TrainingSession, io: TrainIo, outcome: Outcome['outcome'], confidence?: Confidence): Promise<TrainResult> {
  const { record } = session.workout;
  let defectConfirmed: boolean | undefined;
  if (record.originalDefect) {
    io.print(describeDefect(record));
    if (await session.sourceChanged()) io.print('Source has changed since this Workout was made.');
    if (await session.firstToFinish()) defectConfirmed = await io.confirmDefect();
  }
  const rating = await io.rate();
  await session.finish(outcome, rating, defectConfirmed, confidence);
  return { status: outcome, workoutId: record.id, attempt: session.attempt.record.number, dir: session.attempt.dir };
}

/**
 * The one answer of a Prediction or Diagnosis: a key per option, in the order shown, then how sure the
 * human was (asked before the reveal, so it is about the answer, not the outcome: §11.12).
 */
async function readAnswer(io: TrainIo, indices: number[], id: string, number: number, background?: BackgroundCommand): Promise<{ picked: number; confidence?: Confidence } | 'left'> {
  let ended = false;
  void background?.done.then(async (result) => {
    if (ended || background.reported) return;
    const report = await reportResult(background, result);
    if (ended || background.reported) return;
    background.reported = true;
    io.print(`\x07${report}`);
  });

  let picked: number | undefined;
  while (picked === undefined) {
    const read = new AbortController();
    const key = await io.readKey(read.signal);
    if (key === 'q' || key === undefined) {
      ended = true;
      io.print(`Attempt ${number} left open. Resume with: fiu train ${id}`);
      return 'left';
    }
    if (key === 's' && background) io.print(await backgroundStatus(background));
    const choice = Number(key);
    if (Number.isInteger(choice) && choice >= 1 && choice <= indices.length) picked = indices[choice - 1]!;
  }
  ended = true;

  io.print('How sure were you? [1] guessing   [2] fairly sure   [3] certain   [any other key] skip');
  const sure = await io.readKey(new AbortController().signal);
  const confidence = CONFIDENCE_KEYS[sure ?? ''];
  return { picked, ...(confidence ? { confidence } : {}) };
}

/** A Diagnosis's Attempt: the practice incident and the shuffled Causes, one answer, then the truth and what the wrong answer would have looked like. */
async function runDiagnosis(session: TrainingSession, io: TrainIo, { resumed, background }: { resumed: boolean; background?: BackgroundCommand }): Promise<TrainResult> {
  const { record } = session.workout;
  const { explanation } = record.diagnosis!;
  const shown = session.diagnosisCauses();
  const number = session.attempt.record.number;
  const keys = `[1]-[${shown.length}] answer   [q] quit${background ? `   [s] \`${background.command}\`` : ''}`;
  io.print(
    [
      `${record.title} (${record.id}), attempt ${number}${resumed ? ', resumed' : ''}`,
      '',
      PRACTICE_INCIDENT,
      '',
      incidentOf(record),
      '',
      'What explains it?',
      ...shown.map(({ cause }, i) => `  [${i + 1}] ${cause.text.trim()}`),
      '',
      keys,
    ].join('\n'),
  );

  const answer = await readAnswer(io, shown.map(({ index }) => index), record.id, number, background);
  if (answer === 'left') return { status: 'left-pending', workoutId: record.id, attempt: number };

  const { outcome, chosen, truth } = await session.diagnose(answer.picked);
  const reveal =
    outcome === 'completed'
      ? [`Right: ${truth.text.trim()}`]
      : [`Not quite. The cause: ${truth.text.trim()}`, `Your answer would have shown up differently: ${chosen.symptom.trim()}`];
  const anchors = record.sourceAnchors.map((a) => `  ${a.path}:${a.startLine}-${a.endLine}: ${a.explanation}`);
  io.print([...reveal, '', explanation.trim(), '', 'Where this lives:', ...anchors].join('\n'));
  if (outcome === 'abandoned') {
    io.print('[d] the code difference behind the true cause   [any other key] continue');
    if ((await io.readKey(new AbortController().signal)) === 'd') {
      io.print(`The code was changed like this to cause the incident:\n${await session.variantDiff(truth)}`);
    }
  }
  return closeAttempt(session, io, outcome, answer.confidence);
}

/** A Prediction's Attempt: the Scenario and the shuffled options, one answer, then the truth and why. */
async function runPrediction(session: TrainingSession, io: TrainIo, { resumed, background }: { resumed: boolean; background?: BackgroundCommand }): Promise<TrainResult> {
  const { record } = session.workout;
  const { scenario, explanation } = record.prediction!;
  const shown = session.predictionOptions();
  const number = session.attempt.record.number;
  const keys = `[1]-[${shown.length}] answer   [q] quit${background ? `   [s] \`${background.command}\`` : ''}`;
  io.print(
    [
      `${record.title} (${record.id}), attempt ${number}${resumed ? ', resumed' : ''}`,
      '',
      ...(record.whatIf ? [...whatIfLines(record.whatIf), ''] : []),
      scenario.trim(),
      '',
      ...shown.map(({ option }, i) => `  [${i + 1}] ${option.text.trim()}`),
      '',
      keys,
    ].join('\n'),
  );

  const answer = await readAnswer(io, shown.map(({ index }) => index), record.id, number, background);
  if (answer === 'left') return { status: 'left-pending', workoutId: record.id, attempt: number };
  const { picked, confidence } = answer;

  const { outcome, chosen, truth } = await session.answer(picked);
  if (record.whatIf) return revealWhatIf(session, io, { outcome, chosen, truth, confidence });
  // In a Prediction from a commit, why the old behaviour is wrong is known for a fact: Fiutsu says it.
  const old = record.prediction!.options.find((o) => o.previous);
  const commit = record.commit ? `commit ${record.commit.sha.slice(0, 12)}` : 'the commit';
  const why = chosen.previous ? `That was true until ${commit}.` : chosen.misunderstanding.trim();
  const reveal = outcome === 'completed' ? [`Right: ${truth.text.trim()}`] : [`Not quite. What happens: ${truth.text.trim()}`, why];
  const changed = old ? ['', describeChange(record, old)] : [];
  const anchors = record.sourceAnchors.map((a) => `  ${a.path}:${a.startLine}-${a.endLine}: ${a.explanation}`);
  io.print([...reveal, ...changed, '', explanation.trim(), '', 'Where this lives:', ...anchors].join('\n'));
  if (outcome === 'abandoned') {
    io.print(`[d] ${chosen.previous ? 'what the commit changed' : 'the code difference behind your answer'}   [any other key] continue`);
    const read = new AbortController();
    if ((await io.readKey(read.signal)) === 'd') {
      const heading = chosen.previous ? `What ${commit} changed (- before, + now):` : 'For your answer to be what happens, the code would change like this:';
      io.print(`${heading}\n${await session.variantDiff(chosen)}`);
    }
  }
  return closeAttempt(session, io, outcome, confidence);
}

/** A What-if's reveal: both sides, whatever the answer, what was measured, and the change as modelled. */
async function revealWhatIf(
  session: TrainingSession,
  io: TrainIo,
  { outcome, chosen, truth, confidence }: { outcome: Outcome['outcome']; chosen: PredictionOption; truth: PredictionOption; confidence?: Confidence },
): Promise<TrainResult> {
  const { record } = session.workout;
  const today = record.prediction!.options.find((o) => o.previous)!;
  const verdict = outcome === 'completed' ? ['Right.'] : ['Not quite.', chosen.previous ? 'That is what happens today, and this change alters it.' : chosen.misunderstanding.trim()];
  const anchors = record.sourceAnchors.map((a) => `  ${a.path}:${a.startLine}-${a.endLine}: ${a.explanation}`);
  io.print(
    [...verdict, '', `Today: ${today.text.trim()}`, `With this change: ${truth.text.trim()}`, '', record.prediction!.explanation.trim(), '', 'Where this lives:', ...anchors, '', WHAT_IF_LIMITS].join('\n'),
  );
  io.print('[d] the code change, as modelled   [any other key] continue');
  if ((await io.readKey(new AbortController().signal)) === 'd') io.print(`The change, as modelled (- today, + with it):\n${await session.variantDiff(today)}`);
  return closeAttempt(session, io, outcome, confidence);
}

const CONFIDENCE_KEYS: Record<string, Confidence> = { '1': 'guessing', '2': 'fairly-sure', '3': 'certain' };

/** The notice that the Workout's bug may be in the source too. Only ever shown after an Attempt: before, it narrows the search. */
export function describeDefect(record: WorkoutRecord): string {
  const defect = record.originalDefect!;
  const lines = defect.startLine === defect.endLine ? `${defect.startLine}` : `${defect.startLine}-${defect.endLine}`;
  const where = `${record.source.path}:${lines}`;
  const madeFrom = record.source.commit ? ` (Workout made from commit ${record.source.commit.slice(0, 12)})` : '';
  const notice =
    defect.evidence === 'model'
      ? `⚠ The model that wrote this Workout thinks ${where} has a real bug${madeFrom}.`
      : `⚠ This bug may be real: ${where} has the same logic as this Workout's bug${madeFrom}.`;
  return defect.description ? `${notice}
  ${defect.description}` : notice;
}

/** For a Prediction from a commit: which commit changed the behaviour, and what it did before. */
function describeChange(record: WorkoutRecord, old: PredictionOption): string {
  const commit = record.commit;
  const which = commit ? `commit ${commit.sha.slice(0, 12)}${commit.subject ? ` ("${commit.subject}")` : ''}` : 'a commit';
  const by = commit?.aiAuthored ? ', co-written by an AI assistant' : '';
  return `What changed: ${which}${by}.\nBefore it: ${old.text.trim()}`;
}

async function readKeys(
  session: TrainingSession,
  io: TrainIo,
  signal: AbortSignal,
  finish: (outcome: Outcome['outcome'] | 'quit') => void,
  background?: BackgroundCommand,
): Promise<never> {
  for (;;) {
    const key = await io.readKey(signal);
    if (key === undefined) return new Promise<never>(() => {});
    if (key === 'h') {
      const next = await session.nextHint();
      io.print(next ? `Hint ${next.number}/${next.total}: ${next.hint}` : 'No more hints.');
    } else if (key === 'g') {
      io.print(`Here is what the Reference Solution changes:\n${await session.solutionDiff()}`);
      finish('abandoned');
      return new Promise<never>(() => {});
    } else if (key === 's' && background) {
      io.print(await backgroundStatus(background));
    } else if (key === 'q') {
      finish('quit');
      return new Promise<never>(() => {});
    }
  }
}

async function backgroundStatus(background: BackgroundCommand): Promise<string> {
  if (background.result) return reportResult(background, background.result);
  const tail = await background.tail(5);
  return [`\`${background.command}\` running for ${describeDuration(background.elapsedMs())}`, ...(tail ? [tail.replace(/^/gm, '  │ ')] : [])].join('\n');
}

export type QuickWhileResult = { status: 'nothing-ready' } | { status: 'ran'; result: CommandResult };

/**
 * `fiu quick --while "<cmd>"`: the user's command runs in the background while they solve Quick
 * Workouts. Returns how the command ended; with no Quick Workout ready it starts nothing, and the
 * caller runs the command in the foreground instead.
 */
export async function quickWhile(
  cwd: string,
  command: string,
  options: TrainOptions,
  io: TrainIo,
  dependencies: TrainDependencies & { shell?: string } = {},
): Promise<QuickWhileResult> {
  const paths = workspacePaths(await findRepoRoot(cwd));
  const repoConfig = await loadRepoConfig(paths.configFile);
  await expireStaleWorkouts(paths, { ...AUTO_DEFAULTS, ...repoConfig.auto }.expiryDays, new Date());
  const kinds = await preferredKinds(repoConfig, dependencies.configEnv);
  let next = await nextQuickWorkout(paths, kinds);
  if (!next) return { status: 'nothing-ready' };

  const background = await BackgroundCommand.start(command, { cwd, logFile: join(paths.root, 'while', 'last.log'), shell: dependencies.shell });
  io.print(`Running \`${command}\` in the background. Log: ${background.logFile}`);
  try {
    for (;;) {
      await train(cwd, next.record.id, options, io, { ...dependencies, background });
      if (background.result) break;
      next = await nextQuickWorkout(paths, kinds);
      if (!next) break;
      io.print(`Another Quick Workout while \`${command}\` runs? [y] yes   [any other key] wait for it`);
      const answer = new AbortController();
      const key = await Promise.race([io.readKey(answer.signal), background.done.then(() => undefined)]);
      answer.abort();
      if (key !== 'y') break;
    }
  } catch (error) {
    // Fiutsu failing must not cost the user their command: report it, and keep waiting.
    io.print(`Fiutsu stopped: ${error instanceof Error ? error.message : String(error)}`);
  }

  if (!background.result) {
    io.print(`Waiting for \`${command}\`. [q] stop it`);
    const stopKey = new AbortController();
    const stop = (async () => {
      for (;;) {
        const key = await io.readKey(stopKey.signal);
        if (key === undefined) return;
        if (key === 'q') return void (await background.stop());
      }
    })();
    const waiting = io.wait?.(() => `\`${command}\` running for ${describeDuration(background.elapsedMs())}`, background.done);
    await background.done;
    stopKey.abort();
    await Promise.all([stop, waiting]);
  }
  const result = background.result!;
  if (!background.reported) {
    background.reported = true;
    io.print(await reportResult(background, result));
  }
  return { status: 'ran', result };
}
