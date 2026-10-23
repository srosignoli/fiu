import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { drill } from '../src/commands/drill.ts';
import { tempDir, tempGitRepo } from './helpers.ts';

// Calls the real API (and costs money): runs only when ANTHROPIC_API_KEY is set.
const apiKey = process.env.ANTHROPIC_API_KEY;

const SOURCE = `export interface Booking { room: string; start: number; end: number }

/** Returns the bookings that overlap the given time window, ordered by start time. */
export function overlapping(bookings: Booking[], start: number, end: number): Booking[] {
  return bookings
    .filter((b) => b.start < end && start < b.end)
    .slice()
    .sort((a, b) => a.start - b.start || a.room.localeCompare(b.room));
}

/** Merges touching or overlapping bookings of the same room into single blocks. */
export function mergeBlocks(bookings: Booking[]): Booking[] {
  const merged: Booking[] = [];
  for (const b of [...bookings].sort((x, y) => x.room.localeCompare(y.room) || x.start - y.start)) {
    const last = merged.at(-1);
    if (last && last.room === b.room && b.start <= last.end) last.end = Math.max(last.end, b.end);
    else merged.push({ ...b });
  }
  return merged;
}
`;

describe('live Drill generation', { skip: apiKey ? false : 'ANTHROPIC_API_KEY is not set', timeout: 15 * 60_000 }, () => {
  it('produces a Verified TypeScript Drill end to end', async () => {
    const repo = await tempGitRepo();
    await mkdir(join(repo, 'src'));
    await writeFile(join(repo, 'src', 'bookings.ts'), SOURCE);
    const steps: string[] = [];
    const result = await drill(
      repo,
      'src/bookings.ts#mergeBlocks',
      { yes: true, sandbox: true },
      { step: (m) => (steps.push(m), console.log(`  ${m}`)), warn: (m) => console.log(`  warn: ${m}`) },
      { configEnv: { env: { ANTHROPIC_API_KEY: apiKey }, home: await tempDir() } },
    );
    assert.equal(result.status, 'saved', JSON.stringify(result, null, 2));
    if (result.status === 'saved') {
      console.log(`  Saved after ${result.attempts} attempt(s) at ${result.workoutDir}`);
      console.log(await readFile(join(result.workoutDir, 'README.md'), 'utf8'));
    }
  });
});
