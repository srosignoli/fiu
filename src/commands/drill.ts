import { existsSync, statSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { relative, resolve, sep } from 'node:path';
import { loadRepoConfig, loadUserConfig, resolveConfig, type ConfigEnv } from '../config.ts';
import { estimateCost, formatUsd, type Cost, type ModelUsage } from '../cost/usage.ts';
import { ConsentDeclinedError, ConsentRequiredError, hasConsent, recordConsent } from '../consent.ts';
import { MissingApiKeyError, resolveApiKey } from '../credentials.ts';
import { profileForFile } from '../languages/registry.ts';
import { preflight } from '../languages/run.ts';
import { verifySandbox } from '../sandbox/canary.ts';
import { openSandbox } from '../sandbox/sandbox.ts';
import { createModel as createModelDefault } from '../synthesis/model.ts';
import { MAX_ATTEMPTS, synthesizeDrill, type SynthesisEvent } from '../synthesis/synthesize.ts';
import { saveDrill, sourceRevision, type WorkoutRecord } from '../workouts/save.ts';
import { averageSpend, readState, recordSpend, type Spend } from '../workouts/store.ts';
import { ensureWorkspace, excludeWorkspaceFromGit, findRepoRoot, workspacePaths } from '../workspace.ts';

export interface DrillCommandOptions {
  /** --yes: grant consent without prompting. */
  yes: boolean;
  /** False with --no-sandbox: run Workout code without isolation, for this invocation only. */
  sandbox: boolean;
  /** --quick: a Drill that fits a short wait. */
  quick?: boolean;
}

/** How the command talks to the user; the CLI renders it, tests record it. */
export interface DrillUi {
  step(message: string): void;
  warn(message: string): void;
  /** Undefined when there is no terminal to ask in. */
  confirm?: (message: string) => Promise<boolean>;
}

export interface DrillDependencies {
  createModel?: typeof createModelDefault;
  configEnv?: ConfigEnv;
  /** Root for toolchain caches and the sandbox canary cache. */
  cacheRoot?: string;
}

export type DrillCommandResult =
  | { status: 'saved'; record: WorkoutRecord; workoutDir: string; testCmd: string; attempts: number; cost: Cost }
  | { status: 'not-worth-practicing'; reason: string; cost: Cost }
  | { status: 'failed'; feedback: string; cost: Cost };

export class DrillTargetError extends Error {}

/** `kin drill <file>[#symbol]`: generate a Drill, verify it, and save it. */
export async function drill(
  cwd: string,
  target: string,
  options: DrillCommandOptions,
  ui: DrillUi,
  { createModel = createModelDefault, configEnv = { env: process.env, home: homedir() }, cacheRoot }: DrillDependencies = {},
): Promise<DrillCommandResult> {
  const repoRoot = await findRepoRoot(cwd);
  const { file, symbol } = parseTarget(cwd, target);
  const sourcePath = repoRelative(repoRoot, file);

  const paths = workspacePaths(repoRoot);
  await ensureWorkspace(paths);
  await excludeWorkspaceFromGit(repoRoot);
  const repoConfig = await loadRepoConfig(paths.configFile);
  const userConfig = await loadUserConfig(configEnv);
  const config = resolveConfig(repoConfig, userConfig);
  const profile = profileForFile(file, config.profiles);
  // Fail on a missing key before doing anything slow.
  let apiKey: string;
  try {
    apiKey = resolveApiKey(config.provider, userConfig, configEnv);
  } catch (error) {
    if (!(error instanceof MissingApiKeyError)) throw error;
    error.message += `\nOr generate it with your coding agent instead: run \`kin agent install claude\`, then ask it to \`/kin-drill ${sourcePath}\`.`;
    throw error;
  }

  const sandbox = await openSandbox({ repoRoot, allowUnsandboxed: !options.sandbox });
  try {
    if (!sandbox.isolated) ui.warn('Running Workout code WITHOUT a sandbox (--no-sandbox). Only the environment is scrubbed.');
    ui.step('Checking the sandbox and the toolchain');
    await verifySandbox(sandbox, cacheRoot ? { cacheDir: cacheRoot } : {});
    await preflight(sandbox, profile, cacheRoot);

    if (!hasConsent(repoConfig, config.provider)) {
      if (!options.yes) {
        if (!ui.confirm) throw new ConsentRequiredError(config.provider);
        const granted = await ui.confirm(
          `Kintsugi will send ${sourcePath} to ${config.provider} (${config.model}) to generate the Drill. Send code from this repository to ${config.provider}?`,
        );
        if (!granted) throw new ConsentDeclinedError();
      }
      await recordConsent(paths.configFile, config.provider);
    }

    const average = averageSpend((await readState(paths)).spend);
    if (average) ui.step(`Your Drills have averaged ${formatUsd(average.usd)} (last ${average.count})`);

    const { model, providerOptions } = createModel(config.provider, config.model, apiKey);
    const source = await readFile(file, 'utf8');
    // Everything the model is paid for lands in the spend ledger, whatever happens next.
    const usage: ModelUsage[] = [];
    const spend: Pick<Spend, 'result' | 'workoutId' | 'generationAttempts'> = { result: 'error', generationAttempts: 0 };
    try {
      const result = await synthesizeDrill({
        quick: options.quick ?? false,
        target: { path: sourcePath, source, symbol },
        profile,
        sandbox,
        model,
        modelId: config.model,
        providerOptions,
        cacheRoot,
        onEvent: (event) => {
          if (event.type === 'usage') {
            usage.push(...event.usage);
            spend.generationAttempts = event.attempt;
          } else {
            ui.step(describeEvent(event));
          }
        },
      });
      const cost = estimateCost(usage, config.prices);

      if (result.status === 'not-worth-practicing') {
        spend.result = 'not-worth-practicing';
        return { ...result, cost };
      }
      if (result.status === 'failed') {
        spend.result = 'not-verified';
        return { status: 'failed', feedback: result.feedback, cost };
      }

      const record = await saveDrill({
        paths,
        profile,
        drill: result.drill,
        sourcePath,
        symbol,
        revision: await sourceRevision(repoRoot, sourcePath),
        cost,
        generationAttempts: result.attempts,
      });
      Object.assign(spend, { result: 'verified', workoutId: record.id });
      const workoutDir = resolve(paths.workoutsDir, record.id);
      return { status: 'saved', record, workoutDir, testCmd: profile.testCmd, attempts: result.attempts, cost };
    } finally {
      if (usage.length > 0) {
        await recordSpend(paths, {
          at: new Date().toISOString(),
          origin: 'manual',
          generator: 'kintsugi',
          source: sourcePath,
          ...spend,
          cost: estimateCost(usage, config.prices),
        });
      }
    }
  } finally {
    await sandbox.dispose();
  }
}

/** `path/to/file.ts#symbol`; a path that itself contains `#` is taken literally when it exists. */
export function parseTarget(cwd: string, target: string): { file: string; symbol?: string } {
  const literal = resolve(cwd, target);
  const hash = target.lastIndexOf('#');
  const [path, symbol] = existsSync(literal) || hash === -1 ? [target, undefined] : [target.slice(0, hash), target.slice(hash + 1)];
  const file = resolve(cwd, path);
  if (!existsSync(file) || !statSync(file).isFile()) throw new DrillTargetError(`${path} is not a file.`);
  if (symbol === '') throw new DrillTargetError(`Nothing follows "#" in ${target}: name a symbol, or leave out the "#".`);
  return { file, symbol };
}

/** The target as a path relative to the repository root; refuses paths outside it and Workouts themselves. */
export function repoRelative(repoRoot: string, file: string): string {
  const path = relative(repoRoot, file);
  if (path.startsWith('..') || path === '') throw new DrillTargetError(`${file} is outside the repository at ${repoRoot}.`);
  if (path.split(sep)[0] === '.kintsugi') throw new DrillTargetError('Drill your own code, not a Workout.');
  return path.split(sep).join('/');
}

function describeEvent(event: Exclude<SynthesisEvent, { type: 'usage' }>): string {
  const of = `(attempt ${event.attempt} of ${MAX_ATTEMPTS})`;
  switch (event.type) {
    case 'generating':
      return `Generating the Drill ${of}`;
    case 'verifying':
      return `Verifying it in the sandbox ${of}`;
    case 'rejected':
      return `Not Verified, retrying with feedback:\n${event.feedback}`;
  }
}
