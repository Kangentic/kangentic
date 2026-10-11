/**
 * Unit tests for the shared summarize rate-limit window in
 * src/main/agent/shared/summarize-rate-limit.ts.
 *
 * One module-level sliding window caps headless summarize calls per hour. Both
 * the AGENT_SUMMARIZE IPC handler and main's Command Terminal namer draw from
 * it, so `autoNameRateLimitPerHour` is a combined cap. The cross-caller sharing
 * is pinned in agent-summarize-handler.test.ts; this file pins the window's own
 * arithmetic.
 *
 * Every case passes an explicit `now` (a fixed epoch plus offsets) so nothing
 * depends on the wall clock. The one exception is the default-`now` case, which
 * exists to prove the production callers' no-argument form reads the clock.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  tryAcquireSummarizeSlot,
  resetSummarizeRateLimit,
} from '../../src/main/agent/shared/summarize-rate-limit';

const ONE_HOUR_MS = 60 * 60 * 1000;
const ONE_MINUTE_MS = 60 * 1000;
const START = 1_700_000_000_000;

describe('tryAcquireSummarizeSlot', () => {
  beforeEach(() => {
    // The window is module-level state shared across the whole file.
    resetSummarizeRateLimit();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    resetSummarizeRateLimit();
  });

  it('allows exactly `limit` acquisitions within an hour, then refuses', () => {
    expect(tryAcquireSummarizeSlot(3, START)).toBe(true);
    expect(tryAcquireSummarizeSlot(3, START + ONE_MINUTE_MS)).toBe(true);
    expect(tryAcquireSummarizeSlot(3, START + 2 * ONE_MINUTE_MS)).toBe(true);

    expect(tryAcquireSummarizeSlot(3, START + 3 * ONE_MINUTE_MS)).toBe(false);
    expect(tryAcquireSummarizeSlot(3, START + 4 * ONE_MINUTE_MS)).toBe(false);
  });

  it('a limit of 1 allows one call and refuses the next', () => {
    expect(tryAcquireSummarizeSlot(1, START)).toBe(true);
    expect(tryAcquireSummarizeSlot(1, START + 1)).toBe(false);
  });

  it('expires an entry older than one hour so a slot frees up', () => {
    expect(tryAcquireSummarizeSlot(2, START)).toBe(true);
    expect(tryAcquireSummarizeSlot(2, START + ONE_MINUTE_MS)).toBe(true);
    expect(tryAcquireSummarizeSlot(2, START + 2 * ONE_MINUTE_MS)).toBe(false);

    // One millisecond past the hour: the first entry (START) is now older than
    // an hour, the second (START + 1 minute) is not.
    const justPastFirstExpiry = START + ONE_HOUR_MS + 1;
    expect(tryAcquireSummarizeSlot(2, justPastFirstExpiry)).toBe(true);
    // That refilled the window to two live entries.
    expect(tryAcquireSummarizeSlot(2, justPastFirstExpiry + 1)).toBe(false);
  });

  it('keeps an entry that is exactly one hour old (only OLDER than an hour expires)', () => {
    expect(tryAcquireSummarizeSlot(1, START)).toBe(true);

    expect(tryAcquireSummarizeSlot(1, START + ONE_HOUR_MS)).toBe(false);
    expect(tryAcquireSummarizeSlot(1, START + ONE_HOUR_MS + 1)).toBe(true);
  });

  it('slides: only the aged-out entries free slots, newer ones keep counting', () => {
    expect(tryAcquireSummarizeSlot(2, START)).toBe(true);
    expect(tryAcquireSummarizeSlot(2, START + 30 * ONE_MINUTE_MS)).toBe(true);

    // 61 minutes in: the first call aged out, the 30-minute one did not.
    const sixtyOneMinutesIn = START + 61 * ONE_MINUTE_MS;
    expect(tryAcquireSummarizeSlot(2, sixtyOneMinutesIn)).toBe(true);
    expect(tryAcquireSummarizeSlot(2, sixtyOneMinutesIn + 1)).toBe(false);

    // 91 minutes in: the 30-minute entry has aged out too, the 61-minute one has not.
    const ninetyOneMinutesIn = START + 91 * ONE_MINUTE_MS;
    expect(tryAcquireSummarizeSlot(2, ninetyOneMinutesIn)).toBe(true);
    expect(tryAcquireSummarizeSlot(2, ninetyOneMinutesIn + 1)).toBe(false);
  });

  it('a refused call does not record a timestamp, so refusals never extend the lockout', () => {
    expect(tryAcquireSummarizeSlot(1, START)).toBe(true);
    // A burst of refused attempts later in the window.
    for (let attempt = 1; attempt <= 5; attempt++) {
      expect(tryAcquireSummarizeSlot(1, START + attempt * ONE_MINUTE_MS)).toBe(false);
    }

    // Once the only recorded call ages out, the very next attempt succeeds. If
    // refusals had been recorded, the 5-minute refusal would still be live.
    expect(tryAcquireSummarizeSlot(1, START + ONE_HOUR_MS + 1)).toBe(true);
  });

  it('applies the limit passed on each call, so lowering it takes effect on the live window', () => {
    expect(tryAcquireSummarizeSlot(5, START)).toBe(true);
    expect(tryAcquireSummarizeSlot(5, START + 1)).toBe(true);

    // The setting was lowered to 2 while two calls were already recorded.
    expect(tryAcquireSummarizeSlot(2, START + 2)).toBe(false);
    // Raised back: the same window has room again.
    expect(tryAcquireSummarizeSlot(3, START + 3)).toBe(true);
  });

  it('reads the wall clock when `now` is omitted (the form the handler and namer use)', () => {
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(START);

    expect(tryAcquireSummarizeSlot(1)).toBe(true);
    expect(tryAcquireSummarizeSlot(1)).toBe(false);

    nowSpy.mockReturnValue(START + ONE_HOUR_MS + 1);
    expect(tryAcquireSummarizeSlot(1)).toBe(true);
  });

  describe('a limit of 0 or less means unlimited', () => {
    for (const unlimitedLimit of [0, -1]) {
      it(`limit ${unlimitedLimit} never refuses`, () => {
        for (let attempt = 0; attempt < 200; attempt++) {
          expect(tryAcquireSummarizeSlot(unlimitedLimit, START + attempt)).toBe(true);
        }
      });
    }

    it('an unlimited call records nothing, so a later finite limit starts from an empty window', () => {
      for (let attempt = 0; attempt < 50; attempt++) {
        tryAcquireSummarizeSlot(0, START + attempt);
      }

      // The user turned the cap on after 50 unlimited calls: those must not
      // count against it.
      expect(tryAcquireSummarizeSlot(1, START + 100)).toBe(true);
      expect(tryAcquireSummarizeSlot(1, START + 101)).toBe(false);
    });

    it('an unlimited call does not bypass a finite window that is already full', () => {
      expect(tryAcquireSummarizeSlot(1, START)).toBe(true);
      expect(tryAcquireSummarizeSlot(0, START + 1)).toBe(true);

      // The unlimited call neither consumed nor cleared anything.
      expect(tryAcquireSummarizeSlot(1, START + 2)).toBe(false);
    });
  });
});

describe('resetSummarizeRateLimit', () => {
  afterEach(() => {
    resetSummarizeRateLimit();
  });

  it('clears the window so a full limit accepts calls again', () => {
    expect(tryAcquireSummarizeSlot(2, START)).toBe(true);
    expect(tryAcquireSummarizeSlot(2, START + 1)).toBe(true);
    expect(tryAcquireSummarizeSlot(2, START + 2)).toBe(false);

    resetSummarizeRateLimit();

    expect(tryAcquireSummarizeSlot(2, START + 3)).toBe(true);
    expect(tryAcquireSummarizeSlot(2, START + 4)).toBe(true);
    expect(tryAcquireSummarizeSlot(2, START + 5)).toBe(false);
  });

  it('is safe to call on an empty window', () => {
    expect(() => resetSummarizeRateLimit()).not.toThrow();
    expect(tryAcquireSummarizeSlot(1, START)).toBe(true);
  });
});
