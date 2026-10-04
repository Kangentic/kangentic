/**
 * Migration + real-SQL round-trip tests for the `session_activity_intervals`
 * table (src/main/db/migrations/project-schema.ts) and the
 * ActivityIntervalStore that reads/writes it
 * (src/main/activity-engine/activity-interval-store.ts).
 *
 * tests/unit/activity-interval-store.test.ts and
 * tests/unit/activity-interval-commands.test.ts both drive the store against
 * a hand-rolled FAKE Database that dispatches on SQL substring and
 * reimplements the arithmetic (duration_ms = endedMs - startedMs) in
 * JavaScript. Neither ever executes the real CREATE TABLE or the real
 * `duration_ms = ? - started_ms` SQL expression, so a column-name typo in the
 * migration, a mismatch between the migration's columns and the store's
 * INSERT/SELECT column lists, or deleting the CREATE TABLE block entirely
 * would leave every existing test green.
 *
 * This file closes that gap: it runs the REAL migration against a REAL
 * in-memory better-sqlite3 database and round-trips through the REAL store.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { runProjectMigrations } from '../../src/main/db/migrations/project-schema';
import { ActivityIntervalStore, type OpenIntervalInput } from '../../src/main/activity-engine/activity-interval-store';

interface TableColumnInfo {
  name: string;
  notnull: number;
}

interface IndexNameRow {
  name: string;
}

const EXPECTED_COLUMNS: Array<{ name: string; notnull: number }> = [
  { name: 'id', notnull: 0 },
  { name: 'session_id', notnull: 1 },
  { name: 'task_id', notnull: 0 },
  { name: 'disposition', notnull: 1 },
  { name: 'state', notnull: 1 },
  { name: 'previous_state', notnull: 1 },
  { name: 'enter_trigger', notnull: 1 },
  { name: 'started_ms', notnull: 1 },
  { name: 'started_at', notnull: 1 },
  { name: 'ended_ms', notnull: 0 },
  { name: 'ended_at', notnull: 0 },
  { name: 'duration_ms', notnull: 0 },
  { name: 'exit_trigger', notnull: 0 },
  { name: 'recorded_at', notnull: 1 },
];

const EXPECTED_INDEXES = [
  'idx_activity_intervals_task',
  'idx_activity_intervals_session',
  'idx_activity_intervals_started',
  'idx_activity_intervals_open',
].sort();

function indexNamesForTable(db: Database.Database, tableName: string): string[] {
  const rows = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = ?")
    .all(tableName) as IndexNameRow[];
  return rows.map((row) => row.name).sort();
}

function idleInput(overrides: Partial<OpenIntervalInput> = {}): OpenIntervalInput {
  return {
    sessionId: 'session-1',
    taskId: 'task-1',
    disposition: 'idle',
    state: 'idle',
    previousState: 'thinking',
    enterTrigger: 'event:idle',
    startedMs: 1_000,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Migration + real-store tests against a real in-memory SQLite DB.
// ---------------------------------------------------------------------------

describe('runProjectMigrations - session_activity_intervals', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    runProjectMigrations(db);
  });

  afterEach(() => {
    db?.close();
  });

  it('creates session_activity_intervals with exactly the expected columns and notnull flags', () => {
    const columns = (db.pragma('table_info(session_activity_intervals)') as TableColumnInfo[]).map((column) => ({
      name: column.name,
      notnull: column.notnull,
    }));

    expect(columns).toEqual(EXPECTED_COLUMNS);
  });

  it('creates all four documented indexes', () => {
    const indexNames = indexNamesForTable(db, 'session_activity_intervals');
    expect(indexNames).toEqual(EXPECTED_INDEXES);
  });

  it('running the migration a second time does not throw and leaves the schema unchanged', () => {
    const columnsBeforeSecondRun = db.pragma('table_info(session_activity_intervals)') as TableColumnInfo[];
    const indexesBeforeSecondRun = indexNamesForTable(db, 'session_activity_intervals');

    expect(() => runProjectMigrations(db)).not.toThrow();

    const columnsAfterSecondRun = db.pragma('table_info(session_activity_intervals)') as TableColumnInfo[];
    const indexesAfterSecondRun = indexNamesForTable(db, 'session_activity_intervals');

    expect(columnsAfterSecondRun).toEqual(columnsBeforeSecondRun);
    expect(indexesAfterSecondRun).toEqual(indexesBeforeSecondRun);
  });

  it('round-trips openInterval + closeOpenInterval through the real store, computing duration_ms via real SQL', () => {
    const store = new ActivityIntervalStore(db);
    const startedMs = 10_000;
    const endedMs = 14_500;

    store.openInterval(idleInput({ startedMs }), '2026-07-22T00:00:00.000Z');
    const openRow = db
      .prepare('SELECT * FROM session_activity_intervals WHERE session_id = ?')
      .get('session-1') as Record<string, unknown>;
    expect(openRow.ended_ms).toBeNull();
    expect(openRow.duration_ms).toBeNull();
    expect(openRow.started_at).toBe(new Date(startedMs).toISOString());

    store.closeOpenInterval('session-1', endedMs, 'event:prompt');

    const closedRows = store.getForSession('session-1');
    expect(closedRows).toHaveLength(1);
    const closedInterval = closedRows[0];
    // The real SQL expression `duration_ms = ? - started_ms` computed this,
    // not JavaScript arithmetic in the test - this is exactly the drift class
    // (migration column name vs store SQL column name) this file exists to catch.
    expect(closedInterval.durationMs).toBe(endedMs - startedMs);
    expect(closedInterval.endedMs).toBe(endedMs);
    expect(closedInterval.endedAt).toBe(new Date(endedMs).toISOString());
    expect(closedInterval.startedAt).toBe(new Date(startedMs).toISOString());
    expect(closedInterval.exitTrigger).toBe('event:prompt');
  });

  it('closeOpenInterval is a genuine no-op against real SQL when no interval is open', () => {
    const store = new ActivityIntervalStore(db);

    const countBefore = (
      db.prepare('SELECT COUNT(*) as count FROM session_activity_intervals').get() as { count: number }
    ).count;
    expect(countBefore).toBe(0);

    expect(() => store.closeOpenInterval('session-1', 5_000, 'event:prompt')).not.toThrow();

    const countAfter = (
      db.prepare('SELECT COUNT(*) as count FROM session_activity_intervals').get() as { count: number }
    ).count;
    expect(countAfter).toBe(0);
  });

  it('getForTask and getForSession return real ORDER BY started_ms ASC (oldest first)', () => {
    const store = new ActivityIntervalStore(db);

    // Insert out of chronological order to prove the ordering comes from the
    // real SQL ORDER BY, not incidental insertion order.
    store.openInterval(idleInput({ sessionId: 'session-1', taskId: 'task-1', startedMs: 5_000 }), '2026-07-22T00:00:00.000Z');
    store.closeOpenInterval('session-1', 6_000, 'event:prompt');
    store.openInterval(idleInput({ sessionId: 'session-2', taskId: 'task-1', startedMs: 1_000 }), '2026-07-22T00:00:00.000Z');
    store.closeOpenInterval('session-2', 2_000, 'event:prompt');
    store.openInterval(idleInput({ sessionId: 'session-1', taskId: 'task-1', startedMs: 3_000 }), '2026-07-22T00:00:00.000Z');

    const taskIntervals = store.getForTask('task-1');
    expect(taskIntervals.map((interval) => interval.startedMs)).toEqual([1_000, 3_000, 5_000]);

    const sessionOneIntervals = store.getForSession('session-1');
    expect(sessionOneIntervals.map((interval) => interval.startedMs)).toEqual([3_000, 5_000]);
  });
});
