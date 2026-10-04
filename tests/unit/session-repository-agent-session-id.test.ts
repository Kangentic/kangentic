/**
 * Tests for SessionRepository.updateAgentSessionId and recoverStaleSessionId.
 *
 * updateAgentSessionId is the single reconciliation write point for
 * sessions.agent_session_id. It gained a third caller scenario with the
 * /clear-fork fix (a mid-session fork re-reports a new id through the status
 * file), so its write shape and recoverStaleSessionId's targeting/idempotency
 * are pinned here.
 *
 * Uses a tracker mock (no real better-sqlite3) that records the SQL and bound
 * params, as session-repository-find-by-any-id.test.ts does, so the tests pin
 * the statements issued. `tests/unit/helpers/test-database.ts` opens a real
 * database if one is wanted.
 */
import { describe, it, expect, vi } from 'vitest';
import { SessionRepository } from '../../src/main/db/repositories/session-repository';
import { recoverStaleSessionId } from '../../src/main/transition-engine/session-lifecycle';
import type Database from 'better-sqlite3';
import type { SessionRecord } from '../../src/shared/types';

interface ExecutedStatement {
  sql: string;
  params: unknown[];
}

function createMockDb() {
  const executedStatements: ExecutedStatement[] = [];

  const mockStatement = {
    run: vi.fn((...params: unknown[]) => {
      executedStatements[executedStatements.length - 1].params = params;
      return { changes: 1 };
    }),
    get: vi.fn(() => undefined),
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
    id: 'record-1',
    task_id: 'task-1',
    session_type: 'claude_agent',
    agent_session_id: 'agent-1',
    command: 'claude',
    cwd: '/project',
    permission_mode: null,
    prompt: null,
    status: 'running',
    exit_code: null,
    started_at: '2026-08-03T10:00:00Z',
    suspended_at: null,
    exited_at: null,
    suspended_by: null,
    total_cost_usd: null,
    ...overrides,
  } as SessionRecord;
}

interface RecoveryRepoStub {
  findByAnyId: ReturnType<typeof vi.fn>;
  getLatestForTask: ReturnType<typeof vi.fn>;
  updateAgentSessionId: ReturnType<typeof vi.fn>;
}

function makeRecoveryRepo(options: {
  byAnyId?: SessionRecord;
  latestForTask?: SessionRecord;
}): RecoveryRepoStub {
  return {
    findByAnyId: vi.fn(() => options.byAnyId),
    getLatestForTask: vi.fn(() => options.latestForTask),
    updateAgentSessionId: vi.fn(),
  };
}

const asRepo = (stub: RecoveryRepoStub): SessionRepository =>
  stub as unknown as SessionRepository;

describe('SessionRepository.updateAgentSessionId', () => {
  it('updates agent_session_id by primary key with the expected binding order', () => {
    const { mockDb, executedStatements } = createMockDb();
    const repository = new SessionRepository(mockDb);

    repository.updateAgentSessionId('record-uuid', 'new-agent-uuid');

    expect(executedStatements).toHaveLength(1);
    const statement = executedStatements[0];
    expect(statement.sql).toContain('UPDATE sessions');
    expect(statement.sql).toContain('SET agent_session_id = ?');
    expect(statement.sql).toContain('WHERE id = ?');
    // Value first, primary key second.
    expect(statement.params).toEqual(['new-agent-uuid', 'record-uuid']);
  });

  it('is a plain rewrite: a second call with another id issues the same UPDATE', () => {
    const { mockDb, executedStatements } = createMockDb();
    const repository = new SessionRepository(mockDb);

    repository.updateAgentSessionId('record-uuid', 'fork-1');
    repository.updateAgentSessionId('record-uuid', 'fork-2');

    expect(executedStatements).toHaveLength(2);
    expect(executedStatements[1].params).toEqual(['fork-2', 'record-uuid']);
  });
});

describe('recoverStaleSessionId', () => {
  it('fresh capture: fills a null agent_session_id on the exact record', () => {
    const record = makeRecord({ id: 'pty-1', agent_session_id: null });
    const repo = makeRecoveryRepo({ byAnyId: record });

    const changed = recoverStaleSessionId(asRepo(repo), 'pty-1', 'task-1', 'captured-id');

    expect(changed).toBe(true);
    expect(repo.findByAnyId).toHaveBeenCalledWith('pty-1');
    expect(repo.updateAgentSessionId).toHaveBeenCalledWith('pty-1', 'captured-id');
    // The exact-record match means the coarse fallback is never consulted.
    expect(repo.getLatestForTask).not.toHaveBeenCalled();
  });

  it('stale recovery / mid-session fork: rewrites a DIFFERENT reported id', () => {
    const record = makeRecord({ id: 'pty-1', agent_session_id: 'pre-clear-id' });
    const repo = makeRecoveryRepo({ byAnyId: record });

    const changed = recoverStaleSessionId(asRepo(repo), 'pty-1', 'task-1', 'post-clear-id');

    expect(changed).toBe(true);
    expect(repo.updateAgentSessionId).toHaveBeenCalledWith('pty-1', 'post-clear-id');
  });

  it('same reported id is a no-op returning false', () => {
    const record = makeRecord({ id: 'pty-1', agent_session_id: 'agent-1' });
    const repo = makeRecoveryRepo({ byAnyId: record });

    const changed = recoverStaleSessionId(asRepo(repo), 'pty-1', 'task-1', 'agent-1');

    expect(changed).toBe(false);
    expect(repo.updateAgentSessionId).not.toHaveBeenCalled();
  });

  it('repeated forks keep targeting the same record by primary key', () => {
    // After the first reconcile the record carries fork-1; a second /clear
    // reports fork-2. findByAnyId is passed the PTY session id (the record's
    // PRIMARY KEY), which no rewrite of agent_session_id can unmatch, so the
    // second call still lands on the same row.
    const record = makeRecord({ id: 'pty-1', agent_session_id: 'fork-1' });
    const repo = makeRecoveryRepo({ byAnyId: record });

    const changed = recoverStaleSessionId(asRepo(repo), 'pty-1', 'task-1', 'fork-2');

    expect(changed).toBe(true);
    expect(repo.findByAnyId).toHaveBeenCalledWith('pty-1');
    expect(repo.updateAgentSessionId).toHaveBeenCalledWith('pty-1', 'fork-2');
  });

  it('falls back to the latest task record only when the exact id misses (pre-insert window)', () => {
    const latest = makeRecord({ id: 'latest-record', agent_session_id: null });
    const repo = makeRecoveryRepo({ byAnyId: undefined, latestForTask: latest });

    const changed = recoverStaleSessionId(asRepo(repo), 'pty-not-inserted-yet', 'task-1', 'captured-id');

    expect(changed).toBe(true);
    expect(repo.getLatestForTask).toHaveBeenCalledWith('task-1');
    expect(repo.updateAgentSessionId).toHaveBeenCalledWith('latest-record', 'captured-id');
  });

  it('returns false when no record exists at all', () => {
    const repo = makeRecoveryRepo({ byAnyId: undefined, latestForTask: undefined });

    const changed = recoverStaleSessionId(asRepo(repo), 'pty-1', 'task-1', 'captured-id');

    expect(changed).toBe(false);
    expect(repo.updateAgentSessionId).not.toHaveBeenCalled();
  });
});
