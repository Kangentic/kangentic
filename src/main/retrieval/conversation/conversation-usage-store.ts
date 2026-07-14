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

/**
 * One fixed-UTC-bucket group of turn usage, as consumed by the usage-stats
 * service. Grouped by bucket ONLY: per-session cost allocation happens
 * inside the SQL (see getGroupedUsageSince), so the output is O(active
 * buckets in the window), never O(sessions x buckets) - the shape that let
 * a year of history stall the main thread.
 */
export interface GroupedTurnUsageRow {
  /** UTC-aligned group start (epoch ms), a multiple of the groupMs passed in. */
  bucketStartMs: number;
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  turnCount: number;
  /**
   * Dollars of session usage_history cost allocated to this bucket: each
   * turn contributes its owning session's cost proportional to the turn's
   * share of that session's fresh (input + output) tokens across the whole
   * queried window (summing a session's buckets reassembles its full cost).
   * A turn allocates $0 when its session has no in-cost-window ledger row,
   * reported $0, has no fresh tokens, or the turn has no session.
   * API-equivalent and approximate by design (cache reads are weighted the
   * same as nothing; the point is a plausible $-over-time shape, not
   * billing).
   */
  allocatedCostUsd: number;
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

  /**
   * Project-wide turn usage grouped into fixed UTC buckets of `groupMs`,
   * bucket-only output. The usage-stats service passes 5 minutes for the
   * Live period (whose chart buckets sit on the 5-minute grid) and 15
   * minutes otherwise - the coarsest grid that still nests into local
   * hour/day/week chart boundaries for every real-world UTC offset. Turns
   * with a NULL `ts` are excluded (they cannot be placed on a time axis;
   * their tokens still count in the usage_history KPIs). Uses
   * idx_turn_usage_ts. Pass null `sinceMs` for all time; pass `untilMs` to
   * bound the window (the dashboard's day drill-down).
   *
   * Cost allocation happens per turn INSIDE the query (each turn contributes
   * its session's ledger cost weighted by the turn's share of the session's
   * windowed fresh tokens), summed per bucket - algebraically identical to
   * the old per-session-group allocation, without materializing the
   * O(sessions x buckets) intermediate for the JS side.
   * `costSince`/`costUntil` must be the same session_started_at window the
   * service applies to its usage_history aggregates - a turn whose session
   * has no ledger row INSIDE that window allocates $0, exactly like the old
   * JS map built from the windowed row read.
   */
  getGroupedUsageSince(
    sinceMs: number | null,
    groupMs: number,
    untilMs: number | null = null,
    costSince: string | null = null,
    costUntil: string | null = null,
  ): GroupedTurnUsageRow[] {
    const turnClauses = ['ts IS NOT NULL'];
    const turnWindowParams: number[] = [];
    if (sinceMs !== null) {
      turnClauses.push('ts >= ?');
      turnWindowParams.push(sinceMs);
    }
    if (untilMs !== null) {
      turnClauses.push('ts < ?');
      turnWindowParams.push(untilMs);
    }
    const turnWhere = turnClauses.join(' AND ');
    const costClauses: string[] = [];
    const costParams: string[] = [];
    if (costSince !== null) {
      costClauses.push('session_started_at >= ?');
      costParams.push(costSince);
    }
    if (costUntil !== null) {
      costClauses.push('session_started_at < ?');
      costParams.push(costUntil);
    }
    const costWhere = costClauses.length > 0 ? ` WHERE ${costClauses.join(' AND ')}` : '';
    // Bind order matches clause order: session_tokens window, cost window,
    // the two groupMs uses in the SELECT, then the outer turn window.
    return this.db.prepare(`
      WITH session_tokens AS (
        SELECT session_id AS sessionId, SUM(input_tokens + output_tokens) AS totalTokens
        FROM conversation_turn_usage
        WHERE ${turnWhere}
        GROUP BY session_id
      ),
      session_cost AS (
        SELECT session_record_id AS sessionId, total_cost_usd AS costUsd
        FROM usage_history${costWhere}
      )
      SELECT
        CAST(ts / ? AS INTEGER) * ? AS bucketStartMs,
        SUM(input_tokens) AS inputTokens,
        SUM(output_tokens) AS outputTokens,
        SUM(cache_creation_input_tokens) AS cacheCreationTokens,
        SUM(cache_read_input_tokens) AS cacheReadTokens,
        COUNT(*) AS turnCount,
        SUM(CASE
          WHEN session_cost.costUsd IS NOT NULL
           AND session_cost.costUsd != 0
           AND session_tokens.totalTokens > 0
          THEN session_cost.costUsd * ((input_tokens + output_tokens) * 1.0 / session_tokens.totalTokens)
          ELSE 0
        END) AS allocatedCostUsd
      FROM conversation_turn_usage
      LEFT JOIN session_tokens ON session_tokens.sessionId = conversation_turn_usage.session_id
      LEFT JOIN session_cost ON session_cost.sessionId = conversation_turn_usage.session_id
      WHERE ${turnWhere}
      GROUP BY bucketStartMs
      ORDER BY bucketStartMs ASC
    `).all(...turnWindowParams, ...costParams, groupMs, groupMs, ...turnWindowParams) as GroupedTurnUsageRow[];
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
