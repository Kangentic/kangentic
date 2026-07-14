import { describe, it, expect, vi } from 'vitest';
import type Database from 'better-sqlite3';
import {
  ConversationUsageStore,
  extractTurnUsageRecords,
  type TurnUsageOwner,
} from '../../src/main/retrieval/conversation/conversation-usage-store';
import { ConversationIndexer } from '../../src/main/retrieval/conversation/conversation-indexer';
import type { SessionRecord, TranscriptEntry, TranscriptTurnUsage } from '../../src/shared/types';

/**
 * The durable per-turn usage ledger. better-sqlite3 cannot load under vitest, so
 * `conversation_turn_usage` is modeled by a hand-rolled fake `Database` whose
 * INSERT ... ON CONFLICT is a Map upsert keyed by turn_uuid (last write wins,
 * exactly as the real ON CONFLICT DO UPDATE) and whose SELECTs filter that Map.
 * This covers the upsert/dedup/re-point decisions and the read shapes without a
 * real DB; the "survives JSONL pruning" durability comes structurally from the
 * data living in the DB at all (written at index time, not read live from the
 * transcript), which the indexer-integration test exercises.
 */

interface FakeUsageRow {
  turn_uuid: string;
  agent_session_id: string | null;
  session_id: string | null;
  task_id: string | null;
  model: string | null;
  ts: number | null;
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens: number;
  cache_read_input_tokens: number;
  recorded_at: string;
}

function tsKey(row: FakeUsageRow): number {
  return row.ts === null ? Number.NEGATIVE_INFINITY : row.ts;
}

function makeUsageDb(): { db: Database.Database; table: Map<string, FakeUsageRow>; prepare: ReturnType<typeof vi.fn> } {
  const table = new Map<string, FakeUsageRow>();
  const prepare = vi.fn((sql: string) => ({
    run: (...args: unknown[]) => {
      if (sql.includes('INSERT INTO conversation_turn_usage')) {
        const [
          turnUuid,
          agentSessionId,
          sessionId,
          taskId,
          model,
          ts,
          inputTokens,
          outputTokens,
          cacheCreation,
          cacheRead,
          recordedAt,
        ] = args;
        // ON CONFLICT(turn_uuid) DO UPDATE == Map.set (last write wins).
        table.set(String(turnUuid), {
          turn_uuid: String(turnUuid),
          agent_session_id: (agentSessionId as string | null) ?? null,
          session_id: (sessionId as string | null) ?? null,
          task_id: (taskId as string | null) ?? null,
          model: (model as string | null) ?? null,
          ts: (ts as number | null) ?? null,
          input_tokens: Number(inputTokens),
          output_tokens: Number(outputTokens),
          cache_creation_input_tokens: Number(cacheCreation),
          cache_read_input_tokens: Number(cacheRead),
          recorded_at: String(recordedAt),
        });
        return { changes: 1, lastInsertRowid: 0 };
      }
      throw new Error(`unexpected run SQL: ${sql}`);
    },
    all: (...args: unknown[]) => {
      const rows = [...table.values()];
      if (sql.includes('WHERE task_id = ?')) {
        return rows.filter((row) => row.task_id === args[0]).sort((a, b) => tsKey(a) - tsKey(b));
      }
      if (sql.includes('WHERE session_id = ?')) {
        return rows.filter((row) => row.session_id === args[0]).sort((a, b) => tsKey(a) - tsKey(b));
      }
      if (sql.includes('WHERE turn_uuid IN')) {
        const wanted = new Set(args.map((value) => String(value)));
        return rows.filter((row) => wanted.has(row.turn_uuid));
      }
      if (sql.includes('GROUP BY bucketStartMs')) {
        // The grouped burn-rate read, bucket-only output. Mirrors the real
        // SQL's bind order: turn window (session_tokens CTE), cost window,
        // groupMs twice (bucket expression), turn window again (outer scan).
        // This mock has no usage_history table, so allocatedCostUsd is
        // always 0 here; the allocation join is pinned against a REAL
        // database in conversation-usage-cost-allocation.test.ts.
        const hasSince = sql.includes('ts >= ?');
        const hasUntil = sql.includes('ts < ?');
        const windowLength = (hasSince ? 1 : 0) + (hasUntil ? 1 : 0);
        const costLength = (sql.includes('session_started_at >= ?') ? 1 : 0)
          + (sql.includes('session_started_at < ?') ? 1 : 0);
        const groupMs = Number(args[windowLength + costLength]);
        expect(args[windowLength + costLength + 1]).toBe(args[windowLength + costLength]);
        const sinceMs = hasSince ? Number(args[0]) : null;
        const untilMs = hasUntil ? Number(args[hasSince ? 1 : 0]) : null;
        const grouped = new Map<number, {
          bucketStartMs: number;
          inputTokens: number;
          outputTokens: number;
          cacheCreationTokens: number;
          cacheReadTokens: number;
          turnCount: number;
          allocatedCostUsd: number;
        }>();
        for (const row of rows) {
          if (row.ts === null) continue;
          if (sinceMs !== null && row.ts < sinceMs) continue;
          if (untilMs !== null && row.ts >= untilMs) continue;
          const bucketStartMs = Math.floor(row.ts / groupMs) * groupMs;
          let entry = grouped.get(bucketStartMs);
          if (!entry) {
            entry = {
              bucketStartMs,
              inputTokens: 0,
              outputTokens: 0,
              cacheCreationTokens: 0,
              cacheReadTokens: 0,
              turnCount: 0,
              allocatedCostUsd: 0,
            };
            grouped.set(bucketStartMs, entry);
          }
          entry.inputTokens += row.input_tokens;
          entry.outputTokens += row.output_tokens;
          entry.cacheCreationTokens += row.cache_creation_input_tokens;
          entry.cacheReadTokens += row.cache_read_input_tokens;
          entry.turnCount += 1;
        }
        return [...grouped.values()].sort((a, b) => a.bucketStartMs - b.bucketStartMs);
      }
      throw new Error(`unexpected all SQL: ${sql}`);
    },
  }));
  const db = {
    prepare,
    transaction: (fn: () => unknown) => fn,
  } as unknown as Database.Database;
  return { db, table, prepare };
}

function usage(overrides: Partial<TranscriptTurnUsage> = {}): TranscriptTurnUsage {
  return {
    inputTokens: 10,
    outputTokens: 20,
    cacheCreationInputTokens: 5,
    cacheReadInputTokens: 100,
    ...overrides,
  };
}

const owner: TurnUsageOwner = {
  agentSessionId: 'agent-abc',
  sessionId: 'session-1',
  taskId: 'task-1',
};
const now = '2026-07-01T00:00:00Z';

describe('extractTurnUsageRecords', () => {
  it('keeps only assistant turns that reported usage, carrying uuid/ts/model', () => {
    const entries: TranscriptEntry[] = [
      { kind: 'user', uuid: 'u1', ts: 1, text: 'hi' },
      { kind: 'assistant', uuid: 'a1', ts: 2, model: 'claude-opus-4-8', usage: usage(), blocks: [] },
      // Assistant turn with no usage (e.g. a non-Claude adapter) is skipped.
      { kind: 'assistant', uuid: 'a2', ts: 3, blocks: [{ type: 'text', text: 'no usage' }] },
      { kind: 'tool_result', uuid: 't1', ts: 4, toolUseId: 'x', content: 'result' },
      { kind: 'system', uuid: 's1', ts: 5, subtype: 'command', text: '/code-review' },
    ];
    const records = extractTurnUsageRecords(entries);
    expect(records).toEqual([
      { turnUuid: 'a1', ts: 2, model: 'claude-opus-4-8', usage: usage() },
    ]);
  });

  it('defaults a missing model to null', () => {
    const entries: TranscriptEntry[] = [
      { kind: 'assistant', uuid: 'a1', ts: 2, usage: usage(), blocks: [] },
    ];
    expect(extractTurnUsageRecords(entries)[0].model).toBeNull();
  });

  it('returns an empty list when no turn reported usage', () => {
    const entries: TranscriptEntry[] = [
      { kind: 'user', uuid: 'u1', ts: 1, text: 'hi' },
      { kind: 'assistant', uuid: 'a1', ts: 2, blocks: [{ type: 'text', text: 'hello' }] },
    ];
    expect(extractTurnUsageRecords(entries)).toEqual([]);
  });
});

describe('ConversationUsageStore.recordTurns', () => {
  it('persists one row per turn, read back by task and by session', () => {
    const { db } = makeUsageDb();
    const store = new ConversationUsageStore(db);
    store.recordTurns(
      owner,
      [
        { turnUuid: 'a1', ts: 2, model: 'claude-opus-4-8', usage: usage({ outputTokens: 20 }) },
        { turnUuid: 'a2', ts: 4, model: 'claude-opus-4-8', usage: usage({ outputTokens: 40 }) },
      ],
      now,
    );

    const byTask = store.getForTask('task-1');
    expect(byTask.map((record) => record.turnUuid)).toEqual(['a1', 'a2']); // ts ASC
    expect(byTask[0].usage.outputTokens).toBe(20);
    expect(byTask[1].usage.outputTokens).toBe(40);
    expect(byTask[0].sessionId).toBe('session-1');
    expect(byTask[0].agentSessionId).toBe('agent-abc');
    expect(byTask[0].recordedAt).toBe(now);

    expect(store.getForSession('session-1')).toHaveLength(2);
    expect(store.getForSession('other-session')).toHaveLength(0);
  });

  it('preserves the raw token components (not a single sum)', () => {
    const { db } = makeUsageDb();
    const store = new ConversationUsageStore(db);
    store.recordTurns(
      owner,
      [{ turnUuid: 'a1', ts: 2, model: null, usage: usage({ inputTokens: 1, outputTokens: 2, cacheCreationInputTokens: 3, cacheReadInputTokens: 4 }) }],
      now,
    );
    expect(store.getForTask('task-1')[0].usage).toEqual({
      inputTokens: 1,
      outputTokens: 2,
      cacheCreationInputTokens: 3,
      cacheReadInputTokens: 4,
    });
  });

  it('dedups a replayed turn (same uuid) to one row and re-points it to the latest owner', () => {
    const { db, table } = makeUsageDb();
    const store = new ConversationUsageStore(db);

    // Parent session records the turn.
    store.recordTurns(
      { agentSessionId: 'agent-parent', sessionId: 'session-parent', taskId: 'task-1' },
      [{ turnUuid: 'shared-turn', ts: 2, model: 'claude-opus-4-8', usage: usage() }],
      '2026-07-01T00:00:00Z',
    );
    // A --resume replays the SAME turn verbatim under a new owning session.
    store.recordTurns(
      { agentSessionId: 'agent-child', sessionId: 'session-child', taskId: 'task-1' },
      [{ turnUuid: 'shared-turn', ts: 2, model: 'claude-opus-4-8', usage: usage() }],
      '2026-07-01T01:00:00Z',
    );

    // One physical row, not two: task totals never double-count a shared turn.
    expect(table.size).toBe(1);
    const byTask = store.getForTask('task-1');
    expect(byTask).toHaveLength(1);
    // Attribution re-points to the latest writer.
    expect(byTask[0].sessionId).toBe('session-child');
    expect(byTask[0].agentSessionId).toBe('agent-child');
    expect(byTask[0].recordedAt).toBe('2026-07-01T01:00:00Z');
  });

  it('is a no-op on an empty batch and prepares no SQL', () => {
    const { db, prepare } = makeUsageDb();
    new ConversationUsageStore(db).recordTurns(owner, [], now);
    expect(prepare).not.toHaveBeenCalled();
  });

  it('getForTurns returns only the requested uuids', () => {
    const { db } = makeUsageDb();
    const store = new ConversationUsageStore(db);
    store.recordTurns(
      owner,
      [
        { turnUuid: 'a1', ts: 2, model: null, usage: usage() },
        { turnUuid: 'a2', ts: 3, model: null, usage: usage() },
        { turnUuid: 'a3', ts: 4, model: null, usage: usage() },
      ],
      now,
    );
    const picked = store.getForTurns(['a1', 'a3']).map((record) => record.turnUuid).sort();
    expect(picked).toEqual(['a1', 'a3']);
    expect(store.getForTurns([])).toEqual([]);
  });
});

// --- Indexer integration: indexSession populates the ledger from parsed usage --

interface FakeIndexerDbState {
  sessionRecord: SessionRecord;
  usageInserts: unknown[][];
}

function makeIndexerFakeDb(state: FakeIndexerDbState): Database.Database {
  return {
    prepare(sql: string) {
      return {
        get: (..._args: unknown[]) => {
          if (sql.includes('FROM sessions WHERE id = ?')) return state.sessionRecord;
          if (sql.includes('FROM memory_index_state WHERE corpus')) return undefined;
          throw new Error(`unexpected get SQL: ${sql}`);
        },
        all: (..._args: unknown[]) => {
          // upsertDocument's existing-chunk probe: no prior chunks.
          if (sql.includes('FROM memory_chunks') && sql.includes('content_hash')) return [];
          throw new Error(`unexpected all SQL: ${sql}`);
        },
        run: (...args: unknown[]) => {
          if (sql.includes('INSERT INTO conversation_turn_usage')) {
            state.usageInserts.push(args);
            return { changes: 1, lastInsertRowid: 0 };
          }
          if (sql.includes('INSERT INTO memory_index_state')) return { changes: 1, lastInsertRowid: 0 };
          if (sql.includes('INSERT INTO memory_chunks')) return { changes: 1, lastInsertRowid: 1 };
          if (sql.includes('DELETE FROM memory_chunks WHERE id IN')) return { changes: 0 };
          throw new Error(`unexpected run SQL: ${sql}`);
        },
      };
    },
    transaction: (fn: () => unknown) => fn,
  } as unknown as Database.Database;
}

function makeRecord(): SessionRecord {
  return {
    id: 'session-1',
    task_id: 'task-1',
    session_type: 'claude_agent',
    agent_session_id: 'agent-abc',
    cwd: '/work/project',
  } as unknown as SessionRecord;
}

describe('ConversationIndexer.indexSession populates the usage ledger', () => {
  it('records per-turn usage for assistant turns that reported it', async () => {
    const state: FakeIndexerDbState = { sessionRecord: makeRecord(), usageInserts: [] };
    const entries: TranscriptEntry[] = [
      { kind: 'user', uuid: 'u1', ts: 10, text: 'hi' },
      { kind: 'assistant', uuid: 'a1', ts: 20, model: 'claude-opus-4-8', usage: usage({ outputTokens: 42 }), blocks: [{ type: 'text', text: 'hello' }] },
    ];
    const indexer = new ConversationIndexer({
      getDb: () => makeIndexerFakeDb(state),
      getAdapter: () => ({ displayName: 'Claude', parseTranscript: vi.fn(async () => ({ entries, sourcePath: null })) }),
      stat: () => null,
      now: () => now,
      // One chunk so upsertDocument runs; usage comes from ENTRIES, not chunks.
      chunker: () => [
        { seq: 0, text: 'x', contentHash: 'h', tokenEstimate: 1, role: 'assistant', tsStart: 20, tsEnd: 20, turnUuidStart: 'a1', turnUuidEnd: 'a1' },
      ],
      chunkerVersion: 1,
    });

    expect(await indexer.indexSession('project-1', 'session-1')).toBe('indexed');
    // One usage insert for a1; INSERT args: (turn_uuid, agent_session_id,
    // session_id, task_id, model, ts, input, output, cacheCreate, cacheRead, recorded_at).
    expect(state.usageInserts).toHaveLength(1);
    const insert = state.usageInserts[0];
    expect(insert[0]).toBe('a1'); // turn_uuid
    expect(insert[1]).toBe('agent-abc'); // agent_session_id
    expect(insert[2]).toBe('session-1'); // session_id
    expect(insert[3]).toBe('task-1'); // task_id
    expect(insert[4]).toBe('claude-opus-4-8'); // model
    expect(insert[7]).toBe(42); // output_tokens
  });

  it('writes no usage rows when no turn reported usage', async () => {
    const state: FakeIndexerDbState = { sessionRecord: makeRecord(), usageInserts: [] };
    const entries: TranscriptEntry[] = [
      { kind: 'user', uuid: 'u1', ts: 10, text: 'hi' },
      { kind: 'assistant', uuid: 'a1', ts: 20, blocks: [{ type: 'text', text: 'hello' }] },
    ];
    const indexer = new ConversationIndexer({
      getDb: () => makeIndexerFakeDb(state),
      getAdapter: () => ({ displayName: 'Claude', parseTranscript: vi.fn(async () => ({ entries, sourcePath: null })) }),
      stat: () => null,
      now: () => now,
      chunker: () => [
        { seq: 0, text: 'x', contentHash: 'h', tokenEstimate: 1, role: 'assistant', tsStart: 20, tsEnd: 20, turnUuidStart: 'a1', turnUuidEnd: 'a1' },
      ],
      chunkerVersion: 1,
    });

    expect(await indexer.indexSession('project-1', 'session-1')).toBe('indexed');
    expect(state.usageInserts).toHaveLength(0);
  });
});

describe('ConversationUsageStore.getGroupedUsageSince', () => {
  const FIVE_MIN = 5 * 60_000;

  it('groups turns into fixed UTC buckets (bucket-only output), oldest first', () => {
    const { db } = makeUsageDb();
    const store = new ConversationUsageStore(db);
    // Two turns inside the same 5-min bucket, one in the next bucket.
    store.recordTurns(
      owner,
      [
        { turnUuid: 'a1', ts: FIVE_MIN * 100 + 1_000, model: 'model-x', usage: usage({ inputTokens: 10, outputTokens: 20 }) },
        { turnUuid: 'a2', ts: FIVE_MIN * 100 + 2_000, model: 'model-x', usage: usage({ inputTokens: 30, outputTokens: 40 }) },
        { turnUuid: 'a3', ts: FIVE_MIN * 101 + 500, model: 'model-x', usage: usage({ inputTokens: 5, outputTokens: 5 }) },
      ],
      now,
    );

    const groups = store.getGroupedUsageSince(null, FIVE_MIN);
    expect(groups).toHaveLength(2);
    expect(groups[0].bucketStartMs).toBe(FIVE_MIN * 100);
    expect(groups[0].inputTokens).toBe(40);
    expect(groups[0].outputTokens).toBe(60);
    expect(groups[0].turnCount).toBe(2);
    expect(groups[1].bucketStartMs).toBe(FIVE_MIN * 101);
    expect(groups[1].turnCount).toBe(1);
  });

  it('excludes NULL-ts turns (they cannot be placed on a time axis)', () => {
    const { db } = makeUsageDb();
    const store = new ConversationUsageStore(db);
    store.recordTurns(
      owner,
      [
        { turnUuid: 'a1', ts: null, model: 'model-x', usage: usage() },
        { turnUuid: 'a2', ts: FIVE_MIN * 10, model: 'model-x', usage: usage() },
      ],
      now,
    );

    const groups = store.getGroupedUsageSince(null, FIVE_MIN);
    expect(groups).toHaveLength(1);
    expect(groups[0].bucketStartMs).toBe(FIVE_MIN * 10);
  });

  it('applies the sinceMs lower bound when provided', () => {
    const { db } = makeUsageDb();
    const store = new ConversationUsageStore(db);
    store.recordTurns(
      owner,
      [
        { turnUuid: 'a1', ts: FIVE_MIN * 10, model: 'model-x', usage: usage() },
        { turnUuid: 'a2', ts: FIVE_MIN * 20, model: 'model-x', usage: usage() },
      ],
      now,
    );

    const groups = store.getGroupedUsageSince(FIVE_MIN * 15, FIVE_MIN);
    expect(groups).toHaveLength(1);
    expect(groups[0].bucketStartMs).toBe(FIVE_MIN * 20);
  });

  it('merges turns from different sessions and models into one bucket row', () => {
    const { db } = makeUsageDb();
    const store = new ConversationUsageStore(db);
    store.recordTurns(owner, [
      { turnUuid: 'a1', ts: FIVE_MIN * 10 + 100, model: 'model-x', usage: usage() },
      { turnUuid: 'a2', ts: FIVE_MIN * 10 + 200, model: 'model-y', usage: usage() },
    ], now);
    store.recordTurns({ ...owner, sessionId: 'session-2' }, [
      { turnUuid: 'a3', ts: FIVE_MIN * 10 + 300, model: 'model-x', usage: usage() },
    ], now);

    // Bucket-only output: one row for the shared bucket, three turns summed.
    // (Per-session cost allocation happens INSIDE the SQL; pinned against a
    // real database in conversation-usage-cost-allocation.test.ts.)
    const groups = store.getGroupedUsageSince(null, FIVE_MIN);
    expect(groups).toHaveLength(1);
    expect(groups[0].turnCount).toBe(3);
    expect(groups[0].inputTokens).toBe(30);
  });
});
