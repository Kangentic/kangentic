/**
 * The bucket a timed-out screenshot reports for "how long since the machine woke"
 * (DESKTOP-46). If the edges drift, a capture 18 s after an unlock stops reading as
 * one, which is the question the tag exists to answer.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { noteWake, sinceWakeBucket, resetWakeClockForTests } from '../../src/main/browser/wake-clock';

beforeEach(() => {
  resetWakeClockForTests();
});

describe('sinceWakeBucket', () => {
  it('reads none until the machine has woken this run', () => {
    expect(sinceWakeBucket(1_000_000)).toBe('none');
  });

  it('buckets the time since the latest wake at each edge', () => {
    const wokeAt = 1_000_000;
    noteWake(wokeAt);
    expect(sinceWakeBucket(wokeAt)).toBe('under_30s');
    expect(sinceWakeBucket(wokeAt + 29_999)).toBe('under_30s');
    expect(sinceWakeBucket(wokeAt + 30_000)).toBe('under_2m');
    expect(sinceWakeBucket(wokeAt + 119_999)).toBe('under_2m');
    expect(sinceWakeBucket(wokeAt + 120_000)).toBe('under_10m');
    expect(sinceWakeBucket(wokeAt + 599_999)).toBe('under_10m');
    expect(sinceWakeBucket(wokeAt + 600_000)).toBe('over_10m');
  });

  it('measures from the latest wake, not the first', () => {
    noteWake(0);
    noteWake(1_000_000);
    expect(sinceWakeBucket(1_018_000)).toBe('under_30s');
  });
});
