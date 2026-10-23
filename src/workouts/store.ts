import { existsSync } from 'node:fs';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import type { WorkspacePaths } from '../workspace.ts';
import { listAttemptRecords } from './attempts.ts';
import type { WorkoutRecord } from './save.ts';

export const OutcomeSchema = z.preprocess(
  // v1 called the number of save-triggered test runs `attempts`.
  (raw) => (raw && typeof raw === 'object' && 'attempts' in raw && !('runs' in raw) ? { ...raw, runs: (raw as { attempts: unknown }).attempts } : raw),
  z.object({
  workoutId: z.string(),
  /** The Attempt's number; absent on outcomes recorded by v1. */
  attempt: z.number().int().positive().optional(),
  outcome: z.enum(['completed', 'abandoned']),
  at: z.iso.datetime(),
  /** Test runs triggered by saves. */
  runs: z.number().int().nonnegative(),
  hintsUsed: z.number().int().nonnegative(),
  rating: z.enum(['up', 'down']).optional(),
  }),
);
export type Outcome = z.infer<typeof OutcomeSchema>;

const DiscardSchema = z.object({ at: z.iso.datetime(), reason: z.enum(['manual', 'expired']) });
export type Discard = z.infer<typeof DiscardSchema>;

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
  /** Discarded (archived) Workouts by id. */
  discarded: z.record(z.string(), DiscardSchema).default({}),
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
    super(`No Workout "${id}". Run \`kin train\` with no argument to pick one.`);
  }
}

export class WorkoutDiscardedError extends Error {
  constructor(id: string) {
    super(`Workout "${id}" is discarded. Bring it back with \`kin restore ${id}\`.`);
  }
}

/**
 * Where a Workout stands. `queued`: never attempted (the queue); `in-progress`: has an open Attempt;
 * `attempted`: every Attempt finished; `discarded`: archived, hidden from the queue but kept.
 */
export type WorkoutStatus = 'queued' | 'in-progress' | 'attempted' | 'discarded';

export interface StoredWorkout {
  record: WorkoutRecord;
  /** The immutable Workout definition. */
  dir: string;
  status: WorkoutStatus;
}

/** Every Workout in .kintsugi/workouts/, newest first. */
export async function listWorkouts(paths: WorkspacePaths): Promise<StoredWorkout[]> {
  if (!existsSync(paths.workoutsDir)) return [];
  const state = await readState(paths);
  // v1 recorded outcomes against Workouts it then moved to done/; any such outcome means "attempted".
  const finished = new Set(state.outcomes.map((o) => o.workoutId));
  const workouts: StoredWorkout[] = [];
  for (const id of await readdir(paths.workoutsDir)) {
    const dir = join(paths.workoutsDir, id);
    const metadata = join(dir, 'workout.json');
    if (!existsSync(metadata)) continue;
    const record: WorkoutRecord = JSON.parse(await readFile(metadata, 'utf8'));
    workouts.push({ record, dir, status: await statusOf(paths, id, state, finished) });
  }
  return workouts.sort((a, b) => b.record.createdAt.localeCompare(a.record.createdAt));
}

async function statusOf(paths: WorkspacePaths, id: string, state: State, finished: Set<string>): Promise<WorkoutStatus> {
  if (state.discarded[id]) return 'discarded';
  const attempts = await listAttemptRecords(paths, id);
  if (attempts.some((a) => !a.outcome)) return 'in-progress';
  return attempts.length > 0 || finished.has(id) ? 'attempted' : 'queued';
}

export async function loadWorkout(paths: WorkspacePaths, id: string): Promise<StoredWorkout> {
  const found = (await listWorkouts(paths)).find((w) => w.record.id === id);
  if (!found) throw new WorkoutNotFoundError(id);
  return found;
}

/** Archives a Workout: hidden from the queue and its cap, but kept and restorable. */
export async function discardWorkout(paths: WorkspacePaths, id: string, reason: Discard['reason'], now = new Date()): Promise<void> {
  await loadWorkout(paths, id);
  const state = await readState(paths);
  state.discarded[id] = { at: now.toISOString(), reason };
  await writeState(paths, state);
}

export async function restoreWorkout(paths: WorkspacePaths, id: string): Promise<void> {
  const state = await readState(paths);
  if (!state.discarded[id]) throw new Error(`Workout "${id}" isn't discarded.`);
  delete state.discarded[id];
  await writeState(paths, state);
}

/** Records a finished Attempt's outcome in state.json, next to the Attempt's own record. */
export async function recordOutcome(paths: WorkspacePaths, outcome: Outcome): Promise<void> {
  const state = await readState(paths);
  state.outcomes.push(OutcomeSchema.parse(outcome));
  await writeState(paths, state);
}

/** v1 moved finished Workouts to done/; they can't be redone (their Starting Code was edited in place). */
export function legacyDoneNotice(paths: WorkspacePaths): string | undefined {
  if (!existsSync(paths.doneDir)) return undefined;
  return `Workouts finished with Kintsugi v1 stay in ${paths.doneDir} and aren't listed.`;
}
