import { mergeByModel, type ModelUsage } from '../cost/usage.ts';
import { PRICES_AS_OF } from '../cost/prices.ts';
import { listAttemptRecords } from '../workouts/attempts.ts';
import { readState, type Spend } from '../workouts/store.ts';
import { findRepoRoot, workspacePaths } from '../workspace.ts';

export interface SpendBucket {
  usd: number;
  count: number;
}

export interface CostReport {
  since: Date;
  total: SpendBucket;
  /** Spend on Workouts with at least one Attempt, open or finished. */
  attempted: SpendBucket;
  /** Spend on Workouts nobody has attempted, including Discarded ones: paid for, not used. */
  neverAttempted: SpendBucket;
  /** Spend on requests that produced no Workout (not Verified, not worth practicing, or an error). */
  producedNothing: SpendBucket;
  /** Spend on choosing and ordering Tracks' steps. */
  trackPlanning: SpendBucket;
  /** Spend on describing folders and files for the Atlas. */
  atlas: SpendBucket;
  byOrigin: Record<string, SpendBucket>;
  /** Requests your coding agent generated: counted, but their cost isn't measured. */
  byAgent: { requests: number; workouts: number };
  /** Usage that has no known price, so isn't in any dollar figure. */
  unpriced: ModelUsage[];
  pricesAsOf: string;
}

/** The first day of the current month, local time. */
export function startOfMonth(now = new Date()): Date {
  return new Date(now.getFullYear(), now.getMonth(), 1);
}

/** `fiu cost`: what generating Workouts has cost since a date, and how much of it went unused. */
export async function costReport(cwd: string, since: Date = startOfMonth()): Promise<CostReport> {
  const paths = workspacePaths(await findRepoRoot(cwd));
  const state = await readState(paths);
  // v1 outcomes count too: those Workouts were attempted before Attempts existed.
  const attemptedIds = new Set(state.outcomes.map((o) => o.workoutId));
  for (const entry of state.spend) {
    for (const id of entry.workoutIds ?? (entry.workoutId ? [entry.workoutId] : [])) {
      if ((await listAttemptRecords(paths, id)).length > 0) attemptedIds.add(id);
    }
  }

  const empty = (): SpendBucket => ({ usd: 0, count: 0 });
  const report: CostReport = {
    since,
    total: empty(),
    attempted: empty(),
    neverAttempted: empty(),
    producedNothing: empty(),
    trackPlanning: empty(),
    atlas: empty(),
    byOrigin: {},
    byAgent: { requests: 0, workouts: 0 },
    unpriced: [],
    pricesAsOf: PRICES_AS_OF,
  };
  const unpriced: ModelUsage[] = [];
  for (const entry of state.spend.filter((s) => Date.parse(s.at) >= since.getTime())) {
    if (entry.cost === null) {
      report.byAgent.requests++;
      if (entry.result === 'verified') report.byAgent.workouts++;
      continue;
    }
    const cost = entry.cost;
    // The Atlas isn't a Workout, so it has no Origin.
    const buckets = [report.total, bucketFor(report, entry, attemptedIds), ...(entry.result === 'atlas' ? [] : [(report.byOrigin[entry.origin] ??= empty())])];
    for (const bucket of buckets) {
      bucket.usd += cost.usd;
      bucket.count++;
    }
    unpriced.push(...cost.usage.filter((u) => cost.unpricedModels.includes(u.model)));
  }
  report.unpriced = mergeByModel(unpriced);
  return report;
}

function bucketFor(report: CostReport, entry: Spend, attemptedIds: Set<string>): SpendBucket {
  if (entry.result === 'track-plan') return report.trackPlanning;
  if (entry.result === 'atlas') return report.atlas;
  if (entry.result !== 'verified' || !entry.workoutId) return report.producedNothing;
  // A Series counts as attempted once any of its questions is.
  return (entry.workoutIds ?? [entry.workoutId]).some((id) => attemptedIds.has(id)) ? report.attempted : report.neverAttempted;
}
