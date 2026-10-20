import { describe, it, expect, beforeEach } from 'vitest';
import { RateLimitLedger, RATE_LIMIT_RESET_MIN_DROP_POINTS } from '../../src/main/activity-engine/rate-limit-ledger';
import { RATE_LIMIT_RESET_EPSILON_SECONDS } from '../../src/shared/types';
import type { RateLimitWindow } from '../../src/shared/types';

// Fixed epochs: the ledger compares reported values and `resetsAt` only, never
// the wall clock, so every case is deterministic.
const SEVEN_DAY_RESET = 1_792_508_400;
const SEVEN_DAY_SECONDS = 7 * 24 * 60 * 60;
const FIVE_HOUR_RESET = 1_792_486_800;

function sevenDay(usedPercentage: number, resetsAt: number = SEVEN_DAY_RESET): RateLimitWindow {
  return { id: 'seven-day', label: '7d weekly', iconKind: 'period', usedPercentage, resetsAt, windowDurationSeconds: SEVEN_DAY_SECONDS };
}

function fiveHour(usedPercentage: number, resetsAt: number = FIVE_HOUR_RESET): RateLimitWindow {
  return { id: 'five-hour', label: '5h session', iconKind: 'session', usedPercentage, resetsAt, windowDurationSeconds: 5 * 60 * 60 };
}

describe('RateLimitLedger', () => {
  let ledger: RateLimitLedger;

  /** Stamp one seven-day report and return its generation. */
  function report(sessionId: string, usedPercentage: number, resetsAt?: number): number | undefined {
    return ledger.stamp(sessionId, [sevenDay(usedPercentage, resetsAt)])[0].generation;
  }

  beforeEach(() => {
    ledger = new RateLimitLedger();
  });

  it('stamps first reports with generation 0 and returns copies without mutating the input', () => {
    const windows = [fiveHour(30), sevenDay(60)];
    const stamped = ledger.stamp('sess-a', windows);

    expect(stamped.map((rateLimitWindow) => rateLimitWindow.generation)).toEqual([0, 0]);
    expect(stamped[0]).not.toBe(windows[0]);
    expect(windows[0].generation).toBeUndefined();
    expect(stamped[1]).toMatchObject({ id: 'seven-day', usedPercentage: 60, resetsAt: SEVEN_DAY_RESET });
  });

  it('opens a new generation when a session drops below its own report, and stale siblings stay behind (free reset)', () => {
    expect(report('sess-a', 99)).toBe(0);
    expect(report('sess-b', 99)).toBe(0);

    expect(report('sess-a', 1)).toBe(1);
    // sess-b has not called the API since: it repeats its cached 99.
    expect(report('sess-b', 99)).toBe(0);
    expect(report('sess-b', 99)).toBe(0);
    // sess-a's later rises stay in the new generation.
    expect(report('sess-a', 2)).toBe(1);
  });

  it('does not count a drop within the tolerance as a reset', () => {
    report('sess-a', 50);
    expect(report('sess-a', 50 - RATE_LIMIT_RESET_MIN_DROP_POINTS)).toBe(0);

    report('sess-b', 50);
    expect(report('sess-b', 50 - RATE_LIMIT_RESET_MIN_DROP_POINTS - 1)).toBe(1);
  });

  it('opens a new generation for a first report clearly below every current sibling (a new Command Terminal)', () => {
    report('sess-a', 99);
    report('sess-b', 97);

    expect(report('sess-terminal', 1)).toBe(1);
    expect(report('sess-terminal', 2)).toBe(1);
    expect(report('sess-a', 99)).toBe(0);
  });

  it('lets a first report that trails a sibling within the tolerance join the current generation', () => {
    report('sess-a', 52);
    expect(report('sess-new', 50)).toBe(0);
  });

  it('rejoins a session that catches up after a reset without opening another generation', () => {
    report('sess-a', 99);
    report('sess-b', 99);
    report('sess-c', 99);
    expect(report('sess-a', 1)).toBe(1);

    // sess-b calls the API and sees the reset too: a catch-up, not a second reset.
    expect(report('sess-b', 3)).toBe(1);
    // A first report after the reset is compared against the new generation only,
    // so sess-c's stale 99 does not make it look like another reset.
    expect(report('sess-new', 4)).toBe(1);
    expect(report('sess-c', 99)).toBe(0);
  });

  it('heals a false trigger: a sibling that rises after it rejoins the new generation', () => {
    report('sess-a', 51);
    report('sess-b', 51);
    // A noisy own drop past the tolerance opens a generation it should not have.
    expect(report('sess-a', 51 - RATE_LIMIT_RESET_MIN_DROP_POINTS - 1)).toBe(1);
    // sess-b's next fresh report rejoins, so the renderer's same-generation
    // maximum shows its 52 again.
    expect(report('sess-b', 52)).toBe(1);
  });

  it('never opens a generation on a rollover, an older window, or a missing resetsAt', () => {
    report('sess-a', 99);
    expect(report('sess-a', 1, SEVEN_DAY_RESET + SEVEN_DAY_SECONDS)).toBe(0);
    expect(report('sess-b', 1, SEVEN_DAY_RESET - SEVEN_DAY_SECONDS)).toBe(0);

    report('sess-c', 90, 0);
    expect(report('sess-c', 1, 0)).toBe(0);
    expect(report('sess-d', 1, 0)).toBe(0);
  });

  it('keeps generations per window id', () => {
    ledger.stamp('sess-a', [fiveHour(80), sevenDay(99)]);
    const afterReset = ledger.stamp('sess-a', [fiveHour(81), sevenDay(1)]);

    expect(afterReset.map((rateLimitWindow) => rateLimitWindow.generation)).toEqual([0, 1]);
  });

  it('forgets a removed session but keeps the account-wide generation', () => {
    report('sess-a', 99);
    report('sess-b', 99);
    report('sess-a', 1);
    ledger.removeSession('sess-b');

    // sess-b's next report is a first report again, compared with sess-a's 1.
    expect(report('sess-b', 2)).toBe(1);
    ledger.removeSession('sess-a');
    expect(report('sess-a', 3)).toBe(1);
  });

  it('does not compare a first report with siblings or the high-water mark of another window', () => {
    report('sess-a', 99);

    // A report one full window later is a rollover, not a reset, even at 1 against 99.
    expect(report('sess-b', 1, SEVEN_DAY_RESET + SEVEN_DAY_SECONDS)).toBe(0);
    expect(ledger.currentGeneration('seven-day')).toBe(0);
  });

  it('does not compare a first report that has no resetsAt with anything', () => {
    report('sess-a', 99);

    // A missing resetsAt (parses to 0) names no window, so there is nothing to compare against.
    expect(report('sess-c', 1, 0)).toBe(0);
    expect(ledger.currentGeneration('seven-day')).toBe(0);
  });

  it('does not open a generation for a first report exactly at the drop tolerance', () => {
    report('sess-a', 55);
    expect(report('sess-new', 55 - RATE_LIMIT_RESET_MIN_DROP_POINTS)).toBe(0);
    expect(ledger.currentGeneration('seven-day')).toBe(0);
  });

  it('opens a generation for a first report one point past the drop tolerance', () => {
    report('sess-a', 55);
    expect(report('sess-new', 55 - RATE_LIMIT_RESET_MIN_DROP_POINTS - 1)).toBe(1);
    expect(ledger.currentGeneration('seven-day')).toBe(1);
  });

  describe('high-water mark outlives the sessions that set it', () => {
    it('still detects a reset when every earlier session has been removed', () => {
      report('sess-a', 60);
      ledger.removeSession('sess-a');

      // No live sibling is left to compare with, only the account-wide mark.
      expect(report('sess-b', 2)).toBe(1);
    });

    it('belongs to the current generation only, so a later first report joins it instead of opening another', () => {
      report('sess-a', 60);
      ledger.removeSession('sess-a');
      expect(report('sess-b', 2)).toBe(1);

      // The mark restarted at the reset value (2). The pre-reset 60 must not linger.
      expect(report('sess-c', 3)).toBe(1);
      ledger.removeSession('sess-b');
      ledger.removeSession('sess-c');
      expect(report('sess-d', 4)).toBe(1);
      expect(ledger.currentGeneration('seven-day')).toBe(1);
    });

    it('never counts a stale repeat from a session behind the generation', () => {
      report('sess-a', 99);
      report('sess-b', 99);
      expect(report('sess-a', 1)).toBe(1);
      // sess-b is behind generation 1 and repeats its cached 99. That says nothing
      // about the current generation, so it must not lift the mark.
      expect(report('sess-b', 99)).toBe(0);
      ledger.removeSession('sess-a');

      expect(report('sess-d', 2)).toBe(1);
      expect(ledger.currentGeneration('seven-day')).toBe(1);
    });
  });

  it('treats a repeat whose resetsAt jitters within the epsilon as still a repeat', () => {
    report('sess-a', 99);
    report('sess-b', 99);
    expect(report('sess-a', 1)).toBe(1);

    // sess-b re-sends its cached 99 with an anchor a few seconds off. It is still
    // the same report in the same window, so sess-b stays behind generation 1.
    const jitteredResetsAt = SEVEN_DAY_RESET + RATE_LIMIT_RESET_EPSILON_SECONDS / 2;
    expect(report('sess-b', 99, jitteredResetsAt)).toBe(0);
  });
});
