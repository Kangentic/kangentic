import { describe, it, expect } from 'vitest';
import {
  windowElapsedPercentage,
  mergeRateLimitSnapshot,
  RATE_LIMIT_RESET_EPSILON_SECONDS,
  type RateLimitSnapshot,
} from '../../src/renderer/utils/rate-limit-window';
import type { RateLimitWindow } from '../../src/shared/types';

// All cases pass `nowMs` explicitly, so the helper is fully deterministic and
// these assertions carry no wall-clock or platform dependence.
describe('windowElapsedPercentage', () => {
  const FIVE_HOUR_SECONDS = 5 * 60 * 60; // 18000
  const resetsAt = 1_000_000; // arbitrary epoch seconds
  const windowStartMs = (resetsAt - FIVE_HOUR_SECONDS) * 1000;
  const windowMs = FIVE_HOUR_SECONDS * 1000;

  it('returns ~50 at the midpoint of the window', () => {
    expect(windowElapsedPercentage(resetsAt, FIVE_HOUR_SECONDS, windowStartMs + windowMs / 2)).toBe(50);
  });

  it('returns 0 exactly at the window start', () => {
    expect(windowElapsedPercentage(resetsAt, FIVE_HOUR_SECONDS, windowStartMs)).toBe(0);
  });

  it('clamps to 0 before the window has opened', () => {
    expect(windowElapsedPercentage(resetsAt, FIVE_HOUR_SECONDS, windowStartMs - windowMs)).toBe(0);
  });

  it('reaches 100 exactly at the reset time', () => {
    expect(windowElapsedPercentage(resetsAt, FIVE_HOUR_SECONDS, resetsAt * 1000)).toBe(100);
  });

  it('clamps to 100 once the reset time has passed', () => {
    expect(windowElapsedPercentage(resetsAt, FIVE_HOUR_SECONDS, resetsAt * 1000 + windowMs)).toBe(100);
  });

  it('returns null when there is no usable timing anchor', () => {
    expect(windowElapsedPercentage(0, FIVE_HOUR_SECONDS, Date.now())).toBeNull();
    expect(windowElapsedPercentage(-1, FIVE_HOUR_SECONDS, Date.now())).toBeNull();
    expect(windowElapsedPercentage(resetsAt, 0, Date.now())).toBeNull();
    expect(windowElapsedPercentage(resetsAt, NaN, Date.now())).toBeNull();
    expect(windowElapsedPercentage(NaN, FIVE_HOUR_SECONDS, Date.now())).toBeNull();
  });
});

// Fixed epochs throughout: the merge compares reported `resetsAt` values only,
// never the wall clock, so every case here is fully deterministic.
describe('mergeRateLimitSnapshot', () => {
  const FIVE_HOUR_SECONDS = 5 * 60 * 60; // 18000
  const SEVEN_DAY_SECONDS = 7 * 24 * 60 * 60; // 604800
  const FIVE_HOUR_RESET = 2_000_000; // arbitrary fixed epoch seconds
  const SEVEN_DAY_RESET = 3_000_000;

  function fiveHour(usedPercentage: number, resetsAt: number = FIVE_HOUR_RESET): RateLimitWindow {
    return {
      id: 'five-hour',
      label: '5h session',
      iconKind: 'session',
      usedPercentage,
      resetsAt,
      windowDurationSeconds: FIVE_HOUR_SECONDS,
    };
  }

  function sevenDay(usedPercentage: number, resetsAt: number = SEVEN_DAY_RESET): RateLimitWindow {
    return {
      id: 'seven-day',
      label: '7d weekly',
      iconKind: 'period',
      usedPercentage,
      resetsAt,
      windowDurationSeconds: SEVEN_DAY_SECONDS,
    };
  }

  function snapshot(rateLimits: RateLimitWindow[], sourceSessionId: string, capturedAt: number): RateLimitSnapshot {
    return { rateLimits, capturedAt, sourceSessionId };
  }

  it('returns the incoming snapshot unchanged when current is null (seed)', () => {
    const incoming = snapshot([fiveHour(30), sevenDay(10)], 'sess-a', 1000);
    expect(mergeRateLimitSnapshot(null, incoming)).toBe(incoming);
  });

  it('raises usedPercentage when the same window reports higher, updating provenance', () => {
    const current = snapshot([fiveHour(30), sevenDay(10)], 'sess-a', 1000);
    const incoming = snapshot([fiveHour(55), sevenDay(18)], 'sess-b', 2000);

    const result = mergeRateLimitSnapshot(current, incoming);
    expect(result).not.toBe(current);
    expect(result.rateLimits[0].usedPercentage).toBe(55);
    expect(result.rateLimits[1].usedPercentage).toBe(18);
    expect(result.sourceSessionId).toBe('sess-b');
    expect(result.capturedAt).toBe(2000);
  });

  it('rejects a lower same-window report and returns the exact current reference (the flip-flop repro)', () => {
    // The bug: session A reports 98/19, session B reports a stale cached 71/14
    // for the SAME windows. Last-writer-wins made the pill alternate; the merge
    // must hold the fresher 98/19 and not allocate a new snapshot at all.
    const current = snapshot([fiveHour(98), sevenDay(19)], 'sess-fresh', 1000);
    const incoming = snapshot([fiveHour(71), sevenDay(14)], 'sess-stale', 2000);

    expect(mergeRateLimitSnapshot(current, incoming)).toBe(current);
  });

  it('returns the exact current reference when the same window reports an equal value', () => {
    const current = snapshot([fiveHour(40), sevenDay(12)], 'sess-a', 1000);
    const incoming = snapshot([fiveHour(40), sevenDay(12)], 'sess-b', 2000);

    expect(mergeRateLimitSnapshot(current, incoming)).toBe(current);
  });

  it('treats a resetsAt jitter within the epsilon as the same window (lower rejected)', () => {
    const current = snapshot([fiveHour(80, FIVE_HOUR_RESET)], 'sess-a', 1000);
    const incoming = snapshot([fiveHour(70, FIVE_HOUR_RESET - 30)], 'sess-b', 2000);

    expect(mergeRateLimitSnapshot(current, incoming)).toBe(current);
  });

  it('treats a resetsAt jitter within the epsilon as the same window (higher raised)', () => {
    const current = snapshot([fiveHour(80, FIVE_HOUR_RESET)], 'sess-a', 1000);
    const incoming = snapshot([fiveHour(85, FIVE_HOUR_RESET + 30)], 'sess-b', 2000);

    const result = mergeRateLimitSnapshot(current, incoming);
    expect(result.rateLimits[0].usedPercentage).toBe(85);
    expect(result.sourceSessionId).toBe('sess-b');
  });

  it('treats a delta of exactly the epsilon as the same window, not a rollover', () => {
    // resetDelta === EPSILON is not > EPSILON, so it stays same-window: a lower
    // value is still rejected (a rollover would have taken it wholesale).
    const current = snapshot([fiveHour(90, FIVE_HOUR_RESET)], 'sess-a', 1000);
    const incoming = snapshot([fiveHour(3, FIVE_HOUR_RESET + RATE_LIMIT_RESET_EPSILON_SECONDS)], 'sess-b', 2000);

    expect(mergeRateLimitSnapshot(current, incoming)).toBe(current);
  });

  it('treats a delta of one second past the epsilon as a rollover', () => {
    const current = snapshot([fiveHour(90, FIVE_HOUR_RESET)], 'sess-a', 1000);
    const incoming = snapshot([fiveHour(3, FIVE_HOUR_RESET + RATE_LIMIT_RESET_EPSILON_SECONDS + 1)], 'sess-b', 2000);

    const result = mergeRateLimitSnapshot(current, incoming);
    expect(result.rateLimits[0].usedPercentage).toBe(3);
  });

  it('treats a delta of exactly the negative epsilon as the same window (higher raised, anchor pinned)', () => {
    // resetDelta === -EPSILON is not < -EPSILON, so it stays same-window: a higher
    // value raises it (a stale older window would have been ignored). The anchor
    // resetsAt stays the current one, not the incoming (drifted) one.
    const current = snapshot([fiveHour(40, FIVE_HOUR_RESET)], 'sess-a', 1000);
    const incoming = snapshot([fiveHour(70, FIVE_HOUR_RESET - RATE_LIMIT_RESET_EPSILON_SECONDS)], 'sess-b', 2000);

    const result = mergeRateLimitSnapshot(current, incoming);
    expect(result.rateLimits[0].usedPercentage).toBe(70);
    expect(result.rateLimits[0].resetsAt).toBe(FIVE_HOUR_RESET);
    expect(result.sourceSessionId).toBe('sess-b');
  });

  it('treats a delta of one second past the negative epsilon as an older window (ignored)', () => {
    const current = snapshot([fiveHour(40, FIVE_HOUR_RESET)], 'sess-a', 1000);
    const incoming = snapshot([fiveHour(95, FIVE_HOUR_RESET - RATE_LIMIT_RESET_EPSILON_SECONDS - 1)], 'sess-b', 2000);

    // Older window (delta < -EPSILON): ignored even though 95 > 40. Exact current reference kept.
    expect(mergeRateLimitSnapshot(current, incoming)).toBe(current);
  });

  it('takes a rolled-over window wholesale even when its usedPercentage is lower', () => {
    // resetsAt advanced by a whole window length -> the window reset, so a low
    // value (fresh window) legitimately replaces the old high one.
    const current = snapshot([fiveHour(96, FIVE_HOUR_RESET)], 'sess-a', 1000);
    const incoming = snapshot([fiveHour(2, FIVE_HOUR_RESET + FIVE_HOUR_SECONDS)], 'sess-b', 2000);

    const result = mergeRateLimitSnapshot(current, incoming);
    expect(result).not.toBe(current);
    expect(result.rateLimits[0].usedPercentage).toBe(2);
    expect(result.rateLimits[0].resetsAt).toBe(FIVE_HOUR_RESET + FIVE_HOUR_SECONDS);
    expect(result.sourceSessionId).toBe('sess-b');
  });

  it('ignores a report for an older window even when its usedPercentage is higher', () => {
    // A stale reporter still on the previous window: its resetsAt is older, so
    // even a higher number must not overwrite the current window.
    const current = snapshot([fiveHour(40, FIVE_HOUR_RESET)], 'sess-a', 1000);
    const incoming = snapshot([fiveHour(95, FIVE_HOUR_RESET - FIVE_HOUR_SECONDS)], 'sess-b', 2000);

    expect(mergeRateLimitSnapshot(current, incoming)).toBe(current);
  });

  it('does not let the anchor drift across successive same-window updates (a real rollover is still detected)', () => {
    // Each step advances resetsAt by 30s (within epsilon of the PREVIOUS report) and
    // raises usedPercentage, so all three are the same window. Because the anchor is
    // pinned to the first report (resetsAt 1000), the final report at 1061 is a
    // genuine rollover (delta +61 from the pinned anchor, past the epsilon) and is
    // taken wholesale. If the anchor had drifted to 1060, +1 would look same-window
    // and the fresh low value would be wrongly rejected as stale.
    const step1 = mergeRateLimitSnapshot(null, snapshot([fiveHour(10, 1000)], 'sess-a', 1));
    const step2 = mergeRateLimitSnapshot(step1, snapshot([fiveHour(20, 1030)], 'sess-b', 2));
    const step3 = mergeRateLimitSnapshot(step2, snapshot([fiveHour(30, 1060)], 'sess-c', 3));
    // Anchor is still pinned to 1000 through the same-window raises.
    expect(step3.rateLimits[0].resetsAt).toBe(1000);
    expect(step3.rateLimits[0].usedPercentage).toBe(30);

    // A genuine rollover: resetsAt 1061 is > epsilon past the pinned anchor (1000).
    const rolledOver = mergeRateLimitSnapshot(step3, snapshot([fiveHour(5, 1061)], 'sess-d', 4));
    expect(rolledOver.rateLimits[0].usedPercentage).toBe(5);
    expect(rolledOver.rateLimits[0].resetsAt).toBe(1061);
  });

  it('appends an incoming window whose id is unknown to the current snapshot', () => {
    const current = snapshot([fiveHour(30)], 'sess-a', 1000);
    const incoming = snapshot([fiveHour(30), sevenDay(12)], 'sess-b', 2000);

    const result = mergeRateLimitSnapshot(current, incoming);
    expect(result).not.toBe(current);
    expect(result.rateLimits.map((rateLimitWindow) => rateLimitWindow.id)).toEqual(['five-hour', 'seven-day']);
    expect(result.rateLimits[1].usedPercentage).toBe(12);
    expect(result.sourceSessionId).toBe('sess-b');
  });

  it('preserves a current window that is absent from the incoming report', () => {
    const current = snapshot([fiveHour(30), sevenDay(15)], 'sess-a', 1000);
    const incoming = snapshot([fiveHour(30)], 'sess-b', 2000);

    // Only five-hour is in incoming and it is equal, so nothing changes: the
    // preserved seven-day window keeps the whole snapshot reference-stable.
    expect(mergeRateLimitSnapshot(current, incoming)).toBe(current);
  });

  it('applies a mixed outcome in one report: raises one window, ignores a stale sibling', () => {
    const current = snapshot([fiveHour(50, FIVE_HOUR_RESET), sevenDay(20, SEVEN_DAY_RESET)], 'sess-a', 1000);
    const incoming = snapshot(
      [fiveHour(60, FIVE_HOUR_RESET), sevenDay(5, SEVEN_DAY_RESET)],
      'sess-b',
      2000,
    );

    const result = mergeRateLimitSnapshot(current, incoming);
    expect(result).not.toBe(current);
    expect(result.rateLimits[0].usedPercentage).toBe(60); // raised
    expect(result.rateLimits[1].usedPercentage).toBe(20); // stale sibling ignored
    expect(result.sourceSessionId).toBe('sess-b');
  });

  it('returns the exact current reference when the incoming rateLimits array is empty', () => {
    const current = snapshot([fiveHour(30)], 'sess-a', 1000);
    const incoming = snapshot([], 'sess-b', 2000);

    expect(mergeRateLimitSnapshot(current, incoming)).toBe(current);
  });

  it('returns the incoming empty-array snapshot when current is null', () => {
    const incoming = snapshot([], 'sess-b', 2000);
    expect(mergeRateLimitSnapshot(null, incoming)).toBe(incoming);
  });

  it('preserves current window order and appends new ids at the end', () => {
    const current = snapshot([sevenDay(15), fiveHour(30)], 'sess-a', 1000);
    const incoming = snapshot(
      [fiveHour(30), sevenDay(15), { ...fiveHour(1), id: 'one-hour', label: '1h' }],
      'sess-b',
      2000,
    );

    const result = mergeRateLimitSnapshot(current, incoming);
    // Current order (seven-day, five-hour) is preserved; the new id is appended.
    expect(result.rateLimits.map((rateLimitWindow) => rateLimitWindow.id)).toEqual(['seven-day', 'five-hour', 'one-hour']);
  });

  it('does not mutate either input snapshot', () => {
    const currentWindows = [fiveHour(30), sevenDay(10)];
    const current = snapshot(currentWindows, 'sess-a', 1000);
    const incomingWindows = [fiveHour(80), sevenDay(40)];
    const incoming = snapshot(incomingWindows, 'sess-b', 2000);

    mergeRateLimitSnapshot(current, incoming);

    expect(current.rateLimits).toBe(currentWindows);
    expect(current.rateLimits[0].usedPercentage).toBe(30);
    expect(current.sourceSessionId).toBe('sess-a');
    expect(incoming.rateLimits).toBe(incomingWindows);
    expect(incoming.rateLimits[0].usedPercentage).toBe(80);
  });
});
