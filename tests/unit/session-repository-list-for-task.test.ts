/**
 * Tests for SessionRepository.listForTaskNewestFirst.
 *
 * Returns every session record for a task, newest first, so index-based
 * pickers (the MCP get_transcript / get_session_files / get_session_events
 * `sessionIndex` param) can select an older session. The query must order
 * started_at DESC and must NOT carry a LIMIT (unlike getLatestForTask).
 *
 * Uses a tracker mock (no real better-sqlite3) that records the SQL and bound
 * params, as session-repository-find-by-any-id.test.ts does, so the tests pin
 * the statements issued. `tests/unit/helpers/test-database.ts` opens a real
 * database if one is wanted.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SessionRepository } from '../../src/main/db/repositories/session-repository';
import type Database from 'better-sqlite3';
import type { SessionRecord } from '../../src/shared/types';

interface ExecutedStatement {
  sql: string;
  params: unknown[];
}

function createMockDb(allReturn: SessionRecord[]) {
  const executedStatements: ExecutedStatement[] = [];

  const mockStatement = {
    run: vi.fn(() => ({ changes: 0 })),
    get: vi.fn(() => undefined),
    all: vi.fn((...params: unknown[]) => {
      executedStatements[executedStatements.length - 1].params = params;
      return allReturn;
    }),
  };

  const mockDb = {
    prepare: vi.fn((sql: string) => {
      executedStatements.push({ sql, params: [] });
      return mockStatement;
    }),
  } as unknown as Database.Database;

  return { mockDb, executedStatements };
}

function makeRecord(overrides: Partial<SessionRecord>): SessionRecord {
  return {
    id: 'session-1',
    task_id: 'task-1',
    session_type: 'claude_agent',
    agent_session_id: 'agent-1',
    command: 'claude',
    cwd: '/project',
    permission_mode: null,
    prompt: null,
    status: 'exited',
    exit_code: 0,
    started_at: '2026-04-09T10:00:00Z',
    suspended_at: null,
    exited_at: '2026-04-09T11:00:00Z',
    suspended_by: null,
    total_cost_usd: null,
    ...overrides,
  } as SessionRecord;
}

describe('SessionRepository.listForTaskNewestFirst', () => {
  let executedStatements: ExecutedStatement[];
  let repository: SessionRepository;

  function setup(allReturn: SessionRecord[]) {
    const mock = createMockDb(allReturn);
    executedStatements = mock.executedStatements;
    repository = new SessionRepository(mock.mockDb);
  }

  beforeEach(() => {
    executedStatements = [];
  });

  it('orders started_at DESC and does not LIMIT, binding the task id', () => {
    setup([makeRecord({ id: 'newest' }), makeRecord({ id: 'older' })]);

    const result = repository.listForTaskNewestFirst('task-1');

    expect(result).toHaveLength(2);
    expect(executedStatements).toHaveLength(1);
    const statement = executedStatements[0];
    expect(statement.sql).toContain('FROM sessions');
    expect(statement.sql).toContain('task_id = ?');
    expect(statement.sql).toContain('ORDER BY started_at DESC');
    expect(statement.sql).not.toContain('LIMIT');
    expect(statement.params).toEqual(['task-1']);
  });

  it('returns an empty array when the task has no sessions', () => {
    setup([]);

    expect(repository.listForTaskNewestFirst('task-none')).toEqual([]);
  });
});
