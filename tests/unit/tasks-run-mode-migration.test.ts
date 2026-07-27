/**
 * Migration + real-SQL tests for the `tasks.run_mode` column
 * (src/main/db/migrations/project-schema.ts).
 *
 * The rest of the run_mode suite (task-repository.test.ts,
 * spawn-agent-lock-overrides.test.ts) drives mocked SQL, so it would stay green
 * if the ALTER TABLE were missing, the default were wrong, or the backfill
 * never ran. That last one is the dangerous case: the backfill is what makes
 * this migration behavior-preserving. It has to reproduce the old
 * `hasAnyOverrideSet` derivation exactly - any of the four Advanced pins set
 * means the task was authored in override mode - or every already-pinned task
 * on an upgraded board silently stops locking at first spawn.
 *
 * Backfill coverage needs a pre-migration table shape, which is built by
 * running the migration, dropping the new column, seeding rows, and running it
 * again. `ALTER TABLE ... DROP COLUMN` requires SQLite 3.35 or newer (bundled
 * better-sqlite3 is well past that); if this file ever fails on a
 * "near DROP: syntax error", that floor is why.
 *
 * Skips cleanly when better-sqlite3 cannot load under the test runner's Node
 * ABI (NODE_MODULE_VERSION mismatch under plain system Node); mirrors the probe
 * pattern in sent-session-message-migration.test.ts. Expected to SKIP on a
 * developer's local Windows machine (built for Electron's ABI) and RUN on CI
 * (built for plain Node) - a local green here is a skip, not coverage.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type DatabaseType from 'better-sqlite3';

// ---------------------------------------------------------------------------
// ABI probe - mirrors sent-session-message-migration.test.ts.
// ---------------------------------------------------------------------------

function probeBetterSqlite3(): typeof DatabaseType | null {
  try {
    // Variable module name avoids the static-require lint rule, which targets
    // string-literal bare requires in bundled main/preload code; this is a test
    // helper for a native probe, not a bundled require.
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

import { runProjectMigrations } from '../../src/main/db/migrations/project-schema';

interface TableColumnInfo {
  name: string;
  notnull: number;
  dflt_value: string | null;
}

describe.skipIf(!CAN_RUN)('tasks.run_mode migration', () => {
  let database: DatabaseType.Database;

  beforeEach(() => {
    database = new Database!(':memory:');
    database.pragma('foreign_keys = ON');
    runProjectMigrations(database);
  });

  afterEach(() => {
    database.close();
  });

  function runModeColumn(): TableColumnInfo | undefined {
    return (database.pragma('table_info(tasks)') as TableColumnInfo[])
      .find((column) => column.name === 'run_mode');
  }

  /** The first lane the seed created, so seeded rows satisfy swimlane_id. */
  function anyLaneId(): string {
    return (database.prepare('SELECT id FROM swimlanes LIMIT 1').get() as { id: string }).id;
  }

  it('adds run_mode as NOT NULL defaulting to column_settings', () => {
    const column = runModeColumn();

    expect(column).toBeDefined();
    expect(column!.notnull).toBe(1);
    // The default is what an INSERT that predates this column relies on, so it
    // has to be the safe half of the pair (never lock).
    expect(column!.dflt_value).toContain('column_settings');
  });

  it('is idempotent across repeated runs (the app migrates on every project open)', () => {
    expect(() => runProjectMigrations(database)).not.toThrow();
    expect(() => runProjectMigrations(database)).not.toThrow();

    const runModeColumns = (database.pragma('table_info(tasks)') as TableColumnInfo[])
      .filter((column) => column.name === 'run_mode');
    expect(runModeColumns).toHaveLength(1);
  });

  it('does not disturb an existing run_mode value on a re-run', () => {
    const laneId = anyLaneId();
    database.prepare(
      `INSERT INTO tasks (id, title, description, swimlane_id, position, run_mode, created_at, updated_at)
       VALUES ('t-keep', 'Keep', '', ?, 0, 'agent_override', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`,
    ).run(laneId);

    runProjectMigrations(database);

    const row = database.prepare("SELECT run_mode FROM tasks WHERE id = 't-keep'").get() as { run_mode: string };
    expect(row.run_mode).toBe('agent_override');
  });

  describe('backfill of pre-existing rows', () => {
    /**
     * Rebuild the pre-migration state: drop the column the migration adds, seed
     * rows as they would have looked, then let the migration add and backfill
     * it. This is the only way to exercise the UPDATE, since a fresh database
     * runs every migration before any row exists.
     */
    function seedPreMigrationRowsAndRemigrate(): void {
      database.exec('ALTER TABLE tasks DROP COLUMN run_mode');
      const laneId = anyLaneId();
      const insert = database.prepare(
        `INSERT INTO tasks (id, title, description, swimlane_id, position,
           agent_override, model_override, effort_override, permission_mode, auto_command, profile_id,
           created_at, updated_at)
         VALUES (?, ?, '', ?, ?, ?, ?, ?, ?, ?, ?, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`,
      );
      // id, position, agent, model, effort, permission, auto_command, profile
      insert.run('t-bare', 'Bare', laneId, 0, null, null, null, null, null, null);
      insert.run('t-agent', 'Agent pin', laneId, 1, 'codex', null, null, null, null, null);
      insert.run('t-model', 'Model pin', laneId, 2, null, 'fable-5', null, null, null, null);
      insert.run('t-effort', 'Effort pin', laneId, 3, null, null, 'xhigh', null, null, null);
      insert.run('t-permission', 'Permission pin', laneId, 4, null, null, null, 'plan', null, null);
      insert.run('t-profile', 'Profile task', laneId, 5, null, null, null, null, null, 'profile-1');
      insert.run('t-auto-command', 'Auto command only', laneId, 6, null, null, null, null, '/code-review', null);
      // Not reachable through TaskRepository (exclusivity has been enforced
      // since profile_id shipped), seeded to prove the backfill does not depend
      // on that invariant holding in a hand-edited or future-drifted database.
      insert.run('t-profile-and-pin', 'Contradictory', laneId, 7, null, 'fable-5', null, null, null, 'profile-1');

      runProjectMigrations(database);
    }

    function runModeOf(taskId: string): string {
      const row = database.prepare('SELECT run_mode FROM tasks WHERE id = ?').get(taskId) as { run_mode: string };
      return row.run_mode;
    }

    beforeEach(() => {
      seedPreMigrationRowsAndRemigrate();
    });

    it('marks every task carrying an Advanced pin as agent_override', () => {
      // Exactly the old `hasAnyOverrideSet` set, so these rows keep locking at
      // first spawn just as they did before the column existed.
      expect(runModeOf('t-agent')).toBe('agent_override');
      expect(runModeOf('t-model')).toBe('agent_override');
      expect(runModeOf('t-effort')).toBe('agent_override');
      expect(runModeOf('t-permission')).toBe('agent_override');
    });

    it('leaves a task with no pins on column_settings', () => {
      expect(runModeOf('t-bare')).toBe('column_settings');
    });

    it('leaves a profile task on column_settings', () => {
      // A profile task carries no pins by construction, so it must not be
      // swept into override mode - that would freeze its ladder at column 1.
      expect(runModeOf('t-profile')).toBe('column_settings');
    });

    it('never produces a row claiming both a profile and override mode', () => {
      // The one state the first-spawn lock must never see. The backfill's
      // `profile_id IS NULL` clause is what guarantees it, rather than relying
      // on TaskRepository's exclusivity having held for every historical write.
      expect(runModeOf('t-profile-and-pin')).toBe('column_settings');
    });

    it('does not treat auto_command as an Advanced pin', () => {
      // auto_command is an MCP escape hatch, deliberately outside the pin set
      // (ADVANCED_PIN_FIELDS in task-repository.ts). Including it in the
      // backfill would start locking tasks that never locked before.
      expect(runModeOf('t-auto-command')).toBe('column_settings');
    });
  });
});
