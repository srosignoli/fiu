import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { autoCaps } from './kata.ts';

// Background Workouts on, and only a daily limit of 2 set.
const caps = () => autoCaps({ auto: { enabled: true, dailyLimit: 2 } });

describe('the limits in force when the team sets only a daily limit', () => {
  it('keeps 3 waiting, allows 2 a day, and discards after 14 days', () => {
    assert.deepEqual(caps(), { queueCap: 3, dailyLimit: 2, aiOnly: false, expiryDays: 14 });
  });
  it('keeps 3 waiting, allows 5 a day, and discards after 14 days', () => {
    assert.deepEqual(caps(), { queueCap: 3, dailyLimit: 5, aiOnly: false, expiryDays: 14 });
  });
  it('keeps 3 waiting, allows 2 a day, and discards after 7 days', () => {
    assert.deepEqual(caps(), { queueCap: 3, dailyLimit: 2, aiOnly: false, expiryDays: 7 });
  });
  it('keeps 5 waiting, allows 2 a day, and discards after 14 days', () => {
    assert.deepEqual(caps(), { queueCap: 5, dailyLimit: 2, aiOnly: false, expiryDays: 14 });
  });
});
