import { execa } from 'execa';
import { loadRepoConfig } from '../config.ts';
import type { WorkspacePaths } from '../workspace.ts';
import type { Skeleton } from './skeleton.ts';
import { entryState, readAtlas, type Atlas, type AtlasEntry, type AtlasFileEntry } from './store.ts';
import { foreignState, readForeignAtlas, type ForeignAtlas, type ForeignAtlasResult } from './ua.ts';

/**
 * The Atlas as Fiu shows it (ADR 0010): its own entries, with Understand-Anything's filling in where Fiu
 * has none or a stale one. Built in memory for reading; `writeAtlas` drops every entry it didn't write.
 */
export interface AtlasOverlay {
  atlas: Atlas;
  /** Fiu's own entries alone. */
  own: Atlas;
  /**
   * What `fiu atlas build` and `prepare_atlas` plan from: Fiu's folder entries, and the shown file entries,
   * so a file with a current UA entry needs no description. Save it through `savable`.
   */
  build: Atlas;
  /** Extra search words for a file, from UA: its tags and layer. */
  extras: Map<string, { tags: string[]; layer?: string }>;
  ua: UaStatus;
}

export type UaStatus =
  | { status: 'off' }
  | Exclude<ForeignAtlasResult, { status: 'read' }>
  /** `behind`: commits since the one UA analysed, when that commit is here. */
  | (Extract<ForeignAtlasResult, { status: 'read' }> & { behind?: number });

export const UA_LABEL = 'Understand-Anything';
/** How an entry from UA is marked in text, beside the entry. */
export const UA_MARK = '(UA)';

export const fromUa = (entry: Pick<AtlasEntry, 'source'> | undefined) => entry?.source === 'understand-anything';

/** On unless the repository's config turns it off. A config Fiu can't read leaves it on: the rest of Fiu reports that. */
export async function uaEnabled(paths: Pick<WorkspacePaths, 'configFile'>): Promise<boolean> {
  try {
    return (await loadRepoConfig(paths.configFile)).understandAnything !== false;
  } catch {
    return true;
  }
}

/** Fiu's Atlas with UA's graph laid under it, when the repository has one and the setting allows it. */
export async function readAtlasOverlay(paths: Pick<WorkspacePaths, 'atlasFile' | 'configFile' | 'repoRoot'>, skeleton: Skeleton): Promise<AtlasOverlay> {
  const own = await readAtlas(paths);
  if (!(await uaEnabled(paths))) return { atlas: own, own, build: own, extras: new Map(), ua: { status: 'off' } };
  const result = await readForeignAtlas(paths.repoRoot, skeleton);
  if (result.status !== 'read') return { atlas: own, own, build: own, extras: new Map(), ua: result };
  const behind = result.atlas.commitInClone && result.atlas.commit ? await commitsBehind(paths.repoRoot, result.atlas.commit) : undefined;
  const overlay = overlayAtlas(own, result.atlas, skeleton);
  return { ...overlay, own, build: { version: 1, folders: { ...own.folders }, files: { ...overlay.atlas.files } }, ua: { ...result, ...(behind !== undefined ? { behind } : {}) } };
}

/**
 * Pure: Fiu's entry wins when current; a UA entry replaces one that is missing, or stale when UA's is
 * current. A whole file entry comes from one source, so its label is true for its functions too.
 */
export function overlayAtlas(own: Atlas, foreign: ForeignAtlas, skeleton: Skeleton): Pick<AtlasOverlay, 'atlas' | 'extras'> {
  const atlas: Atlas = { version: 1, folders: { ...own.folders }, files: { ...own.files } };
  const extras = new Map<string, { tags: string[]; layer?: string }>();
  const writtenAt = foreign.analyzedAt ?? '';
  for (const entry of foreign.files.values()) {
    const file = skeleton.files.get(entry.path);
    if (!file) continue;
    if (entry.tags.length > 0 || entry.layer) extras.set(entry.path, { tags: entry.tags, ...(entry.layer ? { layer: entry.layer } : {}) });
    if (!entry.text) continue;
    const theirs = foreignState(entry, file);
    const ours = entryState(own.files[entry.path], file.hash);
    if (ours === 'current' || (ours === 'stale' && theirs !== 'current')) continue;
    const replacement: AtlasFileEntry = { hash: entry.hash ?? '', text: entry.text, writtenAt, functions: entry.functions, source: 'understand-anything' };
    atlas.files[entry.path] = replacement;
  }
  // The overview: UA describes the project, not a list of names, so it is current when the commit it analysed is here.
  const root = skeleton.folders.get('');
  if (foreign.overview && root) {
    const ours = entryState(own.folders[''], root.hash);
    if (ours === 'missing' || (ours === 'stale' && foreign.commitInClone)) {
      atlas.folders[''] = { hash: foreign.commitInClone ? root.hash : '', text: foreign.overview, writtenAt, source: 'understand-anything' };
    }
  }
  return { atlas, extras };
}

/**
 * The build atlas after Fiu wrote into it, ready for `writeAtlas`: where a UA entry still stands, Fiu's own
 * entry for that file (a stale one UA's was hiding) is put back, so planning around UA never loses Fiu's.
 */
export function savable(build: Atlas, own: Atlas): Atlas {
  const files = { ...build.files };
  for (const [path, entry] of Object.entries(files)) {
    if (!fromUa(entry)) continue;
    const ours = own.files[path];
    if (ours) files[path] = ours;
    else delete files[path];
  }
  return { version: 1, folders: build.folders, files };
}

/** Files under `scope` that need no description from Fiu because UA's entry is current. */
export function coveredByUa(build: Atlas, own: Atlas, skeleton: Skeleton, scope = ''): number {
  let count = 0;
  for (const file of skeleton.files.values()) {
    if (!file.described || (scope !== '' && !file.path.startsWith(`${scope}/`))) continue;
    const entry = build.files[file.path];
    if (fromUa(entry) && entryState(entry, file.hash) === 'current' && entryState(own.files[file.path], file.hash) !== 'current') count++;
  }
  return count;
}

/** One line saying UA's graph is in use, or why it isn't; undefined when there is none or it is off. */
export function uaNotice(ua: UaStatus): string | undefined {
  if (ua.status === 'off' || ua.status === 'absent') return undefined;
  if (ua.status === 'unreadable') return `${UA_LABEL}'s graph in ${ua.dir}/ couldn't be read (${ua.reason}): ignored.`;
  const { atlas } = ua;
  const where = [
    `${atlas.dir}/`,
    ...(atlas.commit ? [`commit ${atlas.commit.slice(0, 7)}`] : []),
    ...(!atlas.commitInClone ? ['not in this clone, so shown as out of date'] : ua.behind !== undefined && ua.behind > 0 ? [`${ua.behind} commit${ua.behind === 1 ? '' : 's'} behind`] : []),
  ].join(', ');
  const used = `Also using ${UA_LABEL}'s graph (${where}): entries marked ${UA_MARK} are its model's word, not Verified. Turn it off with "understandAnything": false in .fiu/config.json.`;
  return ua.warning ? `${used} Note: ${ua.warning}.` : used;
}

async function commitsBehind(repoRoot: string, commit: string): Promise<number | undefined> {
  const { stdout, exitCode } = await execa('git', ['rev-list', '--count', `${commit}..HEAD`], { cwd: repoRoot, reject: false });
  const count = Number(stdout.trim());
  return exitCode === 0 && Number.isInteger(count) ? count : undefined;
}
