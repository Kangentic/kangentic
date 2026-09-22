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

/**
 * The subagent-attribution columns on conversation_turn_usage.
 *
 * `subagent_id` is the discriminator the whole feature rests on: NULL means a
 * main-thread turn, which is also the correct value for every row written
 * before subagent capture existed. So the migration must be a plain additive
 * ALTER that leaves existing rows alone.
 */
describe.runIf(CAN_RUN)('runProjectMigrations - conversation_turn_usage subagent columns', () => {
  let db: InstanceType<typeof DatabaseType>;

  beforeEach(() => {
    if (!Database) return;
    db = new Database(':memory:');
    runProjectMigrations(db);
  });

  afterEach(() => {
    db?.close();
  });

  it('adds the four subagent columns and the by-type index', () => {
    const columns = (db.pragma('table_info(conversation_turn_usage)') as ColumnInfo[]).map((column) => column.name);
    expect(columns).toEqual(expect.arrayContaining([
      'subagent_id', 'agent_type', 'spawn_depth', 'parent_tool_use_id',
    ]));

    const indexes = (db.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'conversation_turn_usage'",
    ).all() as Array<{ name: string }>).map((row) => row.name);
    expect(indexes).toContain('idx_turn_usage_agent_type');
  });

  it('leaves a pre-existing row as a main-thread turn (all four columns NULL)', () => {
    // A row written before the migration: the ledger's whole history looks like
    // this, and it is all main-thread by construction.
    db.prepare(`
      INSERT INTO conversation_turn_usage
        (turn_uuid, session_id, task_id, model, ts, input_tokens, output_tokens,
         cache_creation_input_tokens, cache_read_input_tokens, recorded_at)
      VALUES ('legacy-turn', 'session-1', 'task-1', 'model-x', 1000, 10, 5, 1, 2, '2026-01-01T00:00:00.000Z')
    `).run();

    expect(() => runProjectMigrations(db)).not.toThrow();

    const row = db.prepare(
      'SELECT subagent_id, agent_type, spawn_depth, parent_tool_use_id FROM conversation_turn_usage WHERE turn_uuid = ?',
    ).get('legacy-turn') as Record<string, unknown>;
    expect(row).toEqual({
      subagent_id: null, agent_type: null, spawn_depth: null, parent_tool_use_id: null,
    });
  });

  it('is idempotent: a second run adds no duplicate column', () => {
    // Without the pragma guard SQLite throws "duplicate column name", and
    // runProjectMigrations runs on every project DB open.
    expect(() => runProjectMigrations(db)).not.toThrow();

    const columns = (db.pragma('table_info(conversation_turn_usage)') as ColumnInfo[]).map((column) => column.name);
    for (const name of ['subagent_id', 'agent_type', 'spawn_depth', 'parent_tool_use_id']) {
      expect(columns.filter((column) => column === name)).toHaveLength(1);
    }
  });
});

/**
 * Migration: usage_history's total_cost_usd / total_duration_ms convert from
 * CUMULATIVE-PER-CONVERSATION agent readings into PER-LEG DELTAS
 * (hasUsageHistoryConversationId in project-schema.ts).
 *
 * The agent reports both columns as a running total for the whole
 * conversation, but each `--resume` leg is its own sessions row and therefore
 * its own usage_history row, so a flat SUM across a conversation's legs
 * counted the running total once per leg. This migration adds
 * conversation_id (backfilled from sessions.agent_session_id) and the raw
 * cumulative_cost_usd / cumulative_duration_ms columns, then rewrites
 * total_cost_usd / total_duration_ms to per-leg deltas via
 * LINEAGE_DELTA_SET_SQL (imported by project-schema.ts from
 * usage-history-repository.ts) so a flat SUM is correct again.
 *
 * The fixture reverts usage_history to the exact pre-migration shape at
 * project-schema.ts:81-100 (agent/effort already present, no lineage
 * columns), the same pattern the describe block above uses for its own
 * migration.
 */
describe.runIf(CAN_RUN)('runProjectMigrations - usage_history conversation lineage deltas', () => {
  let db: InstanceType<typeof DatabaseType>;

  /**
   * Reverts the usage_history table (created fully-modern by a prior
   * runProjectMigrations() call) back to its pre-lineage shape - the exact
   * CREATE TABLE at project-schema.ts:81-100, which already carries agent and
   * effort but not conversation_id / cumulative_cost_usd / cumulative_duration_ms.
   */
  function revertUsageHistoryToPreLineageShape(database: InstanceType<typeof DatabaseType>): void {
    database.exec(`
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
        compaction_count INTEGER NOT NULL DEFAULT 0,
        agent TEXT,
        effort TEXT
      );
      DROP TABLE usage_history_modern_temp;
    `);
  }

  /** Inserts a minimal task row so a session's task_id foreign key resolves. */
  function insertTask(taskId: string): void {
    const swimlaneId = (db.prepare('SELECT id FROM swimlanes LIMIT 1').get() as { id: string }).id;
    const nowIso = new Date().toISOString();
    db.prepare(`
      INSERT INTO tasks (id, title, swimlane_id, position, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(taskId, taskId, swimlaneId, 0, nowIso, nowIso);
  }

  /**
   * Inserts a session row. Two sessions sharing the same agentSessionId
   * simulate two `--resume` legs of one conversation, the case the migration
   * backfills conversation_id for.
   */
  function insertSession(
    sessionRecordId: string,
    taskId: string,
    agentSessionId: string | null,
    sessionStartedAt: string,
  ): void {
    db.prepare(`
      INSERT INTO sessions (id, task_id, session_type, agent_session_id, command, cwd, started_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(sessionRecordId, taskId, 'agent', agentSessionId, 'claude', '/mock/project', sessionStartedAt);
  }

  /** Inserts a pre-migration-shape usage_history row - no lineage columns yet. */
  function insertLegacyUsageHistoryRow(
    id: string,
    sessionRecordId: string,
    sessionStartedAt: string,
    totalCostUsd: number,
    totalDurationMs: number | null,
  ): void {
    const nowIso = new Date().toISOString();
    db.prepare(`
      INSERT INTO usage_history
        (id, session_record_id, recorded_at, session_started_at, total_cost_usd, total_duration_ms)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(id, sessionRecordId, nowIso, sessionStartedAt, totalCostUsd, totalDurationMs);
  }

  beforeEach(() => {
    if (!Database) return;
    db = new Database(':memory:');
    // Bootstrap a fully modern schema (tasks, sessions, swimlanes) via one real
    // migration pass, then revert ONLY usage_history to its pre-lineage shape.
    runProjectMigrations(db);
    revertUsageHistoryToPreLineageShape(db);
  });

  afterEach(() => {
    db?.close();
  });

  it('adds conversation_id, cumulative_cost_usd, cumulative_duration_ms and the conversation index', () => {
    const columnsBeforeMigration = (db.pragma('table_info(usage_history)') as ColumnInfo[]).map((column) => column.name);
    expect(columnsBeforeMigration).not.toContain('conversation_id');
    expect(columnsBeforeMigration).not.toContain('cumulative_cost_usd');
    expect(columnsBeforeMigration).not.toContain('cumulative_duration_ms');

    runProjectMigrations(db);

    const columnsAfterMigration = (db.pragma('table_info(usage_history)') as ColumnInfo[]).map((column) => column.name);
    expect(columnsAfterMigration).toContain('conversation_id');
    expect(columnsAfterMigration).toContain('cumulative_cost_usd');
    expect(columnsAfterMigration).toContain('cumulative_duration_ms');

    const indexes = (db.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'usage_history'",
    ).all() as Array<{ name: string }>).map((row) => row.name);
    expect(indexes).toContain('idx_usage_history_conversation');
  });

  it('preserves the pre-migration raw reading in cumulative_cost_usd and cumulative_duration_ms', () => {
    insertTask('task-lineage-preserve-1');
    insertSession('session-lineage-preserve-1', 'task-lineage-preserve-1', 'conv-preserve-1', '2026-01-01T00:00:00.000Z');
    insertLegacyUsageHistoryRow('usage-lineage-preserve-1', 'session-lineage-preserve-1', '2026-01-01T00:00:00.000Z', 12.34, 5000);

    runProjectMigrations(db);

    const row = db.prepare(
      'SELECT cumulative_cost_usd, cumulative_duration_ms FROM usage_history WHERE id = ?',
    ).get('usage-lineage-preserve-1') as { cumulative_cost_usd: number | null; cumulative_duration_ms: number | null };

    expect(row.cumulative_cost_usd).toBeCloseTo(12.34, 5);
    expect(row.cumulative_duration_ms).toBe(5000);
  });

  it('rewrites a multi-leg conversation so total_cost_usd sums to the LAST cumulative reading, not the sum of readings', () => {
    insertTask('task-lineage-multileg-1');
    insertSession('session-lineage-leg-1', 'task-lineage-multileg-1', 'conv-multileg-1', '2026-01-01T00:00:00.000Z');
    insertSession('session-lineage-leg-2', 'task-lineage-multileg-1', 'conv-multileg-1', '2026-01-01T01:00:00.000Z');
    insertSession('session-lineage-leg-3', 'task-lineage-multileg-1', 'conv-multileg-1', '2026-01-01T02:00:00.000Z');

    // Cumulative-per-conversation readings as the agent reports them: each
    // leg's reading already includes everything the earlier legs spent.
    insertLegacyUsageHistoryRow('usage-lineage-leg-1', 'session-lineage-leg-1', '2026-01-01T00:00:00.000Z', 10, null);
    insertLegacyUsageHistoryRow('usage-lineage-leg-2', 'session-lineage-leg-2', '2026-01-01T01:00:00.000Z', 25, null);
    insertLegacyUsageHistoryRow('usage-lineage-leg-3', 'session-lineage-leg-3', '2026-01-01T02:00:00.000Z', 42.5, null);

    runProjectMigrations(db);

    const rows = db.prepare(`
      SELECT session_record_id, total_cost_usd FROM usage_history
       WHERE session_record_id IN (?, ?, ?)
       ORDER BY session_started_at ASC
    `).all('session-lineage-leg-1', 'session-lineage-leg-2', 'session-lineage-leg-3') as Array<{
      session_record_id: string;
      total_cost_usd: number;
    }>;

    // Each leg's delta against the highest PRIOR reading of the same lineage.
    expect(rows[0].total_cost_usd).toBe(10);
    expect(rows[1].total_cost_usd).toBe(15);
    expect(rows[2].total_cost_usd).toBe(17.5);

    const summedDeltas = rows.reduce((runningTotal, row) => runningTotal + row.total_cost_usd, 0);
    // The bug this migration fixes: summing the raw cumulative readings would
    // give 10 + 25 + 42.5 = 77.5. The per-leg deltas must sum to the LAST
    // reading of the lineage instead.
    expect(summedDeltas).toBe(42.5);
  });

  it('leaves conversation_id NULL and total_cost_usd unchanged for a row whose sessions row is gone', () => {
    // No task/session inserted for this session_record_id - it references a
    // sessions row that no longer exists.
    insertLegacyUsageHistoryRow('usage-lineage-orphan-1', 'session-deleted-long-ago', '2026-01-01T00:00:00.000Z', 3.75, 4000);

    runProjectMigrations(db);

    const row = db.prepare(
      'SELECT conversation_id, total_cost_usd, total_duration_ms FROM usage_history WHERE id = ?',
    ).get('usage-lineage-orphan-1') as { conversation_id: string | null; total_cost_usd: number; total_duration_ms: number | null };

    expect(row.conversation_id).toBeNull();
    expect(row.total_cost_usd).toBeCloseTo(3.75, 5);
    expect(row.total_duration_ms).toBe(4000);
  });

  it('keeps a NULL total_duration_ms as NULL instead of becoming 0', () => {
    insertTask('task-lineage-null-duration-1');
    insertSession('session-lineage-null-duration-1', 'task-lineage-null-duration-1', 'conv-null-duration-1', '2026-01-01T00:00:00.000Z');
    insertLegacyUsageHistoryRow('usage-lineage-null-duration-1', 'session-lineage-null-duration-1', '2026-01-01T00:00:00.000Z', 1, null);

    runProjectMigrations(db);

    const row = db.prepare(
      'SELECT conversation_id, total_duration_ms, cumulative_duration_ms FROM usage_history WHERE id = ?',
    ).get('usage-lineage-null-duration-1') as {
      conversation_id: string | null;
      total_duration_ms: number | null;
      cumulative_duration_ms: number | null;
    };

    // Sanity check on the fixture: this row DOES have a resolvable
    // conversation_id, so it goes through the LINEAGE_DELTA_SET_SQL rewrite
    // rather than being skipped by the `WHERE conversation_id IS NOT NULL`
    // guard - the NULL must survive the CASE WHEN branch inside the rewrite.
    expect(row.conversation_id).toBe('conv-null-duration-1');
    expect(row.cumulative_duration_ms).toBeNull();
    expect(row.total_duration_ms).toBeNull();
  });

  it('running the migration a second time leaves the already-rewritten values unchanged', () => {
    insertTask('task-lineage-idempotent-1');
    insertSession('session-lineage-idempotent-1', 'task-lineage-idempotent-1', 'conv-idempotent-1', '2026-01-01T00:00:00.000Z');
    insertSession('session-lineage-idempotent-2', 'task-lineage-idempotent-1', 'conv-idempotent-1', '2026-01-01T01:00:00.000Z');
    insertLegacyUsageHistoryRow('usage-lineage-idempotent-1', 'session-lineage-idempotent-1', '2026-01-01T00:00:00.000Z', 8, 1000);
    insertLegacyUsageHistoryRow('usage-lineage-idempotent-2', 'session-lineage-idempotent-2', '2026-01-01T01:00:00.000Z', 20, 3000);

    interface LineageRow {
      id: string;
      conversation_id: string | null;
      total_cost_usd: number;
      total_duration_ms: number | null;
      cumulative_cost_usd: number | null;
      cumulative_duration_ms: number | null;
    }
    const selectRows = (): LineageRow[] => db.prepare(`
      SELECT id, conversation_id, total_cost_usd, total_duration_ms, cumulative_cost_usd, cumulative_duration_ms
        FROM usage_history
       WHERE id IN (?, ?)
       ORDER BY id
    `).all('usage-lineage-idempotent-1', 'usage-lineage-idempotent-2') as LineageRow[];

    // First call after the revert - performs the ALTER, the backfill and the
    // delta rewrite (the migration under test).
    runProjectMigrations(db);
    const rowsAfterFirstRun = selectRows();

    // Second call - the pragma guard must see conversation_id already exists
    // and skip the whole block. Without the guard the rewrite would re-run
    // against the ALREADY-DELTA'd total_cost_usd / total_duration_ms values,
    // silently deltaing an already-rewritten number a second time.
    expect(() => runProjectMigrations(db)).not.toThrow();
    const rowsAfterSecondRun = selectRows();

    expect(rowsAfterSecondRun).toEqual(rowsAfterFirstRun);
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
