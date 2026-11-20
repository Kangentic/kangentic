/**
 * `relativeTimeSamples()` sizes the backlog's Updated column, so every string `formatRelativeTime`
 * can print for a past time has to be among the samples, or a date paints past its column.
 * `formatRelativeTime` rounds, so a unit reaches its larger neighbor's length: 6.6 days prints
 * "7 days ago", not "6 days ago". The old table capped day at 6, hour at 23, minute and second at
 * 59, so those outputs were missing (task #1137).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { __setLocaleForTests, formatRelativeTime, relativeTimeSamples } from '../../src/renderer/lib/datetime';

const NOW = Date.parse('2026-06-15T12:00:00.000Z');
const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

function printedAtAge(ageMs: number): string {
  return formatRelativeTime(NOW - ageMs);
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  __setLocaleForTests('en-US');
});

afterEach(() => {
  vi.useRealTimers();
  __setLocaleForTests(undefined);
});

describe('relativeTimeSamples', () => {
  it('prints the expected rounded strings at the unit boundaries', () => {
    expect(printedAtAge(0)).toBe('now');
    expect(printedAtAge(59.6 * SECOND)).toBe('60 seconds ago');
    expect(printedAtAge(59.6 * MINUTE)).toBe('60 minutes ago');
    expect(printedAtAge(23.6 * HOUR)).toBe('24 hours ago');
    expect(printedAtAge(6.6 * DAY)).toBe('7 days ago');
  });

  it('contains the widest string each unit prints, including just under the next unit', () => {
    // The samples are a spread of counts per unit plus the largest count the unit reaches, not
    // every count. What sizes the column is that largest count, so each one must be present.
    const samples = new Set(relativeTimeSamples());
    const justUnderNextUnit = [
      0,
      59.6 * SECOND,
      59.6 * MINUTE,
      23.6 * HOUR,
      6.6 * DAY,
      4.4 * 7 * DAY,
      11.6 * 30 * DAY,
      // Units that start at their own length print a count of 1.
      SECOND,
      MINUTE,
      HOUR,
      DAY,
      7 * DAY,
      30 * DAY,
      365 * DAY,
      99 * 365 * DAY,
    ];
    for (const ageMs of justUnderNextUnit) {
      const printed = printedAtAge(ageMs);
      expect(samples.has(printed), `"${printed}" (age ${ageMs} ms) is not a sample`).toBe(true);
    }
  });
});
