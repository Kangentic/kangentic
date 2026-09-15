import type Database from 'better-sqlite3';
import type { SubagentSpawnLink } from '../../agent/agent-adapter';
import type {
  ConversationTurnUsageRecord,
  SubagentUsageTotals,
  TaskFanOut,
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
  /**
   * The subagent that ran this turn. Absent/null marks a MAIN-THREAD turn, which
   * is what every row written before subagent capture existed is, and what every
   * reader of this table meant by construction. Set it and the row is excluded
   * from the driver-only readers below.
   */
  subagentId?: string | null;
  agentType?: string | null;
  spawnDepth?: number | null;
  parentToolUseId?: string | null;
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
  subagent_id: string | null;
  agent_type: string | null;
  spawn_depth: number | null;
  parent_tool_use_id: string | null;
}

/**
 * The clause that keeps a reader meaning what it has always meant: the main
 * thread. Subagent rows arrived later, so every pre-existing query would have
 * silently changed meaning without it, with no marker in the series where the
 * change happened.
 */
const MAIN_THREAD_ONLY = 'subagent_id IS NULL';

/**
 * How many spawn hops `getTaskFanOuts` will walk before it gives up and leaves a
 * subagent unresolved. Headroom, not a product limit: the deepest nesting ever
 * measured is 2 (the subagent parser's own count, 2,238 turns at depth 1 against
 * 50 at depth 2). It exists so a malformed or cyclic chain terminates.
 */
const MAX_SPAWN_CHAIN_DEPTH = 8;

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
    subagentId: row.subagent_id ?? null,
    agentType: row.agent_type ?? null,
    spawnDepth: row.spawn_depth ?? null,
    parentToolUseId: row.parent_tool_use_id ?? null,
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
 * Pull the subagent-spawning tool calls out of a parsed MAIN transcript: one link
 * per `tool_use` block whose name is the agent's spawn tool.
 *
 * Deliberately NOT filtered on `entry.usage`, unlike `extractTurnUsageRecords`
 * above. An assistant message bearing a `tool_use` block essentially always
 * reports usage, but that is an assumption about the provider rather than an
 * invariant this code controls, and the failure is silent and permanent: a link
 * dropped here leaves its subagent resolving to nothing forever, because a
 * re-walk drops it again. The turn it points at may simply have no ledger row,
 * which the fan-out reader's LEFT JOIN already handles.
 *
 * Pure; the indexer feeds the result to `recordSpawnLinks`. Returns [] when the
 * adapter declares no spawn tool, so an agent with no subagent concept costs one
 * comparison and writes nothing.
 */
export function extractTurnSpawnLinks(
  entries: TranscriptEntry[],
  spawnToolName: string | undefined,
): SubagentSpawnLink[] {
  if (!spawnToolName) return [];
  const links: SubagentSpawnLink[] = [];
  for (const entry of entries) {
    if (entry.kind !== 'assistant') continue;
    for (const block of entry.blocks) {
      if (block.type !== 'tool_use') continue;
      if (block.name !== spawnToolName) continue;
      if (block.id.length === 0) continue;
      links.push({ toolUseId: block.id, turnUuid: entry.uuid });
    }
  }
  return links;
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
            cache_read_input_tokens, recorded_at,
            subagent_id, agent_type, spawn_depth, parent_tool_use_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
           recorded_at = excluded.recorded_at,
           subagent_id = excluded.subagent_id,
           agent_type = excluded.agent_type,
           spawn_depth = excluded.spawn_depth,
           parent_tool_use_id = excluded.parent_tool_use_id`,
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
          turn.subagentId ?? null,
          turn.agentType ?? null,
          turn.spawnDepth ?? null,
          turn.parentToolUseId ?? null,
        );
      }
    });
    run();
  }

  /**
   * Upsert the spawning tool calls a batch of turns emitted, so a subagent's
   * `parent_tool_use_id` has a row to resolve against. Idempotent by
   * `tool_use_id`; a re-walk rewrites the same pair.
   *
   * Early-returns on an empty batch, and that guard is load-bearing rather than
   * tidy. The main-transcript call site is the LIVE turn boundary, which #649
   * deliberately kept `indexSubagentUsage` off after measuring 57ms of main-thread
   * stall per turn there. Most driver turns spawn nothing, so with the guard the
   * common case prepares no statement and opens no transaction; without it, this
   * adds a write to every settled turn in exactly the fan-out workload the ledger
   * exists to measure.
   */
  recordSpawnLinks(links: SubagentSpawnLink[], now: string): void {
    if (links.length === 0) return;
    const run = this.db.transaction(() => {
      const upsert = this.db.prepare(
        `INSERT INTO turn_spawn_links (tool_use_id, turn_uuid, recorded_at)
         VALUES (?, ?, ?)
         ON CONFLICT(tool_use_id) DO UPDATE SET
           turn_uuid = excluded.turn_uuid,
           recorded_at = excluded.recorded_at`,
      );
      for (const link of links) {
        upsert.run(link.toolUseId, link.turnUuid, now);
      }
    });
    run();
  }

  /** A task's MAIN-THREAD per-turn usage, oldest turn first (for a
   *  burn-rate-over-time read). Subagent rows are excluded; read them through
   *  `getSubagentTotalsByType`, which aggregates rather than listing hundreds of
   *  rows a caller would only have had to filter anyway. */
  getForTask(taskId: string): ConversationTurnUsageRecord[] {
    const rows = this.db
      .prepare(`SELECT * FROM conversation_turn_usage WHERE task_id = ? AND ${MAIN_THREAD_ONLY} ORDER BY ts ASC`)
      .all(taskId) as TurnUsageRow[];
    return rows.map(toRecord);
  }

  /** One session's MAIN-THREAD per-turn usage, oldest turn first. */
  getForSession(sessionId: string): ConversationTurnUsageRecord[] {
    const rows = this.db
      .prepare(`SELECT * FROM conversation_turn_usage WHERE session_id = ? AND ${MAIN_THREAD_ONLY} ORDER BY ts ASC`)
      .all(sessionId) as TurnUsageRow[];
    return rows.map(toRecord);
  }

  /**
   * Project-wide MAIN-THREAD turn usage grouped into fixed UTC buckets of
   * `groupMs`, bucket-only output. Subagent rows are excluded from both the
   * aggregate and the cost-allocation denominator, so this series means exactly
   * what it meant before subagent capture existed and stays comparable back
   * through the whole history. Subagent traffic is reported additively by
   * `getSubagentTotalsByType`. The usage-stats service passes 5 minutes for the
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
    // MAIN_THREAD_ONLY belongs to BOTH uses of turnWhere below, not just the
    // outer aggregate. The `session_tokens` CTE is the DENOMINATOR of the
    // per-turn cost allocation, so leaving subagent rows in it would grow every
    // session's token total and redistribute that session's fixed reported cost
    // away from the driver's buckets and into the subagents' timestamps. Window
    // totals would still add up while the series silently changed shape, which is
    // exactly the unmarked discontinuity these columns exist to prevent.
    const turnClauses = [MAIN_THREAD_ONLY, 'ts IS NOT NULL'];
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

  /** Usage for a specific set of MAIN-THREAD turns - the join a conversation view
   *  uses to hang token counts off the turns it is already showing. Subagent rows
   *  are keyed by a synthetic `sub:<id>:<messageId>` uuid that no displayed turn
   *  carries, so the filter is belt-and-braces rather than load-bearing; it is
   *  here so the reader's meaning is stated, not inferred. */
  getForTurns(turnUuids: string[]): ConversationTurnUsageRecord[] {
    if (turnUuids.length === 0) return [];
    const placeholders = turnUuids.map(() => '?').join(',');
    const rows = this.db
      .prepare(
        `SELECT * FROM conversation_turn_usage WHERE turn_uuid IN (${placeholders}) AND ${MAIN_THREAD_ONLY}`,
      )
      .all(...turnUuids) as TurnUsageRow[];
    return rows.map(toRecord);
  }

  /**
   * Subagent token usage rolled up by subagent type, heaviest cache-read first.
   *
   * The mirror image of every other reader here: `subagent_id IS NOT NULL`. This
   * is what answers "which reviewer costs the most" rather than only "this review
   * cost $41.26". A null `agentType` is a real bucket (a subagent whose sidecar
   * was missing and whose records carried no inline attribution), never a dropped
   * row.
   *
   * Reports NO cost. `usage_history.total_cost_usd` already covers the whole
   * session tree, so pricing these tokens and adding them would double count.
   *
   * Pass `taskId` for the per-task breakdown, which is selective on
   * idx_turn_usage_task, or null with a `ts` window for the project-wide one.
   * That one gets only its GROUP BY ordering from idx_turn_usage_agent_type;
   * `subagent_id` is in no index, so the row filter still runs per row.
   * A null window means all time. Turns with a NULL `ts` are included only in the
   * unbounded case, matching `getGroupedUsageSince`, which cannot place them on a
   * time axis.
   */
  getSubagentTotalsByType(
    sinceMs: number | null,
    untilMs: number | null = null,
    taskId: string | null = null,
  ): SubagentUsageTotals[] {
    const clauses = ['subagent_id IS NOT NULL'];
    const params: Array<number | string> = [];
    if (taskId !== null) {
      clauses.push('task_id = ?');
      params.push(taskId);
    }
    if (sinceMs !== null) {
      clauses.push('ts IS NOT NULL');
      clauses.push('ts >= ?');
      params.push(sinceMs);
    }
    if (untilMs !== null) {
      clauses.push('ts IS NOT NULL');
      clauses.push('ts < ?');
      params.push(untilMs);
    }
    return this.db
      .prepare(
        `SELECT
           agent_type AS agentType,
           SUM(input_tokens) AS inputTokens,
           SUM(output_tokens) AS outputTokens,
           SUM(cache_creation_input_tokens) AS cacheCreationTokens,
           SUM(cache_read_input_tokens) AS cacheReadTokens,
           COUNT(*) AS turnCount,
           COUNT(DISTINCT subagent_id) AS subagentCount,
           SUM(CASE WHEN spawn_depth >= 2 THEN 1 ELSE 0 END) AS nestedTurnCount,
           COUNT(DISTINCT CASE WHEN spawn_depth >= 2 THEN subagent_id END) AS nestedSubagentCount,
           MAX(spawn_depth) AS maxSpawnDepth
         FROM conversation_turn_usage
         WHERE ${clauses.join(' AND ')}
         GROUP BY agent_type
         ORDER BY cacheReadTokens DESC, outputTokens DESC`,
      )
      .all(...params) as SubagentUsageTotals[];
  }

  /**
   * One task's subagent spend grouped by the DRIVER TURN that started each
   * fan-out, heaviest first. Answers "what did this one fan-out cost", which the
   * flat per-type rollup cannot: a `/code-review` task spawns the same
   * `review-finder` type from several different turns.
   *
   * Resolution walks `parent_tool_use_id` through `turn_spawn_links` to the turn
   * that emitted the spawning call. A depth-1 subagent lands on a main-thread turn
   * and stops; a deeper one lands on another subagent's turn and inherits that
   * subagent's root, which is what folds a nested agent's tokens into the fan-out
   * that ultimately caused them. `level` caps the walk at `MAX_SPAWN_CHAIN_DEPTH`
   * so a malformed chain cannot loop.
   *
   * `root` is collapsed to ONE row per subagent before the final join, and that
   * GROUP BY is load-bearing rather than tidy. A subagent has exactly one spawning
   * call, but nothing in the schema enforces it: `subagent_id` is the transcript
   * file stem, which carries no session namespace, so two sessions of one task can
   * write the same `subagent_id` with different `parent_tool_use_id` values. Left
   * ungrouped, that subagent gets two `root` rows, the join multiplies every one of
   * its usage rows into both buckets, and the sum guarantee below silently fails.
   * Collapsing here rather than in `subagent_parent` keeps the recursive step's
   * index probe on `turn_spawn_links(turn_uuid)`, and catches any other way the
   * walk could ever produce two roots for one subagent.
   *
   * Two deliberate properties:
   *
   * - A subagent whose parent does not resolve is returned under
   *   `driverTurnUuid: null` rather than dropped. Links only exist for sessions
   *   indexed since they were introduced, so on older tasks that bucket is
   *   everything, and silently omitting it would make these rows disagree with
   *   `getSubagentTotalsByType` over the same task.
   * - No cost, for the reason the per-type rollup records: `total_cost_usd`
   *   already covers the whole session tree.
   */
  getTaskFanOuts(taskId: string): TaskFanOut[] {
    return this.db
      .prepare(
        `WITH RECURSIVE
         subagent_parent AS (
           SELECT DISTINCT subagent_id, parent_tool_use_id
           FROM conversation_turn_usage
           WHERE task_id = ? AND subagent_id IS NOT NULL
         ),
         root AS (
           SELECT sp.subagent_id AS subagent_id, parent.turn_uuid AS root_turn_uuid, 1 AS level
           FROM subagent_parent sp
           JOIN turn_spawn_links link ON link.tool_use_id = sp.parent_tool_use_id
           JOIN conversation_turn_usage parent ON parent.turn_uuid = link.turn_uuid
           WHERE parent.subagent_id IS NULL
           UNION ALL
           SELECT sp.subagent_id, ancestor.root_turn_uuid, ancestor.level + 1
           FROM subagent_parent sp
           JOIN turn_spawn_links link ON link.tool_use_id = sp.parent_tool_use_id
           JOIN conversation_turn_usage parent ON parent.turn_uuid = link.turn_uuid
           JOIN root ancestor ON ancestor.subagent_id = parent.subagent_id
           WHERE parent.subagent_id IS NOT NULL AND ancestor.level < ${MAX_SPAWN_CHAIN_DEPTH}
         )
         SELECT
           root.root_turn_uuid AS driverTurnUuid,
           MIN(driver.ts) AS driverTs,
           SUM(usage.input_tokens) AS inputTokens,
           SUM(usage.output_tokens) AS outputTokens,
           SUM(usage.cache_creation_input_tokens) AS cacheCreationTokens,
           SUM(usage.cache_read_input_tokens) AS cacheReadTokens,
           COUNT(*) AS turnCount,
           COUNT(DISTINCT usage.subagent_id) AS subagentCount,
           MAX(usage.spawn_depth) AS maxSpawnDepth,
           GROUP_CONCAT(DISTINCT usage.agent_type) AS agentTypesCsv
         FROM conversation_turn_usage usage
         LEFT JOIN (
           SELECT subagent_id, MIN(root_turn_uuid) AS root_turn_uuid
           FROM root
           GROUP BY subagent_id
         ) root ON root.subagent_id = usage.subagent_id
         LEFT JOIN conversation_turn_usage driver ON driver.turn_uuid = root.root_turn_uuid
         WHERE usage.task_id = ? AND usage.subagent_id IS NOT NULL
         GROUP BY root.root_turn_uuid
         ORDER BY cacheReadTokens DESC, outputTokens DESC`,
      )
      .all(taskId, taskId)
      .map((row) => {
        const raw = row as Omit<TaskFanOut, 'agentTypes'> & { agentTypesCsv: string | null };
        return {
          driverTurnUuid: raw.driverTurnUuid,
          driverTs: raw.driverTs,
          inputTokens: raw.inputTokens,
          outputTokens: raw.outputTokens,
          cacheCreationTokens: raw.cacheCreationTokens,
          cacheReadTokens: raw.cacheReadTokens,
          turnCount: raw.turnCount,
          subagentCount: raw.subagentCount,
          maxSpawnDepth: raw.maxSpawnDepth,
          // GROUP_CONCAT drops NULLs, so a type-less subagent leaves no empty
          // slot. The comma split assumes an `agent_type` contains no comma:
          // nothing enforces that (the value is whatever the sidecar's
          // `agentType` said), so a comma would split one name into two. Left as
          // an assumption rather than a second query because this field feeds one
          // MCP display line and never a total, so the worst case is a cosmetic
          // mis-split, not a wrong number.
          agentTypes: raw.agentTypesCsv ? raw.agentTypesCsv.split(',') : [],
        };
      });
  }
}
