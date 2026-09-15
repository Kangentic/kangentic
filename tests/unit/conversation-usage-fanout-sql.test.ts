/**
 * EMPIRICAL tests for the subagent readers against a REAL SQLite engine:
 * `getSubagentTotalsByType`'s depth aggregates and `getTaskFanOuts`' recursive
 * resolution of `parent_tool_use_id` through `turn_spawn_links`.
 *
 * These cannot live in `conversation-usage-store.test.ts`. That suite models the
 * ledger with a hand-rolled fake `Database` whose `prepare` matches on SQL
 * substrings, which is right for the upsert and filter decisions it covers but
 * cannot EXECUTE anything - and the whole risk here is in the SQL itself: a
 * recursive CTE, a `COUNT(DISTINCT CASE WHEN ...)`, and a `GROUP BY` over a LEFT
 * JOIN that must keep unresolved rows rather than drop them.
 *
 * node:sqlite rather than better-sqlite3, for the reason task-ordering-sql.test.ts
 * records: better-sqlite3 is compiled for Electron's Node ABI, so a suite gated on
 * it skips everywhere, CI included, and a skipped test is not coverage.
 */

import { describe, it, expect } from 'vitest';
import { runProjectMigrations } from '../../src/main/db/migrations/project-schema';
import {
  ConversationUsageStore,
  extractTurnSpawnLinks,
} from '../../src/main/retrieval/conversation/conversation-usage-store';
import type { TranscriptEntry } from '../../src/shared/types';
import type DatabaseType from 'better-sqlite3';

type SqliteModule = typeof import('node:sqlite');
let sqlite: SqliteModule | null = null;
try {
  sqlite = await import('node:sqlite');
} catch {
  sqlite = null;
}

const describeWithSqlite = sqlite ? describe : describe.skip;

/** See task-ordering-sql.test.ts - same adapter, same non-nesting caveat. */
function adaptDatabase(database: InstanceType<SqliteModule['DatabaseSync']>): DatabaseType.Database {
  const adapter = {
    exec: (sql: string) => database.exec(sql),
    prepare: (sql: string) => database.prepare(sql),
    pragma: (statement: string) => database.prepare(`PRAGMA ${statement}`).all(),
    transaction: <Args extends unknown[], Result>(body: (...args: Args) => Result) =>
      (...args: Args): Result => {
        database.exec('BEGIN');
        try {
          const result = body(...args);
          database.exec('COMMIT');
          return result;
        } catch (error) {
          database.exec('ROLLBACK');
          throw error;
        }
      },
  };
  return adapter as unknown as DatabaseType.Database;
}

const TASK_ID = 'task-1';
const NOW = '2026-09-15T00:00:00.000Z';

function makeStore(): { store: ConversationUsageStore; db: DatabaseType.Database } {
  const db = adaptDatabase(new sqlite!.DatabaseSync(':memory:'));
  runProjectMigrations(db);
  return { store: new ConversationUsageStore(db), db };
}

/** A main-thread ledger row. Written directly: the point here is the readers. */
function insertDriverTurn(db: DatabaseType.Database, turnUuid: string, ts: number): void {
  db.prepare(
    `INSERT INTO conversation_turn_usage
       (turn_uuid, agent_session_id, session_id, task_id, model, ts,
        input_tokens, output_tokens, cache_creation_input_tokens,
        cache_read_input_tokens, recorded_at)
     VALUES (?, 'agent-session', 'session-1', ?, 'model-a', ?, 100, 50, 10, 20, ?)`,
  ).run(turnUuid, TASK_ID, ts, NOW);
}

interface SubagentTurnSpec {
  subagentId: string;
  messageId: string;
  agentType: string | null;
  spawnDepth: number | null;
  parentToolUseId: string | null;
  ts: number;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
}

function insertSubagentTurn(db: DatabaseType.Database, spec: SubagentTurnSpec): void {
  db.prepare(
    `INSERT INTO conversation_turn_usage
       (turn_uuid, agent_session_id, session_id, task_id, model, ts,
        input_tokens, output_tokens, cache_creation_input_tokens,
        cache_read_input_tokens, recorded_at,
        subagent_id, agent_type, spawn_depth, parent_tool_use_id)
     VALUES (?, 'agent-session', 'session-1', ?, 'model-a', ?, ?, ?, 0, ?, ?, ?, ?, ?, ?)`,
  ).run(
    `sub:${spec.subagentId}:${spec.messageId}`,
    TASK_ID,
    spec.ts,
    spec.inputTokens ?? 10,
    spec.outputTokens ?? 20,
    spec.cacheReadTokens ?? 1000,
    NOW,
    spec.subagentId,
    spec.agentType,
    spec.spawnDepth,
    spec.parentToolUseId,
  );
}

/**
 * The MAIN-transcript half of the join. Pure, so it needs no DB - but it lives
 * here rather than in the fake-DB suite because it is the other end of the same
 * mechanism the fan-out tests above exercise, and a regression here produces
 * exactly the `(unlinked)` output those tests treat as a legitimate state. Split
 * across two files, nothing would fail.
 */
describe('extractTurnSpawnLinks', () => {
  function assistantEntry(uuid: string, blocks: TranscriptEntry extends { blocks: infer B } ? B : never): TranscriptEntry {
    return { kind: 'assistant', uuid, ts: 1000, model: 'model-a', blocks };
  }

  it('emits one link per spawn-tool block, keyed to the emitting turn', () => {
    const links = extractTurnSpawnLinks(
      [
        assistantEntry('turn-1', [
          { type: 'text', text: 'fanning out' },
          { type: 'tool_use', id: 'toolu_1', name: 'Task', input: {} },
          { type: 'tool_use', id: 'toolu_2', name: 'Task', input: {} },
        ]),
      ],
      'Task',
    );

    expect(links).toEqual([
      { toolUseId: 'toolu_1', turnUuid: 'turn-1' },
      { toolUseId: 'toolu_2', turnUuid: 'turn-1' },
    ]);
  });

  it('emits a link for a turn that reported NO usage', () => {
    // The main-path mirror of the subagent parser's decoupling: this entry
    // produces no ledger row (extractTurnUsageRecords requires `usage`), and a
    // link dropped here is dropped identically on every re-walk.
    const entry = assistantEntry('turn-1', [{ type: 'tool_use', id: 'toolu_1', name: 'Task', input: {} }]);
    expect(entry.kind === 'assistant' && entry.usage).toBeFalsy();

    expect(extractTurnSpawnLinks([entry], 'Task')).toEqual([
      { toolUseId: 'toolu_1', turnUuid: 'turn-1' },
    ]);
  });

  it('ignores tool_use blocks that are not the spawn tool', () => {
    const links = extractTurnSpawnLinks(
      [
        assistantEntry('turn-1', [
          { type: 'tool_use', id: 'toolu_read', name: 'Read', input: {} },
          { type: 'tool_use', id: 'toolu_bash', name: 'Bash', input: {} },
        ]),
      ],
      'Task',
    );

    // Otherwise the table carries every tool call ever made to serve the
    // handful that are ever referenced.
    expect(links).toEqual([]);
  });

  it('records nothing when the adapter declares no spawn tool', () => {
    // An agent with no subagent concept costs one comparison and writes no rows.
    const links = extractTurnSpawnLinks(
      [assistantEntry('turn-1', [{ type: 'tool_use', id: 'toolu_1', name: 'Task', input: {} }])],
      undefined,
    );

    expect(links).toEqual([]);
  });

  it('skips a blank tool-use id rather than writing an unusable key', () => {
    // tool_use_id is the PRIMARY KEY, and '' would collide across every turn
    // that had one.
    const links = extractTurnSpawnLinks(
      [
        assistantEntry('turn-1', [
          { type: 'tool_use', id: '', name: 'Task', input: {} },
          { type: 'tool_use', id: 'toolu_real', name: 'Task', input: {} },
        ]),
      ],
      'Task',
    );

    expect(links).toEqual([{ toolUseId: 'toolu_real', turnUuid: 'turn-1' }]);
  });

  it('ignores non-assistant entries', () => {
    const links = extractTurnSpawnLinks(
      [
        { kind: 'user', uuid: 'turn-0', ts: 1, text: 'go' },
        { kind: 'tool_result', uuid: 'turn-2', ts: 2, toolUseId: 'toolu_1', content: 'done' },
      ],
      'Task',
    );

    expect(links).toEqual([]);
  });
});

describeWithSqlite('getSubagentTotalsByType depth aggregates', () => {
  it('counts nested turns and agents as a SUBSET of the totals, not an addend', () => {
    const { store, db } = makeStore();
    // Two agents of one type at depth 1, one at depth 2.
    insertSubagentTurn(db, { subagentId: 'a1', messageId: 'm1', agentType: 'review-finder', spawnDepth: 1, parentToolUseId: 'toolu_1', ts: 10 });
    insertSubagentTurn(db, { subagentId: 'a2', messageId: 'm1', agentType: 'review-finder', spawnDepth: 1, parentToolUseId: 'toolu_2', ts: 11 });
    insertSubagentTurn(db, { subagentId: 'a3', messageId: 'm1', agentType: 'review-finder', spawnDepth: 2, parentToolUseId: 'toolu_3', ts: 12 });
    insertSubagentTurn(db, { subagentId: 'a3', messageId: 'm2', agentType: 'review-finder', spawnDepth: 2, parentToolUseId: 'toolu_3', ts: 13 });

    const [row] = store.getSubagentTotalsByType(null, null, TASK_ID);

    expect(row.agentType).toBe('review-finder');
    expect(row.turnCount).toBe(4);
    expect(row.subagentCount).toBe(3);
    // The nested agent contributed 2 of the 4 turns and 1 of the 3 agents.
    expect(row.nestedTurnCount).toBe(2);
    expect(row.nestedSubagentCount).toBe(1);
    expect(row.maxSpawnDepth).toBe(2);
  });

  it('reports maxSpawnDepth null when no row recorded a depth, rather than 0', () => {
    const { store, db } = makeStore();
    // A corrupt sidecar loses spawnDepth permanently; null is a real bucket.
    insertSubagentTurn(db, { subagentId: 'a1', messageId: 'm1', agentType: null, spawnDepth: null, parentToolUseId: null, ts: 10 });

    const [row] = store.getSubagentTotalsByType(null, null, TASK_ID);

    expect(row.maxSpawnDepth).toBeNull();
    expect(row.nestedTurnCount).toBe(0);
    expect(row.nestedSubagentCount).toBe(0);
  });
});

describeWithSqlite('getTaskFanOuts', () => {
  it('groups depth-1 subagents under the driver turn that spawned them', () => {
    const { store, db } = makeStore();
    insertDriverTurn(db, 'driver-1', 1000);
    insertDriverTurn(db, 'driver-2', 2000);
    // Two subagents from driver-1, one from driver-2.
    store.recordSpawnLinks(
      [
        { toolUseId: 'toolu_1', turnUuid: 'driver-1' },
        { toolUseId: 'toolu_2', turnUuid: 'driver-1' },
        { toolUseId: 'toolu_3', turnUuid: 'driver-2' },
      ],
      NOW,
    );
    insertSubagentTurn(db, { subagentId: 'a1', messageId: 'm1', agentType: 'review-finder', spawnDepth: 1, parentToolUseId: 'toolu_1', ts: 1100, outputTokens: 500 });
    insertSubagentTurn(db, { subagentId: 'a2', messageId: 'm1', agentType: 'Explore', spawnDepth: 1, parentToolUseId: 'toolu_2', ts: 1200, outputTokens: 500 });
    insertSubagentTurn(db, { subagentId: 'a3', messageId: 'm1', agentType: 'test-builder', spawnDepth: 1, parentToolUseId: 'toolu_3', ts: 2100, outputTokens: 1 });

    const fanOuts = store.getTaskFanOuts(TASK_ID);

    expect(fanOuts).toHaveLength(2);
    const first = fanOuts.find((row) => row.driverTurnUuid === 'driver-1')!;
    expect(first.subagentCount).toBe(2);
    expect(first.turnCount).toBe(2);
    expect(first.driverTs).toBe(1000);
    expect([...first.agentTypes].sort()).toEqual(['Explore', 'review-finder']);
    const second = fanOuts.find((row) => row.driverTurnUuid === 'driver-2')!;
    expect(second.subagentCount).toBe(1);
  });

  it('folds a depth-2 subagent into the fan-out of the DRIVER turn, two hops up', () => {
    const { store, db } = makeStore();
    insertDriverTurn(db, 'driver-1', 1000);
    // driver-1 spawns a1; a1 itself spawns a2. The nested agent's parent link
    // points at a1's own turn, not at the driver, so resolving it needs the
    // recursive term rather than a single join.
    store.recordSpawnLinks(
      [
        { toolUseId: 'toolu_parent', turnUuid: 'driver-1' },
        { toolUseId: 'toolu_nested', turnUuid: 'sub:a1:m1' },
      ],
      NOW,
    );
    insertSubagentTurn(db, { subagentId: 'a1', messageId: 'm1', agentType: 'review-finder', spawnDepth: 1, parentToolUseId: 'toolu_parent', ts: 1100 });
    insertSubagentTurn(db, { subagentId: 'a2', messageId: 'm1', agentType: 'Explore', spawnDepth: 2, parentToolUseId: 'toolu_nested', ts: 1200 });

    const fanOuts = store.getTaskFanOuts(TASK_ID);

    expect(fanOuts).toHaveLength(1);
    expect(fanOuts[0].driverTurnUuid).toBe('driver-1');
    expect(fanOuts[0].subagentCount).toBe(2);
    expect(fanOuts[0].maxSpawnDepth).toBe(2);
    expect([...fanOuts[0].agentTypes].sort()).toEqual(['Explore', 'review-finder']);
  });

  it('reports subagents with no resolvable parent under a null driver rather than dropping them', () => {
    const { store, db } = makeStore();
    insertDriverTurn(db, 'driver-1', 1000);
    store.recordSpawnLinks([{ toolUseId: 'toolu_1', turnUuid: 'driver-1' }], NOW);
    insertSubagentTurn(db, { subagentId: 'a1', messageId: 'm1', agentType: 'review-finder', spawnDepth: 1, parentToolUseId: 'toolu_1', ts: 1100 });
    // Indexed before spawn links existed: real tokens, no link to resolve.
    insertSubagentTurn(db, { subagentId: 'a2', messageId: 'm1', agentType: 'Explore', spawnDepth: 1, parentToolUseId: 'toolu_missing', ts: 1200 });
    // A corrupt sidecar loses the parent id entirely.
    insertSubagentTurn(db, { subagentId: 'a3', messageId: 'm1', agentType: null, spawnDepth: null, parentToolUseId: null, ts: 1300 });

    const fanOuts = store.getTaskFanOuts(TASK_ID);
    const unlinked = fanOuts.find((row) => row.driverTurnUuid === null);

    expect(unlinked).toBeDefined();
    expect(unlinked!.subagentCount).toBe(2);
    expect(unlinked!.driverTs).toBeNull();
    // The whole point of keeping the bucket: these rows still sum to the totals
    // the per-type breakdown reports over the same task.
    const fanOutTurns = fanOuts.reduce((total, row) => total + row.turnCount, 0);
    const typeTurns = store
      .getSubagentTotalsByType(null, null, TASK_ID)
      .reduce((total, row) => total + row.turnCount, 0);
    expect(fanOutTurns).toBe(typeTurns);
  });

  it('terminates on a parent cycle instead of looping forever', () => {
    const { store, db } = makeStore();
    // Two subagents each named as the other's spawner. Impossible from a real
    // transcript, but a malformed or hand-edited ledger can express it, and an
    // uncapped recursive CTE would spin on it.
    store.recordSpawnLinks(
      [
        { toolUseId: 'toolu_a', turnUuid: 'sub:b1:m1' },
        { toolUseId: 'toolu_b', turnUuid: 'sub:a1:m1' },
      ],
      NOW,
    );
    insertSubagentTurn(db, { subagentId: 'a1', messageId: 'm1', agentType: 'review-finder', spawnDepth: 1, parentToolUseId: 'toolu_a', ts: 10 });
    insertSubagentTurn(db, { subagentId: 'b1', messageId: 'm1', agentType: 'Explore', spawnDepth: 2, parentToolUseId: 'toolu_b', ts: 20 });

    const fanOuts = store.getTaskFanOuts(TASK_ID);

    // Neither reaches a main-thread turn, so both land unlinked. The assertion
    // that matters is that this returns at all.
    expect(fanOuts).toHaveLength(1);
    expect(fanOuts[0].driverTurnUuid).toBeNull();
    expect(fanOuts[0].subagentCount).toBe(2);
  });

  it('does not double-count a subagent that carries two distinct parent links', () => {
    const { store, db } = makeStore();
    insertDriverTurn(db, 'driver-a', 1);
    insertDriverTurn(db, 'driver-b', 2);
    store.recordSpawnLinks(
      [
        { toolUseId: 'toolu-a', turnUuid: 'driver-a' },
        { toolUseId: 'toolu-b', turnUuid: 'driver-b' },
      ],
      NOW,
    );
    // One subagent, but two of its turns name a DIFFERENT spawning call.
    // `subagent_id` is the transcript file stem and carries no session
    // namespace, so two sessions of this task can legitimately write the same
    // id with different `parent_tool_use_id` values - `subagent_parent`'s
    // SELECT DISTINCT then yields two `root` rows for this one subagent.
    insertSubagentTurn(db, { subagentId: 'agent-1', messageId: 'm1', agentType: 'review-finder', spawnDepth: 1, parentToolUseId: 'toolu-a', ts: 10, inputTokens: 100, outputTokens: 10 });
    insertSubagentTurn(db, { subagentId: 'agent-1', messageId: 'm2', agentType: 'review-finder', spawnDepth: 1, parentToolUseId: 'toolu-b', ts: 20, inputTokens: 100, outputTokens: 10 });

    const fanOuts = store.getTaskFanOuts(TASK_ID);

    // Ungrouped roots would multiply this subagent's two usage rows into both
    // buckets, producing two rows that each double-count to 200.
    expect(fanOuts).toHaveLength(1);
    expect(fanOuts[0].turnCount).toBe(2);
    expect(fanOuts[0].subagentCount).toBe(1);
    expect(fanOuts[0].inputTokens).toBe(200);
    // The load-bearing assertion: fan-out totals must equal the per-type
    // rollup's totals over the same task, whatever shape the parent links
    // take - a double-count here would sum to 400 against a true 200.
    const fanOutInputTokens = fanOuts.reduce((total, row) => total + row.inputTokens, 0);
    const typeInputTokens = store
      .getSubagentTotalsByType(null, null, TASK_ID)
      .reduce((total, row) => total + row.inputTokens, 0);
    expect(fanOutInputTokens).toBe(typeInputTokens);
  });

  it('scopes to the task, so another task\'s fan-out is not folded in', () => {
    const { store, db } = makeStore();
    insertDriverTurn(db, 'driver-1', 1000);
    store.recordSpawnLinks([{ toolUseId: 'toolu_1', turnUuid: 'driver-1' }], NOW);
    insertSubagentTurn(db, { subagentId: 'a1', messageId: 'm1', agentType: 'review-finder', spawnDepth: 1, parentToolUseId: 'toolu_1', ts: 1100 });
    db.prepare(
      `INSERT INTO conversation_turn_usage
         (turn_uuid, agent_session_id, session_id, task_id, model, ts,
          input_tokens, output_tokens, cache_creation_input_tokens,
          cache_read_input_tokens, recorded_at, subagent_id, agent_type, spawn_depth, parent_tool_use_id)
       VALUES ('sub:other:m1', 'agent-session', 'session-2', 'task-2', 'model-a', 9,
               1, 1, 0, 1, ?, 'other', 'review-finder', 1, 'toolu_1')`,
    ).run(NOW);

    const fanOuts = store.getTaskFanOuts(TASK_ID);

    expect(fanOuts).toHaveLength(1);
    expect(fanOuts[0].subagentCount).toBe(1);
  });
});

describeWithSqlite('recordSpawnLinks', () => {
  it('is idempotent across a re-walk', () => {
    const { store, db } = makeStore();
    store.recordSpawnLinks([{ toolUseId: 'toolu_1', turnUuid: 'driver-1' }], NOW);
    store.recordSpawnLinks([{ toolUseId: 'toolu_1', turnUuid: 'driver-1' }], '2026-09-16T00:00:00.000Z');

    const rows = db.prepare('SELECT tool_use_id, turn_uuid, recorded_at FROM turn_spawn_links').all() as Array<{
      tool_use_id: string; turn_uuid: string; recorded_at: string;
    }>;
    expect(rows).toHaveLength(1);
    expect(rows[0].turn_uuid).toBe('driver-1');
    expect(rows[0].recorded_at).toBe('2026-09-16T00:00:00.000Z');
  });

  it('writes nothing on an empty batch', () => {
    const { store, db } = makeStore();
    store.recordSpawnLinks([], NOW);
    const count = db.prepare('SELECT COUNT(*) AS n FROM turn_spawn_links').get() as { n: number };
    expect(count.n).toBe(0);
  });
});
