import { homedir } from 'node:os';
import { open, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { execa } from 'execa';
import type { DrillUi } from '../commands/drill.ts';
import { AUTO_DEFAULTS, loadRepoConfig, loadUserConfig, resolveConfig, type ConfigEnv, type PreferredKind, type RepoConfig } from '../config.ts';
import { ConsentDeclinedError, ConsentRequiredError, hasConsent, recordConsent } from '../consent.ts';
import { MissingApiKeyError, resolveApiKey } from '../credentials.ts';
import type { LanguageProfile } from '../languages/profile.ts';
import { preflight } from '../languages/run.ts';
import { verifySandbox } from '../sandbox/canary.ts';
import { openSandbox, type Sandbox } from '../sandbox/sandbox.ts';
import { generateWorkout, type GenerationResult } from '../synthesis/generate.ts';
import { createModel as createModelDefault } from '../synthesis/model.ts';
import { MAX_ATTEMPTS } from '../synthesis/synthesize.ts';
import { NOUN } from '../synthesis/schema.ts';
import { discardWorkout, listWorkouts, readState, writeState, type StoredWorkout } from '../workouts/store.ts';
import { ensureWorkspace, excludeWorkspaceFromGit, findRepoRoot, workspacePaths, type WorkspacePaths } from '../workspace.ts';
import { chooseTarget, operationInProgress, readCommit } from './commits.ts';
import { appendLog, type LogEntry } from './log.ts';

/** Commits that arrive while a generator runs wait here; only the newest are kept. */
export const BACKLOG_SIZE = 5;
/** A lock older than this is taken over even if its process still exists (it hung). */
const STALE_LOCK_MS = 30 * 60 * 1000;
/** How many processed commits to remember. */
const PROCESSED_MEMORY = 500;

export interface RefillOptions {
  /** The commit to generate from; HEAD when absent. */
  commit?: string;
  /** Started by the hook: never prompts, needs `kin auto on`, and obeys the caps. */
  background: boolean;
  /** Foreground only: consent to sending code without prompting. */
  yes?: boolean;
  /** Foreground only: false with --no-sandbox. Background generation is always sandboxed. */
  sandbox?: boolean;
  /** Overrides the configured kinds: `kin predict --commit` asks for a Prediction and nothing else. */
  kinds?: PreferredKind[];
}

export interface RefillDependencies {
  createModel?: typeof createModelDefault;
  configEnv?: ConfigEnv;
  cacheRoot?: string;
  now?: () => Date;
}

export type CommitOutcome = Omit<LogEntry, 'at' | 'background'> & { generation?: GenerationResult };

export interface RefillResult {
  outcomes: CommitOutcome[];
}

export class RefillBusyError extends Error {
  constructor() {
    super('Kintsugi is already generating a Drill in the background for this repository. Try again in a minute.');
  }
}

/**
 * `kin refill [--commit <sha>]`: turn a commit into a Quick Drill. In the background (from the hook)
 * it never prompts, runs one generator per repository, queues commits that arrive meanwhile, and
 * obeys the queue and daily caps. Every outcome goes to .kintsugi/log.
 */
export async function refill(cwd: string, options: RefillOptions, ui: DrillUi, deps: RefillDependencies = {}): Promise<RefillResult> {
  const configEnv = deps.configEnv ?? { env: process.env, home: homedir() };
  const now = deps.now ?? (() => new Date());
  const repoRoot = await findRepoRoot(cwd);
  const paths = workspacePaths(repoRoot);
  await ensureWorkspace(paths);
  await excludeWorkspaceFromGit(repoRoot);
  const repoConfig = await loadRepoConfig(paths.configFile);
  const userConfig = await loadUserConfig(configEnv);
  const config = resolveConfig(repoConfig, userConfig);
  const auto = { ...AUTO_DEFAULTS, ...repoConfig.auto };
  const sha = await resolveCommit(repoRoot, options.commit ?? 'HEAD');

  const outcomes: CommitOutcome[] = [];
  const note = async (outcome: CommitOutcome) => {
    outcomes.push(outcome);
    const { generation: _, ...entry } = outcome;
    await appendLog(paths, { ...entry, background: options.background }, now());
  };

  await expireStaleWorkouts(paths, auto.expiryDays, now());

  if (options.background) {
    const refusal = backgroundRefusal(repoConfig, config.provider);
    if (refusal) {
      await note({ commit: sha, outcome: 'skipped', reason: refusal });
      return { outcomes };
    }
  }
  let apiKey: string;
  try {
    apiKey = resolveApiKey(config.provider, userConfig, configEnv);
  } catch (error) {
    if (!(error instanceof MissingApiKeyError)) throw error;
    if (!options.background) throw error;
    await note({ commit: sha, outcome: 'skipped', reason: 'no API key (commits made from GUI tools may not see shell variables: keep the key in the user config)' });
    return { outcomes };
  }

  const lock = await acquireLock(paths);
  if (!lock) {
    if (!options.background) throw new RefillBusyError();
    await addToBacklog(paths, sha, now());
    await note({ commit: sha, outcome: 'deferred', reason: 'another generator is running; queued in the backlog' });
    return { outcomes };
  }

  let sandbox: Sandbox | undefined;
  const sandboxFor = async (profile: LanguageProfile) => {
    sandbox ??= await openSandbox({ repoRoot, allowUnsandboxed: !options.background && options.sandbox === false });
    if (!sandbox.isolated) ui.warn('Running Workout code WITHOUT a sandbox (--no-sandbox). Only the environment is scrubbed.');
    await verifySandbox(sandbox, deps.cacheRoot ? { cacheDir: deps.cacheRoot } : {});
    await preflight(sandbox, profile, deps.cacheRoot);
    return sandbox;
  };

  try {
    let next: string | undefined = sha;
    while (next) {
      const outcome = await processCommit(next);
      await note(outcome);
      // In the background, work through commits that arrived meanwhile, newest first.
      next = options.background ? await takeFromBacklog(paths) : undefined;
    }
  } finally {
    await sandbox?.dispose();
    await lock.release();
  }
  return { outcomes };

  async function processCommit(commitSha: string): Promise<CommitOutcome> {
    const state = await readState(paths);
    if (state.refill.processed.includes(commitSha)) return { commit: commitSha, outcome: 'skipped', reason: 'already processed' };
    const permanently = async (reason: string): Promise<CommitOutcome> => {
      await markProcessed(paths, commitSha);
      return { commit: commitSha, outcome: 'skipped', reason };
    };

    const info = await readCommit(repoRoot, commitSha);
    if (info.parents.length > 1) return permanently('merge commit');
    if (options.background) {
      const operation = await operationInProgress(repoRoot);
      if (operation) return permanently(`made during ${operation}`);
    }
    const userEmail = (await execa('git', ['config', 'user.email'], { cwd: repoRoot, reject: false })).stdout.trim();
    if (userEmail && info.authorEmail.toLowerCase() !== userEmail.toLowerCase()) return permanently(`authored by ${info.authorEmail}, not you`);
    if (options.background && auto.aiOnly && !info.aiAuthored) return permanently('not AI-authored (aiOnly is on)');

    const choice = await chooseTarget(repoRoot, commitSha, config.profiles);
    if ('skip' in choice) return permanently(choice.skip);
    const { target } = choice;
    const workouts = await listWorkouts(paths);
    if (workouts.some((w) => w.status === 'queued' && w.record.origin === 'commit' && w.record.source.path === target.path)) {
      return permanently(`${target.path} already has a queued Workout from a commit`);
    }

    const kinds = options.kinds ?? config.kinds;
    // A Prediction offers the old behaviour as a wrong option, so it needs the file as it was.
    const before = kinds.includes('prediction') ? await fileBefore(repoRoot, commitSha, target.path) : undefined;
    /** Background runs stay within the daily limit, a fallback's attempts included. */
    const attemptsLeft = async (): Promise<number> =>
      options.background ? Math.min(MAX_ATTEMPTS, auto.dailyLimit - generationsToday((await readState(paths)).spend, now())) : MAX_ATTEMPTS;
    if (options.background) {
      const queued = countsTowardQueueCap(workouts);
      if (queued >= auto.queueCap) return { commit: commitSha, outcome: 'deferred', reason: `the queue already holds ${queued} Workouts (cap ${auto.queueCap})` };
      if ((await attemptsLeft()) <= 0) return { commit: commitSha, outcome: 'deferred', reason: `today's limit of ${auto.dailyLimit} generations is used up` };
    } else if (!hasConsent(repoConfig, config.provider)) {
      if (!options.yes) {
        if (!ui.confirm) throw new ConsentRequiredError(config.provider);
        const what = before === undefined ? `${target.path} (as of ${commitSha.slice(0, 12)})` : `${target.path} (before and after ${commitSha.slice(0, 12)})`;
        const granted = await ui.confirm(
          `Kintsugi will send ${what} to ${config.provider} (${config.model}) to generate a ${NOUN[kinds[0]!]}. Send code from this repository to ${config.provider}?`,
        );
        if (!granted) throw new ConsentDeclinedError();
      }
      await recordConsent(paths.configFile, config.provider);
    }

    try {
      ui.step(`Checking the sandbox and the ${target.profile.id} toolchain`);
      const base = { commit: commitSha, source: target.path };
      let unfit: CommitOutcome | undefined;
      // The first kind that fits the commit; each one that doesn't falls back to the next.
      for (const kind of kinds) {
        if (kind === 'prediction' && before === undefined) {
          unfit = { ...base, outcome: 'not-worth-practicing', reason: 'the commit added this file, so there is no old behaviour to predict against' };
          continue;
        }
        const maxAttempts = await attemptsLeft();
        // Out of budget before the fallback: deferred, not remembered, like any cap.
        if (maxAttempts <= 0) return { ...base, outcome: 'deferred', reason: `today's limit of ${auto.dailyLimit} generations is used up` };
        if (unfit) ui.step(`${unfit.reason}: making a ${NOUN[kind]} instead`);
        const generation = await generateWorkout({
          paths,
          config,
          profile: target.profile,
          sandbox: await sandboxFor(target.profile),
          apiKey,
          createModel: deps.createModel ?? createModelDefault,
          target: {
            path: target.path,
            source: target.source,
            change: { sha: commitSha, subject: info.subject, diff: target.diff, ...(kind === 'prediction' ? { before } : {}) },
          },
          revision: { commit: commitSha, dirty: false },
          quick: true,
          kind,
          origin: 'commit',
          commit: { sha: commitSha, aiAuthored: info.aiAuthored },
          maxAttempts,
          cacheRoot: deps.cacheRoot,
          step: (message) => ui.step(message),
        });
        if (generation.status === 'saved') {
          await markProcessed(paths, commitSha);
          return { ...base, generation, outcome: 'generated', workoutId: generation.record.id };
        }
        if (generation.status === 'failed') {
          await markProcessed(paths, commitSha);
          return { ...base, generation, outcome: 'failed', reason: `no Verified ${NOUN[kind]} after the allowed attempts` };
        }
        unfit = { ...base, generation, outcome: 'not-worth-practicing', reason: generation.reason };
      }
      await markProcessed(paths, commitSha);
      return unfit!;
    } catch (error) {
      // Unattended runs log and move on; a person at the terminal sees the error.
      if (!options.background) throw error;
      return { commit: commitSha, source: target.path, outcome: 'failed', reason: (error as Error).message.split('\n')[0] };
    }
  }
}

/** Why background generation must not run, if it mustn't. */
function backgroundRefusal(repoConfig: RepoConfig, provider: string): string | undefined {
  if (!repoConfig.auto?.enabled) return 'background generation is off (turn it on with `kin auto on`)';
  if (repoConfig.consent?.provider !== provider) return `no consent to send code to ${provider}`;
  return undefined;
}

/** The file as it was before the commit; undefined when the commit added it (or has no parent). */
async function fileBefore(repoRoot: string, sha: string, path: string): Promise<string | undefined> {
  const shown = await execa('git', ['show', `${sha}^:${path}`], { cwd: repoRoot, reject: false, stripFinalNewline: false });
  return shown.exitCode === 0 ? shown.stdout : undefined;
}

async function resolveCommit(repoRoot: string, rev: string): Promise<string> {
  const result = await execa('git', ['rev-parse', '--verify', '--quiet', `${rev}^{commit}`], { cwd: repoRoot, reject: false });
  if (result.exitCode !== 0) throw new Error(`${rev} is not a commit in this repository.`);
  return result.stdout.trim();
}

/** Waiting Workouts that count toward the background queue cap: every queued one except Track steps. */
export const countsTowardQueueCap = (workouts: StoredWorkout[]) => workouts.filter((w) => w.status === 'queued' && w.record.origin !== 'explore').length;

/** Generation attempts spent on commit Workouts since local midnight (retries count). */
export function generationsToday(spend: { at: string; origin: string; generationAttempts: number }[], now: Date): number {
  const midnight = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  return spend.filter((s) => s.origin === 'commit' && Date.parse(s.at) >= midnight).reduce((sum, s) => sum + s.generationAttempts, 0);
}

/** Discards Workouts from commits that sat in the queue past their expiry, freeing the queue. */
export async function expireStaleWorkouts(paths: WorkspacePaths, expiryDays: number, now: Date): Promise<string[]> {
  const cutoff = now.getTime() - expiryDays * 24 * 60 * 60 * 1000;
  const expired = (await listWorkouts(paths)).filter(
    // Only the user's own background Drills: a teammate's, fetched weeks after it was made, mustn't expire on arrival.
    (w) => w.status === 'queued' && w.record.origin === 'commit' && !w.record.sharedBy && Date.parse(w.record.createdAt) < cutoff,
  );
  for (const workout of expired) await discardWorkout(paths, workout.record.id, 'expired', now);
  return expired.map((w) => w.record.id);
}

async function markProcessed(paths: WorkspacePaths, sha: string): Promise<void> {
  const state = await readState(paths);
  state.refill.processed = [...state.refill.processed.filter((s) => s !== sha), sha].slice(-PROCESSED_MEMORY);
  await writeState(paths, state);
}

async function addToBacklog(paths: WorkspacePaths, sha: string, now: Date): Promise<void> {
  const state = await readState(paths);
  state.refill.backlog = [...state.refill.backlog.filter((b) => b.sha !== sha), { sha, at: now.toISOString() }].slice(-BACKLOG_SIZE);
  await writeState(paths, state);
}

/** The newest backlog entry, removed from the backlog. */
async function takeFromBacklog(paths: WorkspacePaths): Promise<string | undefined> {
  const state = await readState(paths);
  const next = state.refill.backlog.pop();
  if (next) await writeState(paths, state);
  return next?.sha;
}

/** A per-repository lock file holding the generator's pid; a dead or hung holder's lock is taken over. */
async function acquireLock(paths: WorkspacePaths): Promise<{ release(): Promise<void> } | undefined> {
  const file = join(paths.root, 'refill.lock');
  const content = JSON.stringify({ pid: process.pid, at: new Date().toISOString() });
  for (let tries = 0; tries < 2; tries++) {
    try {
      const handle = await open(file, 'wx');
      await handle.writeFile(content);
      await handle.close();
      return { release: () => rm(file, { force: true }) };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const holder = await readFile(file, 'utf8').then(JSON.parse, () => undefined);
      if (holder && isAlive(holder.pid) && Date.now() - Date.parse(holder.at) < STALE_LOCK_MS) return undefined;
      await rm(file, { force: true });
    }
  }
  return undefined;
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: it exists but belongs to someone else.
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}
