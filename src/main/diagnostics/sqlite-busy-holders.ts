/**
 * Who else may have held a project database's write lock when a write on main
 * waited out its whole busy timeout (Sentry DESKTOP-5V). Main cannot contend
 * with itself: it holds one synchronous connection per project and no write
 * spans an `await`. So a `SQLITE_BUSY` on main means another process held the
 * lock for 5 s or more: the retrieval worker, or the pty host's transcript
 * writer.
 *
 * Each `SQLITE_BUSY` report carries a `sqlite_busy` context built here, of
 * buckets and yes/no values only (`withEnvironmentContexts` in
 * `error-reporting.ts`):
 *
 * - `retrieval_longest_hold`: the longest write hold the retrieval worker
 *   reported in the last `SQLITE_BUSY_LOOKBACK_MS`. The worker posts a hold
 *   when it commits, so a hold still under way is not in it. A plan-exit move
 *   reports only after its retry, about 11 s after the first busy wait began,
 *   so a hold of that length has usually ended by then.
 * - `pty_host_held`: whether the pty host's own event-loop watchdog wrote a
 *   line in that window. It is the host's evidence, not main's ping timing:
 *   main is the thread blocked in the busy wait, so a ping would read late on
 *   every report.
 */

/** How far back a busy report looks for a holder. */
export const SQLITE_BUSY_LOOKBACK_MS = 30_000;

/** How many posted holds main keeps. One a second for the whole window is far more than a healthy worker sends. */
const MAX_KEPT_HOLDS = 64;

export type WriteHoldBucket = 'none' | '<1s' | '1-5s' | '5-10s' | '10-30s' | '30s+';
export type PtyHostHeld = 'yes' | 'no' | 'unknown';

interface PostedHold {
  at: number;
  heldMs: number;
}

const postedHolds: PostedHold[] = [];

/** A long write hold the retrieval worker posted (`write-hold`). */
export function recordRetrievalWriteHold(heldMs: number, now: number = Date.now()): void {
  if (!Number.isFinite(heldMs) || heldMs < 0) return;
  postedHolds.push({ at: now, heldMs });
  if (postedHolds.length > MAX_KEPT_HOLDS) postedHolds.splice(0, postedHolds.length - MAX_KEPT_HOLDS);
}

/** The longest hold posted within `windowMs` of `now`, or null when none was. */
export function longestRetrievalWriteHoldWithin(windowMs: number, now: number = Date.now()): number | null {
  let longest: number | null = null;
  for (const hold of postedHolds) {
    if (now - hold.at > windowMs) continue;
    if (longest === null || hold.heldMs > longest) longest = hold.heldMs;
  }
  return longest;
}

/** Test-only: forget every posted hold. */
export function resetRetrievalWriteHolds(): void {
  postedHolds.length = 0;
}

export function bucketWriteHold(heldMs: number | null): WriteHoldBucket {
  if (heldMs === null) return 'none';
  if (heldMs < 1_000) return '<1s';
  if (heldMs < 5_000) return '1-5s';
  if (heldMs < 10_000) return '5-10s';
  if (heldMs < 30_000) return '10-30s';
  return '30s+';
}

export interface SqliteBusyContext extends Record<string, string> {
  retrieval_longest_hold: WriteHoldBucket;
  pty_host_held: PtyHostHeld;
}

export function buildSqliteBusyContext(ptyHostHeld: PtyHostHeld, now: number = Date.now()): SqliteBusyContext {
  return {
    retrieval_longest_hold: bucketWriteHold(longestRetrievalWriteHoldWithin(SQLITE_BUSY_LOOKBACK_MS, now)),
    pty_host_held: ptyHostHeld,
  };
}
