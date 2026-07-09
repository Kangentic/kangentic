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
 */
function createSqlTracker() {
  const statements: PreparedStatement[] = [];

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
        // COUNT(*) queries expect a { count } row; the position/display_id
        // COALESCE(MAX(...)) queries in create() expect a { max } row;
        // everything else models a "not found" lookup, matching real
        // better-sqlite3 semantics.
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

  return { db, statements };
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
});
