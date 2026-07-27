/**
 * Unit tests for TaskRepository SQL contracts.
 *
 * better-sqlite3 is compiled for Electron's Node ABI and cannot load under
 * vitest's system Node. Tests use a mock-database that records the SQL
 * prepared by each method and verifies the WHERE-clause contracts without
 * executing real SQLite queries.
 *
 * Covered here:
 *   - listAllInSwimlane: must NOT filter by archived_at (returns ALL tasks in
 *     the swimlane regardless of archival state)
 *   - list(swimlaneId): MUST filter by archived_at IS NULL (active-only)
 *   - Contrast between the two confirms the regression guard: a future edit
 *     that accidentally adds `AND archived_at IS NULL` to listAllInSwimlane
 *     would break the Done-cleanup retry pass (tasks are archived synchronously
 *     on move to Done, so the retry pass would never see them via `list`).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TaskRepository } from '../../src/main/db/repositories/task-repository';
import type Database from 'better-sqlite3';

/** Recorded prepare call with the SQL and arguments passed to run/get/all. */
interface PreparedStatement {
  sql: string;
  args: unknown[];
}

/**
 * Creates a minimal mock of better-sqlite3's Database interface.
 *
 * Every `prepare(sql)` call appends a new PreparedStatement entry.
 * The returned statement object records the positional args from run/get/all
 * into that same entry so callers can assert on both SQL text and bindings.
 *
 * `setExistingRow` seeds the row `getById` (and therefore `update()` /
 * `updateOverrides()`, which both call it internally) returns. Additive and
 * backward-compatible: when unset, `WHERE t.id = ?` lookups still return
 * `undefined` exactly as before, so every pre-existing test is unaffected.
 */
function createSqlTracker() {
  const statements: PreparedStatement[] = [];
  let existingRow: TaskRow | undefined;

  function makeStatement(sql: string): ReturnType<Database.Database['prepare']> {
    const entry: PreparedStatement = { sql, args: [] };
    statements.push(entry);

    return {
      run: vi.fn((...args: unknown[]) => {
        entry.args = args;
        return { changes: 0, lastInsertRowid: 0 };
      }),
      get: vi.fn((...args: unknown[]) => {
        entry.args = args;
        // Row-shaped SELECT_WITH_COUNT lookups (getById and siblings) are
        // checked FIRST and separately from the two aggregate checks below,
        // because SELECT_WITH_COUNT's own attachment-count subquery contains
        // the literal text "COUNT(*)" - matching the aggregate check first
        // would misroute every single-row lookup into the `{ count: 0 }`
        // branch instead of returning the seeded row.
        if (sql.includes('SELECT t.*')) {
          return sql.includes('WHERE t.id = ?') ? existingRow : undefined;
        }
        // COUNT(*) queries expect a { count } row; the position/display_id
        // COALESCE(MAX(...)) queries in create() expect a { max } row.
        if (/COUNT\(\*\)/i.test(sql)) return { count: 0 };
        if (/COALESCE\(MAX\(/i.test(sql)) return { max: -1 };
        return undefined;
      }),
      all: vi.fn((...args: unknown[]) => {
        entry.args = args;
        return [];
      }),
      // Satisfy the Database.Statement interface for any methods the
      // repository may call that are not covered above.
      iterate: vi.fn(() => [][Symbol.iterator]()),
      bind: vi.fn(),
      columns: vi.fn(() => []),
      expand: vi.fn(),
      raw: vi.fn(),
      pluck: vi.fn(),
      safeIntegers: vi.fn(),
      reader: false,
      readonly: false,
      database: null as unknown as Database.Database,
      source: sql,
    } as unknown as ReturnType<Database.Database['prepare']>;
  }

  const db = {
    prepare: vi.fn((sql: string) => makeStatement(sql)),
    // TaskRepository.create uses these two additional methods:
    transaction: vi.fn((fn: () => void) => fn),
    pragma: vi.fn(() => []),
  } as unknown as Database.Database;

  return { db, statements, setExistingRow: (row: TaskRow) => { existingRow = row; } };
}

/**
 * A full DB row (labels pre-serialized) for seeding `getById` via
 * `setExistingRow`. `run_mode` defaults to whatever the repository itself would
 * have derived for the given pins, so a seeded row is always one the repository
 * could actually have written; pass it explicitly to seed override mode with
 * nothing pinned, the state pins cannot express.
 */
function makeTaskRow(overrides: Partial<TaskRow> = {}): TaskRow {
  const merged = {
    id: 'task-1',
    display_id: 1,
    title: 'Existing task',
    description: '',
    swimlane_id: 'lane-1',
    position: 0,
    agent: null,
    session_id: null,
    worktree_path: null,
    branch_name: null,
    pr_number: null,
    pr_url: null,
    pr_state: null,
    head_sha: null,
    external_id: null,
    external_source: null,
    external_url: null,
    base_branch: null,
    use_worktree: null,
    labels: '[]',
    priority: 0,
    model_override: null,
    effort_override: null,
    agent_override: null,
    permission_mode: null,
    auto_command: null,
    profile_id: null,
    attachment_count: 0,
    detail_view_state: null,
    archived_at: null,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    ...overrides,
  } as TaskRow;
  const pinsAnyField = merged.agent_override !== null || merged.model_override !== null
    || merged.effort_override !== null || merged.permission_mode !== null;
  return { run_mode: pinsAnyField ? 'agent_override' : 'column_settings', ...merged };
}

describe('TaskRepository SQL contracts', () => {
  let tracker: ReturnType<typeof createSqlTracker>;
  let repo: TaskRepository;

  beforeEach(() => {
    tracker = createSqlTracker();
    repo = new TaskRepository(tracker.db);
  });

  describe('listAllInSwimlane', () => {
    it('queries by swimlane_id without an archived_at filter', () => {
      repo.listAllInSwimlane('lane-done');

      const statement = tracker.statements.find((s) =>
        s.sql.includes('swimlane_id') && !s.sql.includes('archived_at'),
      );
      expect(statement).toBeDefined();
      expect(statement!.sql).not.toContain('archived_at');
    });

    it('passes the swimlane id as the binding argument', () => {
      repo.listAllInSwimlane('lane-done');

      const statement = tracker.statements.find((s) =>
        s.sql.includes('WHERE t.swimlane_id = ?') && !s.sql.includes('archived_at'),
      );
      expect(statement).toBeDefined();
      expect(statement!.args).toEqual(['lane-done']);
    });

    it('orders results by position ASC', () => {
      repo.listAllInSwimlane('lane-done');

      const statement = tracker.statements.find((s) =>
        s.sql.includes('WHERE t.swimlane_id = ?') && !s.sql.includes('archived_at'),
      );
      expect(statement).toBeDefined();
      expect(statement!.sql).toContain('ORDER BY t.position ASC');
    });
  });

  describe('list (swimlane-scoped)', () => {
    it('filters by archived_at IS NULL when a swimlane id is provided', () => {
      repo.list('lane-todo');

      const statement = tracker.statements.find((s) =>
        s.sql.includes('swimlane_id') && s.sql.includes('archived_at IS NULL'),
      );
      expect(statement).toBeDefined();
      expect(statement!.sql).toContain('archived_at IS NULL');
    });

    it('passes the swimlane id as the binding argument', () => {
      repo.list('lane-todo');

      const statement = tracker.statements.find((s) =>
        s.sql.includes('WHERE t.swimlane_id = ?') && s.sql.includes('archived_at IS NULL'),
      );
      expect(statement).toBeDefined();
      expect(statement!.args).toEqual(['lane-todo']);
    });
  });

  describe('listAllInSwimlane vs list contrast', () => {
    it('list uses archived_at IS NULL but listAllInSwimlane does not - both query the same swimlane column', () => {
      // This is the core regression guard: if someone adds `AND archived_at IS NULL`
      // to listAllInSwimlane's WHERE clause, the Done-cleanup retry pass will stop
      // seeing archived Done tasks and failed cleanups will become permanent.
      repo.list('lane-done');
      const activeOnlyStatements = tracker.statements.filter((s) =>
        s.sql.includes('swimlane_id') && s.sql.includes('archived_at IS NULL'),
      );
      expect(activeOnlyStatements.length).toBeGreaterThan(0);

      // Reset and call listAllInSwimlane
      vi.clearAllMocks();
      tracker = createSqlTracker();
      repo = new TaskRepository(tracker.db);

      repo.listAllInSwimlane('lane-done');
      const allTasksStatements = tracker.statements.filter((s) =>
        s.sql.includes('swimlane_id') && s.sql.includes('archived_at'),
      );
      // No statement should contain archived_at when using listAllInSwimlane
      expect(allTasksStatements).toHaveLength(0);
    });
  });

  describe('listArchivedPreview', () => {
    it('counts all archived tasks and limits the returned rows', () => {
      const result = repo.listArchivedPreview(15);

      // Returns the { totalCount, tasks } shape (mock get() yields count 0,
      // all() yields []).
      expect(result).toEqual({ totalCount: 0, tasks: [] });

      const countStatement = tracker.statements.find((s) => /COUNT\(\*\)/i.test(s.sql));
      expect(countStatement).toBeDefined();
      expect(countStatement!.sql).toContain('archived_at IS NOT NULL');
    });

    it('orders newest-first and applies a LIMIT binding', () => {
      repo.listArchivedPreview(15);

      const previewStatement = tracker.statements.find((s) =>
        s.sql.includes('archived_at IS NOT NULL') && s.sql.includes('LIMIT ?'),
      );
      expect(previewStatement).toBeDefined();
      expect(previewStatement!.sql).toContain('ORDER BY t.archived_at DESC');
      expect(previewStatement!.args).toEqual([15]);
    });

    it('clamps the limit to [1, 100] and floors fractional values', () => {
      const limitBindingFor = (requested: number): number => {
        tracker = createSqlTracker();
        repo = new TaskRepository(tracker.db);
        repo.listArchivedPreview(requested);
        const statement = tracker.statements.find((s) => s.sql.includes('LIMIT ?'));
        return statement!.args[0] as number;
      };

      expect(limitBindingFor(500)).toBe(100); // over cap
      expect(limitBindingFor(0)).toBe(1); // under floor
      expect(limitBindingFor(-5)).toBe(1); // negative floor
      expect(limitBindingFor(15.9)).toBe(15); // floored
    });
  });

  describe('create - createdAt handling', () => {
    // Added for kangentic_move_task_to_project: create() gained an optional
    // `createdAt` on TaskCreateInput so a relocated task can preserve its
    // original creation time instead of always being stamped "now". These
    // isolate that parameter's two branches independent of the higher-level
    // move-to-project test (mcp-move-task-to-project.test.ts), which only
    // exercises the override path indirectly and is skipped locally when
    // better-sqlite3 cannot load under the vitest Node ABI.

    it('defaults created_at to now (equal to updated_at) when createdAt is omitted', () => {
      const before = new Date().toISOString();
      const task = repo.create({ title: 'Untimestamped task', description: '', swimlane_id: 'lane-1' });
      const after = new Date().toISOString();

      // Same `now` value is used for both columns in the source - not just
      // "close in time" but the identical string.
      expect(task.created_at).toBe(task.updated_at);
      expect(task.created_at >= before).toBe(true);
      expect(task.created_at <= after).toBe(true);
    });

    it('preserves an explicit createdAt override, distinct from the updated_at "now" stamp', () => {
      const before = new Date().toISOString();
      const task = repo.create({
        title: 'Relocated task',
        description: '',
        swimlane_id: 'lane-1',
        createdAt: '2020-01-01T00:00:00.000Z',
      });
      const after = new Date().toISOString();

      expect(task.created_at).toBe('2020-01-01T00:00:00.000Z');
      // updated_at is still stamped to the real "now", not the override.
      expect(task.updated_at).not.toBe(task.created_at);
      expect(task.updated_at >= before).toBe(true);
      expect(task.updated_at <= after).toBe(true);
    });

    it('binds the overridden createdAt (not "now") into the INSERT statement', () => {
      repo.create({
        title: 'Relocated task',
        description: '',
        swimlane_id: 'lane-1',
        createdAt: '2020-01-01T00:00:00.000Z',
      });

      const insertStatement = tracker.statements.find((s) => s.sql.includes('INSERT INTO tasks'));
      expect(insertStatement).toBeDefined();
      // Column order: ... model_override, effort_override, agent_override, created_at, updated_at
      const args = insertStatement!.args;
      const createdAtArg = args[args.length - 2];
      const updatedAtArg = args[args.length - 1];
      expect(createdAtArg).toBe('2020-01-01T00:00:00.000Z');
      expect(updatedAtArg).not.toBe('2020-01-01T00:00:00.000Z');
    });
  });

  describe('profile-vs-pin mutual exclusivity (applyProfileExclusivity)', () => {
    // Board Profiles: a task either pins the four Advanced fields for its whole
    // life OR rides a profile's per-column ladder, never both. Covered here on
    // all three write paths that enforce it - create, update, updateOverrides -
    // since each merges "what changed" differently and each has its own bug
    // class if it reads intent from the merged result instead of the request.

    describe('create()', () => {
      it('a profile_id passed alongside a pin wins: the pin is dropped', () => {
        const task = repo.create({
          title: 'T', description: '', swimlane_id: 'lane-1',
          profile_id: 'profile-1', model_override: 'opus',
        });

        expect(task.profile_id).toBe('profile-1');
        expect(task.model_override).toBeNull();
      });

      it('a pin with no profile_id leaves profile_id null', () => {
        const task = repo.create({
          title: 'T', description: '', swimlane_id: 'lane-1', model_override: 'opus',
        });

        expect(task.model_override).toBe('opus');
        expect(task.profile_id).toBeNull();
      });

      it('a profile_id with no pins carries the profile through untouched', () => {
        const task = repo.create({
          title: 'T', description: '', swimlane_id: 'lane-1', profile_id: 'profile-1',
        });

        expect(task.profile_id).toBe('profile-1');
        expect(task.agent_override).toBeNull();
        expect(task.model_override).toBeNull();
        expect(task.effort_override).toBeNull();
        expect(task.permission_mode).toBeNull();
      });

      it('defaults run_mode to column_settings', () => {
        const task = repo.create({ title: 'T', description: '', swimlane_id: 'lane-1' });

        expect(task.run_mode).toBe('column_settings');
      });

      it('run_mode agent_override with nothing pinned survives the create', () => {
        // The whole reason the column exists: this row is byte-identical to a
        // Column Settings task in every other field, so nothing but the mode
        // can tell them apart.
        const task = repo.create({
          title: 'T', description: '', swimlane_id: 'lane-1', run_mode: 'agent_override',
        });

        expect(task.run_mode).toBe('agent_override');
        expect(task.agent_override).toBeNull();
        expect(task.model_override).toBeNull();
        expect(task.effort_override).toBeNull();
        expect(task.permission_mode).toBeNull();
        expect(task.profile_id).toBeNull();
      });

      it('a pin implies run_mode agent_override without being asked', () => {
        const task = repo.create({
          title: 'T', description: '', swimlane_id: 'lane-1', effort_override: 'high',
        });

        expect(task.run_mode).toBe('agent_override');
      });

      it('a profile_id forces run_mode column_settings even when agent_override was requested', () => {
        const task = repo.create({
          title: 'T', description: '', swimlane_id: 'lane-1',
          profile_id: 'profile-1', run_mode: 'agent_override',
        });

        expect(task.profile_id).toBe('profile-1');
        expect(task.run_mode).toBe('column_settings');
      });

      it('persists run_mode in the INSERT statement, not just the returned object', () => {
        // Mirrors the update() test below: the INSERT column list and its
        // positional args are hand-enumerated, so a mode that only lives in
        // the returned Task would look correct here and silently fall back
        // to the schema DEFAULT 'column_settings' on the next read - every
        // "Agent Override with nothing pinned" task would revert to Column
        // Settings the moment the app restarts.
        repo.create({
          title: 'T', description: '', swimlane_id: 'lane-1', run_mode: 'agent_override',
        });

        const insertStatement = tracker.statements.find((statement) => statement.sql.includes('INSERT INTO tasks'));
        expect(insertStatement).toBeDefined();
        expect(insertStatement!.sql).toContain('run_mode');
        expect(insertStatement!.args).toContain('agent_override');
      });
    });

    describe('update()', () => {
      it('pinning a model on a task currently riding a profile switches it to Custom (clears profile_id)', () => {
        // This is the scenario the JSDoc calls out by name: deciding exclusivity
        // from the MERGED result (which still carries the inherited profile_id)
        // instead of from what the caller asked to change would silently
        // re-clear the very pin the caller just requested.
        tracker.setExistingRow(makeTaskRow({ profile_id: 'profile-1', model_override: null }));

        const updated = repo.update({ id: 'task-1', model_override: 'sonnet' });

        expect(updated.model_override).toBe('sonnet');
        expect(updated.profile_id).toBeNull();
      });

      it('setting profile_id clears all four existing pins, even ones untouched by this call', () => {
        tracker.setExistingRow(makeTaskRow({
          model_override: 'sonnet', effort_override: 'high',
          agent_override: 'claude', permission_mode: 'default', profile_id: null,
        }));

        const updated = repo.update({ id: 'task-1', profile_id: 'profile-2' });

        expect(updated.profile_id).toBe('profile-2');
        expect(updated.model_override).toBeNull();
        expect(updated.effort_override).toBeNull();
        expect(updated.agent_override).toBeNull();
        expect(updated.permission_mode).toBeNull();
      });

      it('an unrelated field update leaves an existing profile_id, run_mode, and pins untouched', () => {
        tracker.setExistingRow(makeTaskRow({ profile_id: 'profile-1' }));

        const updated = repo.update({ id: 'task-1', title: 'Renamed' });

        expect(updated.title).toBe('Renamed');
        expect(updated.profile_id).toBe('profile-1');
        expect(updated.run_mode).toBe('column_settings');
      });

      it('switching a bare task to agent_override persists the mode with no pins', () => {
        // The repro: Edit Task on a task with nothing pinned, select Agent
        // Override, change nothing else, Save. Before run_mode existed this
        // wrote five nulls and reopened on Column Settings.
        tracker.setExistingRow(makeTaskRow());

        const updated = repo.update({
          id: 'task-1',
          agent_override: null,
          model_override: null,
          effort_override: null,
          permission_mode: null,
          profile_id: null,
          run_mode: 'agent_override',
        });

        expect(updated.run_mode).toBe('agent_override');
        expect(updated.agent_override).toBeNull();
        expect(updated.model_override).toBeNull();
        expect(updated.effort_override).toBeNull();
        expect(updated.permission_mode).toBeNull();
        expect(updated.profile_id).toBeNull();
      });

      it('run_mode agent_override detaches a task from its profile', () => {
        tracker.setExistingRow(makeTaskRow({ profile_id: 'profile-1' }));

        const updated = repo.update({ id: 'task-1', run_mode: 'agent_override' });

        expect(updated.run_mode).toBe('agent_override');
        expect(updated.profile_id).toBeNull();
      });

      it('run_mode column_settings clears the pins, mirroring the dialog branch', () => {
        tracker.setExistingRow(makeTaskRow({
          model_override: 'sonnet', effort_override: 'high',
          agent_override: 'claude', permission_mode: 'default',
        }));

        const updated = repo.update({ id: 'task-1', run_mode: 'column_settings' });

        expect(updated.run_mode).toBe('column_settings');
        expect(updated.model_override).toBeNull();
        expect(updated.effort_override).toBeNull();
        expect(updated.agent_override).toBeNull();
        expect(updated.permission_mode).toBeNull();
      });

      it('setting profile_id forces column_settings even when agent_override rides along', () => {
        // A row claiming both a profile and override mode is the state the
        // first-spawn lock would misread, so no write may produce one.
        tracker.setExistingRow(makeTaskRow({ model_override: 'sonnet' }));

        const updated = repo.update({
          id: 'task-1', profile_id: 'profile-2', run_mode: 'agent_override',
        });

        expect(updated.profile_id).toBe('profile-2');
        expect(updated.run_mode).toBe('column_settings');
        expect(updated.model_override).toBeNull();
      });

      it('pinning a field flips a column-settings task to agent_override', () => {
        tracker.setExistingRow(makeTaskRow());

        const updated = repo.update({ id: 'task-1', model_override: 'sonnet' });

        expect(updated.run_mode).toBe('agent_override');
      });

      it('persists run_mode in the UPDATE statement, not just the returned object', () => {
        // The update SET list is hand-enumerated and already omits other
        // columns, so a mode that only lives in the return value would look
        // correct here and vanish on the next read.
        tracker.setExistingRow(makeTaskRow());

        repo.update({ id: 'task-1', run_mode: 'agent_override' });

        const updateStatement = tracker.statements.find((statement) => statement.sql.includes('UPDATE tasks SET title'));
        expect(updateStatement!.sql).toContain('run_mode = ?');
        expect(updateStatement!.args).toContain('agent_override');
      });
    });

    describe('updateOverrides()', () => {
      it('pinning a model via the ContextBar popover detaches the task from its profile', () => {
        tracker.setExistingRow(makeTaskRow({ profile_id: 'profile-1' }));

        repo.updateOverrides('task-1', { model_override: 'opus' });

        const updateStatement = tracker.statements.find((s) => s.sql.includes('UPDATE tasks SET model_override'));
        expect(updateStatement).toBeDefined();
        const [modelArg, , profileIdArg, runModeArg] = updateStatement!.args;
        expect(modelArg).toBe('opus');
        expect(profileIdArg).toBeNull();
        // The derived mode has to reach the SET list too - a ContextBar pin
        // that detached from the profile but left run_mode behind would leave
        // the row claiming column settings while carrying a lifetime pin.
        expect(runModeArg).toBe('agent_override');
      });

      it('clearing an override to null is not a pin and leaves profile_id intact', () => {
        tracker.setExistingRow(makeTaskRow({ profile_id: 'profile-1', model_override: 'opus' }));

        repo.updateOverrides('task-1', { model_override: null });

        const updateStatement = tracker.statements.find((s) => s.sql.includes('UPDATE tasks SET model_override'));
        expect(updateStatement).toBeDefined();
        const [modelArg, , profileIdArg, runModeArg] = updateStatement!.args;
        expect(modelArg).toBeNull();
        expect(profileIdArg).toBe('profile-1');
        // Not a pin means not a mode switch either: the seeded row's mode is
        // written back unchanged rather than re-derived from the cleared value.
        expect(runModeArg).toBe('agent_override');
      });
    });
  });
});
