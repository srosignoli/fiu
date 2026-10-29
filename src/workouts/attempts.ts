import { existsSync } from 'node:fs';
import { copyFile, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { LanguageProfile } from '../languages/profile.ts';
import type { WorkspacePaths } from '../workspace.ts';
import type { WorkoutRecord } from './save.ts';

const ATTEMPT_FILE = 'attempt.json';

/** One try at a Workout: its own copy of the Starting Code, and its own outcome. */
export interface AttemptRecord {
  workoutId: string;
  number: number;
  startedAt: string;
  /** Test runs triggered by saves. */
  runs: number;
  hintsUsed: number;
  finishedAt?: string;
  outcome?: 'completed' | 'abandoned';
  rating?: 'up' | 'down';
  /** The human's answer to "Is it a real bug in your code?", when the Workout reported one. */
  defectConfirmed?: boolean;
  /** Prediction only: the order its options are shown in (indices into the Workout's options), shuffled per Attempt. */
  order?: number[];
  /** Prediction only: the option chosen (an index into the Workout's options). */
  answer?: number;
}

export interface Attempt {
  record: AttemptRecord;
  /** Where the human works: a fresh copy of the Workout's files. */
  dir: string;
}

export async function listAttemptRecords(paths: WorkspacePaths, workoutId: string): Promise<AttemptRecord[]> {
  const root = join(paths.attemptsDir, workoutId);
  if (!existsSync(root)) return [];
  const records: AttemptRecord[] = [];
  for (const entry of await readdir(root)) {
    const file = join(root, entry, ATTEMPT_FILE);
    if (existsSync(file)) records.push(JSON.parse(await readFile(file, 'utf8')));
  }
  return records.sort((a, b) => a.number - b.number);
}

/**
 * The Workout's open Attempt, or a new one: a fresh copy of the Starting Code, tests, and support files.
 * Only one Attempt per Workout is open at a time.
 */
export async function openAttempt(
  paths: WorkspacePaths,
  workout: { record: WorkoutRecord; dir: string },
  profile: LanguageProfile,
  now = new Date(),
  random: () => number = Math.random,
): Promise<{ attempt: Attempt; resumed: boolean }> {
  const id = workout.record.id;
  const records = await listAttemptRecords(paths, id);
  const open = records.find((r) => !r.outcome);
  if (open) return { attempt: { record: open, dir: attemptDir(paths, id, open.number) }, resumed: true };

  const number = (records.at(-1)?.number ?? 0) + 1;
  const dir = attemptDir(paths, id, number);
  // A Prediction has no code to work on: only its options, in a fresh order so a retry isn't answered by position.
  const prediction = workout.record.prediction;
  const files = prediction ? [] : [...Object.keys(profile.supportFiles), workout.record.files.code, workout.record.files.test];
  for (const file of files) {
    const source = join(workout.dir, file);
    if (!existsSync(source)) continue;
    await mkdir(dirname(join(dir, file)), { recursive: true });
    await copyFile(source, join(dir, file));
  }
  const record: AttemptRecord = {
    workoutId: id,
    number,
    startedAt: now.toISOString(),
    runs: 0,
    hintsUsed: 0,
    ...(prediction ? { order: shuffled(prediction.options.length, random) } : {}),
  };
  await saveAttempt({ record, dir });
  return { attempt: { record, dir }, resumed: false };
}

/** 0..n-1 in random order (Fisher–Yates). */
function shuffled(n: number, random: () => number): number[] {
  const order = Array.from({ length: n }, (_, i) => i);
  for (let i = n - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [order[i], order[j]] = [order[j]!, order[i]!];
  }
  return order;
}

/** Persists the Attempt's progress, so a resumed Attempt keeps its counts. */
export async function saveAttempt({ record, dir }: Attempt): Promise<void> {
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, ATTEMPT_FILE), JSON.stringify(record, null, 2) + '\n');
}

export const attemptDir = (paths: WorkspacePaths, workoutId: string, number: number) => join(paths.attemptsDir, workoutId, String(number));

/** Files in an Attempt directory that aren't the human's work. */
export const isAttemptBookkeeping = (path: string) => path === ATTEMPT_FILE;
