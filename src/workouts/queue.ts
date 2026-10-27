import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { QUICK } from '../synthesis/schema.ts';
import type { WorkspacePaths } from '../workspace.ts';
import type { WorkoutRecord } from './save.ts';
import { listWorkouts, type StoredWorkout } from './store.ts';

/** A Workout fits a short wait: Quick by its own numbers, however it was requested. */
export async function isQuick(workout: { record: WorkoutRecord; dir: string }): Promise<boolean> {
  if (workout.record.estimatedMinutes > QUICK.maxMinutes) return false;
  const code = await readFile(join(workout.dir, workout.record.files.code), 'utf8').catch(() => undefined);
  return code !== undefined && code.replace(/\n$/, '').split('\n').length <= QUICK.maxStartingCodeLines;
}

/** Workouts made from code an AI wrote come first: practising those is what pays down comprehension debt. */
const fromAiCode = (record: WorkoutRecord) => record.origin === 'agent-task' || (record.origin === 'commit' && record.commit?.aiAuthored === true);

/**
 * The queue's best Quick Workout: never attempted, not Discarded, Quick, with its source file still
 * in the repository; Workouts from AI-written code first, then the newest.
 */
export async function nextQuickWorkout(paths: WorkspacePaths): Promise<StoredWorkout | undefined> {
  const candidates: StoredWorkout[] = [];
  for (const workout of await listWorkouts(paths)) {
    if (workout.status !== 'queued') continue;
    if (!existsSync(join(paths.repoRoot, workout.record.source.path))) continue;
    if (await isQuick(workout)) candidates.push(workout);
  }
  // listWorkouts is newest first, and the sort is stable.
  return candidates.sort((a, b) => Number(fromAiCode(b.record)) - Number(fromAiCode(a.record)))[0];
}
