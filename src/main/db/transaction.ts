/**
 * Every transaction on a Kangentic database goes through here, and takes the
 * write lock when it BEGINS.
 *
 * Two processes write each project database: main (tasks, sessions and the
 * rest of the app) and the retrieval worker (the index). SQLite lets one of
 * them write at a time. better-sqlite3's plain `db.transaction(fn)` begins
 * DEFERRED, taking the write lock at its first write, and a transaction that
 * has read by then cannot wait for it: SQLite fails the upgrade at once with
 * SQLITE_BUSY when another connection holds the lock or has committed since
 * the read (sqlite.org/lang_transaction.html). `.immediate`, better-sqlite3's
 * documented variant, takes the lock at BEGIN, where the busy timeout applies,
 * so the transaction waits its turn instead of failing.
 *
 * `tests/unit/transaction-helper.test.ts` pins both behaviours on two real
 * connections, and fails on any `.transaction(` outside this file.
 */

import type Database from 'better-sqlite3';
import { isTimingSyncWork, recordSyncSpan } from '../diagnostics/event-loop-lag';

/**
 * `db.transaction(body)`, begun IMMEDIATE. Call the result to run it; nested
 * calls become savepoints, as with any better-sqlite3 transaction function.
 *
 * Each run is timed in two parts, because they mean different things:
 * `db:lock-wait` is the time BEGIN spent waiting for the other process to
 * commit (on Windows SQLite's busy retry sleeps at least one 15.6 ms timer
 * tick), and `db:transaction` is the time this connection held the lock, from
 * the body's start through the commit. A long hold makes the other process
 * wait; a long wait means this one did.
 */
export function writeTransaction<Args extends unknown[], Result>(
  db: Database.Database,
  body: (...args: Args) => Result,
): (...args: Args) => Result {
  let bodyStartedAt = 0;
  const immediate = db.transaction((...args: Args): Result => {
    if (bodyStartedAt === 0) bodyStartedAt = performance.now();
    return body(...args);
  }).immediate;
  return (...args: Args): Result => {
    if (!isTimingSyncWork()) return immediate(...args);
    const startedAt = performance.now();
    // A nested run of this same function (a savepoint) restores the outer
    // run's mark when it finishes.
    const outerBodyStartedAt = bodyStartedAt;
    bodyStartedAt = 0;
    try {
      return immediate(...args);
    } finally {
      const endedAt = performance.now();
      const lockedAt = bodyStartedAt === 0 ? endedAt : bodyStartedAt;
      bodyStartedAt = outerBodyStartedAt;
      const waitedMs = lockedAt - startedAt;
      if (waitedMs >= 1) recordSyncSpan('db:lock-wait', waitedMs);
      recordSyncSpan('db:transaction', endedAt - lockedAt);
    }
  };
}
