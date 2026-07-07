import type Database from 'better-sqlite3';
import type {
  ConversationTurnUsageRecord,
  TranscriptEntry,
  TranscriptTurnUsage,
} from '../../../shared/types';

/** One assistant turn's usage for recordTurns. */
export interface TurnUsageInput {
  turnUuid: string;
  /** Epoch ms of the turn, or null. */
  ts: number | null;
  model: string | null;
  usage: TranscriptTurnUsage;
}

/** The owning session shared by every turn in one recordTurns batch. */
export interface TurnUsageOwner {
  agentSessionId: string | null;
  sessionId: string | null;
  taskId: string | null;
}

interface TurnUsageRow {
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

function toRecord(row: TurnUsageRow): ConversationTurnUsageRecord {
  return {
    turnUuid: row.turn_uuid,
    agentSessionId: row.agent_session_id,
    sessionId: row.session_id,
    taskId: row.task_id,
    model: row.model,
    ts: row.ts,
    usage: {
      inputTokens: row.input_tokens,
      outputTokens: row.output_tokens,
      cacheCreationInputTokens: row.cache_creation_input_tokens,
      cacheReadInputTokens: row.cache_read_input_tokens,
    },
    recordedAt: row.recorded_at,
  };
}

/**
 * Pull the durably-storable per-turn usage out of a parsed transcript: one input
 * per assistant turn that reported usage (turns without usage are skipped, so no
 * empty rows are written). Pure; the indexer feeds the result to recordTurns.
 */
export function extractTurnUsageRecords(entries: TranscriptEntry[]): TurnUsageInput[] {
  const records: TurnUsageInput[] = [];
  for (const entry of entries) {
    if (entry.kind === 'assistant' && entry.usage) {
      records.push({
        turnUuid: entry.uuid,
        ts: entry.ts,
        model: entry.model ?? null,
        usage: entry.usage,
      });
    }
  }
  return records;
}

/**
 * Durable per-turn token-usage ledger over `conversation_turn_usage`. Rows are
 * written at index time from the parsed transcript, so they persist independently
 * of the agent's native JSONL (which the agent may prune): cost / burn-rate
 * analysis survives transcript deletion. Keyed by turn uuid - a `--resume` replays
 * its parent's turns verbatim under the same uuid, so the upsert dedups them to one
 * row and per-task / per-project token totals never double-count a shared turn.
 *
 * Deliberately has NO sessions-DELETE cascade (unlike memory_chunks): this is a
 * long-lived ledger, not a rebuildable index, so a turn's usage is not wiped when a
 * session row is deleted (see the migration comment for the shared-turn rationale).
 */
export class ConversationUsageStore {
  constructor(private readonly db: Database.Database) {}

  /**
   * Upsert one owning session's turns. Idempotent; re-recording an already-stored
   * turn (a resumed session replaying it) re-points attribution to the latest owner
   * and refreshes the (identical) token counts. No-op on an empty batch - no SQL is
   * prepared, so a session with no usage-bearing turns touches nothing.
   */
  recordTurns(owner: TurnUsageOwner, turns: TurnUsageInput[], now: string): void {
    if (turns.length === 0) return;
    const run = this.db.transaction(() => {
      const upsert = this.db.prepare(
        `INSERT INTO conversation_turn_usage
           (turn_uuid, agent_session_id, session_id, task_id, model, ts,
            input_tokens, output_tokens, cache_creation_input_tokens,
            cache_read_input_tokens, recorded_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(turn_uuid) DO UPDATE SET
           agent_session_id = excluded.agent_session_id,
           session_id = excluded.session_id,
           task_id = excluded.task_id,
           model = excluded.model,
           ts = excluded.ts,
           input_tokens = excluded.input_tokens,
           output_tokens = excluded.output_tokens,
           cache_creation_input_tokens = excluded.cache_creation_input_tokens,
           cache_read_input_tokens = excluded.cache_read_input_tokens,
           recorded_at = excluded.recorded_at`,
      );
      for (const turn of turns) {
        upsert.run(
          turn.turnUuid,
          owner.agentSessionId,
          owner.sessionId,
          owner.taskId,
          turn.model,
          turn.ts,
          turn.usage.inputTokens,
          turn.usage.outputTokens,
          turn.usage.cacheCreationInputTokens,
          turn.usage.cacheReadInputTokens,
          now,
        );
      }
    });
    run();
  }

  /** A task's per-turn usage, oldest turn first (for a burn-rate-over-time read). */
  getForTask(taskId: string): ConversationTurnUsageRecord[] {
    const rows = this.db
      .prepare('SELECT * FROM conversation_turn_usage WHERE task_id = ? ORDER BY ts ASC')
      .all(taskId) as TurnUsageRow[];
    return rows.map(toRecord);
  }

  /** One session's per-turn usage, oldest turn first. */
  getForSession(sessionId: string): ConversationTurnUsageRecord[] {
    const rows = this.db
      .prepare('SELECT * FROM conversation_turn_usage WHERE session_id = ? ORDER BY ts ASC')
      .all(sessionId) as TurnUsageRow[];
    return rows.map(toRecord);
  }

  /** Usage for a specific set of turns - the join a conversation view uses to hang
   *  token counts off the turns it is already showing. */
  getForTurns(turnUuids: string[]): ConversationTurnUsageRecord[] {
    if (turnUuids.length === 0) return [];
    const placeholders = turnUuids.map(() => '?').join(',');
    const rows = this.db
      .prepare(`SELECT * FROM conversation_turn_usage WHERE turn_uuid IN (${placeholders})`)
      .all(...turnUuids) as TurnUsageRow[];
    return rows.map(toRecord);
  }
}
