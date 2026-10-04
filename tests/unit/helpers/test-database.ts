/**
 * A real better-sqlite3 database for unit tests: the driver production uses.
 *
 * Before better-sqlite3 13 the binding was built for Electron's ABI and could not
 * load under vitest, so suites ran on `node:sqlite` behind an adapter that
 * imitated better-sqlite3's transaction, pragma and savepoint behavior. better-sqlite3
 * 13 is a Node-API module that loads here, so suites open the real thing instead
 * and test what ships rather than an imitation of it.
 * tests/unit/better-sqlite3-loads-in-vitest.test.ts fails if it ever stops loading.
 */
import Database from 'better-sqlite3';
import { getLoadablePath } from 'sqlite-vec';

export interface TestDatabaseOptions {
  /** Records the SQL of every statement prepared, for tests that pin a query's text or plan. */
  prepared?: string[];
  /** Loads the sqlite-vec extension into the connection, as the retrieval worker does. */
  vec?: boolean;
  /** Passed through to better-sqlite3 (`readonly`, `fileMustExist`, `timeout`). */
  databaseOptions?: Database.Options;
}

/** Opens `filename` (default `:memory:`) with better-sqlite3. The caller closes it. */
export function openTestDatabase(filename = ':memory:', options: TestDatabaseOptions = {}): Database.Database {
  const database = new Database(filename, options.databaseOptions);
  if (options.vec) database.loadExtension(getLoadablePath());
  const prepared = options.prepared;
  if (prepared) {
    const prepareStatement = database.prepare.bind(database);
    database.prepare = ((source: string) => {
      prepared.push(source);
      return prepareStatement(source);
    }) as typeof database.prepare;
  }
  return database;
}
