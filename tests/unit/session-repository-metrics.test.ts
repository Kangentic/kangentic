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
// Verifies the JS-level aggregation logic for a task that has two rows sharing
// the same agent_session_id (a `--resume` pair) plus a row with a distinct one.
// Token dedup must use the latest-row-per-lineage strategy, NOT a flat SUM.
// All other fields (cost/duration/compactions/tool calls/lines/files_changed)
// must aggregate across ALL rows, not just the latest.
// ---------------------------------------------------------------------------

/** Row shape as returned by the single .all() query inside listAllSummaries. */
type ListAllSummariesRow = {
  task_id: string;
  task_created_at: string;
  agent_session_id: string | null;
  record_id: string;
  total_cost_usd: number | null;
  total_input_tokens: number | null;
  total_output_tokens: number | null;
  model_display_name: string | null;
  total_duration_ms: number | null;
  exit_code: number | null;
  started_at: string;
  exited_at: string | null;
  suspended_at: string | null;
  tool_call_count: number | null;
  lines_added: number | null;
  lines_removed: number | null;
  files_changed: number | null;
  tool_breakdown: string | null;
  compaction_count: number | null;
  row_num: number;
};

function createListAllSummariesMockDb(rows: ListAllSummariesRow[]): Database.Database {
  return {
    prepare: vi.fn((_sql: string) => ({
      run: vi.fn(() => ({ changes: 0 })),
      get: vi.fn(),
      all: vi.fn(() => rows),
    })),
  } as unknown as Database.Database;
}

describe('listAllSummaries lifetime rollup', () => {
  it('deduplicates tokens by latest-row-per-lineage while summing cost/duration/compactions across all rows and taking MAX files_changed', () => {
    // Three rows for task-1, ordered started_at DESC (as the SQL ORDER BY clause does):
    //   Row A (row_num=1, latest of lineage agt-1): tokens 50 000 / 8 000 -> count
    //   Row B (row_num=2, earlier of lineage agt-1): tokens 20 000 / 3 000 -> skip (same lineage)
    //   Row C (row_num=3, distinct lineage agt-2): tokens 10 000 / 1 500 -> count
    const rowA: ListAllSummariesRow = {
      task_id: 'task-1',
      task_created_at: '2026-04-01T09:00:00Z',
      agent_session_id: 'agt-1',
      record_id: 'rec-1',
      total_cost_usd: 0.30,
      total_input_tokens: 50_000,
      total_output_tokens: 8_000,
      model_display_name: 'Claude Opus 4',
      total_duration_ms: 2_000,
      exit_code: 0,
      started_at: '2026-04-03T12:00:00Z',
      exited_at: '2026-04-03T13:00:00Z',
      suspended_at: null,
      tool_call_count: 5,
      lines_added: 50,
      lines_removed: 10,
      files_changed: 3,
      tool_breakdown: null,
      compaction_count: 2,
      row_num: 1,
    };
    const rowB: ListAllSummariesRow = {
      task_id: 'task-1',
      task_created_at: '2026-04-01T09:00:00Z',
      agent_session_id: 'agt-1', // same lineage as rowA
      record_id: 'rec-2',
      total_cost_usd: 0.10,
      total_input_tokens: 20_000, // must NOT add to token total (same lineage, not latest)
      total_output_tokens: 3_000,
      model_display_name: 'Claude Opus 4',
      total_duration_ms: 1_000,
      exit_code: 0,
      started_at: '2026-04-01T10:00:00Z',
      exited_at: '2026-04-01T11:00:00Z',
      suspended_at: null,
      tool_call_count: 3,
      lines_added: 20,
      lines_removed: 5,
      files_changed: 7, // MAX across all rows
      tool_breakdown: null,
      compaction_count: 1,
      row_num: 2,
    };
    const rowC: ListAllSummariesRow = {
      task_id: 'task-1',
      task_created_at: '2026-04-01T09:00:00Z',
      agent_session_id: 'agt-2', // distinct lineage
      record_id: 'rec-3',
      total_cost_usd: 0.05,
      total_input_tokens: 10_000,
      total_output_tokens: 1_500,
      model_display_name: 'Claude Opus 4',
      total_duration_ms: 500,
      exit_code: 0,
      started_at: '2026-03-30T08:00:00Z',
      exited_at: '2026-03-30T09:00:00Z',
      suspended_at: null,
      tool_call_count: 2,
      lines_added: 10,
      lines_removed: 2,
      files_changed: 1,
      tool_breakdown: null,
      compaction_count: 0,
      row_num: 3,
    };

    const db = createListAllSummariesMockDb([rowA, rowB, rowC]);
    const repo = new SessionRepository(db);
    const summaries = repo.listAllSummaries();

    expect(Object.keys(summaries)).toHaveLength(1);
    const summary = summaries['task-1'];
    expect(summary).toBeDefined();

    // Tokens: only the LATEST row per lineage is counted.
    // agt-1: rowA wins (row_num=1, started_at later) -> 50 000 / 8 000
    // agt-2: rowC (only row) -> 10 000 / 1 500
    // WRONG flat SUM would be 50 000 + 20 000 + 10 000 = 80 000 / 12 500
    expect(summary.totalInputTokens).toBe(60_000);
    expect(summary.totalOutputTokens).toBe(9_500);

    // Cost / duration / compactions / tool calls / lines: SUM across ALL rows
    expect(summary.totalCostUsd).toBeCloseTo(0.45, 10);
    expect(summary.durationMs).toBe(3_500);
    expect(summary.compactionCount).toBe(3);
    expect(summary.toolCallCount).toBe(10);
    expect(summary.linesAdded).toBe(80);
    expect(summary.linesRemoved).toBe(17);

    // files_changed is MAX, not SUM
    expect(summary.filesChanged).toBe(7);

    // Timeline spans the full task life
    expect(summary.startedAt).toBe('2026-03-30T08:00:00Z');
    expect(summary.exitedAt).toBe('2026-04-03T13:00:00Z');
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
