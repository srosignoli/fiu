import { existsSync } from 'node:fs';
import { readFile, rename, writeFile } from 'node:fs/promises';
import { z } from 'zod';
import type { WorkspacePaths } from '../workspace.ts';
import type { Skeleton, SkeletonFolder } from './skeleton.ts';

const EntrySchema = z.object({
  /** The blob hash (a file) or names hash (a folder) of what was described. */
  hash: z.string(),
  text: z.string(),
  writtenAt: z.string(),
});
const FileEntrySchema = EntrySchema.extend({
  /** One line per key function, by symbol name. */
  functions: z.record(z.string(), z.string()).default({}),
});

/** `.kintsugi/atlas.json`. The root folder's entry ('') is the overview of the repository. */
export const AtlasSchema = z.object({
  version: z.literal(1),
  folders: z.record(z.string(), EntrySchema),
  files: z.record(z.string(), FileEntrySchema),
});
export type Atlas = z.infer<typeof AtlasSchema>;
export type AtlasEntry = z.infer<typeof EntrySchema>;
export type AtlasFileEntry = z.infer<typeof FileEntrySchema>;

export const emptyAtlas = (): Atlas => ({ version: 1, folders: {}, files: {} });

export async function readAtlas(paths: Pick<WorkspacePaths, 'atlasFile'>): Promise<Atlas> {
  if (!existsSync(paths.atlasFile)) return emptyAtlas();
  return AtlasSchema.parse(JSON.parse(await readFile(paths.atlasFile, 'utf8')));
}

export async function writeAtlas(paths: Pick<WorkspacePaths, 'atlasFile'>, atlas: Atlas): Promise<void> {
  const sorted = (record: Record<string, unknown>) => Object.fromEntries(Object.entries(record).sort(([a], [b]) => a.localeCompare(b)));
  const temporary = `${paths.atlasFile}.tmp`;
  await writeFile(temporary, JSON.stringify({ version: 1, folders: sorted(atlas.folders), files: sorted(atlas.files) }, null, 2) + '\n');
  await rename(temporary, paths.atlasFile);
}

/** Missing, current, or stale (the content changed since it was described). */
export type EntryState = 'missing' | 'current' | 'stale';
export const entryState = (entry: Pick<AtlasEntry, 'hash'> | undefined, hash: string): EntryState => (!entry ? 'missing' : entry.hash === hash ? 'current' : 'stale');

/** What a build of this folder has to write: the files needing a description, and whether the folder's own entry does. */
export function folderWork(atlas: Atlas, skeleton: Skeleton, folder: SkeletonFolder): { files: string[]; folder: boolean } {
  const files = folder.files.filter((path) => {
    const file = skeleton.files.get(path)!;
    return file.described && entryState(atlas.files[path], file.hash) !== 'current';
  });
  return { files, folder: files.length > 0 || entryState(atlas.folders[folder.path], folder.hash) !== 'current' };
}

/** How many described files and folders have a stale entry. */
export function staleCounts(atlas: Atlas, skeleton: Skeleton): { files: number; folders: number; described: number } {
  let files = 0;
  let folders = 0;
  let described = 0;
  for (const file of skeleton.files.values()) {
    const state = entryState(atlas.files[file.path], file.hash);
    if (state !== 'missing') described++;
    if (state === 'stale') files++;
  }
  for (const folder of skeleton.folders.values()) if (entryState(atlas.folders[folder.path], folder.hash) === 'stale') folders++;
  return { files, folders, described };
}
