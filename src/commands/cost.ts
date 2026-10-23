import { mergeByModel, type ModelUsage } from '../cost/usage.ts';
import { PRICES_AS_OF } from '../cost/prices.ts';
import { readState, type Spend } from '../workouts/store.ts';
import { findRepoRoot, workspacePaths } from '../workspace.ts';

export interface SpendBucket {
  usd: number;
  count: number;
}

export interface CostReport {
  since: Date;
  total: SpendBucket;
  /** Spend on Workouts whose training finished (Completed or Abandoned). */
  finished: SpendBucket;
  /** Spend on Workouts still waiting: paid for, not yet used. */
  notFinished: SpendBucket;
  /** Spend on requests that produced no Workout (not Verified, not worth practicing, or an error). */
  producedNothing: SpendBucket;
  byOrigin: Record<string, SpendBucket>;
  /** Usage that has no known price, so isn't in any dollar figure. */
  unpriced: ModelUsage[];
  pricesAsOf: string;
}

/** The first day of the current month, local time. */
export function startOfMonth(now = new Date()): Date {
  return new Date(now.getFullYear(), now.getMonth(), 1);
}

/** `kin cost`: what generating Workouts has cost since a date, and how much of it went unused. */
export async function costReport(cwd: string, since: Date = startOfMonth()): Promise<CostReport> {
  const paths = workspacePaths(await findRepoRoot(cwd));
  const state = await readState(paths);
  const finishedIds = new Set(state.outcomes.map((o) => o.workoutId));

  const empty = (): SpendBucket => ({ usd: 0, count: 0 });
  const report: CostReport = {
    since,
    total: empty(),
    finished: empty(),
    notFinished: empty(),
    producedNothing: empty(),
    byOrigin: {},
    unpriced: [],
    pricesAsOf: PRICES_AS_OF,
  };
  const unpriced: ModelUsage[] = [];
  for (const entry of state.spend.filter((s) => Date.parse(s.at) >= since.getTime())) {
    const buckets = [report.total, bucketFor(report, entry, finishedIds), (report.byOrigin[entry.origin] ??= empty())];
    for (const bucket of buckets) {
      bucket.usd += entry.cost.usd;
      bucket.count++;
    }
    unpriced.push(...entry.cost.usage.filter((u) => entry.cost.unpricedModels.includes(u.model)));
  }
  report.unpriced = mergeByModel(unpriced);
  return report;
}

function bucketFor(report: CostReport, entry: Spend, finishedIds: Set<string>): SpendBucket {
  if (entry.result !== 'verified' || !entry.workoutId) return report.producedNothing;
  return finishedIds.has(entry.workoutId) ? report.finished : report.notFinished;
}
