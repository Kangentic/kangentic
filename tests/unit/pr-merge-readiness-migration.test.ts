/**
 * Migration + real-SQL round-trip for the `pr_merge_readiness` column on
 * `tasks` (src/main/db/migrations/project-schema.ts) and the TaskRepository
 * INSERT / UPDATE column lists that carry it.
 *
 * `tests/unit/task-repository.test.ts` drives the repository against a
 * statement tracker that never executes SQL, so a column present in the
 * migration but missing from the UPDATE's SET list (the one edit that makes
 * the column persist at all) leaves every existing test green while the verdict
 * silently never lands on disk. This file runs the REAL migration against a
 * REAL in-memory better-sqlite3 database and round-trips through the REAL
 * repository, mirroring `activity-interval-migration.test.ts`'s probe pattern.
 * It skips cleanly when better-sqlite3 cannot load under the test runner's Node
 * ABI (expected on a developer's Windows machine, built for Electron's ABI) and
 * RUNS on CI (built for plain Node).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type DatabaseType from 'better-sqlite3';

function probeBetterSqlite3(): typeof DatabaseType | null {
  try {
    const moduleName = 'better-sqlite3';
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const nativeModule = require(moduleName) as unknown;
    const databaseConstructor = (
      (nativeModule as { default?: typeof DatabaseType }).default ?? nativeModule
    ) as typeof DatabaseType;
    const probeHandle = new databaseConstructor(':memory:');
    probeHandle.close();
    return databaseConstructor;
  } catch {
    return null;
  }
}

const Database = probeBetterSqlite3();
const CAN_RUN = Database !== null;

import { runProjectMigrations } from '../../src/main/db/migrations/project-schema';
import { TaskRepository } from '../../src/main/db/repositories/task-repository';

interface TableColumnInfo {
  name: string;
  type: string;
  notnull: number;
  dflt_value: string | null;
}

describe.runIf(CAN_RUN)('runProjectMigrations - tasks.pr_merge_readiness', () => {
  let db: InstanceType<typeof DatabaseType>;

  beforeEach(() => {
    if (!Database) return;
    db = new Database(':memory:');
    runProjectMigrations(db);
  });

  afterEach(() => {
    db?.close();
  });

  function columnInfo(): TableColumnInfo | undefined {
    return (db.pragma('table_info(tasks)') as TableColumnInfo[]).find((column) => column.name === 'pr_merge_readiness');
  }

  function firstSwimlaneId(): string {
    const row = db.prepare('SELECT id FROM swimlanes ORDER BY position LIMIT 1').get() as { id: string };
    return row.id;
  }

  it('adds a nullable TEXT column with a NULL default', () => {
    const column = columnInfo();
    expect(column).toBeDefined();
    expect(column?.type).toBe('TEXT');
    expect(column?.notnull).toBe(0);
  });

  it('is idempotent: a second run neither throws nor duplicates the column', () => {
    expect(() => runProjectMigrations(db)).not.toThrow();
    const matches = (db.pragma('table_info(tasks)') as TableColumnInfo[]).filter((column) => column.name === 'pr_merge_readiness');
    expect(matches).toHaveLength(1);
  });

  it('round-trips through the real repository: create seeds null, update writes, omit preserves, null clears', () => {
    const repository = new TaskRepository(db);
    const created = repository.create({ title: 'PR task', description: '', swimlane_id: firstSwimlaneId() });
    expect(created.pr_merge_readiness).toBeNull();
    expect(repository.getById(created.id)?.pr_merge_readiness).toBeNull();

    repository.update({ id: created.id, pr_merge_readiness: 'ready' });
    expect(repository.getById(created.id)?.pr_merge_readiness).toBe('ready');

    // An update that omits the field must not clobber it: `undefined` is
    // dropped by the merge, which is what lets the linker preserve a verdict
    // while rewriting the other PR columns.
    repository.update({ id: created.id, title: 'Renamed' });
    expect(repository.getById(created.id)?.pr_merge_readiness).toBe('ready');

    repository.update({ id: created.id, pr_merge_readiness: null });
    expect(repository.getById(created.id)?.pr_merge_readiness).toBeNull();
  });
});

describe.runIf(!CAN_RUN)('tasks.pr_merge_readiness migration tests (skipped)', () => {
  it('skipped - better-sqlite3 cannot load under this Node runtime (NODE_MODULE_VERSION mismatch)', () => {
    expect(CAN_RUN).toBe(false);
  });
});
