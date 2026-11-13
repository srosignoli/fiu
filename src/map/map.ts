import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { execa } from 'execa';
import { existsSync } from 'node:fs';
import { buildSkeleton } from '../atlas/skeleton.ts';
import { readAtlasOverlay, uaNotice } from '../atlas/overlay.ts';
import { findUaDir } from '../atlas/ua.ts';
import { entryState, staleCounts } from '../atlas/store.ts';
import { blindSpots, firstAnswers } from './stats.ts';
import { isAiAuthored } from '../background/commits.ts';
import { loadRepoConfig, loadUserConfig, resolveConfig, type ConfigEnv } from '../config.ts';
import { logicScore } from '../explore/shortlist.ts';
import { isDrillableSourcePath } from '../languages/paths.ts';
import { profileForFile, UnsupportedLanguageError } from '../languages/registry.ts';
import type { WorkoutKind } from '../synthesis/schema.ts';
import { listAttemptRecords } from '../workouts/attempts.ts';
import { listWorkouts, readState } from '../workouts/store.ts';
import { findRepoRoot, workspacePaths } from '../workspace.ts';
import { homedir } from 'node:os';

/** Worst first. */
export type FileState = 'red' | 'amber' | 'green' | 'grey';
const SEVERITY: Record<FileState, number> = { red: 3, amber: 2, green: 1, grey: 0 };

/** Practice goes Stale when a file changes this much after the code the practised Workout came from. */
export const STALE_CHANGED_LINES = 20;
/** Never-practised files changed by AI-authored commits this recently are amber. */
export const RECENT_AI_DAYS = 30;
/** Never-practised files above this quantile of the repository's logic scores are red. */
const RED_QUANTILE = 0.75;
/** Never-practised AI-changed files below this quantile are grey: glue and wiring, not debt. */
const AMBER_QUANTILE = 0.5;

export interface FileEntry {
  path: string;
  state: FileState;
  /** The latest finished Attempt's outcome on a Workout from this file. */
  practice?: 'completed' | 'abandoned';
  /** Which kinds of Workout the file was practised with: code fluency (Drills, Katas) or system fluency (Predictions). */
  practisedWith?: WorkoutKind[];
  /** Lines changed since the practised Workout's commit, when Stale. */
  staleBy?: number;
  aiChangedRecently: boolean;
  score?: number;
  /** A queued or in-progress Workout already made from this file. */
  waitingWorkout?: string;
  /** What the Atlas says the file is for. */
  atlas?: AtlasNote;
  /** Your latest first answer to a Prediction on this file was certain and wrong (§11.12). */
  blindSpot?: { workoutId: string };
}

/** An Atlas entry as the map shows it; stale once the content changed since it was written. */
export interface AtlasNote {
  text: string;
  stale: boolean;
  /** Set when the entry is Understand-Anything's, not Fiu's (ADR 0010). */
  source?: 'understand-anything';
}

export interface DirEntry {
  path: string;
  state: FileState;
  counts: { red: number; amber: number; green: number };
  /** Blind Spots among its files. */
  blindSpots: number;
  files: FileEntry[];
  atlas?: AtlasNote;
}

export type Suggestion =
  | { kind: 'check'; path: string }
  | { kind: 'train'; workoutId: string; path: string }
  | { kind: 'explore'; path: string; red: number }
  | { kind: 'drill'; path: string; state: FileState };

export interface MapReport {
  repository: string;
  /** The directory the map was narrowed to, relative to the repository root ('' for all). */
  scope: string;
  dirs: DirEntry[];
  suggestions: Suggestion[];
  /** Present once an Atlas exists: its overview, and how much of it is stale. */
  atlas?: { overview?: AtlasNote; staleFiles: number; staleFolders: number; notice?: string };
}

export interface MapOptions {
  configEnv?: ConfigEnv;
  now?: Date;
}

/** `fiu map [<path>]`: your comprehension debt, by directory. Local and free: git history, your Attempts, logic scores. */
export async function buildMap(cwd: string, scopePath = '', { configEnv = { env: process.env, home: homedir() }, now = new Date() }: MapOptions = {}): Promise<MapReport> {
  const repo = await findRepoRoot(cwd);
  const paths = workspacePaths(repo);
  const config = resolveConfig(await loadRepoConfig(paths.configFile), await loadUserConfig(configEnv));
  const scope = normaliseScope(repo, cwd, scopePath);

  // Every tracked source file a Language Profile recognises, with its logic score.
  const { stdout } = await execa('git', ['ls-files', '-z'], { cwd: repo });
  const sources: { path: string; score?: number }[] = [];
  for (const path of stdout.split('\0').filter(Boolean)) {
    try {
      profileForFile(path, config.profiles);
    } catch (error) {
      if (error instanceof UnsupportedLanguageError) continue;
      throw error;
    }
    const drillable = isDrillableSourcePath(path);
    const source = drillable ? await readFile(join(repo, path), 'utf8').catch(() => undefined) : undefined;
    sources.push({ path, score: source === undefined ? undefined : logicScore(source)?.score });
  }
  // Red is relative to this repository: its densest quarter (repo-wide, whatever the scope).
  const scores = sources.flatMap((s) => (s.score === undefined ? [] : [s.score])).sort((a, b) => a - b);
  const quantile = (q: number) => (scores.length > 0 ? scores[Math.floor(scores.length * q)]! : Infinity);
  const redThreshold = quantile(RED_QUANTILE);
  const amberThreshold = quantile(AMBER_QUANTILE);

  const practice = await practiceByFile(paths);
  const blind = new Map(blindSpots(await firstAnswers(paths)).map((b) => [b.path, b.workoutId]));
  const aiChanged = await recentlyAiChanged(repo, now);
  const waiting = new Map<string, string>();
  for (const w of await listWorkouts(paths)) {
    if ((w.status === 'queued' || w.status === 'in-progress') && !waiting.has(w.record.source.path)) waiting.set(w.record.source.path, w.record.id);
  }

  const files: FileEntry[] = [];
  for (const { path, score } of sources) {
    if (scope && !(path === scope || path.startsWith(`${scope}/`))) continue;
    const practised = practice.get(path);
    const staleBy = practised?.commit ? await changedSince(repo, practised.commit, path) : undefined;
    const isStale = staleBy !== undefined && staleBy >= STALE_CHANGED_LINES;
    const ai = aiChanged.has(path);
    // Worst first. Only drillable files (with a score) can be red or amber when never practised.
    const state: FileState = practised
      ? isStale
        ? 'amber'
        : 'green'
      : score === undefined
        ? 'grey'
        : score >= redThreshold
          ? 'red'
          : ai && score >= amberThreshold
            ? 'amber'
            : 'grey';
    files.push({
      path,
      state,
      ...(practised ? { practice: practised.outcome, practisedWith: [...practised.kinds].sort() } : {}),
      ...(isStale ? { staleBy } : {}),
      aiChangedRecently: ai,
      ...(score !== undefined ? { score } : {}),
      ...(waiting.has(path) ? { waitingWorkout: waiting.get(path) } : {}),
      ...(blind.has(path) ? { blindSpot: { workoutId: blind.get(path)! } } : {}),
    });
  }

  const dirs = groupByDirectory(files);
  const report: MapReport = { repository: repo, scope, dirs, suggestions: suggest(dirs) };
  // The skeleton costs a read of every file: only when there is an Atlas, Fiu's or Understand-Anything's, to show.
  if (existsSync(paths.atlasFile) || findUaDir(repo) !== undefined) {
    const skeleton = await buildSkeleton(repo, config.profiles);
    const { atlas, build, ua } = await readAtlasOverlay(paths, skeleton);
    const notice = uaNotice(ua);
    const note = (entry: { text: string; hash: string; source?: 'understand-anything' } | undefined, hash: string | undefined): AtlasNote | undefined =>
      entry && hash !== undefined ? { text: entry.text, stale: entryState(entry, hash) === 'stale', ...(entry.source ? { source: entry.source } : {}) } : undefined;
    for (const dir of dirs) {
      const folder = note(atlas.folders[dir.path], skeleton.folders.get(dir.path)?.hash);
      if (folder) dir.atlas = folder;
      for (const file of dir.files) {
        const described = note(atlas.files[file.path], skeleton.files.get(file.path)?.hash);
        if (described) file.atlas = described;
      }
    }
    // What `fiu atlas build` would refresh: files with a current Understand-Anything entry aren't counted.
    const stale = staleCounts(build, skeleton);
    const overview = note(atlas.folders[''], skeleton.folders.get('')?.hash);
    if (existsSync(paths.atlasFile) || notice) report.atlas = { ...(overview ? { overview } : {}), staleFiles: stale.files, staleFolders: stale.folders, ...(notice ? { notice } : {}) };
  }
  return report;
}

function normaliseScope(repo: string, cwd: string, scopePath: string): string {
  if (!scopePath) return '';
  const absolute = join(cwd, scopePath);
  const relative = absolute.startsWith(repo) ? absolute.slice(repo.length).replace(/^\/+/, '') : scopePath;
  return relative.replace(/\/+$/, '');
}

/** For each source file, the latest finished Attempt on a Workout made from it, and that Workout's commit. */
/** For each source file, the latest finished Attempt at any Workout made from it. */
export async function practiceByFile(paths: ReturnType<typeof workspacePaths>) {
  const practice = new Map<string, { outcome: 'completed' | 'abandoned'; at: string; commit?: string; kinds: Set<WorkoutKind> }>();
  const consider = (path: string, kind: WorkoutKind, outcome: 'completed' | 'abandoned', at: string, commit?: string) => {
    const current = practice.get(path);
    const kinds = new Set([...(current?.kinds ?? []), kind]);
    practice.set(path, !current || at > current.at ? { outcome, at, commit, kinds } : { ...current, kinds });
  };
  const workouts = await listWorkouts(paths);
  const byId = new Map(workouts.map((w) => [w.record.id, w.record]));
  for (const { record } of workouts) {
    for (const attempt of await listAttemptRecords(paths, record.id)) {
      if (attempt.outcome && attempt.finishedAt) consider(record.source.path, record.kind ?? 'drill', attempt.outcome, attempt.finishedAt, record.source.commit);
    }
  }
  // Outcomes recorded by v1, before Attempts existed.
  for (const outcome of (await readState(paths)).outcomes) {
    const record = byId.get(outcome.workoutId);
    if (record && outcome.attempt === undefined) consider(record.source.path, record.kind ?? 'drill', outcome.outcome, outcome.at, record.source.commit);
  }
  return practice;
}

/** Files touched by AI-authored commits in the last RECENT_AI_DAYS days. */
async function recentlyAiChanged(repo: string, now: Date): Promise<Set<string>> {
  const since = new Date(now.getTime() - RECENT_AI_DAYS * 24 * 60 * 60 * 1000).toISOString();
  const { stdout } = await execa('git', ['log', `--since=${since}`, '--no-renames', '--name-only', '--format=%x1e%B%x1f'], { cwd: repo, reject: false });
  const changed = new Set<string>();
  for (const entry of stdout.split('\x1e').filter(Boolean)) {
    const [message = '', names = ''] = entry.split('\x1f');
    if (!isAiAuthored(message)) continue;
    for (const name of names.split('\n').map((n) => n.trim()).filter(Boolean)) changed.add(name);
  }
  return changed;
}

/** Lines added plus removed in a file between a commit and the working tree; undefined if the commit isn't known here. */
async function changedSince(repo: string, commit: string, path: string): Promise<number | undefined> {
  const result = await execa('git', ['diff', '--numstat', commit, '--', path], { cwd: repo, reject: false });
  if (result.exitCode !== 0) return undefined;
  return result.stdout
    .split('\n')
    .filter(Boolean)
    .reduce((sum, line) => {
      const [added, removed] = line.split('\t');
      return sum + (Number(added) || 0) + (Number(removed) || 0);
    }, 0);
}

function groupByDirectory(files: FileEntry[]): DirEntry[] {
  const dirs = new Map<string, DirEntry>();
  for (const file of files) {
    const dir = dirname(file.path) === '.' ? '' : dirname(file.path);
    const entry = dirs.get(dir) ?? { path: dir, state: 'grey' as FileState, counts: { red: 0, amber: 0, green: 0 }, blindSpots: 0, files: [] };
    entry.files.push(file);
    if (file.blindSpot) entry.blindSpots++;
    if (file.state !== 'grey') entry.counts[file.state]++;
    if (SEVERITY[file.state] > SEVERITY[entry.state]) entry.state = file.state;
    dirs.set(dir, entry);
  }
  for (const dir of dirs.values()) dir.files.sort((a, b) => SEVERITY[b.state] - SEVERITY[a.state] || a.path.localeCompare(b.path));
  return [...dirs.values()].sort((a, b) => a.path.localeCompare(b.path));
}

/** At most 3: check Blind Spots again, use Drills already paid for, then explore the reddest module, then drill single files. */
function suggest(dirs: DirEntry[]): Suggestion[] {
  const suggestions: Suggestion[] = [];
  for (const file of dirs.flatMap((d) => d.files).filter((f) => f.blindSpot)) {
    if (suggestions.length < 3) suggestions.push({ kind: 'check', path: file.path });
  }
  const files = dirs.flatMap((d) => d.files).filter((f) => f.state === 'red' || f.state === 'amber');
  const bySeverity = files.sort((a, b) => SEVERITY[b.state] - SEVERITY[a.state] || (b.score ?? 0) - (a.score ?? 0));
  for (const file of bySeverity) {
    if (file.waitingWorkout && suggestions.length < 3) suggestions.push({ kind: 'train', workoutId: file.waitingWorkout, path: file.path });
  }
  const reddest = dirs.filter((d) => d.counts.red >= 2).sort((a, b) => b.counts.red - a.counts.red)[0];
  if (reddest && suggestions.length < 3) suggestions.push({ kind: 'explore', path: reddest.path, red: reddest.counts.red });
  const covered = new Set(suggestions.map((s) => s.path));
  for (const file of bySeverity) {
    if (suggestions.length >= 3) break;
    const inExplored = reddest && file.path.startsWith(`${reddest.path}/`) && suggestions.some((s) => s.kind === 'explore');
    if (!covered.has(file.path) && !inExplored && !file.waitingWorkout) suggestions.push({ kind: 'drill', path: file.path, state: file.state });
  }
  return suggestions;
}
