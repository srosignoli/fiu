import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { SEARCH_RESULTS } from '../atlas/search.ts';
import { searchAtlasCommand } from './atlas.ts';
import { loadRepoConfig, loadUserConfig, resolveConfig, type ConfigEnv } from '../config.ts';
import { ConsentDeclinedError, ConsentRequiredError, hasConsent, recordConsent } from '../consent.ts';
import { estimateCost, formatUsd, type ModelUsage } from '../cost/usage.ts';
import { MissingApiKeyError, resolveApiKey } from '../credentials.ts';
import { MIN_STEPS, planTrack, trackKinds, withAtlas, type PlannedStep, type TrackPlan } from '../explore/plan.ts';
import { NOUN, type WorkoutKind } from '../synthesis/schema.ts';
import { readAtlas } from '../atlas/store.ts';
import { ExploreTargetError, repoRelativeDir, shortlist } from '../explore/shortlist.ts';
import { saveTrack, trackId, type TrackRecord, type TrackStep } from '../explore/tracks.ts';
import type { LanguageProfile } from '../languages/profile.ts';
import { preflight } from '../languages/run.ts';
import { verifySandbox } from '../sandbox/canary.ts';
import { openSandbox, type Sandbox } from '../sandbox/sandbox.ts';
import { generateWorkout } from '../synthesis/generate.ts';
import { createModel as createModelDefault } from '../synthesis/model.ts';
import { sourceRevision } from '../workouts/save.ts';
import { averageSpend, readState, recordSpend } from '../workouts/store.ts';
import { ensureWorkspace, excludeWorkspaceFromGit, findRepoRoot, workspacePaths } from '../workspace.ts';
import type { DrillDependencies, DrillUi } from './drill.ts';

export interface ExploreOptions {
  /** --yes: consent to sending code, and to the estimated cost, without prompting. */
  yes: boolean;
  /** --about: choose the module by what the human wants to learn, through the Atlas search, instead of a path. */
  about?: string;
  /** --kinds: the kinds this Track may use, overriding the default (§11.11). */
  kinds?: WorkoutKind[];
  /** False with --no-sandbox. */
  sandbox: boolean;
}

export type ExploreResult =
  | { status: 'saved'; track: TrackRecord; dropped: string[] }
  /** Fewer than MIN_STEPS steps could be Verified: no Track; the Verified Drills remain ordinary Workouts. */
  | { status: 'not-enough'; workoutIds: string[]; dropped: string[] }
  | { status: 'plan-failed'; problems: string[] }
  | { status: 'declined'; plan: TrackPlan };

/**
 * The module a goal is about: the folder holding most of the best search matches (by score), or the
 * nearest folder above it with enough files for a Track.
 */
export async function moduleAbout(repoRoot: string, goal: string, configEnv: ConfigEnv): Promise<string> {
  const { results, described } = await searchAtlasCommand(repoRoot, goal, { configEnv });
  const byFolder = new Map<string, number>();
  for (const result of results.slice(0, SEARCH_RESULTS)) {
    const folder = dirname(result.path) === '.' ? '' : dirname(result.path);
    byFolder.set(folder, (byFolder.get(folder) ?? 0) + result.score);
  }
  const config = resolveConfig(await loadRepoConfig(workspacePaths(repoRoot).configFile), await loadUserConfig(configEnv));
  for (const [folder] of [...byFolder].sort((a, b) => b[1] - a[1])) {
    for (let candidate = folder; ; candidate = dirname(candidate) === '.' ? '' : dirname(candidate)) {
      if ((await shortlist(repoRoot, candidate, config.profiles)).length >= MIN_STEPS) return candidate;
      if (candidate === '') break;
    }
  }
  const hint = described ? 'Try other words, or name the module.' : 'Only names are searched until the Atlas is built (`fiu atlas build`); or name the module.';
  throw new ExploreTargetError(`Nothing matches "${goal}" well enough to choose a module. ${hint}`);
}

/**
 * `fiu explore <path>`: a Track for a module. A static shortlist, one call to choose and order the
 * steps, then every step generated up front (after a cost confirmation), replacing failed ones from
 * the alternates.
 */
export async function explore(
  cwd: string,
  modulePath: string,
  options: ExploreOptions,
  ui: DrillUi,
  { createModel = createModelDefault, configEnv = { env: process.env, home: homedir() }, cacheRoot }: DrillDependencies = {},
): Promise<ExploreResult> {
  const repoRoot = await findRepoRoot(cwd);
  if (options.about !== undefined) {
    modulePath = await moduleAbout(repoRoot, options.about, configEnv);
    ui.step(`Exploring ${modulePath || 'the repository'}: the module closest to "${options.about}"`);
  }
  const module = repoRelativeDir(repoRoot, resolve(cwd, options.about !== undefined ? join(repoRoot, modulePath) : modulePath));
  if (module.startsWith('..')) throw new ExploreTargetError(`${modulePath} is outside the repository at ${repoRoot}.`);
  if (module.split('/')[0] === '.fiu') throw new ExploreTargetError('Explore your own code, not the Fiu workspace.');

  const paths = workspacePaths(repoRoot);
  await ensureWorkspace(paths);
  await excludeWorkspaceFromGit(repoRoot);
  const repoConfig = await loadRepoConfig(paths.configFile);
  const userConfig = await loadUserConfig(configEnv);
  const config = resolveConfig(repoConfig, userConfig);
  let apiKey: string;
  try {
    apiKey = resolveApiKey(config.provider, userConfig, configEnv);
  } catch (error) {
    if (!(error instanceof MissingApiKeyError)) throw error;
    error.message += `\nOr build the Track with your coding agent instead: run \`fiu agent install claude\`, then ask it to explore ${module || 'the repository'}.`;
    throw error;
  }

  const candidates = withAtlas(await shortlist(repoRoot, module, config.profiles), await readAtlas(paths));
  if (candidates.length < MIN_STEPS) {
    throw new ExploreTargetError(
      `${module || 'The repository'} has ${candidates.length} source file(s) worth drilling; a Track needs at least ${MIN_STEPS}. Try a larger module, or \`fiu drill <file>\`.`,
    );
  }

  if (!hasConsent(repoConfig, config.provider)) {
    if (!options.yes) {
      if (!ui.confirm) throw new ConsentRequiredError(config.provider);
      const granted = await ui.confirm(
        `Fiu will send outlines of ${candidates.length} files in ${module || 'the repository'}, then the chosen files, to ${config.provider} (${config.model}). Send code from this repository to ${config.provider}?`,
      );
      if (!granted) throw new ConsentDeclinedError();
    }
    await recordConsent(paths.configFile, config.provider);
  }

  ui.step(`Choosing the steps among ${candidates.length} files`);
  const { model, providerOptions } = createModel(config.provider, config.model, apiKey);
  const kinds = trackKinds(config.kinds, options.kinds);
  const planned = await planTrack({ modulePath: module, kinds, candidates, model, modelId: config.model, providerOptions });
  await recordPlanSpend(planned.usage);
  if (!planned.plan) return { status: 'plan-failed', problems: planned.problems };
  const plan = planned.plan;

  // Each step priced from your recent average for its kind, else your overall average.
  const spend = (await readState(paths)).spend;
  const overall = averageSpend(spend);
  const prices = plan.steps.map((s) => averageSpend(spend, 10, s.kind) ?? overall);
  const estimate = prices.every(Boolean) ? `≈ ${formatUsd(prices.reduce((sum, p) => sum + p!.usd, 0))} (from your recent averages per kind)` : 'unknown (no cost history yet)';
  if (!options.yes) {
    if (!ui.confirm) throw new ConsentRequiredError(config.provider);
    const steps = plan.steps.map((s, i) => `  ${i + 1}. ${NOUN[s.kind]} · ${s.pillar}: ${s.path}: ${s.why}`).join('\n');
    if (!(await ui.confirm(`Track "${plan.title}":\n${steps}\nGenerate these ${plan.steps.length} Workouts now? Estimated cost ${estimate}.`))) {
      return { status: 'declined', plan };
    }
  }

  const id = await trackId(paths, module, new Date());
  const byPath = new Map(candidates.map((c) => [c.path, c]));
  const alternates = [...plan.alternates];
  const steps: TrackStep[] = [];
  const workoutIds: string[] = [];
  const dropped: string[] = [];
  // One sandbox for the whole Track; each language's toolchain is checked (and warmed) once.
  let sandbox: Sandbox | undefined;
  const preflighted = new Set<string>();
  const sandboxFor = async (profile: LanguageProfile): Promise<Sandbox> => {
    if (!sandbox) {
      sandbox = await openSandbox({ repoRoot, allowUnsandboxed: !options.sandbox });
      if (!sandbox.isolated) ui.warn('Running Workout code WITHOUT a sandbox (--no-sandbox). Only the environment is scrubbed.');
      await verifySandbox(sandbox, cacheRoot ? { cacheDir: cacheRoot } : {});
    }
    if (!preflighted.has(profile.id)) {
      await preflight(sandbox, profile, cacheRoot);
      preflighted.add(profile.id);
    }
    return sandbox;
  };

  try {
    for (let position = 0; position < plan.steps.length; position++) {
      const planned = plan.steps[position]!;
      let step: PlannedStep | undefined = planned;
      let fellBack = false;
      while (step) {
        const candidate = byPath.get(step.path)!;
        ui.step(`Step ${steps.length + 1}: a ${NOUN[step.kind]} from ${step.path}`);
        const generation = await generateWorkout({
          paths,
          config,
          profile: candidate.profile,
          sandbox: await sandboxFor(candidate.profile),
          apiKey,
          createModel,
          target: {
            path: step.path,
            source: await readFile(join(repoRoot, step.path), 'utf8'),
            track: { module, step: position + 1, of: plan.steps.length, why: step.why },
          },
          revision: await sourceRevision(repoRoot, step.path),
          quick: false,
          kind: step.kind,
          // A Track step is one question, never a Series.
          questions: 1,
          origin: 'explore',
          track: { id, title: plan.title, module, why: step.why },
          cacheRoot,
          step: (message) => ui.step(message),
        });
        if (generation.status === 'saved') {
          steps.push({ workoutId: generation.record.id, path: step.path, kind: step.kind, pillar: step.pillar, why: step.why });
          workoutIds.push(generation.record.id);
          break;
        }
        dropped.push(`${step.path}: ${generation.status === 'failed' ? `no Verified ${NOUN[step.kind]}` : `not worth practicing (${generation.reason})`}`);
        // An alternate takes the kind of the step it replaces; with none left, a Drill on the planned file.
        const alternate = alternates.shift();
        if (alternate) step = { ...alternate, kind: planned.kind };
        else if (!fellBack && planned.kind !== 'drill' && kinds.includes('drill')) {
          fellBack = true;
          step = { ...planned, kind: 'drill' };
        } else step = undefined;
      }
    }
  } finally {
    await sandbox?.dispose();
  }

  if (steps.length < MIN_STEPS) return { status: 'not-enough', workoutIds, dropped };
  const track: TrackRecord = { id, title: plan.title, module, createdAt: new Date().toISOString(), generator: 'fiu', steps };
  await saveTrack(paths, track);
  return { status: 'saved', track, dropped };

  async function recordPlanSpend(usage: ModelUsage[]) {
    if (usage.length === 0) return;
    await recordSpend(paths, {
      at: new Date().toISOString(),
      origin: 'explore',
      generator: 'fiu',
      source: module || '.',
      result: 'track-plan',
      generationAttempts: 1,
      cost: estimateCost(usage, config.prices),
    });
  }
}
