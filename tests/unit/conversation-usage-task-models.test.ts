/**
 * `ConversationUsageStore.getTaskModelUsage`, the completed task view's Models
 * card, on a real migrated database: turns and the four token kinds per model,
 * the main thread apart from each subagent type, with sentinel and empty turns
 * left out.
 */

import { describe, it, expect, afterEach } from 'vitest';
import type Database from 'better-sqlite3';
import { ConversationUsageStore } from '../../src/main/retrieval/conversation/conversation-usage-store';
import { runProjectMigrations } from '../../src/main/db/migrations/project-schema';
import { openTestDatabase } from './helpers/test-database';

const openDatabases: Database.Database[] = [];

afterEach(() => {
  for (const database of openDatabases.splice(0)) database.close();
});

interface Turn {
  uuid: string;
  taskId: string;
  model: string | null;
  ts: number;
  input?: number;
  output?: number;
  cacheWrite?: number;
  cacheRead?: number;
  subagentId?: string | null;
  agentType?: string | null;
}

function makeDb(turns: Turn[]): Database.Database {
  const db = openTestDatabase();
  openDatabases.push(db);
  runProjectMigrations(db);
  const insert = db.prepare(`
    INSERT INTO conversation_turn_usage
      (turn_uuid, agent_session_id, session_id, task_id, model, ts, input_tokens, output_tokens,
       cache_creation_input_tokens, cache_read_input_tokens, recorded_at, subagent_id, agent_type)
    VALUES (?, 'agent-1', 'session-1', ?, ?, ?, ?, ?, ?, ?, '2026-10-13T00:00:00.000Z', ?, ?)
  `);
  for (const turn of turns) {
    insert.run(
      turn.uuid, turn.taskId, turn.model, turn.ts,
      turn.input ?? 0, turn.output ?? 0, turn.cacheWrite ?? 0, turn.cacheRead ?? 0,
      turn.subagentId ?? null, turn.agentType ?? null,
    );
  }
  return db;
}

describe('ConversationUsageStore.getTaskModelUsage', () => {
  it('sums each model on the main thread and each subagent type apart, oldest model first', () => {
    const db = makeDb([
      { uuid: 'opus-1', taskId: 'task-797', model: 'claude-opus-5-5', ts: 1, input: 3, output: 10, cacheWrite: 100, cacheRead: 1_000 },
      { uuid: 'opus-2', taskId: 'task-797', model: 'claude-opus-5-5', ts: 2, input: 2, output: 20, cacheWrite: 50, cacheRead: 2_000 },
      { uuid: 'sonnet-1', taskId: 'task-797', model: 'claude-sonnet-5-5', ts: 3, input: 1, output: 5, cacheRead: 500 },
      { uuid: 'haiku-sub', taskId: 'task-797', model: 'claude-haiku-5-5', ts: 4, input: 4, output: 8, cacheRead: 300, subagentId: 'sub-1', agentType: 'doc-auditor' },
      // Another task's turn.
      { uuid: 'other', taskId: 'task-801', model: 'claude-opus-5-5', ts: 5, input: 99, output: 99 },
    ]);

    const rows = new ConversationUsageStore(db).getTaskModelUsage('task-797');

    expect(rows).toEqual([
      { modelId: 'claude-opus-5-5', subagentType: null, turns: 2, freshInputTokens: 5, cacheWriteTokens: 150, cacheReadTokens: 3_000, outputTokens: 30 },
      { modelId: 'claude-sonnet-5-5', subagentType: null, turns: 1, freshInputTokens: 1, cacheWriteTokens: 0, cacheReadTokens: 500, outputTokens: 5 },
      { modelId: 'claude-haiku-5-5', subagentType: 'doc-auditor', turns: 1, freshInputTokens: 4, cacheWriteTokens: 0, cacheReadTokens: 300, outputTokens: 8 },
    ]);
  });

  it('leaves out a sentinel model and a turn that reported no tokens', () => {
    const db = makeDb([
      { uuid: 'real', taskId: 'task-797', model: 'claude-opus-5-5', ts: 1, output: 10 },
      { uuid: 'synthetic', taskId: 'task-797', model: '<synthetic>', ts: 2, output: 3 },
      { uuid: 'empty', taskId: 'task-797', model: 'claude-sonnet-5-5', ts: 3 },
    ]);

    const rows = new ConversationUsageStore(db).getTaskModelUsage('task-797');

    expect(rows.map((row) => row.modelId)).toEqual(['claude-opus-5-5']);
  });

  it('keeps a turn that named no model as its own row with a null model id, apart from the named ones', () => {
    const db = makeDb([
      { uuid: 'unnamed-1', taskId: 'task-797', model: null, ts: 1, input: 2, output: 7, cacheWrite: 30, cacheRead: 400 },
      { uuid: 'unnamed-2', taskId: 'task-797', model: null, ts: 2, output: 3 },
      { uuid: 'named', taskId: 'task-797', model: 'claude-opus-5-5', ts: 3, output: 10 },
      // No model and no tokens: left out like any empty turn.
      { uuid: 'unnamed-empty', taskId: 'task-797', model: null, ts: 4 },
    ]);

    const rows = new ConversationUsageStore(db).getTaskModelUsage('task-797');

    expect(rows).toEqual([
      { modelId: null, subagentType: null, turns: 2, freshInputTokens: 2, cacheWriteTokens: 30, cacheReadTokens: 400, outputTokens: 10 },
      { modelId: 'claude-opus-5-5', subagentType: null, turns: 1, freshInputTokens: 0, cacheWriteTokens: 0, cacheReadTokens: 0, outputTokens: 10 },
    ]);
  });

  it('reads an unknown subagent type as an empty name, never as the main thread', () => {
    const db = makeDb([
      { uuid: 'sub', taskId: 'task-797', model: 'claude-haiku-5-5', ts: 1, output: 4, subagentId: 'sub-1', agentType: null },
    ]);

    expect(new ConversationUsageStore(db).getTaskModelUsage('task-797')[0].subagentType).toBe('');
  });
});
