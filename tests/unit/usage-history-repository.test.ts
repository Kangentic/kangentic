/**
 * Tests for `UsageHistoryRepository`. better-sqlite3 cannot load under
 * vitest's system Node, so the DB is mocked with a `prepare`/`run`/`get`
 * surface that records the SQL it was given and the params bound to it.
 *
 * The history is the source of truth for the usage dashboard's period totals.
 * Its tests pin three contracts that must not silently regress:
 *
 *   1. UPSERT on `session_record_id` (idempotency for repeat captures of the
 *      same record at suspend then app shutdown).
 *   2. Period bucketing uses `session_started_at`, not `recorded_at`. If the
 *      filter ever flips, "Today" would mean "captured today" which is wrong
 *      for sessions that finalize across midnight.
 *   3. `recordSessionUsage` does NOT clobber git stat columns. Git stats land
 *      via `updateGitStats` AFTER the cost capture, so the UPSERT must leave
 *      them alone on a re-capture of the same record.
 */

import { describe, it, expect, vi } from 'vitest';
import type Database from 'better-sqlite3';
import {
  UsageHistoryRepository,
  type RecordSessionUsageInput,
} from '../../src/main/db/repositories/usage-history-repository';

interface PreparedStatement {
  sql: string;
  runParams: unknown[][];
  getParams: unknown[][];
  allParams: unknown[][];
  getReturn?: unknown;
}

function createMockDb(getReturn?: unknown): {
  db: Database.Database;
  statements: PreparedStatement[];
} {
  const statements: PreparedStatement[] = [];

  const db = {
    prepare: vi.fn((sql: string) => {
      const statement: PreparedStatement = {
        sql,
        runParams: [],
        getParams: [],
        allParams: [],
        getReturn,
      };
      statements.push(statement);
      return {
        run: vi.fn((...params: unknown[]) => {
          statement.runParams.push(params);
          return { changes: 1 };
        }),
        get: vi.fn((...params: unknown[]) => {
          statement.getParams.push(params);
          return statement.getReturn;
        }),
        all: vi.fn((...params: unknown[]) => {
          statement.allParams.push(params);
          return [];
        }),
      };
    }),
  } as unknown as Database.Database;

  return { db, statements };
}

function makeUsageInput(overrides: Partial<RecordSessionUsageInput> = {}): RecordSessionUsageInput {
  return {
    sessionRecordId: 'session-record-1',
    sessionStartedAt: '2026-04-01T10:00:00Z',
    sessionType: 'claude_agent',
    totalCostUsd: 0.42,
    totalInputTokens: 1234,
    totalOutputTokens: 567,
    totalDurationMs: 60000,
    toolCallCount: 7,
    modelId: 'claude-opus-4',
    modelDisplayName: 'Claude Opus 4',
    compactionCount: 0,
    agent: 'claude',
    effort: 'high',
    ...overrides,
  };
}

describe('UsageHistoryRepository.recordSessionUsage', () => {
  it('issues an INSERT ... ON CONFLICT(session_record_id) DO UPDATE statement', () => {
    const { db, statements } = createMockDb();
    const repository = new UsageHistoryRepository(db);

    repository.recordSessionUsage(makeUsageInput());

    expect(statements).toHaveLength(1);
    const sql = statements[0].sql;
    expect(sql).toMatch(/INSERT\s+INTO\s+usage_history/i);
    expect(sql).toMatch(/ON\s+CONFLICT\s*\(\s*session_record_id\s*\)\s+DO\s+UPDATE/i);
  });

  it('binds session_record_id, started_at, type, cost, tokens, duration, count, model in the documented column order', () => {
    const { db, statements } = createMockDb();
    const repository = new UsageHistoryRepository(db);

    repository.recordSessionUsage(makeUsageInput());

    const params = statements[0].runParams[0];
    // Positional order matches the INSERT column list:
    //   id, session_record_id, recorded_at, session_started_at, session_type,
    //   total_cost_usd, total_input_tokens, total_output_tokens,
    //   total_duration_ms, tool_call_count, model_id, model_display_name,
    //   compaction_count, agent, effort
    expect(params).toHaveLength(15);
    // id (param 0) is a generated uuid - just assert it's a string
    expect(typeof params[0]).toBe('string');
    expect((params[0] as string).length).toBeGreaterThan(0);
    expect(params[1]).toBe('session-record-1');
    // recorded_at (param 2) is generated at write time - assert it's a valid ISO string
    expect(typeof params[2]).toBe('string');
    expect(Number.isFinite(Date.parse(params[2] as string))).toBe(true);
    expect(params[3]).toBe('2026-04-01T10:00:00Z');
    expect(params[4]).toBe('claude_agent');
    expect(params[5]).toBe(0.42);
    expect(params[6]).toBe(1234);
    expect(params[7]).toBe(567);
    expect(params[8]).toBe(60000);
    expect(params[9]).toBe(7);
    expect(params[10]).toBe('claude-opus-4');
    expect(params[11]).toBe('Claude Opus 4');
    expect(params[12]).toBe(0);
    expect(params[13]).toBe('claude');
    expect(params[14]).toBe('high');
  });

  it('keeps a previously-stamped agent and effort when a re-capture has none (COALESCE in the upsert)', () => {
    const { db, statements } = createMockDb();
    const repository = new UsageHistoryRepository(db);

    repository.recordSessionUsage(makeUsageInput({ agent: null, effort: null }));

    const doUpdateMatch = statements[0].sql.match(/DO\s+UPDATE\s+SET\s+([\s\S]+)$/i);
    expect(doUpdateMatch).not.toBeNull();
    expect(doUpdateMatch![1]).toMatch(/agent\s*=\s*COALESCE\(\s*excluded\.agent\s*,\s*usage_history\.agent\s*\)/i);
    expect(doUpdateMatch![1]).toMatch(/effort\s*=\s*COALESCE\(\s*excluded\.effort\s*,\s*usage_history\.effort\s*\)/i);
  });

  it('does NOT include git stat columns in the DO UPDATE SET clause (owned by updateGitStats)', () => {
    const { db, statements } = createMockDb();
    const repository = new UsageHistoryRepository(db);

    repository.recordSessionUsage(makeUsageInput());

    const sql = statements[0].sql;
    // Extract just the DO UPDATE portion. Anything outside it can mention
    // git stat columns (the INSERT column list mentions them by absence,
    // not literally), so we scope the check.
    const doUpdateMatch = sql.match(/DO\s+UPDATE\s+SET\s+([\s\S]+)$/i);
    expect(doUpdateMatch).not.toBeNull();
    const doUpdateClause = doUpdateMatch![1];
    expect(doUpdateClause).not.toMatch(/lines_added/i);
    expect(doUpdateClause).not.toMatch(/lines_removed/i);
    expect(doUpdateClause).not.toMatch(/files_changed/i);
  });

  it('writes a fresh recorded_at on each call (so re-captures reflect the latest flush time)', () => {
    const { db, statements } = createMockDb();
    const repository = new UsageHistoryRepository(db);

    const beforeFirst = Date.now();
    repository.recordSessionUsage(makeUsageInput());
    const afterFirst = Date.now();

    const recordedAt = statements[0].runParams[0][2] as string;
    const parsed = Date.parse(recordedAt);
    expect(parsed).toBeGreaterThanOrEqual(beforeFirst);
    expect(parsed).toBeLessThanOrEqual(afterFirst);
  });

  it('passes nullable fields through unchanged', () => {
    const { db, statements } = createMockDb();
    const repository = new UsageHistoryRepository(db);

    repository.recordSessionUsage(makeUsageInput({
      sessionType: null,
      totalDurationMs: null,
      modelId: null,
      modelDisplayName: null,
    }));

    const params = statements[0].runParams[0];
    expect(params[4]).toBeNull(); // session_type
    expect(params[8]).toBeNull(); // total_duration_ms
    expect(params[10]).toBeNull(); // model_id
    expect(params[11]).toBeNull(); // model_display_name
  });
});

describe('UsageHistoryRepository.updateGitStats', () => {
  it('issues an UPDATE filtered by session_record_id and binds the three stats', () => {
    const { db, statements } = createMockDb();
    const repository = new UsageHistoryRepository(db);

    repository.updateGitStats('session-record-1', {
      linesAdded: 100,
      linesRemoved: 25,
      filesChanged: 4,
    });

    expect(statements).toHaveLength(1);
    expect(statements[0].sql).toMatch(/UPDATE\s+usage_history/i);
    expect(statements[0].sql).toMatch(/WHERE\s+session_record_id\s*=\s*\?/i);
    expect(statements[0].runParams[0]).toEqual([100, 25, 4, 'session-record-1']);
  });
});

describe('UsageHistoryRepository.setTaskGitStats', () => {
  /**
   * Unlike `createMockDb` above (which always returns `{ changes: 1 }`), these
   * tests need to control whether the CANONICAL update reports a matched row,
   * so the mock distinguishes the canonical `WHERE session_record_id = ?`
   * update from the sibling `WHERE session_record_id IN (...)` zero-out by
   * SQL shape, and also stubs `db.transaction` (better-sqlite3's real
   * transaction wrapper just invokes the callback synchronously).
   */
  function createMockDbForSetTaskGitStats(canonicalChanges: number): {
    db: Database.Database;
    runCalls: Array<{ sql: string; params: unknown[] }>;
  } {
    const runCalls: Array<{ sql: string; params: unknown[] }> = [];
    const db = {
      prepare: vi.fn((sql: string) => ({
        run: vi.fn((...params: unknown[]) => {
          runCalls.push({ sql, params });
          const isSiblingZeroOut = sql.includes(' IN (');
          return { changes: isSiblingZeroOut ? 1 : canonicalChanges };
        }),
      })),
      transaction: vi.fn((fn: (...args: unknown[]) => unknown) => (...args: unknown[]) => fn(...args)),
    } as unknown as Database.Database;
    return { db, runCalls };
  }

  it('writes the canonical record and zeros every other record id', () => {
    const { db, runCalls } = createMockDbForSetTaskGitStats(1);
    const repository = new UsageHistoryRepository(db);

    repository.setTaskGitStats(['record-A', 'record-B', 'record-C'], 'record-B', {
      linesAdded: 10,
      linesRemoved: 2,
      filesChanged: 3,
    });

    expect(runCalls).toHaveLength(2);
    expect(runCalls[0].sql).toMatch(/UPDATE\s+usage_history/i);
    expect(runCalls[0].sql).toMatch(/WHERE\s+session_record_id\s*=\s*\?/i);
    expect(runCalls[0].params).toEqual([10, 2, 3, 'record-B']);

    expect(runCalls[1].sql).toMatch(/session_record_id\s+IN\s*\(\?,\s*\?\)/i);
    // The zeroed values are literals in the SQL, not bound params - only the
    // sibling ids are bound.
    expect(runCalls[1].params).toEqual(['record-A', 'record-C']);
  });

  it('does NOT zero siblings when the canonical record has no history row (changes === 0)', () => {
    const { db, runCalls } = createMockDbForSetTaskGitStats(0);
    const repository = new UsageHistoryRepository(db);

    repository.setTaskGitStats(['record-A', 'record-B'], 'record-B', {
      linesAdded: 5,
      linesRemoved: 1,
      filesChanged: 1,
    });

    // Only the canonical (no-op) UPDATE ran - the sibling zero-out never fires,
    // so an earlier leg's real churn on record-A is left untouched.
    expect(runCalls).toHaveLength(1);
  });

  it('is a no-op sibling write when the canonical id is the only record for the task', () => {
    const { db, runCalls } = createMockDbForSetTaskGitStats(1);
    const repository = new UsageHistoryRepository(db);

    repository.setTaskGitStats(['record-B'], 'record-B', {
      linesAdded: 1,
      linesRemoved: 1,
      filesChanged: 1,
    });

    expect(runCalls).toHaveLength(1);
  });
});

describe('UsageHistoryRepository.listRowsAfter', () => {
  it('issues a WHERE-less SELECT when since is null (All Time), oldest first', () => {
    const { db, statements } = createMockDb();
    const repository = new UsageHistoryRepository(db);

    const result = repository.listRowsAfter(null);

    expect(statements).toHaveLength(1);
    expect(statements[0].sql).not.toMatch(/WHERE/i);
    expect(statements[0].sql).toMatch(/FROM\s+usage_history/i);
    expect(statements[0].sql).toMatch(/ORDER\s+BY\s+session_started_at\s+ASC/i);
    expect(result).toEqual([]);
  });

  it('filters on session_started_at when since is provided (not recorded_at)', () => {
    const { db, statements } = createMockDb();
    const repository = new UsageHistoryRepository(db);

    repository.listRowsAfter('2026-04-01T00:00:00Z');

    expect(statements[0].sql).toMatch(/WHERE\s+session_started_at\s*>=\s*\?/i);
    expect(statements[0].sql).not.toMatch(/recorded_at\s*>=/i);
    expect(statements[0].allParams[0]).toEqual(['2026-04-01T00:00:00Z']);
  });

  it('selects the agent and effort columns (the by-agent / by-effort breakdown sources)', () => {
    const { db, statements } = createMockDb();
    const repository = new UsageHistoryRepository(db);

    repository.listRowsAfter(null);

    expect(statements[0].sql).toMatch(/\bagent\b/);
    expect(statements[0].sql).toMatch(/\beffort\b/);
  });
});
