import { createHash } from 'node:crypto';
import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, relative, sep } from 'node:path';
import { execa } from 'execa';
import { existsSync } from 'node:fs';
import { buildSkeleton } from '../atlas/skeleton.ts';
import { AtlasSchema, mergeAtlas, preferCurrent, preferOursOrNewer, readAtlas, writeAtlas, type Atlas } from '../atlas/store.ts';
import { loadRepoConfig, loadUserConfig, resolveConfig, type ConfigEnv } from '../config.ts';
import { listTracks, saveTrack, type TrackRecord } from '../explore/tracks.ts';
import type { LanguageProfile } from '../languages/profile.ts';
import { preflight } from '../languages/run.ts';
import { verifySandbox } from '../sandbox/canary.ts';
import { openSandbox, type Sandbox } from '../sandbox/sandbox.ts';
import { describeFailures, verify } from '../verify/gate.ts';
import type { SharedBy, WorkoutRecord } from '../workouts/save.ts';
import { listWorkouts, loadWorkout, seriesQuestions } from '../workouts/store.ts';
import { ensureWorkspace, excludeWorkspaceFromGit, findRepoRoot, workspacePaths } from '../workspace.ts';
import { commitWith, fetchShared, gitIdentity, onSomeRemoteBranch, pushShared, readBlob, readTree, SharingError } from './git.ts';

export type { SharedBy };

const PUSH_ATTEMPTS = 3;
const WORKOUTS = 'workouts/';
const TRACKS = 'tracks/';
/** The team's Atlas: one file, merged entry by entry. */
const ATLAS = 'atlas.json';

type Files = Map<string, Buffer>;

/** Keys sorted at every level, so equal objects serialise identically. */
const stable = (value: unknown): unknown =>
  Array.isArray(value)
    ? value.map(stable)
    : value && typeof value === 'object'
      ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, stable(v)]))
      : value;

/**
 * What a Workout *is*, independent of where it lives and who shared it: every definition file, with
 * `workout.json`'s id and sharedBy stamp left out.
 */
export function fingerprint(files: Files): string {
  const hash = createHash('sha256');
  for (const path of [...files.keys()].sort()) {
    let content = files.get(path)!;
    if (path === 'workout.json') {
      const { id: _id, sharedBy: _sharedBy, ...rest } = JSON.parse(content.toString('utf8'));
      content = Buffer.from(JSON.stringify(stable(rest)));
    }
    hash.update(path).update('\0').update(content).update('\0');
  }
  return hash.digest('hex');
}

async function readDirFiles(dir: string): Promise<Files> {
  const files: Files = new Map();
  for (const entry of await readdir(dir, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const full = join(entry.parentPath, entry.name);
    files.set(relative(dir, full).split(sep).join('/'), await readFile(full));
  }
  return files;
}

/** The shared tree's Workouts and Tracks, grouped. */
async function sharedContents(repo: string, commit: string | undefined) {
  const tree = await readTree(repo, commit);
  const workouts = new Map<string, Map<string, string>>();
  const tracks = new Map<string, string>();
  for (const [path, blob] of tree) {
    if (path.startsWith(WORKOUTS)) {
      const [id, ...rest] = path.slice(WORKOUTS.length).split('/');
      if (!id || rest.length === 0) continue;
      if (!workouts.has(id)) workouts.set(id, new Map());
      workouts.get(id)!.set(rest.join('/'), blob);
    } else if (path.startsWith(TRACKS) && path.endsWith('.json')) {
      tracks.set(path.slice(TRACKS.length, -'.json'.length), blob);
    }
  }
  return { tree, workouts, tracks };
}

async function blobsToFiles(repo: string, blobs: Map<string, string>): Promise<Files> {
  const files: Files = new Map();
  for (const [path, blob] of blobs) files.set(path, await readBlob(repo, blob));
  return files;
}

async function hashContent(repo: string, content: Buffer): Promise<string> {
  return (await execa('git', ['hash-object', '-w', '--stdin'], { cwd: repo, input: content })).stdout.trim();
}

const suffixed = (id: string, print: string) => `${id}-${print.slice(0, 6)}`;

export interface ShareOptions {
  /** The remote to share through; `share.remote` in config, else origin. */
  remote?: string;
  /** --atlas: also share the Atlas, merged with the team's. */
  atlas?: boolean;
  now?: Date;
}

/** The Atlas on the shared branch, if any; an unreadable one counts as none. */
async function sharedAtlas(repo: string, tree: Map<string, string>): Promise<Atlas | undefined> {
  const blob = tree.get(ATLAS);
  if (!blob) return undefined;
  const parsed = AtlasSchema.safeParse(JSON.parse((await readBlob(repo, blob)).toString('utf8')));
  return parsed.success ? parsed.data : undefined;
}

const atlasJson = (atlas: Atlas) => {
  const sorted = (record: Record<string, unknown>) => Object.fromEntries(Object.entries(record).sort(([a], [b]) => a.localeCompare(b)));
  return Buffer.from(JSON.stringify({ version: 1, folders: sorted(atlas.folders), files: sorted(atlas.files) }, null, 2) + '\n');
};

export interface ShareReport {
  remote: string;
  /** Newly shared, with the id they were shared under (suffixed when a different Workout already had theirs). */
  shared: { id: string; as: string; kind: 'workout' | 'track' }[];
  alreadyShared: string[];
  warnings: string[];
  /** With --atlas: how many entries the team's Atlas holds now, and whether it changed. */
  atlas?: { entries: number; changed: boolean };
}

export class NotShareableError extends Error {}

/** `fiu share <id>...`: publishes Workouts (or whole Tracks) to the shared branch. */
export async function share(cwd: string, ids: string[], options: ShareOptions = {}): Promise<ShareReport> {
  if (ids.length === 0 && !options.atlas) throw new NotShareableError('Name the Workouts or Tracks to share, or pass --atlas to share the Atlas.');
  const repo = await findRepoRoot(cwd);
  const paths = workspacePaths(repo);
  const remote = options.remote ?? (await loadRepoConfig(paths.configFile)).share?.remote ?? 'origin';
  const identity = await gitIdentity(repo);
  const sharedBy: SharedBy = { ...identity, at: (options.now ?? new Date()).toISOString() };

  // What to share: each id is a Track (with all its steps), a Series (with all its questions), or a single Workout.
  const tracks = new Map((await listTracks(paths)).map((t) => [t.id, t]));
  const workoutIds: string[] = [];
  const trackRecords: TrackRecord[] = [];
  for (const id of ids) {
    const track = tracks.get(id);
    const series = id.startsWith('series_') ? await seriesQuestions(paths, id) : [];
    if (track) {
      trackRecords.push(track);
      workoutIds.push(...track.steps.map((s) => s.workoutId));
    } else if (series.length > 0) {
      workoutIds.push(...series.map((w) => w.record.id));
    } else {
      workoutIds.push(id);
    }
  }
  const workouts = await Promise.all([...new Set(workoutIds)].map((id) => loadWorkout(paths, id)));
  if (options.atlas && !existsSync(paths.atlasFile)) throw new NotShareableError('There is no Atlas to share yet: build it with `fiu atlas build`, or ask your agent: /fiu-atlas');
  const localAtlas = options.atlas ? await readAtlas(paths) : undefined;

  const refusals: string[] = [];
  const warnings: string[] = [];
  for (const { record } of workouts) {
    const { commit, dirty } = record.source;
    if (!commit || dirty) refusals.push(`${record.id} was made from uncommitted code in ${record.source.path}: teammates couldn't see its source.`);
    else if (!(await onSomeRemoteBranch(repo, commit))) {
      warnings.push(`${record.id} points at ${commit.slice(0, 12)}, which isn't on a remote branch yet: push your branch so teammates' source links work.`);
    }
  }
  if (refusals.length > 0) throw new NotShareableError(`Not shared:\n${refusals.map((r) => `- ${r}`).join('\n')}`);

  for (let attempt = 1; attempt <= PUSH_ATTEMPTS; attempt++) {
    const parent = await fetchShared(repo, remote);
    const remoteContents = await sharedContents(repo, parent);
    const additions = new Map<string, string>();
    const report: ShareReport = { remote, shared: [], alreadyShared: [], warnings };
    const sharedAs = new Map<string, string>();

    for (const { record, dir } of workouts) {
      const files = await readDirFiles(dir);
      const print = fingerprint(files);
      let as = record.id;
      const existing = remoteContents.workouts.get(as);
      if (existing && fingerprint(await blobsToFiles(repo, existing)) === print) {
        report.alreadyShared.push(record.id);
        sharedAs.set(record.id, as);
        continue;
      }
      if (existing) {
        as = suffixed(record.id, print);
        if (remoteContents.workouts.has(as)) {
          report.alreadyShared.push(record.id);
          sharedAs.set(record.id, as);
          continue;
        }
      }
      for (const [path, content] of files) {
        let blobContent = content;
        if (path === 'workout.json') {
          const json = JSON.parse(content.toString('utf8')) as WorkoutRecord;
          // A Workout fetched from a teammate keeps its original stamp.
          blobContent = Buffer.from(JSON.stringify({ ...json, id: as, sharedBy: json.sharedBy ?? sharedBy }, null, 2) + '\n');
        }
        additions.set(`${WORKOUTS}${as}/${path}`, await hashContent(repo, blobContent));
      }
      sharedAs.set(record.id, as);
      report.shared.push({ id: record.id, as, kind: 'workout' });
    }

    for (const track of trackRecords) {
      const manifest = {
        ...track,
        steps: track.steps.map((s) => ({ ...s, workoutId: sharedAs.get(s.workoutId) ?? s.workoutId })),
        sharedBy: track.sharedBy ?? sharedBy,
      };
      const existing = remoteContents.tracks.get(track.id);
      if (existing) {
        report.alreadyShared.push(track.id);
        continue;
      }
      additions.set(`${TRACKS}${track.id}.json`, await hashContent(repo, Buffer.from(JSON.stringify(manifest, null, 2) + '\n')));
      report.shared.push({ id: track.id, as: track.id, kind: 'track' });
    }

    if (localAtlas) {
      const theirs = await sharedAtlas(repo, remoteContents.tree);
      const merged = theirs ? mergeAtlas(localAtlas, theirs, preferOursOrNewer).atlas : localAtlas;
      const content = atlasJson(merged);
      const blob = await hashContent(repo, content);
      const changed = remoteContents.tree.get(ATLAS) !== blob;
      if (changed) additions.set(ATLAS, blob);
      report.atlas = { entries: Object.keys(merged.folders).length + Object.keys(merged.files).length, changed };
    }

    if (additions.size === 0) return report;
    const what = [...report.shared.map((s) => s.as), ...(report.atlas?.changed ? ['the Atlas'] : [])];
    const message = `Share ${what.join(', ')}\n\nShared by ${identity.name} <${identity.email}> with Fiu.`;
    const commit = await commitWith(repo, parent, additions, message);
    if ((await pushShared(repo, remote, commit)) === 'pushed') return report;
    // A teammate pushed first: start again from their branch.
  }
  throw new SharingError(`The shared branch kept moving while sharing; try again in a moment.`);
}

export interface FetchOptions {
  remote?: string;
  /** False with --no-sandbox: teammates' code then runs without isolation, for this invocation only. */
  sandbox: boolean;
}

export interface FetchDependencies {
  configEnv?: ConfigEnv;
  cacheRoot?: string;
}

export interface FetchReport {
  remote: string;
  nothingShared: boolean;
  imported: { id: string; as: string }[];
  alreadyHave: string[];
  /** Workouts that failed re-verification here, and why. */
  rejected: { id: string; reason: string }[];
  tracks: { id: string; as: string }[];
  skippedTracks: { id: string; reason: string }[];
  /** Atlas entries the team had that were missing here, or replaced stale ones here. */
  atlas?: { added: number; replaced: number };
}

/**
 * `fiu fetch`: brings in what teammates shared. Every incoming Workout is re-verified in the local
 * sandbox before it is added; Track manifests follow their steps' (possibly renamed) ids.
 */
export async function fetchWorkouts(cwd: string, options: FetchOptions, step: (message: string) => void = () => {}, deps: FetchDependencies = {}): Promise<FetchReport> {
  const repo = await findRepoRoot(cwd);
  const paths = workspacePaths(repo);
  await ensureWorkspace(paths);
  await excludeWorkspaceFromGit(repo);
  const repoConfig = await loadRepoConfig(paths.configFile);
  const config = resolveConfig(repoConfig, await loadUserConfig(deps.configEnv ?? { env: process.env, home: homedir() }));
  const remote = options.remote ?? repoConfig.share?.remote ?? 'origin';
  const report: FetchReport = { remote, nothingShared: false, imported: [], alreadyHave: [], rejected: [], tracks: [], skippedTracks: [] };

  step(`Fetching ${remote}`);
  const commit = await fetchShared(repo, remote);
  if (!commit) return { ...report, nothingShared: true };
  const contents = await sharedContents(repo, commit);

  // Local Workouts by id and by content, so a renamed import is recognised next time.
  const local = new Map<string, string>();
  for (const { record, dir } of await listWorkouts(paths)) local.set(record.id, fingerprint(await readDirFiles(dir)));
  const byPrint = new Map([...local].map(([id, print]) => [print, id]));
  const localIdFor = new Map<string, string>();

  let sandbox: Sandbox | undefined;
  const preflighted = new Set<string>();
  const sandboxFor = async (profile: LanguageProfile) => {
    if (!sandbox) {
      sandbox = await openSandbox({ repoRoot: repo, allowUnsandboxed: !options.sandbox });
      await verifySandbox(sandbox, deps.cacheRoot ? { cacheDir: deps.cacheRoot } : {});
    }
    if (!preflighted.has(profile.id)) {
      await preflight(sandbox, profile, deps.cacheRoot);
      preflighted.add(profile.id);
    }
    return sandbox;
  };

  const incoming = join(paths.root, 'incoming');
  try {
    for (const [id, blobs] of contents.workouts) {
      const files = await blobsToFiles(repo, blobs);
      const print = fingerprint(files);
      const same = byPrint.get(print);
      if (same) {
        report.alreadyHave.push(id);
        localIdFor.set(id, same);
        continue;
      }
      const as = local.has(id) ? suffixed(id, print) : id;
      const record = JSON.parse(files.get('workout.json')?.toString('utf8') ?? 'null') as WorkoutRecord | null;
      const profile = record && config.profiles.find((p) => p.id === record.language);
      if (!record || !profile) {
        report.rejected.push({ id, reason: record ? `no Language Profile "${record.language}" here` : 'missing workout.json' });
        continue;
      }

      step(`Re-verifying ${id}`);
      const text = (name: string) => files.get(name)?.toString('utf8') ?? '';
      const verification = await verify(
        {
          // A Quick Kata's gap (5–12 lines) is within a regular Kata's bounds, so `quick` isn't needed here.
          kind: record.kind,
          startingCode: text(record.files.code),
          referenceSolution: text(record.files.solution),
          testSuiteCode: text(record.files.test),
          regressionTestName: record.regressionTestName,
          // The sharer's source isn't here to compare with: that check ran when the Prediction was made.
          options: record.prediction?.options,
          causes: record.diagnosis?.causes,
          ...(record.files.previous ? { previous: text(record.files.previous) } : {}),
          ...(record.whatIf ? { whatIf: true } : {}),
        },
        profile,
        await sandboxFor(profile),
        { cacheRoot: deps.cacheRoot },
      );
      if (!verification.verified) {
        report.rejected.push({ id, reason: describeFailures(verification.failures, 300).split('\n')[0]! });
        continue;
      }

      // Stage inside .fiu/ (same filesystem), then move into place in one step.
      const staging = join(incoming, as);
      await rm(staging, { recursive: true, force: true });
      for (const [path, content] of files) {
        const target = join(staging, path);
        await mkdir(dirname(target), { recursive: true });
        await writeFile(target, path === 'workout.json' ? JSON.stringify({ ...record, id: as }, null, 2) + '\n' : content);
      }
      await rename(staging, join(paths.workoutsDir, as));
      local.set(as, print);
      byPrint.set(print, as);
      localIdFor.set(id, as);
      report.imported.push({ id, as });
    }

    const localTracks = new Set((await listTracks(paths)).map((t) => t.id));
    for (const [id, blob] of contents.tracks) {
      if (localTracks.has(id)) continue;
      const manifest = JSON.parse((await readBlob(repo, blob)).toString('utf8')) as TrackRecord;
      const steps = manifest.steps.map((s) => ({ ...s, workoutId: localIdFor.get(s.workoutId) ?? s.workoutId }));
      const missing = steps.filter((s) => !local.has(s.workoutId));
      if (missing.length > 0) {
        report.skippedTracks.push({ id, reason: `${missing.length} of its steps couldn't be fetched` });
        continue;
      }
      await saveTrack(paths, { ...manifest, steps });
      report.tracks.push({ id, as: id });
    }

    const theirs = await sharedAtlas(repo, contents.tree);
    if (theirs) {
      const merged = mergeAtlas(await readAtlas(paths), theirs, preferCurrent(await buildSkeleton(repo, config.profiles)));
      if (merged.added + merged.replaced > 0) await writeAtlas(paths, merged.atlas);
      report.atlas = { added: merged.added, replaced: merged.replaced };
    }
  } finally {
    await sandbox?.dispose();
    await rm(incoming, { recursive: true, force: true });
  }
  return report;
}

export { SharingError };
