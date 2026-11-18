/** What happened to one commit (or one generation request) in `fiu refill`. */
export interface LogEntry {
  at: string;
  /** The commit, when the entry is about one. */
  commit?: string;
  outcome: 'generated' | 'skipped' | 'deferred' | 'not-worth-practicing' | 'failed';
  /** For skipped, deferred, and failed: why. */
  reason?: string;
  source?: string;
  workoutId?: string;
  background: boolean;
}

/** Appends one JSON line to the log; `append` stands in for appending to .fiu/log. */
export function appendLog(append: (line: string) => void, entry: Omit<LogEntry, 'at'>, now = new Date()): void {
  append(JSON.stringify({ at: now.toISOString(), ...entry }) + '\n');
}

/** The log's entries, in order. `text` is the log file's contents, undefined when there is no log yet. */
export function readLog(text: string | undefined): LogEntry[] {
  // TODO: read every entry of the log, skipping a line that isn't JSON.
  return [];
}

/**
 * One line about background failures not yet seen, and when the newest one was, to mark them seen.
 * `seen` is when the user was last told.
 */
export function unseenFailureSummary(text: string | undefined, seen: string): { message?: string; seenAt: string } {
  const failures = readLog(text).filter((e) => e.background && e.outcome === 'failed' && e.at > seen);
  if (failures.length === 0) return { seenAt: seen };
  return { message: `${failures.length} background Drill${failures.length === 1 ? '' : 's'} failed: see \`fiu log\`.`, seenAt: failures.at(-1)!.at };
}
