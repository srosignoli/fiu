import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import type { LanguageProfile } from '../languages/profile.ts';
import { applyAtlasOutput, ATLAS_RULES, AtlasOutputSchema, checkAtlasOutput, folderPrompt, type AtlasOutput } from './describe.ts';
import { atlasScope, buildSkeleton, foldersBottomUp, type Skeleton } from './skeleton.ts';
import { readAtlasOverlay, savable } from './overlay.ts';
import { folderWork, writeAtlas, type Atlas } from './store.ts';
import type { WorkspacePaths } from '../workspace.ts';

export type PreparedAtlas =
  | { status: 'up-to-date'; scope: string }
  | {
      status: 'ready';
      /** The folder to describe now: the deepest one in the scope still missing or stale. */
      folder: string;
      /** Every folder in the scope still to describe, in order, this one first. */
      pending: string[];
      /** The files of this folder to describe. */
      files: string[];
      rules: string;
      /** What to read: subfolders' entries, declarations, and key functions' code. */
      prompt: string;
      /** The shape submit_atlas expects, as JSON Schema. */
      entriesSchema: unknown;
    };

export type SubmittedAtlas = { status: 'saved'; folder: string; pending: string[] } | { status: 'rejected'; feedback: string };

/** The folders in the scope with something missing or stale, deepest first. */
const pendingFolders = (atlas: Atlas, skeleton: Skeleton, scope: string) =>
  foldersBottomUp(skeleton, scope)
    .filter((folder) => folderWork(atlas, skeleton, folder).folder)
    .map((folder) => folder.path);

/** `prepare_atlas(dir)`: the next folder of `dir`'s subtree to describe, with everything needed to describe it. */
export async function prepareAtlas(repoRoot: string, paths: WorkspacePaths, profiles: readonly LanguageProfile[], dir: string | undefined): Promise<PreparedAtlas> {
  const skeleton = await buildSkeleton(repoRoot, profiles);
  const scope = atlasScope(repoRoot, repoRoot, dir, skeleton);
  // Files with a current Understand-Anything entry need nothing from the agent (ADR 0010).
  const { build: atlas } = await readAtlasOverlay(paths, skeleton);
  const pending = pendingFolders(atlas, skeleton, scope);
  if (pending.length === 0) return { status: 'up-to-date', scope };
  const folder = skeleton.folders.get(pending[0]!)!;
  const { files } = folderWork(atlas, skeleton, folder);
  const sources = new Map(await Promise.all(files.map(async (file) => [file, await readFile(join(repoRoot, file), 'utf8')] as const)));
  return {
    status: 'ready',
    folder: folder.path,
    pending,
    files,
    rules: ATLAS_RULES,
    prompt: folderPrompt(skeleton, atlas, folder, files, sources),
    entriesSchema: z.toJSONSchema(AtlasOutputSchema),
  };
}

/** `submit_atlas(folder, entries)`: checks and saves one folder's entries; `pending` is what remains of `scope`. */
export async function submitAtlas(
  repoRoot: string,
  paths: WorkspacePaths,
  profiles: readonly LanguageProfile[],
  folderPath: string,
  entries: AtlasOutput,
  scope: string | undefined,
  now: Date,
): Promise<SubmittedAtlas> {
  const skeleton = await buildSkeleton(repoRoot, profiles);
  const path = atlasScope(repoRoot, repoRoot, folderPath || undefined, skeleton);
  const folder = skeleton.folders.get(path)!;
  const { build: atlas, own } = await readAtlasOverlay(paths, skeleton);
  const { files } = folderWork(atlas, skeleton, folder);
  const problems = checkAtlasOutput(skeleton, folder, files, entries);
  if (problems.length > 0) return { status: 'rejected', feedback: `Fix these and submit again:\n${problems.map((p) => `- ${p}`).join('\n')}` };
  applyAtlasOutput(atlas, skeleton, folder, entries, now);
  await writeAtlas(paths, savable(atlas, own));
  return { status: 'saved', folder: path, pending: pendingFolders(atlas, skeleton, atlasScope(repoRoot, repoRoot, scope ?? (path || undefined), skeleton)) };
}
