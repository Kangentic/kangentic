/**
 * The holder half of a `SQLITE_BUSY` report (Sentry DESKTOP-5V): which long
 * write holds of the retrieval worker fall in the lookback, and the buckets
 * they are sent as. If these drift, a busy report names a hold from minutes
 * earlier as the holder, or misses the one that caused it.
 */
import { afterEach, describe, expect, it } from 'vitest';
import {
  bucketWriteHold,
  buildSqliteBusyContext,
  longestRetrievalWriteHoldWithin,
  recordRetrievalWriteHold,
  resetRetrievalWriteHolds,
  SQLITE_BUSY_LOOKBACK_MS,
} from '../../src/main/diagnostics/sqlite-busy-holders';

afterEach(resetRetrievalWriteHolds);

describe('retrieval write holds in the lookback', () => {
  it('returns the longest hold within the window and none outside it', () => {
    const now = 1_000_000;
    recordRetrievalWriteHold(25_000, now - SQLITE_BUSY_LOOKBACK_MS - 1);
    recordRetrievalWriteHold(1_200, now - 20_000);
    recordRetrievalWriteHold(9_800, now - 1_000);
    recordRetrievalWriteHold(2_000, now);

    expect(longestRetrievalWriteHoldWithin(SQLITE_BUSY_LOOKBACK_MS, now)).toBe(9_800);
    expect(longestRetrievalWriteHoldWithin(500, now)).toBe(2_000);
  });

  it('is null when the worker posted nothing, and ignores a value that is not a duration', () => {
    recordRetrievalWriteHold(Number.NaN);
    recordRetrievalWriteHold(-5);

    expect(longestRetrievalWriteHoldWithin(SQLITE_BUSY_LOOKBACK_MS)).toBeNull();
  });

  it('keeps a bounded number of holds, the newest ones', () => {
    const now = 5_000_000;
    recordRetrievalWriteHold(20_000, now - 100);
    for (let index = 0; index < 200; index++) recordRetrievalWriteHold(1_500, now);

    expect(longestRetrievalWriteHoldWithin(SQLITE_BUSY_LOOKBACK_MS, now)).toBe(1_500);
  });
});

describe('the sqlite_busy context', () => {
  it.each([
    [null, 'none'],
    [999, '<1s'],
    [1_000, '1-5s'],
    [4_999, '1-5s'],
    [5_000, '5-10s'],
    [10_000, '10-30s'],
    [30_000, '30s+'],
  ] as const)('buckets a %s ms hold as %s', (heldMs, bucket) => {
    expect(bucketWriteHold(heldMs)).toBe(bucket);
  });

  it('holds exactly the two fixed fields, bucketed', () => {
    const now = 2_000_000;
    recordRetrievalWriteHold(11_000, now - 3_000);

    expect(buildSqliteBusyContext('yes', now)).toEqual({ retrieval_longest_hold: '10-30s', pty_host_held: 'yes' });
  });
});
