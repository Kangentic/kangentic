/**
 * Tests for SessionRepository.findByAnyId.
 *
 * findByAnyId resolves a session record by either its Kangentic id or its
 * agent_session_id - used by the MCP get_transcript handler which accepts
 * either flavor of UUID. The query must bind the same id positionally to
 * both columns and return the most recent match.
 *
 * Uses a tracker mock (no real better-sqlite3) that records the SQL and bound
 * params, as session-repository-orphan.test.ts does, so the tests pin the
 * statements issued. `tests/unit/helpers/test-database.ts` opens a real
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

function createMockDb(getReturn: SessionRecord | undefined) {
  const executedStatements: ExecutedStatement[] = [];

  const mockStatement = {
    run: vi.fn(() => ({ changes: 0 })),
    get: vi.fn((...params: unknown[]) => {
      executedStatements[executedStatements.length - 1].params = params;
      return getReturn;
    }),
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

describe('SessionRepository.findByAnyId', () => {
  let executedStatements: ExecutedStatement[];
  let repository: SessionRepository;

  function setup(getReturn: SessionRecord | undefined) {
    const mock = createMockDb(getReturn);
    executedStatements = mock.executedStatements;
    repository = new SessionRepository(mock.mockDb);
  }

  beforeEach(() => {
    executedStatements = [];
  });

  it('queries both id and agent_session_id columns with the same bound value', () => {
    const expected = makeRecord({ id: 'pty-uuid', agent_session_id: 'pty-uuid' });
    setup(expected);

    const result = repository.findByAnyId('pty-uuid');

    expect(result).toEqual(expected);
    expect(executedStatements).toHaveLength(1);
    const statement = executedStatements[0];
    expect(statement.sql).toContain('FROM sessions');
    expect(statement.sql).toContain('id = ?');
    expect(statement.sql).toContain('agent_session_id = ?');
    expect(statement.sql).toContain('OR');
    // Same id bound twice - once for each column.
    expect(statement.params).toEqual(['pty-uuid', 'pty-uuid']);
  });

  it('orders by started_at DESC and limits to one row so collisions return the newest match', () => {
    setup(makeRecord({}));

    repository.findByAnyId('any-id');

    const statement = executedStatements[0];
    expect(statement.sql).toContain('ORDER BY started_at DESC');
    expect(statement.sql).toContain('LIMIT 1');
  });

  it('returns undefined when no row matches', () => {
    setup(undefined);

    const result = repository.findByAnyId('does-not-exist');

    expect(result).toBeUndefined();
  });

  it('finds a record stored under agent_session_id when caller passes that flavor', () => {
    // The MCP handler accepts either the Kangentic PTY session id or the
    // Claude agent_session_id. With both columns OR'd in the SQL, the same
    // method must succeed for both inputs.
    const record = makeRecord({ id: 'kangentic-side', agent_session_id: 'claude-side' });
    setup(record);

    const result = repository.findByAnyId('claude-side');

    expect(result).toEqual(record);
    expect(executedStatements[0].params).toEqual(['claude-side', 'claude-side']);
  });
});
