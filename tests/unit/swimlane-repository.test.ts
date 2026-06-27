/**
 * Unit tests for SwimlaneRepository.description round-trip through real SQLite.
 *
 * Pins four behaviors added by the add-description-fiel branch:
 *   1. create({ name, description }) then getById()/list() returns the description
 *      (proves INSERT column/placeholder/arg alignment is correct for description
 *      at position 3 after id and name).
 *   2. create({ name }) with no description - mapRow returns JS null, not undefined.
 *   3. update({ id, description }) changes the stored description
 *      (proves UPDATE SET includes description = ? and binds the right arg).
 *   4. update({ id, description: null }) clears it back to null.
 *   5. runProjectMigrations is idempotent: a second call on the same DB does NOT
 *      add a duplicate description column (the pragma guard fires and skips the
 *      ALTER TABLE; without it SQLite would throw "table swimlanes already has
 *      column description").
 *
 * Uses a real in-memory better-sqlite3 DB (':memory:') so the actual SQLite
 * engine validates INSERT/UPDATE column counts and argument alignment. No
 * disk writes. Skips cleanly when better-sqlite3 cannot load under the test
 * runner's Node ABI (NODE_MODULE_VERSION mismatch under plain system Node;
 * CI resolves the correct ABI at build time).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type DatabaseType from 'better-sqlite3';

// ---------------------------------------------------------------------------
// ABI probe - mirrors opencode-project-relocation.test.ts and
// opencode-schema-canary.test.ts patterns.
// ---------------------------------------------------------------------------

function probeBetterSqlite3(): typeof DatabaseType | null {
  try {
    // Use a variable for the module name to avoid the static-require lint rule
    // (which targets string-literal bare requires in bundled main/preload code;
    // this is a test helper for a native probe, not a bundled require).
    const moduleName = 'better-sqlite3';
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const nativeModule = require(moduleName) as unknown;
    const databaseConstructor = (
      (nativeModule as { default?: typeof DatabaseType }).default ?? nativeModule
    ) as typeof DatabaseType;
    // Force the native binding to load now - the NODE_MODULE_VERSION mismatch
    // only surfaces on instantiation, not on require.
    const probeHandle = new databaseConstructor(':memory:');
    probeHandle.close();
    return databaseConstructor;
  } catch {
    return null;
  }
}

const Database = probeBetterSqlite3();
const CAN_RUN = Database !== null;

// ---------------------------------------------------------------------------
// Imports (always resolved - they use 'import type' for better-sqlite3 so
// no native binding is touched at module load time).
// ---------------------------------------------------------------------------

import { runProjectMigrations } from '../../src/main/db/migrations/project-schema';
import { SwimlaneRepository } from '../../src/main/db/repositories/swimlane-repository';

// ---------------------------------------------------------------------------
// Round-trip tests against a real in-memory SQLite DB.
// ---------------------------------------------------------------------------

describe.runIf(CAN_RUN)('SwimlaneRepository - description column round-trip', () => {
  let db: InstanceType<typeof DatabaseType>;
  let repository: SwimlaneRepository;

  beforeEach(() => {
    if (!Database) return;
    db = new Database(':memory:');
    runProjectMigrations(db);
    repository = new SwimlaneRepository(db);
  });

  afterEach(() => {
    db?.close();
  });

  it('create with description set - INSERT binds the value and SELECT returns it unchanged', () => {
    // The production INSERT has description at position 3 (after id, name) in
    // both the column list and the ? bind list. If either is removed, SQLite
    // either throws a column-count mismatch or stores NULL here.
    // Red trigger: remove 'description' from the INSERT column list OR from
    // the run() bind args -> description comes back null -> assertion fails.
    const createdSwimlane = repository.create({
      name: 'Queue',
      description: 'Handles tasks waiting for review',
    });

    expect(createdSwimlane.description).toBe('Handles tasks waiting for review');

    // Verify the value actually persisted to the DB (not just the in-memory return).
    const fromGetById = repository.getById(createdSwimlane.id);
    expect(fromGetById?.description).toBe('Handles tasks waiting for review');

    const fromList = repository.list().find((lane) => lane.id === createdSwimlane.id);
    expect(fromList?.description).toBe('Handles tasks waiting for review');
  });

  it('create with no description - mapRow maps the NULL column to JS null', () => {
    // SQLite stores NULL for this row because description has DEFAULT NULL.
    // mapRow must return JS null (not undefined, not empty string).
    // Red trigger: remove the description field from mapRow's return object ->
    // fromGetById.description would be undefined, not null -> toBeNull() fails.
    const createdSwimlane = repository.create({ name: 'Queue B' });

    expect(createdSwimlane.description).toBeNull();

    const fromGetById = repository.getById(createdSwimlane.id);
    expect(fromGetById?.description).toBeNull();
  });

  it('update with description set - UPDATE SET writes the new value to the DB', () => {
    // The production UPDATE has 'description = ?' in the SET clause.
    // If removed, the DB row stays NULL and the read-back assertion fails.
    // Red trigger: remove 'description = ?' from the UPDATE SQL and its
    // matching bind arg -> fromGetById still shows null -> assertion fails.
    const createdSwimlane = repository.create({ name: 'Queue C' });
    expect(createdSwimlane.description).toBeNull();

    repository.update({ id: createdSwimlane.id, description: 'Updated column purpose' });

    // Read back from DB to confirm the UPDATE actually persisted.
    const fromGetById = repository.getById(createdSwimlane.id);
    expect(fromGetById?.description).toBe('Updated column purpose');
  });

  it('update with description: null - clears a previously set description back to null', () => {
    // Null is a valid update value: input.description !== undefined (null !== undefined)
    // so the merge applies it. The UPDATE SET must then write NULL to the DB.
    const createdSwimlane = repository.create({
      name: 'Queue D',
      description: 'Initial description text',
    });
    expect(createdSwimlane.description).toBe('Initial description text');

    repository.update({ id: createdSwimlane.id, description: null });

    const fromGetById = repository.getById(createdSwimlane.id);
    expect(fromGetById?.description).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Migration idempotency test.
// ---------------------------------------------------------------------------

describe.runIf(CAN_RUN)('runProjectMigrations - description column idempotency', () => {
  it('running migrations twice leaves exactly one description column and does not throw', () => {
    if (!Database) return;
    const freshDb = new Database(':memory:');
    try {
      // First run - creates the swimlanes table, applies all ALTER TABLE
      // migrations including the description column addition.
      runProjectMigrations(freshDb);

      const columnsAfterFirstRun = (
        freshDb.pragma('table_info(swimlanes)') as Array<{ name: string }>
      ).map((column) => column.name);
      const descriptionCountAfterFirst = columnsAfterFirstRun.filter(
        (columnName) => columnName === 'description',
      ).length;
      expect(descriptionCountAfterFirst).toBe(1);

      // Second run - the pragma guard must detect the column exists and skip
      // the ALTER TABLE. Without the guard SQLite throws
      // "SqliteError: table swimlanes already has column description".
      expect(() => runProjectMigrations(freshDb)).not.toThrow();

      const columnsAfterSecondRun = (
        freshDb.pragma('table_info(swimlanes)') as Array<{ name: string }>
      ).map((column) => column.name);
      const descriptionCountAfterSecond = columnsAfterSecondRun.filter(
        (columnName) => columnName === 'description',
      ).length;
      expect(descriptionCountAfterSecond).toBe(1);
    } finally {
      freshDb.close();
    }
  });
});

// ---------------------------------------------------------------------------
// Skip-notice for environments where better-sqlite3 cannot load.
// ---------------------------------------------------------------------------

describe.runIf(!CAN_RUN)('SwimlaneRepository description tests (skipped)', () => {
  it('skipped - better-sqlite3 cannot load under this Node runtime (NODE_MODULE_VERSION mismatch)', () => {
    expect(CAN_RUN).toBe(false);
  });
});
