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
});
