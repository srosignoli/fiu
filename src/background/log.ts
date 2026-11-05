import { existsSync } from 'node:fs';
import { appendFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { WorkspacePaths } from '../workspace.ts';
import { readState, writeState } from '../workouts/store.ts';

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

export const logPath = (paths: WorkspacePaths) => join(paths.root, 'log');

/** Appends one JSON line to .fiutsu/log. */
export async function appendLog(paths: WorkspacePaths, entry: Omit<LogEntry, 'at'>, now = new Date()): Promise<void> {
  await appendFile(logPath(paths), JSON.stringify({ at: now.toISOString(), ...entry }) + '\n');
}

export async function readLog(paths: WorkspacePaths): Promise<LogEntry[]> {
  if (!existsSync(logPath(paths))) return [];
  return (await readFile(logPath(paths), 'utf8'))
    .split('\n')
    .filter(Boolean)
    .flatMap((line) => {
      try {
        return [JSON.parse(line) as LogEntry];
      } catch {
        return [];
      }
    });
}

/**
 * One line about background failures the user hasn't been told about yet, for `fiu quick` and
 * `fiu train`. Showing it marks those failures as seen.
 */
export async function unseenFailureSummary(paths: WorkspacePaths): Promise<string | undefined> {
  const state = await readState(paths);
  const seen = state.refill.failuresSeenAt ?? '';
  const failures = (await readLog(paths)).filter((e) => e.background && e.outcome === 'failed' && e.at > seen);
  if (failures.length === 0) return undefined;
  state.refill.failuresSeenAt = failures.at(-1)!.at;
  await writeState(paths, state);
  return `${failures.length} background Drill${failures.length === 1 ? '' : 's'} failed: see \`fiu log\`.`;
}
