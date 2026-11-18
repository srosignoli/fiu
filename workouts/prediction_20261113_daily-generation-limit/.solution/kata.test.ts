import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { generationsToday } from './kata.ts';

// 9:00 this morning, local time.
const now = new Date(2026, 10, 13, 9, 0);
const spend = [
  // 11:50 last night: a commit's Workout, 2 attempts.
  { at: new Date(2026, 10, 12, 23, 50).toISOString(), origin: 'commit', generationAttempts: 2 },
  // 7:30 this morning: a commit's Workout, 3 attempts.
  { at: new Date(2026, 10, 13, 7, 30).toISOString(), origin: 'commit', generationAttempts: 3 },
  // 8:15 this morning: a Drill asked for by hand, 1 attempt.
  { at: new Date(2026, 10, 13, 8, 15).toISOString(), origin: 'manual', generationAttempts: 1 },
];

describe('the daily limit on background generation', () => {
  it('counts 3 attempts as used today', () => {
    assert.equal(generationsToday(spend, now), 3);
  });
  it('counts 4 attempts as used today', () => {
    assert.equal(generationsToday(spend, now), 4);
  });
  it('counts 5 attempts as used today', () => {
    assert.equal(generationsToday(spend, now), 5);
  });
  it('counts 1 attempt as used today', () => {
    assert.equal(generationsToday(spend, now), 1);
  });
});
