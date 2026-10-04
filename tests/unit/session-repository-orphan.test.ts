/**
 * Tests for SessionRepository orphan recovery including queued records.
 *
 * Verifies that crash recovery correctly marks both 'running' and 'queued'
 * session records as 'orphaned', since queued sessions (like running ones)
 * represent in-memory state that is lost on crash.
 *
 * Uses a mock database that tracks the executed SQL, so the tests pin the
 * statements issued. `tests/unit/helpers/test-database.ts` opens a real
 * database if one is wanted.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SessionRepository } from '../../src/main/db/repositories/session-repository';
import type Database from 'better-sqlite3';

/** Create a mock better-sqlite3 Database that tracks executed SQL. */
function createMockDb() {
  const executedStatements: Array<{ sql: string; params: unknown[] }> = [];

  const mockStatement = {
    run: vi.fn((...params: unknown[]) => {
      executedStatements[executedStatements.length - 1].params = params;
      return { changes: 1 };
    }),
    get: vi.fn(),
    all: vi.fn(() => []),
  };

  const mockDb = {
    prepare: vi.fn((sql: string) => {
      executedStatements.push({ sql, params: [] });
      return mockStatement;
    }),
  } as unknown as Database.Database;

  return { mockDb, executedStatements, mockStatement };
}

describe('SessionRepository orphan recovery', () => {
  let mockDb: Database.Database;
  let executedStatements: Array<{ sql: string; params: unknown[] }>;
  let repo: SessionRepository;

  beforeEach(() => {
    const mock = createMockDb();
    mockDb = mock.mockDb;
    executedStatements = mock.executedStatements;
    repo = new SessionRepository(mockDb);
  });

  it('markAllRunningAsOrphaned targets both running and queued statuses', () => {
    repo.markAllRunningAsOrphaned();

    expect(executedStatements).toHaveLength(1);
    const statement = executedStatements[0];
    expect(statement.sql).toContain("status = 'orphaned'");
    expect(statement.sql).toContain("'running'");
    expect(statement.sql).toContain("'queued'");
    expect(statement.sql).toContain('IN');
  });

  it('markAllRunningAsOrphaned does not target suspended or exited', () => {
    repo.markAllRunningAsOrphaned();

    const statement = executedStatements[0];
    expect(statement.sql).not.toContain("'suspended'");
    expect(statement.sql).not.toContain("'exited'");
  });

  it('markRunningAsOrphanedExcluding targets both running and queued with exclusion', () => {
    repo.markRunningAsOrphanedExcluding(new Set(['task-1', 'task-2']));

    expect(executedStatements).toHaveLength(1);
    const statement = executedStatements[0];
    expect(statement.sql).toContain("status = 'orphaned'");
    expect(statement.sql).toContain("'running'");
    expect(statement.sql).toContain("'queued'");
    expect(statement.sql).toContain('IN');
    expect(statement.sql).toContain('task_id NOT IN');
    expect(statement.params).toEqual(['task-1', 'task-2']);
  });

  it('markRunningAsOrphanedExcluding with empty set delegates to markAllRunningAsOrphaned', () => {
    repo.markRunningAsOrphanedExcluding(new Set());

    expect(executedStatements).toHaveLength(1);
    const statement = executedStatements[0];
    // Should use the simpler query (no NOT IN clause)
    expect(statement.sql).not.toContain('task_id NOT IN');
    expect(statement.sql).toContain("'running'");
    expect(statement.sql).toContain("'queued'");
  });
});
