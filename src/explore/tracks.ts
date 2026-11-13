import { existsSync } from 'node:fs';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { WorkoutKind } from '../synthesis/schema.ts';
import type { Generator, SharedBy } from '../workouts/save.ts';
import { listWorkouts, type WorkoutStatus } from '../workouts/store.ts';
import type { WorkspacePaths } from '../workspace.ts';

export interface TrackStep {
  workoutId: string;
  path: string;
  /** Absent on Tracks made before v4.3: those steps are Drills. */
  kind?: WorkoutKind;
  pillar: 'algorithm' | 'pattern' | 'library';
  why: string;
}

/** A Track's manifest: the module it teaches and its steps, in order. */
export interface TrackRecord {
  id: string;
  title: string;
  /** The module directory, relative to the repository root; for a flow, the folder its files share. */
  module: string;
  /** Set when the Track follows a business flow from Understand-Anything's domain graph (ADR 0010). */
  flow?: string;
  createdAt: string;
  generator: Generator;
  steps: TrackStep[];
  /** Set on Tracks fetched from the team's shared branch. */
  sharedBy?: SharedBy;
}

export class TrackNotFoundError extends Error {
  constructor(id: string) {
    super(`No Track "${id}". Run \`fiu track\` to list them.`);
  }
}

export const tracksDir = (paths: WorkspacePaths) => join(paths.root, 'tracks');

export async function saveTrack(paths: WorkspacePaths, track: TrackRecord): Promise<void> {
  await mkdir(tracksDir(paths), { recursive: true });
  await writeFile(join(tracksDir(paths), `${track.id}.json`), JSON.stringify(track, null, 2) + '\n');
}

/** Every Track, newest first. */
export async function listTracks(paths: WorkspacePaths): Promise<TrackRecord[]> {
  if (!existsSync(tracksDir(paths))) return [];
  const tracks: TrackRecord[] = [];
  for (const file of await readdir(tracksDir(paths))) {
    if (file.endsWith('.json')) tracks.push(JSON.parse(await readFile(join(tracksDir(paths), file), 'utf8')));
  }
  return tracks.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export async function loadTrack(paths: WorkspacePaths, id: string): Promise<TrackRecord> {
  const track = (await listTracks(paths)).find((t) => t.id === id);
  if (!track) throw new TrackNotFoundError(id);
  return track;
}

/** A unique id from the date and the module's name, or the flow's when the Track follows one. */
export async function trackId(paths: WorkspacePaths, module: string, now: Date, flow?: string): Promise<string> {
  const name = flow ? flow.split(/\s+/).slice(0, 5).join('-') : module.split('/').filter(Boolean).slice(-2).join('-');
  const slug = (name || 'repository').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  const base = `track_${now.toISOString().slice(0, 10).replaceAll('-', '')}_${slug}`;
  const taken = new Set((await listTracks(paths)).map((t) => t.id));
  let id = base;
  for (let n = 2; taken.has(id); n++) id = `${base}-${n}`;
  return id;
}

export interface StepProgress extends TrackStep {
  /** `missing` when the Workout was removed by hand. */
  status: WorkoutStatus | 'missing';
}

/** Each step with its Workout's status, and the step to open next: the first one in progress or not yet attempted. */
export async function trackProgress(paths: WorkspacePaths, track: TrackRecord): Promise<{ steps: StepProgress[]; next?: StepProgress }> {
  const statuses = new Map((await listWorkouts(paths)).map((w) => [w.record.id, w.status]));
  const steps = track.steps.map((step) => ({ ...step, status: statuses.get(step.workoutId) ?? ('missing' as const) }));
  const next = steps.find((s) => s.status === 'in-progress') ?? steps.find((s) => s.status === 'queued');
  return { steps, next };
}
