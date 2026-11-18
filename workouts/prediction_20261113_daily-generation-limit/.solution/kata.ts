/** One entry of the spend ledger: when a generation ran, why, and how many tries it took. */
export interface SpendEntry {
  at: string;
  origin: string;
  generationAttempts: number;
}

/** Generation attempts spent on commit Workouts since local midnight (retries count). */
export function generationsToday(spend: SpendEntry[], now: Date): number {
  const midnight = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  return spend.filter((s) => s.origin === 'commit' && Date.parse(s.at) >= midnight).reduce((sum, s) => sum + s.generationAttempts, 0);
}
