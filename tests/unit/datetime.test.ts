import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import {
  __setLocaleForTests,
  formatDateTime,
  formatShortDateTime,
  formatDate,
  formatTime,
  formatRelativeTime,
  formatDurationBetween,
} from '../../src/renderer/lib/datetime';

const SAMPLE_ISO = '2026-04-14T22:00:00Z';

afterEach(() => {
  __setLocaleForTests(undefined);
  vi.useRealTimers();
});

describe('formatDateTime', () => {
  it('produces different strings for en-US and en-GB (proves locale is honoured)', () => {
    __setLocaleForTests('en-US');
    const usString = formatDateTime(SAMPLE_ISO);
    __setLocaleForTests('en-GB');
    const gbString = formatDateTime(SAMPLE_ISO);
    expect(usString).not.toEqual(gbString);
    expect(usString.length).toBeGreaterThan(0);
    expect(gbString.length).toBeGreaterThan(0);
  });

  it('returns empty string for invalid input', () => {
    expect(formatDateTime(null)).toBe('');
    expect(formatDateTime(undefined)).toBe('');
    expect(formatDateTime('not a date')).toBe('');
    expect(formatDateTime(NaN)).toBe('');
  });

  it('accepts Date, string, and number inputs', () => {
    __setLocaleForTests('en-US');
    const date = new Date(SAMPLE_ISO);
    expect(formatDateTime(date)).toEqual(formatDateTime(SAMPLE_ISO));
    expect(formatDateTime(date.getTime())).toEqual(formatDateTime(SAMPLE_ISO));
  });
});

describe('formatShortDateTime', () => {
  it('produces shorter output than formatDateTime', () => {
    __setLocaleForTests('en-US');
    const short = formatShortDateTime(SAMPLE_ISO);
    const medium = formatDateTime(SAMPLE_ISO);
    expect(short.length).toBeLessThanOrEqual(medium.length);
  });

  it('differs by locale', () => {
    __setLocaleForTests('en-US');
    const usString = formatShortDateTime(SAMPLE_ISO);
    __setLocaleForTests('en-GB');
    const gbString = formatShortDateTime(SAMPLE_ISO);
    expect(usString).not.toEqual(gbString);
  });
});

describe('formatDate', () => {
  it('omits time from output', () => {
    __setLocaleForTests('en-US');
    const result = formatDate(SAMPLE_ISO);
    expect(result).not.toMatch(/\d+:\d+/);
  });

  it('differs by locale', () => {
    __setLocaleForTests('en-US');
    const usString = formatDate(SAMPLE_ISO);
    __setLocaleForTests('en-GB');
    const gbString = formatDate(SAMPLE_ISO);
    expect(usString).not.toEqual(gbString);
  });
});

describe('formatTime', () => {
  it('contains time components', () => {
    __setLocaleForTests('en-US');
    const result = formatTime(SAMPLE_ISO);
    expect(result).toMatch(/\d+:\d+/);
  });

  it('uses 24-hour format in en-GB and 12-hour in en-US', () => {
    __setLocaleForTests('en-US');
    const usString = formatTime(SAMPLE_ISO);
    __setLocaleForTests('en-GB');
    const gbString = formatTime(SAMPLE_ISO);
    expect(usString).toMatch(/AM|PM/i);
    expect(gbString).not.toMatch(/AM|PM/i);
  });
});

describe('formatRelativeTime', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-14T12:00:00Z'));
  });

  it('formats past times in English (en-US)', () => {
    __setLocaleForTests('en-US');
    const fiveMinutesAgo = new Date(Date.now() - 5 * 60 * 1000);
    expect(formatRelativeTime(fiveMinutesAgo)).toMatch(/5 minutes ago/);
  });

  it('formats past times with locale-appropriate phrasing (es)', () => {
    __setLocaleForTests('es');
    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);
    const result = formatRelativeTime(twoHoursAgo);
    expect(result).toMatch(/hace|horas/);
    expect(result).not.toMatch(/ago/);
  });

  it('formats future times', () => {
    __setLocaleForTests('en-US');
    const inTwoHours = new Date(Date.now() + 2 * 60 * 60 * 1000);
    expect(formatRelativeTime(inTwoHours)).toMatch(/in 2 hours/);
  });

  it('uses the largest fitting unit', () => {
    __setLocaleForTests('en-US');
    const threeDaysAgo = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000);
    expect(formatRelativeTime(threeDaysAgo)).toMatch(/3 days ago/);
  });

  it('returns empty string for invalid input', () => {
    expect(formatRelativeTime(null)).toBe('');
    expect(formatRelativeTime('bogus')).toBe('');
  });
});

describe('formatDurationBetween', () => {
  it('matches the elapsed format of formatDuration', () => {
    const start = new Date('2026-04-14T10:00:00Z');
    const end = new Date('2026-04-14T11:30:00Z');
    expect(formatDurationBetween(start, end)).toBe('1h 30m');
  });

  it('handles string and number inputs', () => {
    expect(formatDurationBetween('2026-04-14T10:00:00Z', '2026-04-14T10:00:45Z')).toBe('45s');
    expect(formatDurationBetween(0, 90_000)).toBe('1m 30s');
  });

  it('returns empty string for invalid input', () => {
    expect(formatDurationBetween(null, null)).toBe('');
    expect(formatDurationBetween('2026-04-14T10:00:00Z', null)).toBe('');
  });

  it('clamps reversed args (end < start) to "0s"', () => {
    const start = new Date('2026-04-14T11:30:00Z');
    const end = new Date('2026-04-14T10:00:00Z');
    expect(formatDurationBetween(start, end)).toBe('0s');
    expect(formatDurationBetween(90_000, 0)).toBe('0s');
  });
});

describe('formatRelativeTime - unit boundaries', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-14T12:00:00Z'));
    __setLocaleForTests('en-US');
  });

  // 60 s boundary: at exactly 60 000 ms the helper picks "minute" not "second"
  it('60 s ago uses minute unit', () => {
    const sixtySecondsAgo = new Date(Date.now() - 60 * 1000);
    expect(formatRelativeTime(sixtySecondsAgo)).toMatch(/1 minute ago/);
  });

  it('59 s ago uses second unit (just below 60 s boundary)', () => {
    const fiftyNineSecondsAgo = new Date(Date.now() - 59 * 1000);
    expect(formatRelativeTime(fiftyNineSecondsAgo)).toMatch(/59 seconds ago/);
  });

  // 60 min boundary
  it('60 min ago uses hour unit', () => {
    const sixtyMinutesAgo = new Date(Date.now() - 60 * 60 * 1000);
    expect(formatRelativeTime(sixtyMinutesAgo)).toMatch(/1 hour ago/);
  });

  it('59 min ago uses minute unit (just below 60 min boundary)', () => {
    const fiftyNineMinutesAgo = new Date(Date.now() - 59 * 60 * 1000);
    expect(formatRelativeTime(fiftyNineMinutesAgo)).toMatch(/59 minutes ago/);
  });

  // 24 h boundary
  it('24 h ago uses day unit', () => {
    const twentyFourHoursAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
    // numeric:'auto' in en-US renders -1 day as "yesterday"
    expect(formatRelativeTime(twentyFourHoursAgo)).toMatch(/yesterday/i);
  });

  it('23 h ago uses hour unit (just below 24 h boundary)', () => {
    const twentyThreeHoursAgo = new Date(Date.now() - 23 * 60 * 60 * 1000);
    expect(formatRelativeTime(twentyThreeHoursAgo)).toMatch(/23 hours ago/);
  });

  // 7 day boundary
  it('7 days ago uses week unit', () => {
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    // numeric:'auto' in en-US renders -1 week as "last week"
    expect(formatRelativeTime(sevenDaysAgo)).toMatch(/last week/i);
  });

  it('6 days ago uses day unit (just below 7 day boundary)', () => {
    const sixDaysAgo = new Date(Date.now() - 6 * 24 * 60 * 60 * 1000);
    expect(formatRelativeTime(sixDaysAgo)).toMatch(/6 days ago/);
  });

  // 30 day boundary
  it('30 days ago uses month unit', () => {
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    // numeric:'auto' in en-US renders -1 month as "last month"
    expect(formatRelativeTime(thirtyDaysAgo)).toMatch(/last month/i);
  });

  it('29 days ago uses week unit (29 days >= 7 day week threshold)', () => {
    // The week threshold is 7 * 24 * 60 * 60 * 1000. 29 days exceeds it so the
    // helper picks "week" not "day". Math.round(29*86400000 / 604800000) = 4.
    const twentyNineDaysAgo = new Date(Date.now() - 29 * 24 * 60 * 60 * 1000);
    expect(formatRelativeTime(twentyNineDaysAgo)).toMatch(/4 weeks ago/);
  });

  // 365 day boundary
  it('365 days ago uses year unit', () => {
    const threeSixtyFiveDaysAgo = new Date(Date.now() - 365 * 24 * 60 * 60 * 1000);
    // numeric:'auto' in en-US renders -1 year as "last year"
    expect(formatRelativeTime(threeSixtyFiveDaysAgo)).toMatch(/last year/i);
  });

  it('364 days ago uses month unit (364 days >= 30 day month threshold, below 365 day year threshold)', () => {
    // 364 days >= 30 * 24 * 60 * 60 * 1000 (month threshold), so "month" fires before "year".
    // Math.round(364 * 86400000 / (30 * 86400000)) = Math.round(12.13) = 12.
    const threeSixtyFourDaysAgo = new Date(Date.now() - 364 * 24 * 60 * 60 * 1000);
    expect(formatRelativeTime(threeSixtyFourDaysAgo)).toMatch(/12 months ago/);
    expect(formatRelativeTime(threeSixtyFourDaysAgo)).not.toMatch(/year/i);
  });
});

describe('formatRelativeTime - sub-minute range', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-14T12:00:00Z'));
    __setLocaleForTests('en-US');
  });

  it('10 s ago emits "X seconds ago"', () => {
    const tenSecondsAgo = new Date(Date.now() - 10 * 1000);
    expect(formatRelativeTime(tenSecondsAgo)).toMatch(/10 seconds ago/);
  });

  it('45 s ago emits "X seconds ago"', () => {
    const fortyFiveSecondsAgo = new Date(Date.now() - 45 * 1000);
    expect(formatRelativeTime(fortyFiveSecondsAgo)).toMatch(/45 seconds ago/);
  });

  it('10 s in the future emits "in X seconds"', () => {
    const inTenSeconds = new Date(Date.now() + 10 * 1000);
    expect(formatRelativeTime(inTenSeconds)).toMatch(/in 10 seconds/);
  });

  it('value under 500 ms rounds to 0 seconds which yields "now" with numeric:auto', () => {
    // deltaMs < 500 ms -> Math.round(deltaMs / 1000) = 0
    // Intl.RelativeTimeFormat with numeric:'auto' renders format(0, 'second') as "now" in en-US
    const almostNow = new Date(Date.now() + 400);
    expect(formatRelativeTime(almostNow)).toBe('now');
  });
});

describe('formatter cache invalidation', () => {
  it('second __setLocaleForTests call produces output from the new locale, not a stale cache hit', () => {
    // Confirm that switching from en-US to en-GB clears the formatter cache
    // and causes subsequent calls to use the new locale. This specifically guards
    // against a bug where the cache key omits the locale and a stale formatter
    // from the first locale is returned for the second.
    __setLocaleForTests('en-US');
    const usResult = formatDateTime(SAMPLE_ISO);

    __setLocaleForTests('en-GB');
    const gbResult = formatDateTime(SAMPLE_ISO);

    // en-US uses "Apr 14, 2026" style; en-GB uses "14 Apr 2026" style.
    // They must differ -- if the cache were stale, gbResult === usResult.
    expect(gbResult).not.toBe(usResult);
    expect(gbResult.length).toBeGreaterThan(0);

    // A third call with en-GB should return the same value (cache hit on correct locale).
    const gbResultCached = formatDateTime(SAMPLE_ISO);
    expect(gbResultCached).toBe(gbResult);
  });
});
