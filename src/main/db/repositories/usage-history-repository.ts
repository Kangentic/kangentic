import type Database from 'better-sqlite3';
import { v4 as uuidv4 } from 'uuid';

/**
 * One-row window aggregate of usage_history (SUM/COUNT/MIN/MAX pushed into
 * SQL so the synchronous main-process JS work is O(1) per project instead of
 * O(historical rows)). Feeds the dashboard KPI totals, previous-period
 * deltas, and per-project summaries.
 */
export interface UsageWindowTotals {
  sessionCount: number;
  totalCostUsd: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  toolCallCount: number;
  linesAdded: number;
  linesRemoved: number;
  filesChanged: number;
  compactionCount: number;
  totalDurationMs: number;
  /**
   * Rows where the agent REPORTED a cost, which drives the `costKnown` KPI
   * flag and therefore whether the Cost tile and the $/hr line render at all.
   *
   * Counted off `cumulative_cost_usd`, not the summable `total_cost_usd`. Those
   * two stopped meaning the same thing when cost became a per-leg delta: a
   * resume leg that did no work carries a real cumulative reading and a delta
   * of zero, and 539 of 2,434 rows on the dogfooding install are exactly that.
   * Counting the delta would let a window made only of such legs report "no
   * cost reported by agents" over a conversation that genuinely spent money.
   *
   * The COALESCE covers a row written before the cumulative columns existed.
   */
  costKnownCount: number;
  minSessionStartedAt: string | null;
  maxSessionStartedAt: string | null;
}

/**
 * One (model_id, model_display_name, agent, effort) rollup row - O(distinct
 * dimension combos) rows per window. Feeds the by-model / by-agent /
 * by-effort breakdowns and the per-project topAgent, which regroup these in
 * JS (model rows merge further on the parsed BASE model id, a string-shape
 * normalization SQL cannot express).
 *
 * Cost comes from `usage_history` (per-leg deltas); TOKENS come from the
 * per-turn ledger, joined on the session. The `usage_history` token columns
 * are context-window snapshots, not consumption, so a breakdown built on them
 * ranked models by how big their contexts happened to be.
 *
 * Known gap, the same one the cost allocation has: a turn whose session has no
 * ledger row in the window is dropped by the join, so the breakdown's tokens
 * can fall slightly short of the Tokens tile, which counts every turn. The
 * alternative (an outer join on a dimension set that only `usage_history`
 * knows) would invent a row with no model, agent or effort to file it under.
 */
export interface UsageRollupRow {
  modelId: string | null;
  modelDisplayName: string | null;
  agent: string | null;
  effort: string | null;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  sessionCount: number;
}

/**
 * usage_history grouped to fixed UTC buckets of the service-chosen width
 * (15 minutes) per model - the cost-series input. Like the turn-group query,
 * fine UTC buckets nest exactly into local hour/day/week chart buckets
 * (every real-world UTC offset is a multiple of 15 minutes), so folding
 * groups in JS lands each session in the same chart bucket as folding raw
 * rows did.
 */
export interface UsageCostGroupRow {
  /** UTC-aligned group start (epoch ms), a multiple of the groupMs passed in. */
  bucketStartMs: number;
  modelId: string | null;
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
  sessionCount: number;
}

export interface RecordSessionUsageInput {
  sessionRecordId: string;
  sessionStartedAt: string;
  sessionType: string | null;
  /**
   * The conversation this session record is one leg of - the session's
   * `agent_session_id`. Null when unknown, which means "its own lineage".
   *
   * This is what makes the cumulative readings below summable. See the
   * per-leg delta note on {@link UsageHistoryRepository.recordSessionUsage}.
   */
  conversationId: string | null;
  /**
   * The agent's raw CUMULATIVE cost reading for the whole conversation, not
   * this leg's share. Named for what it is: passing a per-leg value here
   * would silently under-count every later leg.
   */
  cumulativeCostUsd: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  /** The agent's raw CUMULATIVE duration reading. See `cumulativeCostUsd`. */
  cumulativeDurationMs: number | null;
  toolCallCount: number;
  modelId: string | null;
  modelDisplayName: string | null;
  compactionCount: number;
  /** Agent name the session ran under (generic; null when unknown). */
  agent: string | null;
  /** Last-applied `--effort` value (null = agent default, no flag). */
  effort: string | null;
}

export interface UsageHistoryGitStatsInput {
  linesAdded: number;
  linesRemoved: number;
  filesChanged: number;
}

/**
 * Recomputes a row's summable `total_cost_usd` / `total_duration_ms` from its
 * own cumulative reading minus the highest reading of a PRIOR leg of the same
 * conversation. One definition, used by both the write path's forward
 * recompute and the one-time backfill migration, so the two cannot drift into
 * disagreeing about what a per-leg delta is.
 *
 * "Prior" is by `session_started_at` with `session_record_id` breaking a tie,
 * which keeps two legs that share a start timestamp from both claiming the
 * same baseline. The clamp at 0 covers a CLI that reset its counter mid-record
 * (a fork the lineage key did not catch): that leg contributes nothing rather
 * than a negative, so the error is bounded and errs low.
 *
 * Callers supply the `WHERE` clause. It is a SET-clause fragment rather than a
 * whole statement because the two callers scope differently: the migration
 * rewrites every lineage row at once, the write path only this leg and later.
 */
export const LINEAGE_DELTA_SET_SQL = `
  total_cost_usd = MAX(0, COALESCE(cumulative_cost_usd, 0) - COALESCE((
    SELECT MAX(prior.cumulative_cost_usd)
      FROM usage_history prior
     WHERE prior.conversation_id = usage_history.conversation_id
       AND (prior.session_started_at < usage_history.session_started_at
         OR (prior.session_started_at = usage_history.session_started_at
             AND prior.session_record_id < usage_history.session_record_id))
  ), 0)),
  total_duration_ms = CASE WHEN cumulative_duration_ms IS NULL THEN NULL ELSE
    MAX(0, cumulative_duration_ms - COALESCE((
      SELECT MAX(prior.cumulative_duration_ms)
        FROM usage_history prior
       WHERE prior.conversation_id = usage_history.conversation_id
         AND (prior.session_started_at < usage_history.session_started_at
           OR (prior.session_started_at = usage_history.session_started_at
               AND prior.session_record_id < usage_history.session_record_id))
    ), 0))
  END
`;

/**
 * Append-only history of finalized session usage. Decoupled from the `sessions`
 * and `tasks` tables: rows here outlive task deletion, bulk-archive cleanup,
 * and revert-to-backlog. The usage dashboard's period totals read from this
 * history so that "All Time" reflects every dollar/token actually spent on the
 * project.
 *
 * WHICH COLUMNS ARE SAFE TO FLAT-SUM. A `--resume` is a new session record and
 * therefore a new row here, so any column carrying a conversation-wide running
 * total gets counted once per leg. Each column was audited against the real
 * dogfooding ledger (2,434 rows over 1,226 conversations) by asking whether a
 * lineage's legs ever DECREASE, which a per-leg counter does and a cumulative
 * one does not:
 *
 * - `total_cost_usd`, `total_duration_ms`: cumulative, and the reason the
 *   per-leg delta scheme below exists. Summing the raw readings read $113,948
 *   where the conversations totalled $50,580.
 * - `tool_call_count`: per-leg (fell on 689 of 1,208 leg pairs). Safe. The
 *   transcript backfill in `refineTranscriptToolCounts` can write a
 *   conversation-wide count onto a parked session, but it only fills an EMPTY
 *   live count, and just 2 pairs show the repeat-with-nonzero signature.
 * - `lines_added` / `lines_removed` / `files_changed`: per-TASK cumulative, and
 *   already protected by `setTaskGitStats` below, which keeps exactly one row
 *   per task lineage non-zero. Verified: 280 tasks carry churn, none with more
 *   than one non-zero row.
 * - `compaction_count`: per-leg (`UsageAccumulator` counts per CLI run). Safe.
 * - `total_input_tokens` / `total_output_tokens`: per-capture context-window
 *   snapshots. They sum without double-counting, but the sum is not a token
 *   count; the dashboard reads `conversation_turn_usage` for tokens.
 *
 * Re-run that audit before adding a summed column.
 */
export class UsageHistoryRepository {
  constructor(private db: Database.Database) {}

  /**
   * Insert or update the history row for a session record. UPSERT on
   * `session_record_id` keeps capture idempotent when the same record is
   * captured at suspend AND again at app shutdown (the existing
   * `sessions.updateMetrics` path also uses REPLACE semantics, so this
   * mirrors what the user already sees in the sessions table).
   *
   * COST AND DURATION ARE STORED AS PER-LEG DELTAS. The agent reports both as
   * cumulative-per-conversation readings, and a `--resume` is a new session
   * record, so summing the raw readings across a lineage counts the running
   * total once per leg (measured at 2.2x on the dogfooding install). The raw
   * reading is kept in `cumulative_*` purely as a baseline for later legs and
   * must NEVER be summed; `total_cost_usd` / `total_duration_ms` are the
   * summable columns, so every read query stays a flat SUM. This is the same
   * shape `setTaskGitStats` below uses for branch-cumulative git churn,
   * applied to a conversation lineage instead of a task lineage.
   *
   * The write RECOMPUTES this row and every LATER leg of the same lineage
   * rather than just deriving one delta, which is what keeps
   * `SUM(total_cost_usd) == MAX(cumulative_cost_usd)` per lineage true
   * unconditionally. A one-shot derivation drifts: re-capturing an earlier leg
   * (the shutdown sweep touches every session, not just the newest) raises its
   * cumulative while its successors keep deltas measured against the old
   * baseline, and a three-leg lineage then over-counts. Recomputing forward is
   * also self-healing - a lineage repairs itself on the next capture.
   *
   * A null `conversationId` has no lineage to measure against, so its reading
   * IS its delta. That is the rule the migration's backfill uses for the rows
   * whose `sessions` row was deleted.
   *
   * Git stat columns are intentionally NOT in the UPDATE clause: they are
   * owned by `setTaskGitStats` (called later from the finalization-path
   * captureGitChurn) and must not be clobbered by a re-capture.
   */
  recordSessionUsage(input: RecordSessionUsageInput): void {
    const write = this.db.transaction((usage: RecordSessionUsageInput) => {
      this.db.prepare(`
        INSERT INTO usage_history
          (id, session_record_id, recorded_at, session_started_at, session_type,
           conversation_id, cumulative_cost_usd, cumulative_duration_ms,
           total_cost_usd, total_input_tokens, total_output_tokens,
           total_duration_ms, tool_call_count, model_id, model_display_name,
           compaction_count, agent, effort)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(session_record_id) DO UPDATE SET
          recorded_at = excluded.recorded_at,
          session_started_at = excluded.session_started_at,
          session_type = excluded.session_type,
          conversation_id = COALESCE(excluded.conversation_id, usage_history.conversation_id),
          cumulative_cost_usd = excluded.cumulative_cost_usd,
          cumulative_duration_ms = excluded.cumulative_duration_ms,
          total_cost_usd = excluded.total_cost_usd,
          total_input_tokens = excluded.total_input_tokens,
          total_output_tokens = excluded.total_output_tokens,
          total_duration_ms = excluded.total_duration_ms,
          tool_call_count = excluded.tool_call_count,
          model_id = excluded.model_id,
          model_display_name = excluded.model_display_name,
          compaction_count = excluded.compaction_count,
          agent = COALESCE(excluded.agent, usage_history.agent),
          effort = COALESCE(excluded.effort, usage_history.effort)
      `).run(
        uuidv4(),
        usage.sessionRecordId,
        new Date().toISOString(),
        usage.sessionStartedAt,
        usage.sessionType,
        usage.conversationId,
        usage.cumulativeCostUsd,
        usage.cumulativeDurationMs,
        // Provisional, and correct as-is for a lineage-less row. Anything with
        // a lineage is rewritten by the recompute below.
        usage.cumulativeCostUsd,
        usage.totalInputTokens,
        usage.totalOutputTokens,
        usage.cumulativeDurationMs,
        usage.toolCallCount,
        usage.modelId,
        usage.modelDisplayName,
        usage.compactionCount,
        usage.agent,
        usage.effort,
      );

      if (usage.conversationId === null) return;
      // This leg and every later one. `>=` on the tie-break covers the row
      // just written, so the provisional value above never survives.
      this.db.prepare(`
        UPDATE usage_history
           SET ${LINEAGE_DELTA_SET_SQL}
         WHERE conversation_id = ?
           AND (session_started_at > ?
             OR (session_started_at = ? AND session_record_id >= ?))
      `).run(
        usage.conversationId,
        usage.sessionStartedAt,
        usage.sessionStartedAt,
        usage.sessionRecordId,
      );
    });
    write(input);
  }

  /**
   * Update git diff stats for a previously-recorded session row. Silent no-op
   * if no history row exists for `sessionRecordId` (e.g. the session was
   * captured with cost = 0 and skipped the history entirely).
   */
  updateGitStats(sessionRecordId: string, stats: UsageHistoryGitStatsInput): void {
    this.db.prepare(`
      UPDATE usage_history
         SET lines_added = ?, lines_removed = ?, files_changed = ?
       WHERE session_record_id = ?
    `).run(stats.linesAdded, stats.linesRemoved, stats.filesChanged, sessionRecordId);
  }

  /**
   * Write git churn to exactly ONE row per task lineage: `canonicalRecordId`
   * (the record finalizing right now) gets the stats, every other record id
   * in `recordIds` (the task's other session records) is zeroed. Git churn is
   * branch-cumulative, so writing it to every `--resume` record and letting
   * the dashboard's flat SUM add them together would double-count; this
   * keeps the invariant that at most one `usage_history` row per task carries
   * non-zero churn, matching the flat SUM in `computeKpis`.
   *
   * If the canonical record has no history row (e.g. a cost-less leg that
   * never called `recordSessionUsage`), siblings are left untouched rather
   * than zeroed - an earlier leg's real churn must not be wiped just because
   * the LATEST leg happened to have no billable usage.
   */
  setTaskGitStats(recordIds: string[], canonicalRecordId: string, stats: UsageHistoryGitStatsInput): void {
    const write = this.db.transaction((allRecordIds: string[], canonicalId: string) => {
      const result = this.db.prepare(`
        UPDATE usage_history
           SET lines_added = ?, lines_removed = ?, files_changed = ?
         WHERE session_record_id = ?
      `).run(stats.linesAdded, stats.linesRemoved, stats.filesChanged, canonicalId);
      if (result.changes === 0) return;

      const siblings = allRecordIds.filter((recordId) => recordId !== canonicalId);
      if (siblings.length === 0) return;
      const placeholders = siblings.map(() => '?').join(', ');
      this.db.prepare(`
        UPDATE usage_history
           SET lines_added = 0, lines_removed = 0, files_changed = 0
         WHERE session_record_id IN (${placeholders})
      `).run(...siblings);
    });
    write(recordIds, canonicalRecordId);
  }

  /**
   * Builds the shared `[since, until)` window clause. All read queries filter
   * on `session_started_at` (when the work happened, not when the metrics
   * were flushed) so "Today" means "session started today" even for sessions
   * that finalize across midnight; null `since` = all time. Served by
   * idx_usage_history_session_started_at.
   */
  private buildWindowClause(since: string | null, until: string | null): { clauses: string[]; params: string[] } {
    const clauses: string[] = [];
    const params: string[] = [];
    if (since !== null) {
      clauses.push('session_started_at >= ?');
      params.push(since);
    }
    if (until !== null) {
      clauses.push('session_started_at < ?');
      params.push(until);
    }
    return { clauses, params };
  }

  /**
   * One-row SUM/COUNT/MIN/MAX aggregate over the window. The flat SUMs over
   * lines_added / lines_removed / files_changed are safe because the
   * `setTaskGitStats` canonical-record invariant guarantees at most one row
   * per task lineage carries non-zero churn. min/maxSessionStartedAt replace
   * the JS scans for the All Time range start and per-project lastActiveMs.
   */
  getUsageTotals(since: string | null, until: string | null = null): UsageWindowTotals {
    const { clauses, params } = this.buildWindowClause(since, until);
    const where = clauses.length > 0 ? ` WHERE ${clauses.join(' AND ')}` : '';
    return this.db.prepare(`
      SELECT
        COUNT(*) AS sessionCount,
        COALESCE(SUM(total_cost_usd), 0) AS totalCostUsd,
        COALESCE(SUM(total_input_tokens), 0) AS totalInputTokens,
        COALESCE(SUM(total_output_tokens), 0) AS totalOutputTokens,
        COALESCE(SUM(tool_call_count), 0) AS toolCallCount,
        COALESCE(SUM(lines_added), 0) AS linesAdded,
        COALESCE(SUM(lines_removed), 0) AS linesRemoved,
        COALESCE(SUM(files_changed), 0) AS filesChanged,
        COALESCE(SUM(compaction_count), 0) AS compactionCount,
        COALESCE(SUM(total_duration_ms), 0) AS totalDurationMs,
        COALESCE(SUM(CASE WHEN COALESCE(cumulative_cost_usd, total_cost_usd) > 0 THEN 1 ELSE 0 END), 0) AS costKnownCount,
        MIN(session_started_at) AS minSessionStartedAt,
        MAX(session_started_at) AS maxSessionStartedAt
      FROM usage_history${where}
    `).get(...params) as UsageWindowTotals;
  }

  /**
   * GROUP BY (model_id, model_display_name, agent, effort) rollup over the
   * window. Ordered by each combo's earliest session so JS regrouping (base
   * model id merge, agent/effort maps) encounters combos in the same order
   * the old row-by-row fold encountered rows - which pins first-encounter
   * behavior like the model display-name pick and stable-sort tie order.
   */
  listUsageRollup(
    since: string | null,
    until: string | null = null,
    sinceMs: number | null = null,
    untilMs: number | null = null,
  ): UsageRollupRow[] {
    const { clauses, params } = this.buildWindowClause(since, until);
    const where = clauses.length > 0 ? ` WHERE ${clauses.join(' AND ')}` : '';

    // Turn window, in epoch ms. The two ledgers key their windows differently
    // (`session_started_at` ISO here, `ts` integer there), so both bounds are
    // passed rather than derived, and the turn CTE is filtered on the same
    // instants the Tokens tile uses.
    const turnClauses = ['subagent_id IS NULL', 'ts IS NOT NULL'];
    const turnParams: number[] = [];
    if (sinceMs !== null) {
      turnClauses.push('ts >= ?');
      turnParams.push(sinceMs);
    }
    if (untilMs !== null) {
      turnClauses.push('ts < ?');
      turnParams.push(untilMs);
    }

    return this.db.prepare(`
      WITH session_turns AS (
        SELECT session_id AS sessionId,
               SUM(input_tokens) AS inputTokens,
               SUM(output_tokens) AS outputTokens
          FROM conversation_turn_usage
         WHERE ${turnClauses.join(' AND ')}
         GROUP BY session_id
      )
      SELECT
        model_id AS modelId,
        model_display_name AS modelDisplayName,
        agent,
        effort,
        COALESCE(SUM(session_turns.inputTokens), 0) AS inputTokens,
        COALESCE(SUM(session_turns.outputTokens), 0) AS outputTokens,
        COALESCE(SUM(total_cost_usd), 0) AS costUsd,
        COUNT(*) AS sessionCount
      FROM usage_history
      LEFT JOIN session_turns ON session_turns.sessionId = usage_history.session_record_id
      ${where}
      GROUP BY model_id, model_display_name, agent, effort
      ORDER BY MIN(session_started_at) ASC
    `).all(...turnParams, ...params) as UsageRollupRow[];
  }

  /**
   * Window rows grouped to fixed UTC buckets of `groupMs` per model (the
   * usage-stats service passes 15 minutes; see UsageCostGroupRow for the
   * nesting rationale). Rows whose session_started_at SQLite cannot parse are
   * excluded, mirroring the old fold's Date.parse NaN skip. Ordered by bucket
   * then each group's earliest session, so the JS fold builds each chart
   * point's per-model slices in the same first-encounter order as the old
   * row-by-row fold.
   */
  listUsageCostGroups(since: string | null, until: string | null, groupMs: number): UsageCostGroupRow[] {
    const { clauses, params } = this.buildWindowClause(since, until);
    clauses.unshift(`CAST(strftime('%s', session_started_at) AS INTEGER) IS NOT NULL`);
    return this.db.prepare(`
      SELECT
        CAST(CAST(strftime('%s', session_started_at) AS INTEGER) * 1000 / ? AS INTEGER) * ? AS bucketStartMs,
        model_id AS modelId,
        COALESCE(SUM(total_cost_usd), 0) AS costUsd,
        COALESCE(SUM(total_input_tokens), 0) AS inputTokens,
        COALESCE(SUM(total_output_tokens), 0) AS outputTokens,
        COUNT(*) AS sessionCount
      FROM usage_history
      WHERE ${clauses.join(' AND ')}
      GROUP BY bucketStartMs, model_id
      ORDER BY bucketStartMs ASC, MIN(session_started_at) ASC
    `).all(groupMs, groupMs, ...params) as UsageCostGroupRow[];
  }

  /**
   * How many of `sessionRecordIds` already have a ledger row inside the
   * window - the live-session dedup: a running session already snapshotted by
   * the periodic metrics timer must not be counted twice on top of the
   * ledger-derived session count. Live lists are tiny (one id per running
   * session), so the IN list never approaches SQLite's parameter limit.
   */
  countSessionsRepresented(since: string | null, until: string | null, sessionRecordIds: string[]): number {
    if (sessionRecordIds.length === 0) return 0;
    const { clauses, params } = this.buildWindowClause(since, until);
    const placeholders = sessionRecordIds.map(() => '?').join(', ');
    clauses.unshift(`session_record_id IN (${placeholders})`);
    const row = this.db.prepare(`
      SELECT COUNT(*) AS representedCount
      FROM usage_history
      WHERE ${clauses.join(' AND ')}
    `).get(...sessionRecordIds, ...params) as { representedCount: number };
    return row.representedCount;
  }

  /**
   * How much cost and how many snapshot tokens the window's ledger ALREADY
   * holds for `sessionRecordIds` - the baseline the renderer's live overlay
   * subtracts before layering its own in-memory numbers on top.
   *
   * Without this the Cost tile double-counts every running session: the 45s
   * metrics timer has already upserted that session's reading into the ledger,
   * so `SUM(total_cost_usd) + liveOverlay` counts it twice and the tile floats
   * above the by-model / by-agent / by-effort breakdowns, which have no
   * overlay. `countSessionsRepresented` above is the same idea for the session
   * COUNT; this is its cost/token sibling.
   *
   * Live lists are tiny (one id per running session), so the IN list never
   * approaches SQLite's parameter limit.
   */
  sumSessionsRepresented(
    since: string | null,
    until: string | null,
    sessionRecordIds: string[],
  ): { costUsd: number; inputTokens: number; outputTokens: number } {
    if (sessionRecordIds.length === 0) return { costUsd: 0, inputTokens: 0, outputTokens: 0 };
    const { clauses, params } = this.buildWindowClause(since, until);
    const placeholders = sessionRecordIds.map(() => '?').join(', ');
    clauses.unshift(`session_record_id IN (${placeholders})`);
    return this.db.prepare(`
      SELECT COALESCE(SUM(total_cost_usd), 0) AS costUsd,
             COALESCE(SUM(total_input_tokens), 0) AS inputTokens,
             COALESCE(SUM(total_output_tokens), 0) AS outputTokens
      FROM usage_history
      WHERE ${clauses.join(' AND ')}
    `).get(...sessionRecordIds, ...params) as
      { costUsd: number; inputTokens: number; outputTokens: number };
  }

}
