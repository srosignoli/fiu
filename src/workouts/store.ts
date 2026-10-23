import { existsSync } from 'node:fs';
import { mkdir, readdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import type { WorkspacePaths } from '../workspace.ts';
import type { WorkoutRecord } from './save.ts';

export const OutcomeSchema = z.object({
  workoutId: z.string(),
  outcome: z.enum(['completed', 'abandoned']),
  at: z.iso.datetime(),
  /** Test runs triggered by saves. */
  attempts: z.number().int().nonnegative(),
  hintsUsed: z.number().int().nonnegative(),
  rating: z.enum(['up', 'down']).optional(),
});
export type Outcome = z.infer<typeof OutcomeSchema>;

const StateSchema = z.object({ outcomes: z.array(OutcomeSchema) });

export class WorkoutNotFoundError extends Error {
  constructor(id: string) {
    super(`No pending Workout "${id}". Run \`kin train\` with no argument to pick one.`);
  }
}

export interface PendingWorkout {
  record: WorkoutRecord;
  dir: string;
}

/** Workouts waiting in .kintsugi/workouts/, newest first. */
export async function listPending(paths: WorkspacePaths): Promise<PendingWorkout[]> {
  if (!existsSync(paths.workoutsDir)) return [];
  const pending: PendingWorkout[] = [];
  for (const id of await readdir(paths.workoutsDir)) {
    const dir = join(paths.workoutsDir, id);
    const metadata = join(dir, 'workout.json');
    if (!existsSync(metadata)) continue;
    pending.push({ record: JSON.parse(await readFile(metadata, 'utf8')), dir });
  }
  return pending.sort((a, b) => b.record.createdAt.localeCompare(a.record.createdAt));
}

export async function loadPending(paths: WorkspacePaths, id: string): Promise<PendingWorkout> {
  const found = (await listPending(paths)).find((w) => w.record.id === id);
  if (!found) throw new WorkoutNotFoundError(id);
  return found;
}

/** Appends the outcome to state.json and moves the Workout to done/. */
export async function finishWorkout(paths: WorkspacePaths, workout: PendingWorkout, outcome: Outcome): Promise<string> {
  const raw = existsSync(paths.stateFile) ? JSON.parse(await readFile(paths.stateFile, 'utf8')) : { outcomes: [] };
  const state = StateSchema.parse(raw);
  state.outcomes.push(OutcomeSchema.parse(outcome));
  await writeFile(paths.stateFile, JSON.stringify(state, null, 2) + '\n');

  await mkdir(paths.doneDir, { recursive: true });
  const destination = join(paths.doneDir, workout.record.id);
  await rename(workout.dir, destination);
  return destination;
}
