import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { appendLog, readLog, unseenFailureSummary } from './kata.ts';

const line = (entry: object) => JSON.stringify(entry) + '\n';
const generated = { at: '2026-11-13T08:00:00.000Z', commit: 'a1', outcome: 'generated', workoutId: 'drill_1', background: true };
const failed = { at: '2026-11-13T09:00:00.000Z', commit: 'b2', outcome: 'failed', reason: 'no Verified Drill', background: true };

describe('the refill log', () => {
  it('reads every entry, in the order written', () => {
    assert.deepEqual(readLog(line(generated) + line(failed)), [generated, failed]);
  });

  it('skips a line cut short by a crash, keeping the others', () => {
    const cut = '{"at":"2026-11-13T08:30:00.000Z","commit":"c3","outc';
    assert.deepEqual(readLog(line(generated) + cut + '\n' + line(failed)), [generated, failed]);
  });

  it('reads nothing before anything is logged', () => {
    assert.deepEqual(readLog(undefined), []);
  });

  it('appends one JSON line per outcome, stamped with the time', () => {
    const written: string[] = [];
    appendLog((l) => written.push(l), { commit: 'a1', outcome: 'skipped', reason: 'a merge', background: true }, new Date('2026-11-13T07:00:00.000Z'));
    assert.deepEqual(written, ['{"at":"2026-11-13T07:00:00.000Z","commit":"a1","outcome":"skipped","reason":"a merge","background":true}\n']);
  });

  it('tells the user once about background failures they have not seen', () => {
    const log = line(generated) + line(failed);
    assert.deepEqual(unseenFailureSummary(log, '2026-11-13T08:30:00.000Z'), { message: '1 background Drill failed: see `fiu log`.', seenAt: failed.at });
    assert.deepEqual(unseenFailureSummary(log, failed.at), { seenAt: failed.at });
  });
});
