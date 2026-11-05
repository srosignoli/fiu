import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { answersOnly, QUICK, type WorkoutKind } from '../synthesis/schema.ts';
import type { WorkspacePaths } from '../workspace.ts';
import type { WorkoutRecord } from './save.ts';
import { listWorkouts, type StoredWorkout } from './store.ts';

/** A Workout fits a short wait: Quick by its own numbers, however it was requested. */
export async function isQuick(workout: { record: WorkoutRecord; dir: string }): Promise<boolean> {
  if (workout.record.estimatedMinutes > QUICK.maxMinutes) return false;
  // A Prediction or Diagnosis shows no code, so only its minutes count.
  if (answersOnly(workout.record.kind)) return true;
  const code = await readFile(join(workout.dir, workout.record.files.code), 'utf8').catch(() => undefined);
  return code !== undefined && code.replace(/\n$/, '').split('\n').length <= QUICK.maxStartingCodeLines;
}

/** Workouts made from code an AI wrote come first: practising those is what pays down comprehension debt. */
const fromAiCode = (record: WorkoutRecord) => record.origin === 'agent-task' || (record.origin === 'commit' && record.commit?.aiAuthored === true);

/**
 * The queue's best Quick Workout: never attempted, not Discarded, Quick, with its source file still
 * in the repository; the preferred kinds first (in order, any other kind after), then Workouts from
 * AI-written code, then the newest.
 */
export async function nextQuickWorkout(paths: WorkspacePaths, kinds: readonly WorkoutKind[] = ['drill']): Promise<StoredWorkout | undefined> {
  const candidates: StoredWorkout[] = [];
  for (const workout of await listWorkouts(paths)) {
    // Track steps are a curriculum, worked through with `fiu track`, not a snack for a short wait.
    if (workout.status !== 'queued' || workout.record.origin === 'explore') continue;
    if (!existsSync(join(paths.repoRoot, workout.record.source.path))) continue;
    if (await isQuick(workout)) candidates.push(workout);
  }
  const rank = (record: WorkoutRecord) => {
    const at = kinds.indexOf(record.kind ?? 'drill');
    return at === -1 ? kinds.length : at;
  };
  // listWorkouts is newest first, and the sort is stable.
  return candidates.sort((a, b) => rank(a.record) - rank(b.record) || Number(fromAiCode(b.record)) - Number(fromAiCode(a.record)))[0];
}
