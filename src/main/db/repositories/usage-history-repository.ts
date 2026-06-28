import type Database from 'better-sqlite3';
import { v4 as uuidv4 } from 'uuid';
import type { PeriodUsageStats } from '../../../shared/types';

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
}

export interface UsageHistoryGitStatsInput {
  linesAdded: number;
  linesRemoved: number;
  filesChanged: number;
}

/**
 * Append-only history of finalized session usage. Decoupled from the `sessions`
 * and `tasks` tables: rows here outlive task deletion, bulk-archive cleanup,
 * and revert-to-backlog. The StatusBar period selector reads from this history
 * so that "All Time" reflects every dollar/token actually spent on the project.
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
         compaction_count)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
        compaction_count = excluded.compaction_count
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
   * Sum cost/tokens across all history rows whose session started on or after
   * `since`. Pass null for "All Time". Period bucketing uses
   * `session_started_at` (when the work happened), not `recorded_at` (when
   * the metrics were flushed) so the existing Today/Week/Month semantics are
   * preserved.
   */
  getStatsAfter(since: string | null): PeriodUsageStats {
    const row = since
      ? this.db.prepare(`
          SELECT
            COALESCE(SUM(total_cost_usd), 0) AS totalCostUsd,
            COALESCE(SUM(total_input_tokens), 0) AS totalInputTokens,
            COALESCE(SUM(total_output_tokens), 0) AS totalOutputTokens
          FROM usage_history
          WHERE session_started_at >= ?
        `).get(since) as PeriodUsageStats
      : this.db.prepare(`
          SELECT
            COALESCE(SUM(total_cost_usd), 0) AS totalCostUsd,
            COALESCE(SUM(total_input_tokens), 0) AS totalInputTokens,
            COALESCE(SUM(total_output_tokens), 0) AS totalOutputTokens
          FROM usage_history
        `).get() as PeriodUsageStats;
    return row ?? { totalCostUsd: 0, totalInputTokens: 0, totalOutputTokens: 0 };
  }
}
