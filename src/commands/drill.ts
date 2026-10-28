import { existsSync, statSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { relative, resolve, sep } from 'node:path';
import { loadRepoConfig, loadUserConfig, resolveConfig, type ConfigEnv } from '../config.ts';
import { ConsentDeclinedError, ConsentRequiredError, hasConsent, recordConsent } from '../consent.ts';
import { MissingApiKeyError, resolveApiKey } from '../credentials.ts';
import { profileForFile } from '../languages/registry.ts';
import { preflight } from '../languages/run.ts';
import { verifySandbox } from '../sandbox/canary.ts';
import { openSandbox } from '../sandbox/sandbox.ts';
import { createModel as createModelDefault } from '../synthesis/model.ts';
import { generateWorkout, type GenerationResult } from '../synthesis/generate.ts';
import type { WorkoutKind } from '../synthesis/schema.ts';
import { sourceRevision } from '../workouts/save.ts';
import { ensureWorkspace, excludeWorkspaceFromGit, findRepoRoot, workspacePaths } from '../workspace.ts';

export interface DrillCommandOptions {
  /** --yes: grant consent without prompting. */
  yes: boolean;
  /** False with --no-sandbox: run Workout code without isolation, for this invocation only. */
  sandbox: boolean;
  /** --quick: a Drill that fits a short wait. */
  quick?: boolean;
  /** `kin kata`: a Kata instead of a Drill. */
  kind?: WorkoutKind;
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

export type DrillCommandResult = GenerationResult;

export class DrillTargetError extends Error {}

/** `kin drill <file>[#symbol]` (and `kin kata`): generate a Drill or Kata, verify it, and save it. */
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
  const kind = options.kind ?? 'drill';
  const noun = kind === 'drill' ? 'Drill' : 'Kata';

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
    error.message += `\nOr generate it with your coding agent instead: run \`kin agent install claude\`, then ask it to \`/kin-drill ${sourcePath}${kind === 'kata' ? ' kata' : ''}\`.`;
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
          `Kintsugi will send ${sourcePath} to ${config.provider} (${config.model}) to generate the ${noun}. Send code from this repository to ${config.provider}?`,
        );
        if (!granted) throw new ConsentDeclinedError();
      }
      await recordConsent(paths.configFile, config.provider);
    }

    return await generateWorkout({
      paths,
      config,
      profile,
      sandbox,
      apiKey,
      createModel,
      target: { path: sourcePath, source: await readFile(file, 'utf8'), symbol },
      revision: await sourceRevision(repoRoot, sourcePath),
      quick: options.quick ?? false,
      kind,
      origin: 'manual',
      cacheRoot,
      step: (message) => ui.step(message),
    });
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
