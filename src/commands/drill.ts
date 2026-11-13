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
import { targetOf } from '../atlas/search.ts';
import { readAtlasOverlay } from '../atlas/overlay.ts';
import { findRule, locateRule, RuleNotFoundError } from '../atlas/rules.ts';
import { buildSkeleton } from '../atlas/skeleton.ts';
import { listWorkouts } from '../workouts/store.ts';
import { shortlist } from '../explore/shortlist.ts';
import { searchAtlasCommand } from './atlas.ts';
import { practiceByFile } from '../map/map.ts';
import { answersOnly, NOUN, type WorkoutKind } from '../synthesis/schema.ts';
import { sourceRevision } from '../workouts/save.ts';
import { ensureWorkspace, excludeWorkspaceFromGit, findRepoRoot, workspacePaths } from '../workspace.ts';

export interface DrillCommandOptions {
  /** --yes: grant consent without prompting. */
  yes: boolean;
  /** False with --no-sandbox: run Workout code without isolation, for this invocation only. */
  sandbox: boolean;
  /** --quick: a Drill that fits a short wait. */
  quick?: boolean;
  /** `fiu kata`, `fiu predict`, and `fiu diagnose`: another kind instead of a Drill. */
  kind?: WorkoutKind;
  /** `fiu predict --questions`: how many questions the Series asks (default: the `predictionQuestions` setting). */
  questions?: number;
  /** `fiu predict --what-if`: a sentence to model, or true to have the model propose a change. */
  whatIf?: string | true;
  /** `fiu predict --rule "<words>"`: a Prediction about this business rule from Understand-Anything's domain graph (ADR 0010). */
  rule?: string;
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

/** `fiu drill <file>[#symbol]` (and `fiu kata`, `fiu predict`): generate a Workout, verify it, and save it. */
export async function drill(
  cwd: string,
  /** A file, optionally `#symbol`. For a Prediction or Diagnosis also a directory, or undefined for the repository root. */
  target: string | undefined,
  options: DrillCommandOptions,
  ui: DrillUi,
  { createModel = createModelDefault, configEnv = { env: process.env, home: homedir() }, cacheRoot }: DrillDependencies = {},
): Promise<DrillCommandResult> {
  const repoRoot = await findRepoRoot(cwd);
  const kind = options.kind ?? 'drill';
  const noun = NOUN[kind];

  const paths = workspacePaths(repoRoot);
  await ensureWorkspace(paths);
  await excludeWorkspaceFromGit(repoRoot);
  const repoConfig = await loadRepoConfig(paths.configFile);
  const userConfig = await loadUserConfig(configEnv);
  const config = resolveConfig(repoConfig, userConfig);
  let rule: { text: string; domain?: string } | undefined;
  if (options.rule !== undefined) {
    if (kind !== 'prediction' || options.whatIf) throw new DrillTargetError('A rule is the topic of a Prediction: use fiu predict --rule, without --what-if.');
    const chosen = await ruleTarget(repoRoot, options.rule, target, options, ui, config.profiles);
    rule = chosen.rule;
    // A located target is repository-relative; one the human named stays relative to where they are.
    if (target === undefined) {
      target = chosen.target;
      cwd = repoRoot;
    }
  }
  const directory = answersOnly(kind) && !rule ? directoryTarget(cwd, repoRoot, target) : undefined;
  const sentence = typeof options.whatIf === 'string' ? options.whatIf.trim() : undefined;
  if (directory !== undefined) {
    target = sentence ? await closestTo(sentence, repoRoot, directory, options, ui, configEnv) : await pickUnpractised(repoRoot, directory, config.profiles, paths);
    ui.step(`Asking about ${target}`);
  }
  if (target === undefined) throw new DrillTargetError(`Name the file to make the ${noun} from.`);
  const { file, symbol } = parseTarget(directory === undefined ? cwd : repoRoot, target);
  const sourcePath = repoRelative(repoRoot, file);
  const profile = profileForFile(file, config.profiles);
  // Fail on a missing key before doing anything slow.
  let apiKey: string;
  try {
    apiKey = resolveApiKey(config.provider, userConfig, configEnv);
  } catch (error) {
    if (!(error instanceof MissingApiKeyError)) throw error;
    error.message += `\nOr generate it with your coding agent instead: run \`fiu agent install claude\`, then ask it to \`/fiu-drill ${sourcePath}${kind === 'drill' ? '' : ` ${kind}`}\`.`;
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
          `Fiu will send ${sourcePath} to ${config.provider} (${config.model}) to generate the ${noun}. Send code from this repository to ${config.provider}?`,
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
      target: { path: sourcePath, source: await readFile(file, 'utf8'), symbol, ...(options.whatIf ? { whatIf: sentence ? { sentence } : {} } : {}), ...(rule ? { rule } : {}) },
      revision: await sourceRevision(repoRoot, sourcePath),
      // Every Prediction and Diagnosis is Quick by its own rules; the flag only shapes Drills and Katas.
      quick: !answersOnly(kind) && (options.quick ?? false),
      kind,
      // A What-if, or a Prediction about a rule, is always one question.
      ...(kind === 'prediction' && !options.whatIf && !rule ? { questions: options.questions ?? config.predictionQuestions } : {}),
      origin: 'manual',
      cacheRoot,
      step: (message) => ui.step(message),
    });
  } finally {
    await sandbox.dispose();
  }
}

/**
 * A Prediction about a rule: the rule some words mean, and where it is enforced: the target given, else
 * the best place Fiu locates, confirmed before anything is spent.
 */
async function ruleTarget(
  repoRoot: string,
  wanted: string,
  given: string | undefined,
  options: DrillCommandOptions,
  ui: DrillUi,
  profiles: Parameters<typeof shortlist>[2],
): Promise<{ rule: { text: string; domain?: string }; target?: string }> {
  const paths = workspacePaths(repoRoot);
  const skeleton = await buildSkeleton(repoRoot, profiles);
  const { atlas, extras, ua } = await readAtlasOverlay(paths, skeleton);
  if (ua.status === 'off') throw new DrillTargetError('Understand-Anything is turned off for this repository ("understandAnything": false in .fiu/config.json).');
  if (ua.status !== 'read' || ua.atlas.rules.length === 0) {
    throw new DrillTargetError('This repository has no Understand-Anything business rules: run /understand and then /understand-domain in Claude Code (they write .ua/domain-graph.json).');
  }
  let found;
  try {
    found = findRule(ua.atlas.rules, wanted);
  } catch (error) {
    if (error instanceof RuleNotFoundError) throw new DrillTargetError(error.message);
    throw error;
  }
  const rule = { text: found.text, ...(found.domain ? { domain: found.domain } : {}) };
  if (given !== undefined) return { rule };
  const places = await locateRule(found, repoRoot, skeleton, atlas, extras);
  if (places.length === 0) throw new DrillTargetError(`Fiu can't tell where "${found.text}" is enforced. Name the code: fiu predict <file>#<symbol> --rule "${wanted}"`);
  const best = `${places[0]!.path}#${places[0]!.symbol}`;
  const others = places.slice(1).map((p) => `${p.path}#${p.symbol}`);
  const alternatives = others.length > 0 ? ` (or name another: ${others.join(', ')})` : '';
  if (options.yes) return { rule, target: best };
  if (!ui.confirm) throw new DrillTargetError(`The rule "${found.text}" looks enforced in ${best}${alternatives}. Name it to go ahead: fiu predict ${best} --rule "${wanted}"`);
  const how = places[0]!.evidence === 'names' ? 'the rule names it' : 'its words match the rule';
  if (!(await ui.confirm(`Rule (Understand-Anything): "${found.text}"\nIt looks enforced in ${best} (${how})${alternatives}. Ask about it there?`))) {
    throw new DrillTargetError(`Nothing generated. Name the code: fiu predict <file>#<symbol> --rule "${wanted}"`);
  }
  return { rule, target: best };
}

/** `fiu predict --rule` with no words: every rule, where Fiu would ask about it, and what Predictions about it found. */
export async function listRules(cwd: string, { configEnv = { env: process.env, home: homedir() } }: Pick<DrillDependencies, 'configEnv'> = {}) {
  const repoRoot = await findRepoRoot(cwd);
  const paths = workspacePaths(repoRoot);
  const config = resolveConfig(await loadRepoConfig(paths.configFile), await loadUserConfig(configEnv));
  const skeleton = await buildSkeleton(repoRoot, config.profiles);
  const { atlas, extras, ua } = await readAtlasOverlay(paths, skeleton);
  if (ua.status !== 'read' || ua.atlas.rules.length === 0) return [];
  // A rule a Prediction checked shows where it was measured, not where Fiu would guess.
  const checked = new Map<string, { agrees: boolean; target: string }>();
  for (const { record } of await listWorkouts(paths)) {
    if (record.rule) checked.set(record.rule.text, { agrees: record.rule.agrees, target: `${record.source.path}${record.source.symbol ? `#${record.source.symbol}` : ''}` });
  }
  return Promise.all(
    ua.atlas.rules.map(async (rule) => {
      const check = checked.get(rule.text);
      if (check) return { rule, ...check };
      const [place] = await locateRule(rule, repoRoot, skeleton, atlas, extras);
      return { rule, ...(place ? { target: `${place.path}#${place.symbol}` } : {}), agrees: undefined };
    }),
  );
}

/** A What-if with no file: the Atlas search's closest target for the sentence, confirmed before anything is spent. */
async function closestTo(sentence: string, repoRoot: string, directory: string, options: DrillCommandOptions, ui: DrillUi, configEnv: ConfigEnv): Promise<string> {
  const { results } = await searchAtlasCommand(repoRoot, sentence, { configEnv });
  const best = results.find((r) => directory === '' || r.path.startsWith(`${directory}/`));
  if (!best) throw new DrillTargetError(`Nothing${directory ? ` in ${directory}` : ''} matches "${sentence}". Name the file: fiu predict <file> --what-if "${sentence}"`);
  const target = targetOf(best);
  if (options.yes) return target;
  if (!ui.confirm) throw new DrillTargetError(`The closest match is ${target}. Name it to go ahead: fiu predict ${target} --what-if "${sentence}"`);
  if (!(await ui.confirm(`The closest match for "${sentence}" is ${target}. Model the change there?`))) throw new DrillTargetError(`Nothing generated. Name the file: fiu predict <file> --what-if "${sentence}"`);
  return target;
}

/** For `fiu predict`: the directory to choose a file from (repository-relative), or undefined when the target is a file. */
function directoryTarget(cwd: string, repoRoot: string, target: string | undefined): string | undefined {
  if (target === undefined) return '';
  const path = resolve(cwd, target);
  if (!existsSync(path) || !statSync(path).isDirectory()) return undefined;
  const dir = relative(repoRoot, path);
  if (dir.startsWith('..')) throw new DrillTargetError(`${target} is outside the repository at ${repoRoot}.`);
  if (dir.split(sep)[0] === '.fiu') throw new DrillTargetError('Ask about your own code, not a Workout.');
  return dir.split(sep).join('/');
}

/** The densest file in the directory's shortlist that you have never Practised: people who don't read code don't know file names. */
export async function pickUnpractised(repoRoot: string, directory: string, profiles: Parameters<typeof shortlist>[2], paths: ReturnType<typeof workspacePaths>): Promise<string> {
  const candidates = await shortlist(repoRoot, directory, profiles);
  const practised = await practiceByFile(paths);
  const pick = candidates.find((c) => !practised.has(c.path));
  const where = directory || 'the repository';
  if (candidates.length === 0) throw new DrillTargetError(`${where} has no source files worth asking about.`);
  if (!pick) throw new DrillTargetError(`You have practised every file Fiu would pick in ${where}. Name a file, or a smaller directory.`);
  return pick.path;
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
  if (path.split(sep)[0] === '.fiu') throw new DrillTargetError('Drill your own code, not a Workout.');
  return path.split(sep).join('/');
}
