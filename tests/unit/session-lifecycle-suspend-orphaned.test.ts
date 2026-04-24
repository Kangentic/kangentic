/**
 * Tests for markRecordSuspended accepting 'orphaned' as a source status.
 *
 * The pause-on-restart setting upgrades crashed records ('orphaned') directly
 * to 'suspended' without retire-and-recreate. This widens the allowed source
 * statuses from ['running', 'exited'] to ['running', 'exited', 'orphaned'].
 *
 * Uses a mock better-sqlite3 DB (the real binding is compiled against
 * Electron's Node ABI and can't load under vitest).
 */

import { describe, it, expect, vi } from 'vitest';
import type Database from 'better-sqlite3';
import { SessionRepository } from '../../src/main/db/repositories/session-repository';
import { markRecordSuspended } from '../../src/main/engine/session-lifecycle';

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
  return { mockDb, executedStatements };
}

describe('markRecordSuspended', () => {
  it('allows transitioning from running, exited, or orphaned', () => {
    const { mockDb, executedStatements } = createMockDb();
    const repo = new SessionRepository(mockDb);

    const ok = markRecordSuspended(repo, 'session-id-1', 'user');

    expect(ok).toBe(true);
    expect(executedStatements).toHaveLength(1);
    const statement = executedStatements[0];

    // SQL should reference 'suspended' as target and 'orphaned' as one of sources
    expect(statement.sql).toContain("status = ?");
    expect(statement.sql).toContain("WHERE id = ? AND status IN");

    // Bound params layout (from compareAndUpdateStatus):
    //   [status='suspended', suspended_at, suspended_by, id, ...fromList]
    // With fromList = ['running', 'exited', 'orphaned'].
    const params = statement.params;
    expect(params[0]).toBe('suspended');
    expect(params).toContain('user');          // suspended_by value
    expect(params).toContain('running');        // source status
    expect(params).toContain('exited');         // source status
    expect(params).toContain('orphaned');       // NEW: source status for pause-on-restart
  });

  it("threads the suspendedBy='system' value through", () => {
    const { mockDb, executedStatements } = createMockDb();
    const repo = new SessionRepository(mockDb);

    markRecordSuspended(repo, 'session-id-2', 'system');

    expect(executedStatements[0].params).toContain('system');
  });
});
