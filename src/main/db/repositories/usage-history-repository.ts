import type Database from 'better-sqlite3';
import { v4 as uuidv4 } from 'uuid';

/** One usage_history row as consumed by the usage-stats service. */
export interface UsageHistoryRow {
  sessionRecordId: string;
  sessionStartedAt: string;
  totalCostUsd: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalDurationMs: number | null;
  toolCallCount: number;
  modelId: string | null;
  modelDisplayName: string | null;
  linesAdded: number;
  linesRemoved: number;
  filesChanged: number;
  compactionCount: number;
  agent: string | null;
  effort: string | null;
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
   * owned by `updateGitStats` (called later from the post-suspend captureGitStats
   * path) and must not be clobbered by a re-capture.
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
   * List all history rows whose session started on or after `since` (null =
   * all time) and, when `until` is given, strictly before it (the dashboard's
   * day drill-down needs a bounded window). Oldest first. One query feeds the
   * usage dashboard's KPI totals, cost-per-day series, and by-model /
   * by-agent breakdowns; row counts are per-finalized-session (hundreds to
   * low thousands), so aggregating in JS is cheap and keeps the bucketing
   * logic in pure, unit-testable functions. Filters on `session_started_at`
   * (when the work happened, not when the metrics were flushed) so "Today"
   * means "session started today" even for sessions that finalize across
   * midnight.
   */
  listRowsAfter(since: string | null, until: string | null = null): UsageHistoryRow[] {
    const select = `
      SELECT
        session_record_id AS sessionRecordId,
        session_started_at AS sessionStartedAt,
        total_cost_usd AS totalCostUsd,
        total_input_tokens AS totalInputTokens,
        total_output_tokens AS totalOutputTokens,
        total_duration_ms AS totalDurationMs,
        tool_call_count AS toolCallCount,
        model_id AS modelId,
        model_display_name AS modelDisplayName,
        lines_added AS linesAdded,
        lines_removed AS linesRemoved,
        files_changed AS filesChanged,
        compaction_count AS compactionCount,
        agent,
        effort
      FROM usage_history
    `;
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
    const where = clauses.length > 0 ? ` WHERE ${clauses.join(' AND ')}` : '';
    return this.db.prepare(`${select}${where} ORDER BY session_started_at ASC`)
      .all(...params) as UsageHistoryRow[];
  }

}
