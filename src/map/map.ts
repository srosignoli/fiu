import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { execa } from 'execa';
import { isAiAuthored } from '../background/commits.ts';
import { loadRepoConfig, loadUserConfig, resolveConfig, type ConfigEnv } from '../config.ts';
import { logicScore } from '../explore/shortlist.ts';
import { isDrillableSourcePath } from '../languages/paths.ts';
import { profileForFile, UnsupportedLanguageError } from '../languages/registry.ts';
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
  /** Lines changed since the practised Workout's commit, when Stale. */
  staleBy?: number;
  aiChangedRecently: boolean;
  score?: number;
  /** A queued or in-progress Workout already made from this file. */
  waitingWorkout?: string;
}

export interface DirEntry {
  path: string;
  state: FileState;
  counts: { red: number; amber: number; green: number };
  files: FileEntry[];
}

export type Suggestion =
  | { kind: 'train'; workoutId: string; path: string }
  | { kind: 'explore'; path: string; red: number }
  | { kind: 'drill'; path: string; state: FileState };

export interface MapReport {
  repository: string;
  /** The directory the map was narrowed to, relative to the repository root ('' for all). */
  scope: string;
  dirs: DirEntry[];
  suggestions: Suggestion[];
}

export interface MapOptions {
  configEnv?: ConfigEnv;
  now?: Date;
}

/** `kin map [<path>]`: your comprehension debt, by directory. Local and free: git history, your Attempts, logic scores. */
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
      ...(practised ? { practice: practised.outcome } : {}),
      ...(isStale ? { staleBy } : {}),
      aiChangedRecently: ai,
      ...(score !== undefined ? { score } : {}),
      ...(waiting.has(path) ? { waitingWorkout: waiting.get(path) } : {}),
    });
  }

  const dirs = groupByDirectory(files);
  return { repository: repo, scope, dirs, suggestions: suggest(dirs) };
}

function normaliseScope(repo: string, cwd: string, scopePath: string): string {
  if (!scopePath) return '';
  const absolute = join(cwd, scopePath);
  const relative = absolute.startsWith(repo) ? absolute.slice(repo.length).replace(/^\/+/, '') : scopePath;
  return relative.replace(/\/+$/, '');
}

/** For each source file, the latest finished Attempt on a Workout made from it, and that Workout's commit. */
async function practiceByFile(paths: ReturnType<typeof workspacePaths>) {
  const practice = new Map<string, { outcome: 'completed' | 'abandoned'; at: string; commit?: string }>();
  const consider = (path: string, outcome: 'completed' | 'abandoned', at: string, commit?: string) => {
    const current = practice.get(path);
    if (!current || at > current.at) practice.set(path, { outcome, at, commit });
  };
  const workouts = await listWorkouts(paths);
  const byId = new Map(workouts.map((w) => [w.record.id, w.record]));
  for (const { record } of workouts) {
    for (const attempt of await listAttemptRecords(paths, record.id)) {
      if (attempt.outcome && attempt.finishedAt) consider(record.source.path, attempt.outcome, attempt.finishedAt, record.source.commit);
    }
  }
  // Outcomes recorded by v1, before Attempts existed.
  for (const outcome of (await readState(paths)).outcomes) {
    const record = byId.get(outcome.workoutId);
    if (record && outcome.attempt === undefined) consider(record.source.path, outcome.outcome, outcome.at, record.source.commit);
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
    const entry = dirs.get(dir) ?? { path: dir, state: 'grey' as FileState, counts: { red: 0, amber: 0, green: 0 }, files: [] };
    entry.files.push(file);
    if (file.state !== 'grey') entry.counts[file.state]++;
    if (SEVERITY[file.state] > SEVERITY[entry.state]) entry.state = file.state;
    dirs.set(dir, entry);
  }
  for (const dir of dirs.values()) dir.files.sort((a, b) => SEVERITY[b.state] - SEVERITY[a.state] || a.path.localeCompare(b.path));
  return [...dirs.values()].sort((a, b) => a.path.localeCompare(b.path));
}

/** At most 3: use Drills already paid for, then explore the reddest module, then drill single files. */
function suggest(dirs: DirEntry[]): Suggestion[] {
  const suggestions: Suggestion[] = [];
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
