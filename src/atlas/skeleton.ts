import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { execa } from 'execa';
import { logicScore, repoRelativeDir } from '../explore/shortlist.ts';
import { isDrillableSourcePath } from '../languages/paths.ts';
import type { LanguageProfile } from '../languages/profile.ts';
import { profileForFile, UnsupportedLanguageError } from '../languages/registry.ts';
import { MAX_SOURCE_LINES } from '../synthesis/prompt.ts';
import { extractSymbols, keyFunctions, type AtlasSymbol } from './symbols.ts';

export class AtlasTargetError extends Error {}

/** One file of the Atlas, computed from the code: correct by construction, free to rebuild. */
export interface SkeletonFile {
  /** Relative to the repository root, with `/`. */
  path: string;
  /** The git blob hash of the file as it is now, working tree included. */
  hash: string;
  lines: number;
  /** Source worth describing: not a test, generated, or vendored file. */
  described: boolean;
  /** Over the 3,000 lines Fiutsu generates Workouts from. */
  tooLong: boolean;
  /** The file's logic score, when it has one (§11.4). */
  score?: number;
  symbols: AtlasSymbol[];
  /** Names of the symbols the Atlas describes: the densest functions. Empty for files that aren't described. */
  keyFunctions: string[];
}

export interface SkeletonFolder {
  /** '' for the repository root. */
  path: string;
  /** Over the names of its files and subfolders: a folder is re-described when they change. */
  hash: string;
  folders: string[];
  files: string[];
}

export interface Skeleton {
  files: Map<string, SkeletonFile>;
  folders: Map<string, SkeletonFolder>;
}

/** Git's own blob hash, so a description written on one clone matches the same content on another. */
export const blobHash = (content: Buffer) => createHash('sha1').update(`blob ${content.length}\0`).update(content).digest('hex');

const parentOf = (path: string) => (dirname(path) === '.' ? '' : dirname(path));

/** The Atlas's structure: the files `fiu map` shows, their symbols, and the folders that hold them. */
export async function buildSkeleton(repoRoot: string, profiles: readonly LanguageProfile[]): Promise<Skeleton> {
  const { stdout } = await execa('git', ['ls-files', '-z'], { cwd: repoRoot });
  const files = new Map<string, SkeletonFile>();
  for (const path of stdout.split('\0').filter(Boolean)) {
    let profile: LanguageProfile;
    try {
      profile = profileForFile(path, profiles);
    } catch (error) {
      if (error instanceof UnsupportedLanguageError) continue;
      throw error;
    }
    const content = await readFile(join(repoRoot, path)).catch(() => undefined);
    if (content === undefined) continue;
    files.set(path, skeletonFile(path, content, profile));
  }

  const folders = new Map<string, SkeletonFolder>();
  const folder = (path: string): SkeletonFolder => {
    let entry = folders.get(path);
    if (!entry) {
      entry = { path, hash: '', folders: [], files: [] };
      folders.set(path, entry);
      if (path !== '') folder(parentOf(path)).folders.push(path);
    }
    return entry;
  };
  folder('');
  for (const path of files.keys()) folder(parentOf(path)).files.push(path);
  for (const entry of folders.values()) {
    entry.folders.sort();
    entry.files.sort();
    entry.hash = createHash('sha1').update([...entry.folders.map((f) => `${f}/`), ...entry.files].join('\n')).digest('hex');
  }
  return { files, folders };
}

export function skeletonFile(path: string, content: Buffer, profile: LanguageProfile): SkeletonFile {
  const source = content.toString('utf8');
  const lines = source.split('\n').length;
  const described = isDrillableSourcePath(path);
  const symbols = extractSymbols(source, profile.declarationPattern);
  const score = logicScore(source)?.score;
  return {
    path,
    hash: blobHash(content),
    lines,
    described,
    tooLong: lines > MAX_SOURCE_LINES,
    ...(score !== undefined ? { score } : {}),
    symbols,
    keyFunctions: described ? keyFunctions(symbols).map((s) => s.name) : [],
  };
}

/** The folders under `scope` (itself included), deepest first: the order they are described in. */
export function foldersBottomUp(skeleton: Skeleton, scope = ''): SkeletonFolder[] {
  const inScope = (path: string) => scope === '' || path === scope || path.startsWith(`${scope}/`);
  const depth = (path: string) => (path === '' ? 0 : path.split('/').length);
  return [...skeleton.folders.values()].filter((f) => inScope(f.path)).sort((a, b) => depth(b.path) - depth(a.path) || a.path.localeCompare(b.path));
}

/** A folder argument as a repository-relative path: '' for the root. */
export function atlasScope(repoRoot: string, cwd: string, path: string | undefined, skeleton: Skeleton): string {
  if (path === undefined) return '';
  const scope = repoRelativeDir(repoRoot, resolve(cwd, path));
  if (scope.startsWith('..')) throw new AtlasTargetError(`${path} is outside the repository at ${repoRoot}.`);
  if (scope === '' || skeleton.folders.has(scope)) return scope;
  if (skeleton.files.has(scope)) throw new AtlasTargetError(`${path} is a file: the Atlas is built a folder at a time. Build its folder instead.`);
  throw new AtlasTargetError(`${path} holds no source files Fiutsu recognises.`);
}
