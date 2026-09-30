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
import { timeSyncWork } from '../diagnostics/event-loop-lag';

/**
 * `db.transaction(body)`, begun IMMEDIATE. Call the result to run it; nested
 * calls become savepoints, as with any better-sqlite3 transaction function.
 * Each run is timed, so a transaction that waited on the other process's write
 * shows in the slow-work log.
 */
export function writeTransaction<Args extends unknown[], Result>(
  db: Database.Database,
  body: (...args: Args) => Result,
): (...args: Args) => Result {
  const immediate = db.transaction(body).immediate;
  return (...args: Args): Result => timeSyncWork('db:transaction', () => immediate(...args));
}
