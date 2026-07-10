/**
 * Unit tests for the usage_history agent/effort migration in
 * runProjectMigrations (src/main/db/migrations/project-schema.ts).
 *
 * Pins three behaviors added for the agent/effort usage-dashboard breakdown:
 *   1. Upgrade path + backfill: an existing usage_history table that predates
 *      the agent/effort columns gets them added via ALTER TABLE, and existing
 *      rows are backfilled from sessions/tasks (agent from tasks.agent via
 *      sessions.task_id, effort from sessions.applied_effort), joined on
 *      usage_history.session_record_id = sessions.id.
 *   2. A usage_history row whose session_record_id has no surviving
 *      sessions/tasks row is left with agent = NULL, effort = NULL (the
 *      documented "(unknown)" / "(default)" render case) rather than
 *      erroring or resolving to some other value.
 *   3. Idempotency: running the migration again after the columns already
 *      exist does not throw ("duplicate column name") and does not corrupt
 *      the already-backfilled values.
 *
 * Uses a real in-memory better-sqlite3 DB (':memory:'). The fixture bootstraps
 * a fully modern schema via one real runProjectMigrations() call (so
 * tasks/sessions/swimlanes match production exactly instead of a
 * hand-maintained schema copy that could drift), then surgically reverts
 * ONLY usage_history to its pre-migration shape (the exact CREATE TABLE from
 * before this PR - no agent/effort columns) to simulate an existing
 * installation about to receive the new migration. The migration-under-test
 * is the runProjectMigrations() call made AFTER that revert.
 *
 * Skips cleanly when better-sqlite3 cannot load under the test runner's Node
 * ABI (NODE_MODULE_VERSION mismatch under plain system Node); mirrors the
 * probe pattern in swimlane-repository.test.ts.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type DatabaseType from 'better-sqlite3';

// ---------------------------------------------------------------------------
// ABI probe - mirrors swimlane-repository.test.ts.
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
// Imports (always resolved - 'import type' for better-sqlite3 touches no
// native binding at module load time).
// ---------------------------------------------------------------------------

import { runProjectMigrations } from '../../src/main/db/migrations/project-schema';

interface ColumnInfo {
  name: string;
}

interface UsageHistoryAgentEffortRow {
  session_record_id: string;
  agent: string | null;
  effort: string | null;
}

/**
 * Reverts the usage_history table (created fully-modern by a prior
 * runProjectMigrations() call) back to its pre-agent/effort shape - the
 * exact CREATE TABLE that existed before this migration was added. Tests
 * call this immediately after bootstrap, before inserting any fixture rows,
 * so there is nothing to preserve across the swap.
 */
function revertUsageHistoryToPreMigrationShape(db: InstanceType<typeof DatabaseType>): void {
  db.exec(`
    ALTER TABLE usage_history RENAME TO usage_history_modern_temp;
    CREATE TABLE usage_history (
      id TEXT PRIMARY KEY,
      session_record_id TEXT NOT NULL UNIQUE,
      recorded_at TEXT NOT NULL,
      session_started_at TEXT NOT NULL,
      session_type TEXT,
      total_cost_usd REAL NOT NULL,
      total_input_tokens INTEGER NOT NULL DEFAULT 0,
      total_output_tokens INTEGER NOT NULL DEFAULT 0,
      total_duration_ms INTEGER,
      tool_call_count INTEGER NOT NULL DEFAULT 0,
      model_id TEXT,
      model_display_name TEXT,
      lines_added INTEGER NOT NULL DEFAULT 0,
      lines_removed INTEGER NOT NULL DEFAULT 0,
      files_changed INTEGER NOT NULL DEFAULT 0,
      compaction_count INTEGER NOT NULL DEFAULT 0
    );
    DROP TABLE usage_history_modern_temp;
  `);
}

// ---------------------------------------------------------------------------
// Migration tests against a real in-memory SQLite DB.
// ---------------------------------------------------------------------------

describe.runIf(CAN_RUN)('runProjectMigrations - usage_history agent/effort migration', () => {
  let db: InstanceType<typeof DatabaseType>;

  beforeEach(() => {
    if (!Database) return;
    db = new Database(':memory:');
    // Bootstrap a fully modern schema (tasks, sessions, swimlanes, and a
    // usage_history table that starts with agent/effort via the fresh-DB
    // CREATE TABLE path) via one real migration pass.
    runProjectMigrations(db);
    // Simulate an existing installation: usage_history predates agent/effort.
    revertUsageHistoryToPreMigrationShape(db);
  });

  afterEach(() => {
    db?.close();
  });

  it('adds agent/effort columns and backfills an existing row from sessions/tasks', () => {
    const swimlaneId = (db.prepare('SELECT id FROM swimlanes LIMIT 1').get() as { id: string }).id;
    const nowIso = new Date().toISOString();

    db.prepare(`
      INSERT INTO tasks (id, title, swimlane_id, position, agent, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run('task-codex-1', 'Codex task', swimlaneId, 0, 'codex', nowIso, nowIso);

    db.prepare(`
      INSERT INTO sessions (id, task_id, session_type, command, cwd, started_at, applied_effort)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run('session-codex-1', 'task-codex-1', 'agent', 'codex', '/mock/project', nowIso, 'high');

    // Pre-migration usage_history row - no agent/effort columns to supply,
    // the table was just reverted to the old shape.
    db.prepare(`
      INSERT INTO usage_history
        (id, session_record_id, recorded_at, session_started_at, total_cost_usd)
      VALUES (?, ?, ?, ?, ?)
    `).run('usage-history-1', 'session-codex-1', nowIso, nowIso, 0.5);

    // Sanity check on the fixture itself: confirm the pre-migration shape
    // really lacks the columns, so a false pass below can't hide a fixture bug.
    const columnsBeforeMigration = (db.pragma('table_info(usage_history)') as ColumnInfo[]).map((c) => c.name);
    expect(columnsBeforeMigration).not.toContain('agent');
    expect(columnsBeforeMigration).not.toContain('effort');

    // The migration under test.
    runProjectMigrations(db);

    const columnsAfterMigration = (db.pragma('table_info(usage_history)') as ColumnInfo[]).map((c) => c.name);
    expect(columnsAfterMigration).toContain('agent');
    expect(columnsAfterMigration).toContain('effort');

    const row = db.prepare(
      'SELECT session_record_id, agent, effort FROM usage_history WHERE id = ?',
    ).get('usage-history-1') as UsageHistoryAgentEffortRow;

    expect(row.agent).toBe('codex');
    expect(row.effort).toBe('high');
  });

  it('leaves agent/effort NULL for a usage_history row whose session no longer exists', () => {
    const nowIso = new Date().toISOString();

    // No matching sessions/tasks row exists for this session_record_id -
    // the documented "(unknown)" / "(default)" case.
    db.prepare(`
      INSERT INTO usage_history
        (id, session_record_id, recorded_at, session_started_at, total_cost_usd)
      VALUES (?, ?, ?, ?, ?)
    `).run('usage-history-orphan-1', 'session-deleted-long-ago', nowIso, nowIso, 0.1);

    runProjectMigrations(db);

    const row = db.prepare(
      'SELECT session_record_id, agent, effort FROM usage_history WHERE id = ?',
    ).get('usage-history-orphan-1') as UsageHistoryAgentEffortRow;

    expect(row.agent).toBeNull();
    expect(row.effort).toBeNull();
  });

  it('running the migration again does not throw and does not corrupt the backfilled values', () => {
    const swimlaneId = (db.prepare('SELECT id FROM swimlanes LIMIT 1').get() as { id: string }).id;
    const nowIso = new Date().toISOString();

    db.prepare(`
      INSERT INTO tasks (id, title, swimlane_id, position, agent, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run('task-codex-2', 'Codex task 2', swimlaneId, 0, 'codex', nowIso, nowIso);

    db.prepare(`
      INSERT INTO sessions (id, task_id, session_type, command, cwd, started_at, applied_effort)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run('session-codex-2', 'task-codex-2', 'agent', 'codex', '/mock/project', nowIso, 'high');

    db.prepare(`
      INSERT INTO usage_history
        (id, session_record_id, recorded_at, session_started_at, total_cost_usd)
      VALUES (?, ?, ?, ?, ?)
    `).run('usage-history-2', 'session-codex-2', nowIso, nowIso, 0.75);

    // First call after the revert - performs the ALTER + backfill (the
    // migration under test).
    runProjectMigrations(db);

    const rowAfterFirstRun = db.prepare(
      'SELECT agent, effort FROM usage_history WHERE id = ?',
    ).get('usage-history-2') as UsageHistoryAgentEffortRow;
    expect(rowAfterFirstRun.agent).toBe('codex');
    expect(rowAfterFirstRun.effort).toBe('high');

    // Second call - the pragma guard must see agent/effort already exist and
    // skip the ALTER TABLE. Without the guard SQLite throws "duplicate
    // column name: agent".
    expect(() => runProjectMigrations(db)).not.toThrow();

    const columnsAfterSecondRun = (db.pragma('table_info(usage_history)') as ColumnInfo[]).map((c) => c.name);
    expect(columnsAfterSecondRun.filter((name) => name === 'agent')).toHaveLength(1);
    expect(columnsAfterSecondRun.filter((name) => name === 'effort')).toHaveLength(1);

    const rowAfterSecondRun = db.prepare(
      'SELECT agent, effort FROM usage_history WHERE id = ?',
    ).get('usage-history-2') as UsageHistoryAgentEffortRow;
    expect(rowAfterSecondRun.agent).toBe('codex');
    expect(rowAfterSecondRun.effort).toBe('high');
  });
});

// ---------------------------------------------------------------------------
// Skip-notice for environments where better-sqlite3 cannot load.
// ---------------------------------------------------------------------------

describe.runIf(!CAN_RUN)('usage_history agent/effort migration tests (skipped)', () => {
  it('skipped - better-sqlite3 cannot load under this Node runtime (NODE_MODULE_VERSION mismatch)', () => {
    expect(CAN_RUN).toBe(false);
  });
});
