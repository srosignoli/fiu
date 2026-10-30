import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { applyAtlasOutput, ATLAS_RULES, describeFolder, FILES_PER_CALL, folderPrompt } from '../atlas/describe.ts';
import { atlasScope, buildSkeleton, foldersBottomUp, type Skeleton, type SkeletonFolder } from '../atlas/skeleton.ts';
import { folderWork, readAtlas, writeAtlas, type Atlas } from '../atlas/store.ts';
import { loadRepoConfig, loadUserConfig, resolveConfig, type ConfigEnv } from '../config.ts';
import { ConsentDeclinedError, ConsentRequiredError, hasConsent, recordConsent } from '../consent.ts';
import { describeCost, estimateCost, mergeByModel, type Cost, type ModelUsage } from '../cost/usage.ts';
import { MissingApiKeyError, resolveApiKey } from '../credentials.ts';
import { createModel as createModelDefault, type ProviderOptions } from '../synthesis/model.ts';
import { recordSpend } from '../workouts/store.ts';
import { ensureWorkspace, excludeWorkspaceFromGit, findRepoRoot, workspacePaths } from '../workspace.ts';
import type { DrillUi } from './drill.ts';

export interface AtlasBuildOptions {
  /** --yes: consent to sending code, and to the estimated cost, without prompting. */
  yes: boolean;
}

export interface AtlasDependencies {
  createModel?: typeof createModelDefault;
  configEnv?: ConfigEnv;
  now?: () => Date;
}

/** One call: some of a folder's files, and the folder's own entry on its last call. */
export interface AtlasCall {
  folder: SkeletonFolder;
  files: string[];
  wantFolder: boolean;
}

export type AtlasBuildResult =
  | { status: 'up-to-date' }
  | { status: 'declined'; calls: number }
  | { status: 'built'; folders: number; files: number; failed: { folder: string; problems: string[] }[]; cost: Cost };

/** Every call a build of `scope` makes, deepest folders first: files in batches, the folder's entry with the last. */
export function planAtlasCalls(atlas: Atlas, skeleton: Skeleton, scope: string): AtlasCall[] {
  const calls: AtlasCall[] = [];
  for (const folder of foldersBottomUp(skeleton, scope)) {
    const work = folderWork(atlas, skeleton, folder);
    if (!work.folder) continue;
    for (let i = 0; i < work.files.length; i += FILES_PER_CALL) {
      const files = work.files.slice(i, i + FILES_PER_CALL);
      calls.push({ folder, files, wantFolder: i + FILES_PER_CALL >= work.files.length });
    }
    if (work.files.length === 0) calls.push({ folder, files: [], wantFolder: true });
  }
  return calls;
}

/** About 4 characters a token; about 60 output tokens an entry, plus room for thinking. */
export function estimateAtlasCost(calls: AtlasCall[], prompts: string[], modelId: string, prices: Parameters<typeof estimateCost>[1]): Cost {
  const usage: ModelUsage[] = calls.map((call, i) => {
    const functions = call.files.length * 5;
    return {
      model: modelId,
      inputTokens: Math.ceil((ATLAS_RULES.length + prompts[i]!.length) / 4),
      outputTokens: 60 * (call.files.length + 1) + 30 * functions + 500,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    };
  });
  return estimateCost(usage, prices);
}

/** Describing is light work: on models with an effort setting, use less of it than Workout design does. */
function lighter(options: ProviderOptions): ProviderOptions {
  const anthropic = options.anthropic as Record<string, unknown> | undefined;
  return anthropic?.effort ? { ...options, anthropic: { ...anthropic, effort: 'low' } } : options;
}

/** `kin atlas build [<dir>]`: describe what is missing or stale in the Atlas, bottom up, after a cost confirmation. */
export async function buildAtlas(
  cwd: string,
  path: string | undefined,
  options: AtlasBuildOptions,
  ui: DrillUi,
  { createModel = createModelDefault, configEnv = { env: process.env, home: homedir() }, now = () => new Date() }: AtlasDependencies = {},
): Promise<AtlasBuildResult> {
  const repoRoot = await findRepoRoot(cwd);
  const paths = workspacePaths(repoRoot);
  await ensureWorkspace(paths);
  await excludeWorkspaceFromGit(repoRoot);
  const repoConfig = await loadRepoConfig(paths.configFile);
  const userConfig = await loadUserConfig(configEnv);
  const config = resolveConfig(repoConfig, userConfig);

  const skeleton = await buildSkeleton(repoRoot, config.profiles);
  const scope = atlasScope(repoRoot, cwd, path, skeleton);
  const atlas = await readAtlas(paths);
  const calls = planAtlasCalls(atlas, skeleton, scope);
  if (calls.length === 0) return { status: 'up-to-date' };

  let apiKey: string;
  try {
    apiKey = resolveApiKey(config.provider, userConfig, configEnv);
  } catch (error) {
    if (!(error instanceof MissingApiKeyError)) throw error;
    error.message += `\nOr build the Atlas with your coding agent instead: run \`kin agent install claude\`, then ask it to \`/kin-atlas${scope ? ` ${scope}` : ''}\`.`;
    throw error;
  }

  const folderCount = new Set(calls.map((c) => c.folder.path)).size;
  const fileCount = calls.reduce((sum, c) => sum + c.files.length, 0);
  const where = scope || 'the repository';
  if (!hasConsent(repoConfig, config.provider)) {
    if (!options.yes) {
      if (!ui.confirm) throw new ConsentRequiredError(config.provider);
      const granted = await ui.confirm(
        `Kintsugi will send the declarations and key functions of ${fileCount} file(s) in ${where} to ${config.provider} (${config.model}). Send code from this repository to ${config.provider}?`,
      );
      if (!granted) throw new ConsentDeclinedError();
    }
    await recordConsent(paths.configFile, config.provider);
  }

  const read = async (files: string[]) => new Map(await Promise.all(files.map(async (file) => [file, await readFile(join(repoRoot, file), 'utf8')] as const)));
  if (!options.yes) {
    if (!ui.confirm) throw new ConsentRequiredError(config.provider);
    const prompts = await Promise.all(calls.map(async (c) => folderPrompt(skeleton, atlas, c.folder, c.files, await read(c.files), { wantFolder: c.wantFolder })));
    const estimate = describeCost(estimateAtlasCost(calls, prompts, config.model, config.prices));
    const question = `Describe ${folderCount} folder(s) and ${fileCount} file(s) in ${where}: ${calls.length} call(s) to ${config.model}, estimated ${estimate}. Go ahead?`;
    if (!(await ui.confirm(question))) return { status: 'declined', calls: calls.length };
  }

  const { model, providerOptions } = createModel(config.provider, config.model, apiKey);
  const usage: ModelUsage[] = [];
  const failed: { folder: string; problems: string[] }[] = [];
  const described = { folders: 0, files: 0 };
  for (const call of calls) {
    const name = call.folder.path || 'the repository overview';
    ui.step(call.files.length > 0 ? `Describing ${name} (${call.files.length} file(s))` : `Describing ${name}`);
    const result = await describeFolder({
      skeleton,
      atlas,
      folder: call.folder,
      files: call.files,
      sources: await read(call.files),
      wantFolder: call.wantFolder,
      model,
      modelId: config.model,
      providerOptions: lighter(providerOptions),
    });
    usage.push(...result.usage);
    if (result.usage.length > 0) {
      await recordSpend(paths, {
        at: now().toISOString(),
        origin: 'manual',
        generator: 'kintsugi',
        source: call.folder.path || '.',
        result: 'atlas',
        generationAttempts: 1,
        cost: estimateCost(result.usage, config.prices),
      });
    }
    if (!result.output) {
      failed.push({ folder: call.folder.path, problems: result.problems });
      continue;
    }
    applyAtlasOutput(atlas, skeleton, call.folder, result.output, now(), { wantFolder: call.wantFolder });
    await writeAtlas(paths, atlas);
    described.files += call.files.length;
    if (call.wantFolder) described.folders++;
  }
  return { status: 'built', ...described, failed, cost: estimateCost(mergeByModel(usage), config.prices) };
}
