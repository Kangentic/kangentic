/**
 * node:sqlite behind the slice of better-sqlite3's API the app's database code
 * uses, for unit tests on a real SQLite database. better-sqlite3 is compiled
 * for Electron's Node ABI, so it cannot load under vitest's system Node.
 *
 * `transaction(body)` returns what better-sqlite3's does: a function that runs
 * `body` in a transaction, with `.deferred`, `.immediate` and `.exclusive`
 * variants that begin it that way. The app goes through `writeTransaction`,
 * which calls `.immediate`. A call inside a running transaction becomes a
 * savepoint, as it does in better-sqlite3.
 *
 * `prepared`, when given, records every statement prepared, for tests that pin
 * a query's text or plan.
 */

import type DatabaseType from 'better-sqlite3';

type SqliteModule = typeof import('node:sqlite');
export type NodeDatabase = InstanceType<SqliteModule['DatabaseSync']>;

type BeginMode = 'DEFERRED' | 'IMMEDIATE' | 'EXCLUSIVE';

export function adaptDatabase(database: NodeDatabase, prepared?: string[]): DatabaseType.Database {
  let depth = 0;

  function transaction<Args extends unknown[], Result>(body: (...args: Args) => Result) {
    const run = (mode: BeginMode) => (...args: Args): Result => {
      const savepoint = `sp_${depth}`;
      database.exec(depth === 0 ? `BEGIN ${mode}` : `SAVEPOINT ${savepoint}`);
      depth += 1;
      let result: Result;
      try {
        result = body(...args);
      } catch (error) {
        depth -= 1;
        database.exec(depth === 0 ? 'ROLLBACK' : `ROLLBACK TO ${savepoint}; RELEASE ${savepoint}`);
        throw error;
      }
      // Decremented once, outside the body's catch: a COMMIT that fails
      // (SQLITE_BUSY from a second connection) took depth below 0 before.
      depth -= 1;
      try {
        database.exec(depth === 0 ? 'COMMIT' : `RELEASE ${savepoint}`);
      } catch (error) {
        // A failed COMMIT leaves the transaction open; close it, as
        // better-sqlite3 does, so the next call begins a fresh one.
        if (depth === 0) {
          try {
            database.exec('ROLLBACK');
          } catch {
            // Already closed.
          }
        }
        throw error;
      }
      return result;
    };
    return Object.assign(run('DEFERRED'), {
      deferred: run('DEFERRED'),
      immediate: run('IMMEDIATE'),
      exclusive: run('EXCLUSIVE'),
    });
  }

  const adapter = {
    exec: (sql: string) => database.exec(sql),
    prepare: (sql: string) => {
      prepared?.push(sql);
      return database.prepare(sql);
    },
    pragma: (statement: string) => database.prepare(`PRAGMA ${statement}`).all(),
    transaction,
    /** True inside a transaction run through `transaction`, as better-sqlite3's is. */
    get inTransaction() {
      return depth > 0;
    },
  };
  return adapter as unknown as DatabaseType.Database;
}
