/**
 * Real-SQLite regression test for `applyBoardConfigToDb`'s "ghost or delete
 * columns not in config" branch (src/main/config/board-config/apply-config.ts).
 *
 * This branch changed behavior, not just shape, in the column-deletion work:
 * three bare `db.prepare(...).run(...)` calls were replaced with a call to
 * `deleteSwimlaneRowWithReferences`, which wraps them in its OWN
 * `db.transaction()` - nested inside `applyBoardConfigToDb`'s own outer
 * transaction. better-sqlite3 supports this via an automatic SAVEPOINT when
 * `db.inTransaction` is already true, but nothing exercised the nesting with a
 * real database before this file: the existing apply-config coverage
 * (`board-config-parity.test.ts`) mocks `SwimlaneRepository` entirely and its
 * fake `db` has no `.prepare`, so the delete branch was never actually run
 * there - only `create`/`update` call-shape was pinned.
 *
 * Uses a real in-memory better-sqlite3 DB so the actual engine validates the
 * nested transaction and the cross-table cleanup. `getProjectDb` is mocked to
 * hand back that real DB (rather than opening a file under a config dir),
 * mirroring how `board-config-cache.test.ts` mocks the same module - but here
 * the returned handle is real, not a stub, so `SwimlaneRepository` and
 * `ActionRepository` are left UNMOCKED and run for real against it.
 *
 * Caveat: these in-memory DBs (like every sibling real-SQLite test file) do
 * NOT set `PRAGMA foreign_keys = ON` the way production's `getProjectDb`
 * does. A wrong delete ORDER inside `deleteSwimlaneRowWithReferences` (e.g.
 * dropping the swimlane row before its transitions) would still pass here
 * even though it would violate an FK in production. These tests pin the
 * OUTCOME (rows and references end up correct), not the delete ordering.
 *
 * Skips cleanly when better-sqlite3 cannot load under the runner's Node ABI
 * (NODE_MODULE_VERSION mismatch under plain system Node); CI resolves the
 * correct ABI at build time. Mirrors swimlane-repository.test.ts.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
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

// ---------------------------------------------------------------------------
// Mock getProjectDb to hand back the real in-memory DB built per-test, so
// applyBoardConfigToDb (and the real, unmocked SwimlaneRepository /
// ActionRepository it constructs internally) operate on it.
// ---------------------------------------------------------------------------

const hoisted = vi.hoisted(() => ({
  currentDb: null as unknown,
}));

vi.mock('../../src/main/db/database', () => ({
  getProjectDb: () => hoisted.currentDb,
}));

import { runProjectMigrations } from '../../src/main/db/migrations/project-schema';
import { SwimlaneRepository } from '../../src/main/db/repositories/swimlane-repository';
import { applyBoardConfigToDb } from '../../src/main/config/board-config/apply-config';
import type { BoardConfig, Swimlane } from '../../src/shared/types';

describe.runIf(CAN_RUN)('applyBoardConfigToDb - column delete branch (real SQLite)', () => {
  let db: InstanceType<typeof DatabaseType>;
  let repository: SwimlaneRepository;

  beforeEach(() => {
    if (!Database) return;
    db = new Database(':memory:');
    runProjectMigrations(db);
    repository = new SwimlaneRepository(db);
    hoisted.currentDb = db;
  });

  afterEach(() => {
    db?.close();
    hoisted.currentDb = null;
  });

  /**
   * Config that mirrors the current DB state 1:1 for every default lane
   * EXCEPT the caller-supplied extra custom lane, which is deliberately
   * omitted so the reconciler's ghost-or-delete branch fires for it alone.
   * Keeping every other lane's id present means only the one deletion under
   * test actually happens.
   */
  function configOmitting(defaultLanes: Swimlane[]): BoardConfig {
    return {
      version: 1,
      columns: defaultLanes.map((lane) => ({
        id: lane.id,
        name: lane.name,
        role: lane.role ?? undefined,
        permissionMode: lane.permission_mode ?? undefined,
      })),
      actions: [],
      transitions: [],
    };
  }

  it('deletes an empty column omitted from config, nulls a survivor\'s plan_exit_target_id, and removes its transitions', () => {
    const defaultLanes = repository.list();
    const planning = defaultLanes.find((lane) => lane.name === 'Planning')!;
    expect(planning).toBeDefined();

    const legacy = repository.create({ name: 'Legacy Column' });
    // Point an existing, surviving lane's plan-exit at the doomed column -
    // this is the dangling reference deleteSwimlaneRowWithReferences must null.
    repository.update({ id: planning.id, plan_exit_target_id: legacy.id });
    expect(repository.getById(planning.id)?.plan_exit_target_id).toBe(legacy.id);

    db.prepare("INSERT INTO actions (id, name, type, config_json, created_at) VALUES (?, ?, ?, ?, ?)")
      .run('action-1', 'Ping', 'webhook', '{}', '2026-01-01T00:00:00.000Z');
    db.prepare('INSERT INTO swimlane_transitions (id, from_swimlane_id, to_swimlane_id, action_id, execution_order) VALUES (?, ?, ?, ?, ?)')
      .run('transition-1', '*', legacy.id, 'action-1', 0);

    // legacy.id is deliberately absent from this config's columns.
    const config = configOmitting(defaultLanes);

    const result = applyBoardConfigToDb('project-x', config);

    // Sanity: the config must have passed validateBoardConfig (no fatal early
    // return) or every assertion below would pass vacuously against an
    // untouched DB.
    expect(result.warnings).toEqual([]);

    expect(repository.getById(legacy.id)).toBeUndefined();
    expect(repository.getById(planning.id)?.plan_exit_target_id).toBeNull();

    const remainingTransitions = db
      .prepare('SELECT COUNT(*) as count FROM swimlane_transitions WHERE from_swimlane_id = ? OR to_swimlane_id = ?')
      .get(legacy.id, legacy.id) as { count: number };
    expect(remainingTransitions.count).toBe(0);

    // Survivors (including the outer transaction's own reconciled rows) are
    // untouched - the nested transaction did not roll back or corrupt the rest.
    for (const lane of defaultLanes) {
      expect(repository.getById(lane.id), `${lane.name} should have survived reconciliation`).toBeDefined();
    }
  });

  it('ghosts (never deletes) a column omitted from config while it still holds a task, leaving its references intact', () => {
    const defaultLanes = repository.list();
    const planning = defaultLanes.find((lane) => lane.name === 'Planning')!;

    const legacy = repository.create({ name: 'Legacy Column' });
    repository.update({ id: planning.id, plan_exit_target_id: legacy.id });
    db.prepare("INSERT INTO actions (id, name, type, config_json, created_at) VALUES (?, ?, ?, ?, ?)")
      .run('action-1', 'Ping', 'webhook', '{}', '2026-01-01T00:00:00.000Z');
    db.prepare('INSERT INTO swimlane_transitions (id, from_swimlane_id, to_swimlane_id, action_id, execution_order) VALUES (?, ?, ?, ?, ?)')
      .run('transition-1', '*', legacy.id, 'action-1', 0);
    db.prepare(
      'INSERT INTO tasks (id, title, swimlane_id, position, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
    ).run('task-1', 'A task', legacy.id, 0, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');

    const config = configOmitting(defaultLanes);

    const result = applyBoardConfigToDb('project-x', config);

    expect(result.warnings).toEqual([]);

    // Ghosted, not deleted: the row survives, marked is_ghost.
    const afterApply = repository.getById(legacy.id);
    expect(afterApply).toBeDefined();
    expect(afterApply?.is_ghost).toBe(true);

    // Because the delete branch never ran, the references it would have
    // cleaned are left exactly as they were.
    expect(repository.getById(planning.id)?.plan_exit_target_id).toBe(legacy.id);
    const remainingTransitions = db
      .prepare('SELECT COUNT(*) as count FROM swimlane_transitions WHERE from_swimlane_id = ? OR to_swimlane_id = ?')
      .get(legacy.id, legacy.id) as { count: number };
    expect(remainingTransitions.count).toBe(1);
  });
});

describe.runIf(!CAN_RUN)('applyBoardConfigToDb column-delete tests (skipped)', () => {
  it('skipped - better-sqlite3 cannot load under this Node runtime (NODE_MODULE_VERSION mismatch)', () => {
    expect(CAN_RUN).toBe(false);
  });
});
