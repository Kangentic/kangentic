import { describe, it, expect, vi, afterEach } from 'vitest';
import type Database from 'better-sqlite3';
import {
  ConversationUsageStore,
  extractTurnUsageRecords,
  TURNS_PER_TRANSACTION,
  type TurnUsageOwner,
} from '../../src/main/retrieval/conversation/conversation-usage-store';
import { runProjectMigrations } from '../../src/main/db/migrations/project-schema';
import { ConversationIndexer } from '../../src/main/retrieval/conversation/conversation-indexer';
import type { TranscriptEntry, TranscriptTurnUsage } from '../../src/shared/types';
import { openTestDatabase } from './helpers/test-database';

/**
 * The durable per-turn usage ledger, on a real in-memory better-sqlite3 database
 * with the project migrations applied, so the upsert/dedup/re-point decisions and
 * every read shape run the shipped SQL. The "survives JSONL pruning" durability
 * comes structurally from the data living in the DB at all (written at index
 * time, not read live from the transcript), which the indexer-integration test
 * exercises.
 */

const openDatabases: Database.Database[] = [];

afterEach(() => {
  for (const database of openDatabases.splice(0)) database.close();
});

/**
 * A migrated in-memory project database. `prepared` records the SQL prepared
 * after the migrations ran, so a test can pin that a call prepares none.
 */
function makeUsageDb(): { db: Database.Database; prepared: string[]; rowCount: () => number } {
  const prepared: string[] = [];
  const db = openTestDatabase(':memory:', { prepared });
  openDatabases.push(db);
  runProjectMigrations(db);
  prepared.length = 0;
  return {
    db,
    prepared,
    rowCount: () => (db.prepare('SELECT COUNT(*) AS count FROM conversation_turn_usage').get() as { count: number }).count,
  };
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
  it('leaves an unchanged turn unwritten, and rewrites one whose usage changed', () => {
    // Every agent turn records the whole transcript's turns again; before, each
    // replay rewrote every row of the conversation.
    const { db } = makeUsageDb();
    const store = new ConversationUsageStore(db);
    const recordedAt = (turnUuid: string): string => (db
      .prepare('SELECT recorded_at AS recordedAt FROM conversation_turn_usage WHERE turn_uuid = ?')
      .get(turnUuid) as { recordedAt: string }).recordedAt;
    const turns = [
      { turnUuid: 'a1', ts: 2, model: 'model-x', usage: usage() },
      { turnUuid: 'a2', ts: 4, model: 'model-x', usage: usage() },
    ];
    store.recordTurns(owner, turns, '2026-07-01T00:00:00.000Z');

    store.recordTurns(owner, [turns[0], { ...turns[1], usage: usage({ outputTokens: 99 }) }], '2026-07-02T00:00:00.000Z');

    expect(recordedAt('a1')).toBe('2026-07-01T00:00:00.000Z');
    expect(recordedAt('a2')).toBe('2026-07-02T00:00:00.000Z');
  });

  it('records a batch larger than one transaction in full', () => {
    const { db } = makeUsageDb();
    const store = new ConversationUsageStore(db);
    const turns = Array.from({ length: TURNS_PER_TRANSACTION * 2 + 5 }, (_, index) => ({
      turnUuid: `turn-${index}`, ts: index, model: 'model-x', usage: usage(),
    }));

    store.recordTurns(owner, turns, now);

    expect(store.getForTask('task-1')).toHaveLength(turns.length);
  });

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
    const { db, rowCount } = makeUsageDb();
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
    expect(rowCount()).toBe(1);
    const byTask = store.getForTask('task-1');
    expect(byTask).toHaveLength(1);
    // Attribution re-points to the latest writer.
    expect(byTask[0].sessionId).toBe('session-child');
    expect(byTask[0].agentSessionId).toBe('agent-child');
    expect(byTask[0].recordedAt).toBe('2026-07-01T01:00:00Z');
  });

  it('is a no-op on an empty batch and prepares no SQL', () => {
    const { db, prepared } = makeUsageDb();
    new ConversationUsageStore(db).recordTurns(owner, [], now);
    expect(prepared).toEqual([]);
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

  it('round-trips the subagent columns, and leaves them null for a main-thread turn', () => {
    const { db } = makeUsageDb();
    const store = new ConversationUsageStore(db);
    store.recordTurns(
      owner,
      [
        { turnUuid: 'driver-1', ts: 1, model: 'm', usage: usage() },
        {
          turnUuid: 'sub:agent-a1:msg_01', ts: 2, model: 'm', usage: usage(),
          subagentId: 'agent-a1', agentType: 'review-finder', spawnDepth: 1, parentToolUseId: 'toolu_01AAA',
        },
      ],
      now,
    );

    // The driver row's NULLs are what keep every pre-existing reader meaning
    // exactly what it meant before these columns existed.
    const [driver] = store.getForTask('task-1');
    expect(driver.turnUuid).toBe('driver-1');
    expect(driver.subagentId).toBeNull();
    expect(driver.agentType).toBeNull();
    expect(driver.spawnDepth).toBeNull();
    expect(driver.parentToolUseId).toBeNull();

    const [subagent] = store.getSubagentTotalsByType(null, null, 'task-1');
    expect(subagent.agentType).toBe('review-finder');
    expect(subagent.turnCount).toBe(1);
    expect(subagent.subagentCount).toBe(1);
  });
});

describe('ConversationUsageStore subagent-vs-main-thread split', () => {
  const owner = { agentSessionId: 'agent-1', sessionId: 'session-1', taskId: 'task-1' };
  const now = '2026-07-01T00:00:00Z';

  function seed() {
    const { db } = makeUsageDb();
    const store = new ConversationUsageStore(db);
    store.recordTurns(
      owner,
      [
        { turnUuid: 'driver-1', ts: 10, model: 'm', usage: { inputTokens: 100, outputTokens: 40, cacheCreationInputTokens: 5, cacheReadInputTokens: 900 } },
        { turnUuid: 'driver-2', ts: 20, model: 'm', usage: { inputTokens: 60, outputTokens: 20, cacheCreationInputTokens: 3, cacheReadInputTokens: 700 } },
        {
          turnUuid: 'sub:agent-a1:msg_01', ts: 11, model: 'm',
          usage: { inputTokens: 5000, outputTokens: 2000, cacheCreationInputTokens: 300, cacheReadInputTokens: 900_000 },
          subagentId: 'agent-a1', agentType: 'review-finder', spawnDepth: 1, parentToolUseId: 'toolu_01AAA',
        },
        {
          turnUuid: 'sub:agent-a2:msg_02', ts: 12, model: 'm',
          usage: { inputTokens: 4000, outputTokens: 1500, cacheCreationInputTokens: 200, cacheReadInputTokens: 1_500_000 },
          subagentId: 'agent-a2', agentType: 'review-finder', spawnDepth: 1, parentToolUseId: 'toolu_01BBB',
        },
        {
          turnUuid: 'sub:agent-b1:msg_03', ts: 13, model: 'm',
          usage: { inputTokens: 700, outputTokens: 200, cacheCreationInputTokens: 50, cacheReadInputTokens: 60_000 },
          subagentId: 'agent-b1', agentType: 'test-builder', spawnDepth: 2, parentToolUseId: 'toolu_01CCC',
        },
      ],
      now,
    );
    return store;
  }

  it('excludes subagent rows from every main-thread reader', () => {
    const store = seed();
    // Each of these meant "the driver" by construction before subagent rows
    // existed; they have to keep meaning it, or the history stops being
    // comparable with no marker where it changed.
    expect(store.getForTask('task-1').map((row) => row.turnUuid)).toEqual(['driver-1', 'driver-2']);
    expect(store.getForSession('session-1').map((row) => row.turnUuid)).toEqual(['driver-1', 'driver-2']);
    expect(store.getForTurns(['driver-1', 'sub:agent-a1:msg_01']).map((row) => row.turnUuid)).toEqual(['driver-1']);
  });

  it('groups subagent rows by type, counting distinct subagents', () => {
    const store = seed();

    const breakdown = store.getSubagentTotalsByType(null, null, 'task-1');

    expect(breakdown).toEqual([
      // Heaviest cache read first: that is the number fan-out tuning turns on.
      // Nested means spawn depth 2 or deeper: both review-finders sit at depth 1,
      // the test-builder at depth 2.
      { agentType: 'review-finder', inputTokens: 9000, outputTokens: 3500, cacheCreationTokens: 500, cacheReadTokens: 2_400_000, turnCount: 2, subagentCount: 2, nestedTurnCount: 0, nestedSubagentCount: 0, maxSpawnDepth: 1 },
      { agentType: 'test-builder', inputTokens: 700, outputTokens: 200, cacheCreationTokens: 50, cacheReadTokens: 60_000, turnCount: 1, subagentCount: 1, nestedTurnCount: 1, nestedSubagentCount: 1, maxSpawnDepth: 2 },
    ]);
  });

  it('windows the breakdown on ts', () => {
    const store = seed();
    expect(store.getSubagentTotalsByType(13, null, 'task-1').map((row) => row.agentType)).toEqual(['test-builder']);
    expect(store.getSubagentTotalsByType(null, 13, 'task-1').map((row) => row.agentType)).toEqual(['review-finder']);
  });

  it('reports nothing for a task with no fan-out, rather than a zero row', () => {
    const store = seed();
    expect(store.getSubagentTotalsByType(null, null, 'task-other')).toEqual([]);
  });
});

// --- Indexer integration: indexSession populates the ledger from parsed usage --

interface LedgerRow {
  turn_uuid: string;
  agent_session_id: string | null;
  session_id: string | null;
  task_id: string | null;
  model: string | null;
  output_tokens: number;
}

describe('ConversationIndexer.indexSession populates the usage ledger', () => {
  /** An indexer over a migrated database holding the one session it indexes. */
  function indexerFor(entries: TranscriptEntry[]) {
    const { db } = makeUsageDb();
    // The ledger is not foreign-keyed to the board, so the session is the only row it needs.
    db.exec('PRAGMA foreign_keys = OFF');
    db.prepare(
      `INSERT INTO sessions (id, task_id, session_type, agent_session_id, command, cwd, status, started_at)
       VALUES ('session-1', 'task-1', 'claude_agent', 'agent-abc', 'claude', '/work/project', 'running', ?)`,
    ).run(now);
    const indexer = new ConversationIndexer({
      getDb: () => db,
      getAdapter: () => ({ displayName: 'Claude', parseTranscript: vi.fn(async () => ({ entries, sourcePath: null })) }),
      stat: () => null,
      now: () => now,
      // One chunk so upsertDocument runs; usage comes from ENTRIES, not chunks.
      chunker: () => [
        { seq: 0, text: 'x', contentHash: 'h', tokenEstimate: 1, role: 'assistant', tsStart: 20, tsEnd: 20, turnUuidStart: 'a1', turnUuidEnd: 'a1' },
      ],
      chunkerVersion: 1,
    });
    const ledger = (): LedgerRow[] => db
      .prepare('SELECT turn_uuid, agent_session_id, session_id, task_id, model, output_tokens FROM conversation_turn_usage ORDER BY turn_uuid')
      .all() as LedgerRow[];
    return { indexer, ledger };
  }

  it('records per-turn usage for assistant turns that reported it', async () => {
    const { indexer, ledger } = indexerFor([
      { kind: 'user', uuid: 'u1', ts: 10, text: 'hi' },
      { kind: 'assistant', uuid: 'a1', ts: 20, model: 'claude-opus-4-8', usage: usage({ outputTokens: 42 }), blocks: [{ type: 'text', text: 'hello' }] },
    ]);

    expect(await indexer.indexSession('project-1', 'session-1')).toBe('indexed');

    expect(ledger()).toEqual([{
      turn_uuid: 'a1',
      agent_session_id: 'agent-abc',
      session_id: 'session-1',
      task_id: 'task-1',
      model: 'claude-opus-4-8',
      output_tokens: 42,
    }]);
  });

  it('writes no usage rows when no turn reported usage', async () => {
    const { indexer, ledger } = indexerFor([
      { kind: 'user', uuid: 'u1', ts: 10, text: 'hi' },
      { kind: 'assistant', uuid: 'a1', ts: 20, blocks: [{ type: 'text', text: 'hello' }] },
    ]);

    expect(await indexer.indexSession('project-1', 'session-1')).toBe('indexed');

    expect(ledger()).toEqual([]);
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

describe('ConversationUsageStore.getEarliestTurnMs', () => {
  // Backs UsageDashboardStats.earliestTurnMs: the Tokens tile's "per-turn
  // capture starts <date>" note, which fires when the selected range reaches
  // back further than this. NOT window-scoped - it answers how far back real
  // token counts go at all.
  it('returns the oldest ts across every turn, ignoring a NULL ts', () => {
    const { db } = makeUsageDb();
    const store = new ConversationUsageStore(db);
    store.recordTurns(owner, [
      { turnUuid: 'a1', ts: 5000, model: 'model-x', usage: usage() },
      // A NULL ts (no timestamp on the transcript entry) cannot be the
      // earliest anything; it must not win a bare MIN() or poison the read.
      { turnUuid: 'a2', ts: null, model: 'model-x', usage: usage() },
      { turnUuid: 'a3', ts: 2000, model: 'model-x', usage: usage() },
    ], now);

    expect(store.getEarliestTurnMs()).toBe(2000);
  });

  it('returns null when the ledger has no rows', () => {
    const { db } = makeUsageDb();
    const store = new ConversationUsageStore(db);
    expect(store.getEarliestTurnMs()).toBeNull();
  });

  it('returns null when every row has a NULL ts', () => {
    const { db } = makeUsageDb();
    const store = new ConversationUsageStore(db);
    store.recordTurns(owner, [
      { turnUuid: 'a1', ts: null, model: 'model-x', usage: usage() },
    ], now);

    expect(store.getEarliestTurnMs()).toBeNull();
  });
});
