/**
 * Tests for `parseToolBreakdown` / `isPerToolStat` (via `getSummaryForTask`)
 * and for the `updateMetrics` -> `getSummaryForTask` round-trip with
 * `tool_breakdown`.
 *
 * Both helpers are module-private. They are exercised indirectly through
 * `getSummaryForTask`, which is the sole caller of `parseToolBreakdown`.
 * This approach is preferred over exporting the helpers because:
 *   - it tests the actual integration path (DB column -> deserialized PerToolStat[])
 *   - it avoids exposing implementation details in the public module surface
 *   - it gives the same branch coverage as direct tests
 *
 * better-sqlite3 is compiled for Electron's Node ABI and cannot load under
 * vitest's system Node. All tests use a queue-based mock DB that returns
 * pre-programmed values per `prepare()` call, matching the exact call order
 * inside `getSummaryForTask`.
 */

import { describe, it, expect, vi } from 'vitest';
import type Database from 'better-sqlite3';
import { SessionRepository } from '../../src/main/db/repositories/session-repository';
import type { SessionRecord } from '../../src/shared/types';

// ---------------------------------------------------------------------------
// Mock DB helpers
// ---------------------------------------------------------------------------

/**
 * A queue-based mock DB for `getSummaryForTask`.
 *
 * `getSummaryForTask` calls `prepare().get()` exactly three times, in order:
 *   call 0 - the latestRecord query (returns a SessionRecord row)
 *   call 1 - the aggregated query (SUM cost/duration/compactions/tool calls/lines)
 *   call 2 - the tokens query (latest row per lineage, SUMmed)
 *
 * Pass `latestRecordReturn` for call 0, `aggregateReturn` for call 1, and
 * `tokensReturn` for call 2. Additional `prepare()` calls fall back to undefined.
 */
function createGetSummaryMockDb(options: {
  latestRecordReturn: unknown;
  aggregateReturn: unknown;
  tokensReturn?: unknown;
}): Database.Database {
  const getReturns: unknown[] = [
    options.latestRecordReturn,
    options.aggregateReturn,
    options.tokensReturn ?? { total_input_tokens: 0, total_output_tokens: 0 },
  ];
  let callIndex = 0;

  const mockDb = {
    prepare: vi.fn((_sql: string) => {
      const index = callIndex;
      callIndex += 1;
      return {
        run: vi.fn(() => ({ changes: 0 })),
        get: vi.fn((..._params: unknown[]) => getReturns[index]),
        all: vi.fn(() => []),
      };
    }),
  } as unknown as Database.Database;

  return mockDb;
}

/**
 * A single-statement mock DB for `updateMetrics`. Captures the SQL and params
 * passed to `.run()` so we can assert the right column is written.
 */
function createUpdateMetricsMockDb(): {
  db: Database.Database;
  capturedParams: unknown[][];
} {
  const capturedParams: unknown[][] = [];

  const db = {
    prepare: vi.fn((_sql: string) => ({
      run: vi.fn((...params: unknown[]) => {
        capturedParams.push(params);
        return { changes: 1 };
      }),
      get: vi.fn(),
      all: vi.fn(() => []),
    })),
  } as unknown as Database.Database;

  return { db, capturedParams };
}

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

/** Minimal aggregate row returned by the second query in getSummaryForTask. */
function makeAggregateRow() {
  return {
    total_cost_usd: 0.05,
    total_duration_ms: 3600000,
    total_tool_calls: 5,
    total_compactions: 0,
    total_lines_added: 10,
    total_lines_removed: 3,
    max_files_changed: 2,
    earliest_started_at: '2026-04-01T10:00:00Z',
    latest_ended_at: '2026-04-01T11:00:00Z',
  };
}

/** Token row returned by the third query in getSummaryForTask. */
function makeTokensRow(input = 1000, output = 200) {
  return { total_input_tokens: input, total_output_tokens: output };
}

/** Minimal session record, overridable via the `toolBreakdown` parameter. */
function makeLatestRecord(toolBreakdown: string | null): SessionRecord & { task_created_at: string } {
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
    started_at: '2026-04-01T10:00:00Z',
    suspended_at: null,
    exited_at: '2026-04-01T11:00:00Z',
    suspended_by: null,
    total_cost_usd: 0.05,
    total_input_tokens: 1000,
    total_output_tokens: 200,
    model_id: 'claude-opus-4',
    model_display_name: 'Claude Opus 4',
    total_duration_ms: 3600000,
    tool_call_count: 5,
    lines_added: 10,
    lines_removed: 3,
    files_changed: 2,
    tool_breakdown: toolBreakdown,
    compaction_count: 0,
    task_created_at: '2026-04-01T09:00:00Z',
  } as SessionRecord & { task_created_at: string };
}

// ---------------------------------------------------------------------------
// Gap 1: parseToolBreakdown / isPerToolStat via getSummaryForTask
// ---------------------------------------------------------------------------

describe('parseToolBreakdown (via getSummaryForTask)', () => {
  function getSummaryWithBreakdown(toolBreakdown: string | null) {
    const db = createGetSummaryMockDb({
      latestRecordReturn: makeLatestRecord(toolBreakdown),
      aggregateReturn: makeAggregateRow(),
    });
    const repo = new SessionRepository(db);
    return repo.getSummaryForTask('task-1');
  }

  it('returns a typed PerToolStat[] for a valid full row', () => {
    const row = JSON.stringify([
      { toolName: 'Bash', callCount: 3, totalDurationMs: 1500, interruptedCount: 1, costUsd: 0.01, inputTokens: 200, outputTokens: 50 },
    ]);
    const summary = getSummaryWithBreakdown(row);
    expect(summary).not.toBeNull();
    expect(summary!.toolBreakdown).toEqual([
      { toolName: 'Bash', callCount: 3, totalDurationMs: 1500, interruptedCount: 1, costUsd: 0.01, inputTokens: 200, outputTokens: 50 },
    ]);
  });

  it('accepts a valid row with optional fields absent (cost/tokens omitted)', () => {
    const row = JSON.stringify([
      { toolName: 'Read', callCount: 2, totalDurationMs: 200, interruptedCount: 0 },
    ]);
    const summary = getSummaryWithBreakdown(row);
    expect(summary!.toolBreakdown).toEqual([
      { toolName: 'Read', callCount: 2, totalDurationMs: 200, interruptedCount: 0 },
    ]);
    // Optional fields must be absent, not null, when the writer omitted them.
    expect(summary!.toolBreakdown[0].costUsd).toBeUndefined();
    expect(summary!.toolBreakdown[0].inputTokens).toBeUndefined();
    expect(summary!.toolBreakdown[0].outputTokens).toBeUndefined();
  });

  it('silently drops a row whose required field toolName is not a string', () => {
    const row = JSON.stringify([
      { toolName: 42, callCount: 1, totalDurationMs: 100, interruptedCount: 0 },
    ]);
    const summary = getSummaryWithBreakdown(row);
    expect(summary!.toolBreakdown).toEqual([]);
  });

  it('silently drops a row whose required field callCount is missing', () => {
    const row = JSON.stringify([
      { toolName: 'Bash', totalDurationMs: 100, interruptedCount: 0 },
    ]);
    const summary = getSummaryWithBreakdown(row);
    expect(summary!.toolBreakdown).toEqual([]);
  });

  it('silently drops a row where optional field costUsd is wrong type (e.g. string "free")', () => {
    const row = JSON.stringify([
      { toolName: 'Bash', callCount: 1, totalDurationMs: 100, interruptedCount: 0, costUsd: 'free' },
    ]);
    const summary = getSummaryWithBreakdown(row);
    expect(summary!.toolBreakdown).toEqual([]);
  });

  it('returns [] for non-array JSON (e.g. an object "{}")', () => {
    const summary = getSummaryWithBreakdown('{}');
    expect(summary!.toolBreakdown).toEqual([]);
  });

  it('returns [] for invalid JSON', () => {
    const summary = getSummaryWithBreakdown('{not valid json');
    expect(summary!.toolBreakdown).toEqual([]);
  });

  it('returns [] for null input (session predates the tool_breakdown column)', () => {
    const summary = getSummaryWithBreakdown(null);
    expect(summary!.toolBreakdown).toEqual([]);
  });

  it('returns [] for empty string input', () => {
    // Empty string is falsy - parseToolBreakdown returns [] without attempting JSON.parse.
    const summary = getSummaryWithBreakdown('');
    expect(summary!.toolBreakdown).toEqual([]);
  });

  it('drops only invalid rows and keeps valid ones in a mixed array', () => {
    const row = JSON.stringify([
      { toolName: 'Bash', callCount: 2, totalDurationMs: 800, interruptedCount: 0 },
      { toolName: 999, callCount: 1, totalDurationMs: 100, interruptedCount: 0 }, // invalid
      { toolName: 'Read', callCount: 1, totalDurationMs: 50, interruptedCount: 0 },
    ]);
    const summary = getSummaryWithBreakdown(row);
    expect(summary!.toolBreakdown).toHaveLength(2);
    expect(summary!.toolBreakdown.map((tool) => tool.toolName)).toEqual(['Bash', 'Read']);
  });

  it('returns null (not an empty summary) when no session record has metrics', () => {
    // latestRecord = undefined simulates a task with no completed sessions.
    const db = createGetSummaryMockDb({
      latestRecordReturn: undefined,
      aggregateReturn: makeAggregateRow(),
    });
    const repo = new SessionRepository(db);
    const summary = repo.getSummaryForTask('task-1');
    expect(summary).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Gap 2: updateMetrics -> getSummaryForTask round-trip (tool_breakdown column)
// ---------------------------------------------------------------------------

describe('updateMetrics tool_breakdown round-trip', () => {
  it('passes the toolBreakdown JSON string to the UPDATE statement', () => {
    const { db, capturedParams } = createUpdateMetricsMockDb();
    const repo = new SessionRepository(db);

    const toolBreakdownJson = JSON.stringify([
      { toolName: 'Bash', callCount: 3, totalDurationMs: 900, interruptedCount: 1 },
    ]);

    repo.updateMetrics('session-1', {
      totalCostUsd: 0.05,
      totalInputTokens: 1000,
      totalOutputTokens: 200,
      modelId: 'claude-opus-4',
      modelDisplayName: 'Claude Opus 4',
      totalDurationMs: 3600000,
      toolCallCount: 3,
      toolBreakdown: toolBreakdownJson,
      compactionCount: 2,
    });

    expect(capturedParams).toHaveLength(1);
    // Positional order in the UPDATE: cost, input, output, modelId, displayName,
    // duration, count, breakdown, compactionCount, id.
    const params = capturedParams[0];
    expect(params[7]).toBe(toolBreakdownJson);
    expect(params[8]).toBe(2);
    expect(params[9]).toBe('session-1');
  });

  it('passes NULL for toolBreakdown when no tool events exist', () => {
    const { db, capturedParams } = createUpdateMetricsMockDb();
    const repo = new SessionRepository(db);

    repo.updateMetrics('session-1', {
      totalCostUsd: 0.01,
      totalInputTokens: 500,
      totalOutputTokens: 100,
      modelId: 'claude-opus-4',
      modelDisplayName: 'Claude Opus 4',
      totalDurationMs: 1000,
      toolCallCount: 0,
      toolBreakdown: null,
      compactionCount: 0,
    });

    const params = capturedParams[0];
    expect(params[7]).toBeNull();
    expect(params[8]).toBe(0);
  });

  it('getSummaryForTask returns toolBreakdown [] when the stored value is NULL', () => {
    // End-to-end check: NULL stored in DB -> getSummaryForTask returns [].
    const db = createGetSummaryMockDb({
      latestRecordReturn: makeLatestRecord(null),
      aggregateReturn: makeAggregateRow(),
    });
    const repo = new SessionRepository(db);
    const summary = repo.getSummaryForTask('task-1');
    expect(summary!.toolBreakdown).toEqual([]);
  });

  it('getSummaryForTask returns deserialized toolBreakdown array when a valid JSON string is stored', () => {
    const toolBreakdownJson = JSON.stringify([
      { toolName: 'Bash', callCount: 5, totalDurationMs: 2500, interruptedCount: 2, costUsd: 0.02 },
      { toolName: 'Read', callCount: 3, totalDurationMs: 300, interruptedCount: 0 },
    ]);
    const db = createGetSummaryMockDb({
      latestRecordReturn: makeLatestRecord(toolBreakdownJson),
      aggregateReturn: makeAggregateRow(),
    });
    const repo = new SessionRepository(db);
    const summary = repo.getSummaryForTask('task-1');
    expect(summary!.toolBreakdown).toHaveLength(2);
    expect(summary!.toolBreakdown[0]).toMatchObject({ toolName: 'Bash', callCount: 5, costUsd: 0.02 });
    expect(summary!.toolBreakdown[1]).toMatchObject({ toolName: 'Read', callCount: 3 });
  });
});

// ---------------------------------------------------------------------------
// Lifetime rollup wiring: getSummaryForTask maps the SUMmed aggregate
// (cost / duration / compactions) and the latest-per-lineage token row onto the
// summary, instead of taking cost/tokens/duration from the latest record.
// (The SQL aggregation itself - SUM across rows, window-function token dedup -
// runs only against real better-sqlite3, which can't load under vitest; it is
// validated empirically and by the transcript-usage test below. This locks the
// field mapping so a future refactor can't silently revert to "latest record".)
// ---------------------------------------------------------------------------

describe('getSummaryForTask lifetime rollup mapping', () => {
  it('maps SUMmed cost/duration/compactions and latest-per-lineage tokens, not the latest record snapshot', () => {
    // The latest record carries SNAPSHOT values that must NOT be used for the
    // lifetime totals: its cost (0.05) / duration (3600000) / tokens (1000/200)
    // differ from the aggregate + token rows the rollup must read instead.
    const db = createGetSummaryMockDb({
      latestRecordReturn: makeLatestRecord(null),
      aggregateReturn: {
        total_cost_usd: 0.42, // SUM across runs, > the latest record's 0.05
        total_duration_ms: 9_000_000,
        total_tool_calls: 17,
        total_compactions: 3,
        total_lines_added: 120,
        total_lines_removed: 40,
        max_files_changed: 9,
        earliest_started_at: '2026-04-01T08:00:00Z',
        latest_ended_at: '2026-04-03T12:00:00Z',
      },
      tokensReturn: makeTokensRow(50_000, 8_000), // latest-per-lineage SUM
    });
    const repo = new SessionRepository(db);
    const summary = repo.getSummaryForTask('task-1');

    expect(summary).not.toBeNull();
    // Lifetime aggregates (NOT the latest record's snapshot values).
    expect(summary!.totalCostUsd).toBe(0.42);
    expect(summary!.durationMs).toBe(9_000_000);
    expect(summary!.compactionCount).toBe(3);
    expect(summary!.toolCallCount).toBe(17);
    expect(summary!.linesAdded).toBe(120);
    expect(summary!.linesRemoved).toBe(40);
    expect(summary!.filesChanged).toBe(9);
    // Tokens come from the dedicated latest-per-lineage token query.
    expect(summary!.totalInputTokens).toBe(50_000);
    expect(summary!.totalOutputTokens).toBe(8_000);
    // Timeline spans the whole task life; model/exit still from the latest run.
    expect(summary!.startedAt).toBe('2026-04-01T08:00:00Z');
    expect(summary!.exitedAt).toBe('2026-04-03T12:00:00Z');
    expect(summary!.modelDisplayName).toBe('Claude Opus 4');
  });

  it('defaults compactionCount to 0 when no compactions were recorded', () => {
    const db = createGetSummaryMockDb({
      latestRecordReturn: makeLatestRecord(null),
      aggregateReturn: makeAggregateRow(), // total_compactions: 0
      tokensReturn: makeTokensRow(),
    });
    const repo = new SessionRepository(db);
    expect(repo.getSummaryForTask('task-1')!.compactionCount).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Hole 1 (DB layer): SessionRepository.updateTranscriptTokens
// Pins the SQL shape and positional binding for the transcript-token-only
// UPDATE that `refineTranscriptTokens` calls fire-and-forget after a session ends.
// ---------------------------------------------------------------------------

/** Captures both the SQL string and the `.run()` params for every `prepare()` call. */
function createSqlCaptureMockDb(): {
  db: Database.Database;
  capturedCalls: Array<{ sql: string; params: unknown[] }>;
} {
  const capturedCalls: Array<{ sql: string; params: unknown[] }> = [];
  const db = {
    prepare: vi.fn((sql: string) => ({
      run: vi.fn((...params: unknown[]) => {
        capturedCalls.push({ sql, params });
        return { changes: 1 };
      }),
      get: vi.fn(),
      all: vi.fn(() => []),
    })),
  } as unknown as Database.Database;
  return { db, capturedCalls };
}

describe('SessionRepository.updateTranscriptTokens', () => {
  it('binds totalInputTokens, totalOutputTokens, and record id in that positional order', () => {
    const { db, capturedCalls } = createSqlCaptureMockDb();
    const repo = new SessionRepository(db);

    repo.updateTranscriptTokens('session-abc', {
      totalInputTokens: 50_000,
      totalOutputTokens: 8_000,
    });

    expect(capturedCalls).toHaveLength(1);
    // UPDATE sessions SET total_input_tokens = ?, total_output_tokens = ? WHERE id = ?
    expect(capturedCalls[0].params[0]).toBe(50_000);
    expect(capturedCalls[0].params[1]).toBe(8_000);
    expect(capturedCalls[0].params[2]).toBe('session-abc');
  });

  it('issues an UPDATE touching ONLY the two token columns, not cost or model', () => {
    const { db, capturedCalls } = createSqlCaptureMockDb();
    const repo = new SessionRepository(db);

    repo.updateTranscriptTokens('session-abc', {
      totalInputTokens: 1,
      totalOutputTokens: 2,
    });

    const { sql } = capturedCalls[0];
    expect(sql).toMatch(/UPDATE\s+sessions/i);
    expect(sql).toMatch(/total_input_tokens\s*=/i);
    expect(sql).toMatch(/total_output_tokens\s*=/i);
    // Must NOT touch cost, model, or other metric columns - those are owned by
    // updateMetrics / captureSessionMetrics.
    expect(sql).not.toMatch(/total_cost_usd/i);
    expect(sql).not.toMatch(/model_id/i);
    expect(sql).not.toMatch(/tool_call_count/i);
  });
});

// ---------------------------------------------------------------------------
// Hole 2 (DB layer): SessionRepository.updateTranscriptToolCounts
// Pins the SQL shape, positional binding, and the backfill-only-when-empty
// guard for the transcript-tool-count-only UPDATE that
// `refineTranscriptToolCounts` calls fire-and-forget after a session ends.
// ---------------------------------------------------------------------------

describe('SessionRepository.updateTranscriptToolCounts', () => {
  it('binds toolCallCount, the serialized breakdown, and record id in that positional order', () => {
    const { db, capturedCalls } = createSqlCaptureMockDb();
    const repo = new SessionRepository(db);

    repo.updateTranscriptToolCounts('session-abc', {
      toolCallCount: 5,
      toolBreakdown: [{ toolName: 'Bash', callCount: 5, totalDurationMs: 0, interruptedCount: 0 }],
    });

    expect(capturedCalls).toHaveLength(1);
    // UPDATE sessions SET tool_call_count = ?, tool_breakdown = ? WHERE id = ? AND (...)
    expect(capturedCalls[0].params[0]).toBe(5);
    expect(capturedCalls[0].params[1]).toBe(
      JSON.stringify([{ toolName: 'Bash', callCount: 5, totalDurationMs: 0, interruptedCount: 0 }]),
    );
    expect(capturedCalls[0].params[2]).toBe('session-abc');
  });

  it('writes a NULL breakdown when toolBreakdown is empty', () => {
    const { db, capturedCalls } = createSqlCaptureMockDb();
    const repo = new SessionRepository(db);

    repo.updateTranscriptToolCounts('session-abc', { toolCallCount: 0, toolBreakdown: [] });

    expect(capturedCalls[0].params[1]).toBeNull();
  });

  it('issues an UPDATE touching ONLY the two tool-count columns, not cost/tokens/model', () => {
    const { db, capturedCalls } = createSqlCaptureMockDb();
    const repo = new SessionRepository(db);

    repo.updateTranscriptToolCounts('session-abc', { toolCallCount: 1, toolBreakdown: [] });

    const { sql } = capturedCalls[0];
    expect(sql).toMatch(/UPDATE\s+sessions/i);
    expect(sql).toMatch(/tool_call_count\s*=/i);
    expect(sql).toMatch(/tool_breakdown\s*=/i);
    expect(sql).not.toMatch(/total_cost_usd/i);
    expect(sql).not.toMatch(/model_id/i);
    expect(sql).not.toMatch(/total_input_tokens/i);
    expect(sql).not.toMatch(/total_output_tokens/i);
  });

  it('carries the backfill-only-when-empty guard so a healthy live count is never overwritten', () => {
    const { db, capturedCalls } = createSqlCaptureMockDb();
    const repo = new SessionRepository(db);

    repo.updateTranscriptToolCounts('session-abc', { toolCallCount: 1, toolBreakdown: [] });

    const { sql } = capturedCalls[0];
    expect(sql).toMatch(/WHERE\s+id\s*=\s*\?\s*AND\s*\(\s*tool_call_count\s+IS\s+NULL\s+OR\s+tool_call_count\s*=\s*0\s*\)/i);
  });
});

// ---------------------------------------------------------------------------
// Hole 3: listAllSummaries lifetime rollup
// The aggregation itself now runs in SQL (one CTE query, generalizing
// getSummaryForTask with GROUP BY task_id) and is pinned against a REAL
// database - including the lineage token dedup, MAX files_changed, and the
// parity with getSummaryForTask - in session-repository-summaries.test.ts.
// What the mock level can still meaningfully pin is (a) the SQL carrying the
// load-bearing aggregation clauses and (b) the aggregate-row -> SessionSummary
// mapping.
// ---------------------------------------------------------------------------

/** Row shape as returned by the single aggregated .all() query inside
 *  listAllSummaries (one row per task). */
type ListAllSummariesAggregateRow = {
  task_id: string;
  task_created_at: string;
  total_cost_usd: number;
  total_duration_ms: number;
  total_tool_calls: number;
  total_compactions: number;
  total_lines_added: number;
  total_lines_removed: number;
  max_files_changed: number;
  earliest_started_at: string;
  latest_ended_at: string | null;
  total_input_tokens: number;
  total_output_tokens: number;
  agent_session_id: string | null;
  record_id: string;
  model_display_name: string | null;
  exit_code: number | null;
  tool_breakdown: string | null;
};

function createListAllSummariesMockDb(rows: ListAllSummariesAggregateRow[]): {
  db: Database.Database;
  capturedSql: string[];
} {
  const capturedSql: string[] = [];
  const db = {
    prepare: vi.fn((sql: string) => {
      capturedSql.push(sql);
      return {
        run: vi.fn(() => ({ changes: 0 })),
        get: vi.fn(),
        all: vi.fn(() => rows),
      };
    }),
  } as unknown as Database.Database;
  return { db, capturedSql };
}

describe('listAllSummaries lifetime rollup (SQL-aggregated)', () => {
  const aggregateRow: ListAllSummariesAggregateRow = {
    task_id: 'task-1',
    task_created_at: '2026-04-01T09:00:00Z',
    total_cost_usd: 0.45,
    total_duration_ms: 3_500,
    total_tool_calls: 10,
    total_compactions: 3,
    total_lines_added: 80,
    total_lines_removed: 17,
    max_files_changed: 7,
    earliest_started_at: '2026-03-30T08:00:00Z',
    latest_ended_at: '2026-04-03T13:00:00Z',
    total_input_tokens: 60_000,
    total_output_tokens: 9_500,
    agent_session_id: 'agt-1',
    record_id: 'rec-1',
    model_display_name: 'Claude Opus 4',
    exit_code: 0,
    tool_breakdown: JSON.stringify([
      { toolName: 'Bash', callCount: 2, totalDurationMs: 500, interruptedCount: 0 },
    ]),
  };

  it('maps the one-row-per-task aggregate onto SessionSummary keyed by task id', () => {
    const { db } = createListAllSummariesMockDb([aggregateRow]);
    const repo = new SessionRepository(db);
    const summaries = repo.listAllSummaries();

    expect(Object.keys(summaries)).toEqual(['task-1']);
    expect(summaries['task-1']).toEqual({
      sessionId: 'agt-1',
      totalCostUsd: 0.45,
      totalInputTokens: 60_000,
      totalOutputTokens: 9_500,
      modelDisplayName: 'Claude Opus 4',
      durationMs: 3_500,
      toolCallCount: 10,
      compactionCount: 3,
      linesAdded: 80,
      linesRemoved: 17,
      filesChanged: 7,
      taskCreatedAt: '2026-04-01T09:00:00Z',
      startedAt: '2026-03-30T08:00:00Z',
      exitedAt: '2026-04-03T13:00:00Z',
      exitCode: 0,
      toolBreakdown: [{ toolName: 'Bash', callCount: 2, totalDurationMs: 500, interruptedCount: 0 }],
    });
  });

  it('falls back to the record id as sessionId and tolerates NULL scalars', () => {
    const { db } = createListAllSummariesMockDb([{
      ...aggregateRow,
      agent_session_id: null,
      model_display_name: null,
      exit_code: null,
      latest_ended_at: null,
      tool_breakdown: null,
    }]);
    const repo = new SessionRepository(db);
    const summary = repo.listAllSummaries()['task-1'];

    expect(summary.sessionId).toBe('rec-1');
    expect(summary.modelDisplayName).toBe('');
    expect(summary.exitCode).toBeNull();
    expect(summary.exitedAt).toBeNull();
    expect(summary.toolBreakdown).toEqual([]);
  });

  it('issues ONE query whose SQL carries the load-bearing aggregation clauses', () => {
    const { db, capturedSql } = createListAllSummariesMockDb([]);
    const repo = new SessionRepository(db);
    repo.listAllSummaries();

    expect(capturedSql).toHaveLength(1);
    const sql = capturedSql[0];
    // Costed rows only, grouped per task.
    expect(sql).toMatch(/WHERE\s+total_cost_usd\s+IS\s+NOT\s+NULL/i);
    expect(sql).toMatch(/GROUP\s+BY\s+task_id/i);
    // Token dedup: latest row per session lineage, NOT a flat SUM (a flat SUM
    // would double-count a session resumed across restarts).
    expect(sql).toMatch(/PARTITION\s+BY\s+task_id\s*,\s*COALESCE\s*\(\s*agent_session_id\s*,\s*id\s*\)/i);
    // files_changed is MAX (branch-cumulative), the rest are SUMs.
    expect(sql).toMatch(/MAX\s*\(\s*COALESCE\s*\(\s*files_changed\s*,\s*0\s*\)\s*\)/i);
    // Timeline spans the whole task life; suspended stands in for exited.
    expect(sql).toMatch(/MIN\s*\(\s*started_at\s*\)/i);
    expect(sql).toMatch(/MAX\s*\(\s*COALESCE\s*\(\s*exited_at\s*,\s*suspended_at\s*\)\s*\)/i);
  });
});

describe('SessionRepository.setTaskGitStats', () => {
  /** better-sqlite3's real `db.transaction(fn)` returns a function that just
   *  invokes `fn` synchronously - this stub mirrors that. */
  function createMockDb(): { db: Database.Database; runCalls: Array<{ sql: string; params: unknown[] }> } {
    const runCalls: Array<{ sql: string; params: unknown[] }> = [];
    const db = {
      prepare: vi.fn((sql: string) => ({
        run: vi.fn((...params: unknown[]) => {
          runCalls.push({ sql, params });
          return { changes: 1 };
        }),
      })),
      transaction: vi.fn((fn: (...args: unknown[]) => unknown) => (...args: unknown[]) => fn(...args)),
    } as unknown as Database.Database;
    return { db, runCalls };
  }

  it('writes the canonical record and zeros every other record id (one row per task lineage)', () => {
    const { db, runCalls } = createMockDb();
    const repository = new SessionRepository(db);

    repository.setTaskGitStats(['record-A', 'record-B', 'record-C'], 'record-B', {
      linesAdded: 10,
      linesRemoved: 2,
      filesChanged: 3,
    });

    expect(runCalls).toHaveLength(2);
    expect(runCalls[0].sql).toMatch(/UPDATE\s+sessions/i);
    expect(runCalls[0].sql).toMatch(/WHERE\s+id\s*=\s*\?/i);
    expect(runCalls[0].params).toEqual([10, 2, 3, 'record-B']);

    expect(runCalls[1].sql).toMatch(/id\s+IN\s*\(\?,\s*\?\)/i);
    // The zeroed values are literals in the SQL, not bound params - only the
    // sibling ids are bound.
    expect(runCalls[1].params).toEqual(['record-A', 'record-C']);
  });

  it('is a no-op sibling write when the canonical id is the only record for the task', () => {
    const { db, runCalls } = createMockDb();
    const repository = new SessionRepository(db);

    repository.setTaskGitStats(['record-B'], 'record-B', {
      linesAdded: 1,
      linesRemoved: 1,
      filesChanged: 1,
    });

    expect(runCalls).toHaveLength(1);
  });
});
