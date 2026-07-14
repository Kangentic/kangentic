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
  /** Rows with total_cost_usd > 0 (drives the costKnown KPI flag). */
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
  totalCostUsd: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalDurationMs: number | null;
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
 * Append-only history of finalized session usage. Decoupled from the `sessions`
 * and `tasks` tables: rows here outlive task deletion, bulk-archive cleanup,
 * and revert-to-backlog. The usage dashboard's period totals read from this
 * history so that "All Time" reflects every dollar/token actually spent on the
 * project.
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
   * Git stat columns are intentionally NOT in the UPDATE clause: they are
   * owned by `setTaskGitStats` (called later from the finalization-path
   * captureGitChurn) and must not be clobbered by a re-capture.
   */
  recordSessionUsage(input: RecordSessionUsageInput): void {
    this.db.prepare(`
      INSERT INTO usage_history
        (id, session_record_id, recorded_at, session_started_at, session_type,
         total_cost_usd, total_input_tokens, total_output_tokens,
         total_duration_ms, tool_call_count, model_id, model_display_name,
         compaction_count, agent, effort)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(session_record_id) DO UPDATE SET
        recorded_at = excluded.recorded_at,
        session_started_at = excluded.session_started_at,
        session_type = excluded.session_type,
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
      input.sessionRecordId,
      new Date().toISOString(),
      input.sessionStartedAt,
      input.sessionType,
      input.totalCostUsd,
      input.totalInputTokens,
      input.totalOutputTokens,
      input.totalDurationMs,
      input.toolCallCount,
      input.modelId,
      input.modelDisplayName,
      input.compactionCount,
      input.agent,
      input.effort,
    );
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
        COALESCE(SUM(CASE WHEN total_cost_usd > 0 THEN 1 ELSE 0 END), 0) AS costKnownCount,
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
  listUsageRollup(since: string | null, until: string | null = null): UsageRollupRow[] {
    const { clauses, params } = this.buildWindowClause(since, until);
    const where = clauses.length > 0 ? ` WHERE ${clauses.join(' AND ')}` : '';
    return this.db.prepare(`
      SELECT
        model_id AS modelId,
        model_display_name AS modelDisplayName,
        agent,
        effort,
        COALESCE(SUM(total_input_tokens), 0) AS inputTokens,
        COALESCE(SUM(total_output_tokens), 0) AS outputTokens,
        COALESCE(SUM(total_cost_usd), 0) AS costUsd,
        COUNT(*) AS sessionCount
      FROM usage_history${where}
      GROUP BY model_id, model_display_name, agent, effort
      ORDER BY MIN(session_started_at) ASC
    `).all(...params) as UsageRollupRow[];
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

}
