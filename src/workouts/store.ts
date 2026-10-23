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

export const ModelUsageSchema = z.object({
  model: z.string(),
  inputTokens: z.number(),
  outputTokens: z.number(),
  cacheReadTokens: z.number(),
  cacheWriteTokens: z.number(),
});

export const CostSchema = z.object({
  usage: z.array(ModelUsageSchema),
  usd: z.number(),
  unpricedModels: z.array(z.string()),
  pricesAsOf: z.string(),
});

/** One request for a Workout and everything it cost, whether or not it produced one. */
export const SpendSchema = z.object({
  at: z.iso.datetime(),
  origin: z.enum(['manual', 'agent-task']),
  /** Entries from before agent mode are all `kintsugi`. */
  generator: z.enum(['kintsugi', 'agent']).default('kintsugi'),
  /** The source file, relative to the repository root. */
  source: z.string(),
  result: z.enum(['verified', 'not-verified', 'not-worth-practicing', 'error']),
  workoutId: z.string().optional(),
  generationAttempts: z.number().int().nonnegative(),
  /** Null when the user's agent generated it: Kintsugi can't see its usage. */
  cost: CostSchema.nullable(),
});
export type Spend = z.infer<typeof SpendSchema>;

const StateSchema = z.object({
  outcomes: z.array(OutcomeSchema),
  /** The spend ledger: every generation request, including those that produced nothing. */
  spend: z.array(SpendSchema).default([]),
});
export type State = z.infer<typeof StateSchema>;

export async function readState(paths: WorkspacePaths): Promise<State> {
  const raw = existsSync(paths.stateFile) ? JSON.parse(await readFile(paths.stateFile, 'utf8')) : { outcomes: [] };
  return StateSchema.parse(raw);
}

async function writeState(paths: WorkspacePaths, state: State): Promise<void> {
  await writeFile(paths.stateFile, JSON.stringify(state, null, 2) + '\n');
}

export async function recordSpend(paths: WorkspacePaths, spend: Spend): Promise<void> {
  const state = await readState(paths);
  state.spend.push(SpendSchema.parse(spend));
  await writeState(paths, state);
}

/** The mean cost of recent generation requests, counting only fully priced ones. */
export function averageSpend(spend: Spend[], last = 10): { usd: number; count: number } | undefined {
  const priced = spend.filter((s) => s.cost !== null && s.cost.unpricedModels.length === 0).slice(-last);
  if (priced.length === 0) return undefined;
  return { usd: priced.reduce((sum, s) => sum + s.cost!.usd, 0) / priced.length, count: priced.length };
}

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
  const state = await readState(paths);
  state.outcomes.push(OutcomeSchema.parse(outcome));
  await writeState(paths, state);

  await mkdir(paths.doneDir, { recursive: true });
  const destination = join(paths.doneDir, workout.record.id);
  await rename(workout.dir, destination);
  return destination;
}
