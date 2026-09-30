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
      try {
        const result = body(...args);
        depth -= 1;
        database.exec(depth === 0 ? 'COMMIT' : `RELEASE ${savepoint}`);
        return result;
      } catch (error) {
        depth -= 1;
        database.exec(depth === 0 ? 'ROLLBACK' : `ROLLBACK TO ${savepoint}; RELEASE ${savepoint}`);
        throw error;
      }
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
  };
  return adapter as unknown as DatabaseType.Database;
}
