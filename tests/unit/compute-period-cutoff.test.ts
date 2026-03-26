/**
 * Unit tests for computePeriodCutoff.
 *
 * Verifies that each UsageTimePeriod maps to the correct ISO date cutoff:
 *   'live' / 'all' → null (no filter)
 *   'today'        → midnight local time today
 *   'week'         → midnight local time on Monday of the current week
 *   'month'        → midnight local time on the 1st of the current month
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { computePeriodCutoff } from '../../src/shared/period-cutoff';

describe('computePeriodCutoff', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns null for "live"', () => {
    expect(computePeriodCutoff('live')).toBeNull();
  });

  it('returns null for "all"', () => {
    expect(computePeriodCutoff('all')).toBeNull();
  });

  it('returns midnight today for "today"', () => {
    // Wednesday 2026-03-25 at 15:30:00 local time
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 2, 25, 15, 30, 0));

    const result = computePeriodCutoff('today');
    const expected = new Date(2026, 2, 25, 0, 0, 0).toISOString();
    expect(result).toBe(expected);
  });

  it('returns Monday midnight for "week" when today is Wednesday', () => {
    // Wednesday 2026-03-25
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 2, 25, 10, 0, 0));

    const result = computePeriodCutoff('week');
    const expected = new Date(2026, 2, 23, 0, 0, 0).toISOString(); // Monday March 23
    expect(result).toBe(expected);
  });

  it('returns Monday midnight for "week" when today is Monday', () => {
    // Monday 2026-03-23
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 2, 23, 8, 0, 0));

    const result = computePeriodCutoff('week');
    const expected = new Date(2026, 2, 23, 0, 0, 0).toISOString(); // Same day
    expect(result).toBe(expected);
  });

  it('returns Monday midnight for "week" when today is Sunday', () => {
    // Sunday 2026-03-29
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 2, 29, 18, 0, 0));

    const result = computePeriodCutoff('week');
    const expected = new Date(2026, 2, 23, 0, 0, 0).toISOString(); // Previous Monday March 23
    expect(result).toBe(expected);
  });

  it('returns 1st of month midnight for "month"', () => {
    // March 25, 2026
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 2, 25, 12, 0, 0));

    const result = computePeriodCutoff('month');
    const expected = new Date(2026, 2, 1, 0, 0, 0).toISOString(); // March 1
    expect(result).toBe(expected);
  });

  it('handles month boundary for "week" crossing into previous month', () => {
    // Tuesday 2026-03-03 - Monday is March 2
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 2, 3, 9, 0, 0));

    const result = computePeriodCutoff('week');
    const expected = new Date(2026, 2, 2, 0, 0, 0).toISOString(); // Monday March 2
    expect(result).toBe(expected);
  });
});
