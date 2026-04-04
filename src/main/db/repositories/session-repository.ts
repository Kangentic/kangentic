import { v4 as uuidv4 } from 'uuid';
import type Database from 'better-sqlite3';
import type { SessionRecord, SessionRecordStatus, SessionSummary, SuspendedBy, PeriodUsageStats } from '../../../shared/types';

/** Fields accepted by insert(). Excludes `id` (auto-generated) and metric columns (set via updateMetrics). */
type SessionInsertInput = Omit<SessionRecord,
  'id' | 'total_cost_usd' | 'total_input_tokens' | 'total_output_tokens' | 'model_id' | 'model_display_name' | 'total_duration_ms' | 'tool_call_count' | 'lines_added' | 'lines_removed' | 'files_changed'
>;

export interface SessionMetricsInput {
  totalCostUsd: number | null;
  totalInputTokens: number | null;
  totalOutputTokens: number | null;
  modelId: string | null;
  modelDisplayName: string | null;
  totalDurationMs: number | null;
  toolCallCount: number | null;
}

export class SessionRepository {
  constructor(private db: Database.Database) {}

  insert(record: SessionInsertInput): SessionRecord {
    const id = uuidv4();
    this.db.prepare(`
      INSERT INTO sessions (id, task_id, session_type, agent_session_id, command, cwd, permission_mode, prompt, status, exit_code, started_at, suspended_at, exited_at, suspended_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      record.task_id,
      record.session_type,
      record.agent_session_id,
      record.command,
      record.cwd,
      record.permission_mode,
      record.prompt,
      record.status,
      record.exit_code,
      record.started_at,
      record.suspended_at,
      record.exited_at,
      record.suspended_by,
    );
    return {
      id,
      ...record,
      total_cost_usd: null,
      total_input_tokens: null,
      total_output_tokens: null,
      model_id: null,
      model_display_name: null,
      total_duration_ms: null,
      tool_call_count: null,
      lines_added: null,
      lines_removed: null,
      files_changed: null,
    };
  }

  /**
   * Atomic compare-and-set status transition. Only updates if the current
   * status matches one of the expected "from" statuses. Returns true if the
   * row was actually updated (transition succeeded), false if the current
   * status didn't match (transition rejected).
   *
   * This prevents race conditions between concurrent writers (e.g. suspend()
   * setting 'suspended' while onExit sets 'exited').
   */
  compareAndUpdateStatus(
    id: string,
    expectedFrom: SessionRecordStatus | SessionRecordStatus[],
    to: SessionRecordStatus,
    extra?: { exit_code?: number; suspended_at?: string; exited_at?: string; suspended_by?: SuspendedBy | null },
  ): boolean {
    const sets = ['status = ?'];
    const params: unknown[] = [to];

    if (extra?.exit_code !== undefined) {
      sets.push('exit_code = ?');
      params.push(extra.exit_code);
    }
    if (extra?.suspended_at !== undefined) {
      sets.push('suspended_at = ?');
      params.push(extra.suspended_at);
    }
    if (extra?.exited_at !== undefined) {
      sets.push('exited_at = ?');
      params.push(extra.exited_at);
    }
    if (extra?.suspended_by !== undefined) {
      sets.push('suspended_by = ?');
      params.push(extra.suspended_by);
    }

    const fromList = Array.isArray(expectedFrom) ? expectedFrom : [expectedFrom];
    const placeholders = fromList.map(() => '?').join(', ');
    params.push(id, ...fromList);

    const result = this.db.prepare(
      `UPDATE sessions SET ${sets.join(', ')} WHERE id = ? AND status IN (${placeholders})`,
    ).run(...params);
    return result.changes > 0;
  }

  /** Update the agent_session_id for a session record (stale ID recovery). */
  updateAgentSessionId(id: string, agentSessionId: string): void {
    this.db.prepare('UPDATE sessions SET agent_session_id = ? WHERE id = ?').run(agentSessionId, id);
  }

  /** Get suspended agent sessions that can be resumed */
  getResumable(): SessionRecord[] {
    return this.db.prepare(
      `SELECT * FROM sessions WHERE status = 'suspended' AND session_type != 'run_script'`
    ).all() as SessionRecord[];
  }

  /** Mark all currently 'running' sessions as 'orphaned' (crash recovery) */
  markAllRunningAsOrphaned(): void {
    this.db.prepare(
      `UPDATE sessions SET status = 'orphaned' WHERE status IN ('running', 'queued')`
    ).run();
  }

  /**
   * Mark 'running' sessions as 'orphaned', but SKIP records whose task_id
   * is in the exclusion set. This prevents re-entrant recovery calls (e.g.
   * Vite hot-reload) from orphaning sessions that are actively running.
   */
  markRunningAsOrphanedExcluding(excludeTaskIds: Set<string>): void {
    if (excludeTaskIds.size === 0) {
      this.markAllRunningAsOrphaned();
      return;
    }
    const ids = Array.from(excludeTaskIds);
    const placeholders = ids.map(() => '?').join(', ');
    this.db.prepare(
      `UPDATE sessions SET status = 'orphaned' WHERE status IN ('running', 'queued') AND task_id NOT IN (${placeholders})`
    ).run(...ids);
  }

  /** Get orphaned agent sessions */
  getOrphaned(): SessionRecord[] {
    return this.db.prepare(
      `SELECT * FROM sessions WHERE status = 'orphaned' AND session_type != 'run_script'`
    ).all() as SessionRecord[];
  }

  /** Delete all session records for a given task */
  deleteByTaskId(taskId: string): void {
    this.db.prepare('DELETE FROM sessions WHERE task_id = ?').run(taskId);
  }

  /** Update the working directory of a session record (e.g. after enabling a worktree). */
  updateCwd(id: string, cwd: string): void {
    this.db.prepare('UPDATE sessions SET cwd = ? WHERE id = ?').run(cwd, id);
  }

  /** Find the latest session record for a given task */
  getLatestForTask(taskId: string): SessionRecord | undefined {
    return this.db.prepare(
      `SELECT * FROM sessions WHERE task_id = ? ORDER BY started_at DESC LIMIT 1`
    ).get(taskId) as SessionRecord | undefined;
  }

  /** Get task IDs whose latest session was user-paused (for reconciliation). */
  getUserPausedTaskIds(): Set<string> {
    const rows = this.db.prepare(`
      SELECT s.task_id FROM sessions s
      INNER JOIN (
        SELECT task_id, MAX(started_at) as max_started_at
        FROM sessions GROUP BY task_id
      ) latest ON s.task_id = latest.task_id AND s.started_at = latest.max_started_at
      WHERE s.status = 'suspended' AND s.suspended_by = 'user'
    `).all() as Array<{ task_id: string }>;
    return new Set(rows.map(r => r.task_id));
  }

  /** Get all distinct agent session IDs (for stale directory cleanup). */
  listAllAgentSessionIds(): string[] {
    const rows = this.db.prepare(
      `SELECT DISTINCT agent_session_id FROM sessions WHERE agent_session_id IS NOT NULL`
    ).all() as Array<{ agent_session_id: string }>;
    return rows.map(r => r.agent_session_id);
  }

  /** Update the 7 metric columns for a session record. */
  updateMetrics(id: string, metrics: SessionMetricsInput): void {
    this.db.prepare(`
      UPDATE sessions SET
        total_cost_usd = ?,
        total_input_tokens = ?,
        total_output_tokens = ?,
        model_id = ?,
        model_display_name = ?,
        total_duration_ms = ?,
        tool_call_count = ?
      WHERE id = ?
    `).run(
      metrics.totalCostUsd,
      metrics.totalInputTokens,
      metrics.totalOutputTokens,
      metrics.modelId,
      metrics.modelDisplayName,
      metrics.totalDurationMs,
      metrics.toolCallCount,
      id,
    );
  }

  /** Update git diff stats for a session record. */
  updateGitStats(id: string, stats: { linesAdded: number; linesRemoved: number; filesChanged: number }): void {
    this.db.prepare(`
      UPDATE sessions SET lines_added = ?, lines_removed = ?, files_changed = ?
      WHERE id = ?
    `).run(stats.linesAdded, stats.linesRemoved, stats.filesChanged, id);
  }

  /**
   * Get session summary for a task, aggregated across all session records.
   *
   * Cumulative Claude metrics (cost, tokens, duration, model) come from the
   * latest record (Claude's status.json accumulates across --resume cycles).
   * Per-PTY metrics (tool calls, git stats) are summed across all records.
   * Timeline uses task.created_at as the start time.
   */
  getSummaryForTask(taskId: string): SessionSummary | null {
    const latestRecord = this.db.prepare(
      `SELECT s.*, t.created_at AS task_created_at
       FROM sessions s
       JOIN tasks t ON t.id = s.task_id
       WHERE s.task_id = ? AND s.total_cost_usd IS NOT NULL
       ORDER BY s.started_at DESC LIMIT 1`
    ).get(taskId) as (SessionRecord & { task_created_at: string }) | undefined;
    if (!latestRecord) return null;

    const aggregated = this.db.prepare(
      `SELECT
         COALESCE(SUM(tool_call_count), 0) AS total_tool_calls,
         COALESCE(SUM(lines_added), 0) AS total_lines_added,
         COALESCE(SUM(lines_removed), 0) AS total_lines_removed,
         MAX(COALESCE(files_changed, 0)) AS max_files_changed,
         MIN(started_at) AS earliest_started_at,
         MAX(COALESCE(exited_at, suspended_at)) AS latest_ended_at
       FROM sessions
       WHERE task_id = ? AND total_cost_usd IS NOT NULL`
    ).get(taskId) as {
      total_tool_calls: number;
      total_lines_added: number;
      total_lines_removed: number;
      max_files_changed: number;
      earliest_started_at: string;
      latest_ended_at: string | null;
    };

    return {
      sessionId: latestRecord.agent_session_id ?? latestRecord.id,
      totalCostUsd: latestRecord.total_cost_usd ?? 0,
      totalInputTokens: latestRecord.total_input_tokens ?? 0,
      totalOutputTokens: latestRecord.total_output_tokens ?? 0,
      modelDisplayName: latestRecord.model_display_name ?? '',
      durationMs: latestRecord.total_duration_ms ?? 0,
      toolCallCount: aggregated.total_tool_calls,
      linesAdded: aggregated.total_lines_added,
      linesRemoved: aggregated.total_lines_removed,
      filesChanged: aggregated.max_files_changed,
      taskCreatedAt: latestRecord.task_created_at,
      startedAt: aggregated.earliest_started_at,
      exitedAt: aggregated.latest_ended_at,
      exitCode: latestRecord.exit_code,
    };
  }

  /**
   * Get summaries for all tasks that have metric data, keyed by task_id.
   * Aggregates per-PTY metrics across all session records per task.
   */
  listAllSummaries(): Record<string, SessionSummary> {
    const rows = this.db.prepare(
      `SELECT
         s.task_id,
         t.created_at AS task_created_at,
         s.agent_session_id,
         s.id AS record_id,
         s.total_cost_usd,
         s.total_input_tokens,
         s.total_output_tokens,
         s.model_display_name,
         s.total_duration_ms,
         s.exit_code,
         s.started_at,
         s.exited_at,
         s.suspended_at,
         s.tool_call_count,
         s.lines_added,
         s.lines_removed,
         s.files_changed,
         ROW_NUMBER() OVER (PARTITION BY s.task_id ORDER BY s.started_at DESC) AS row_num
       FROM sessions s
       JOIN tasks t ON t.id = s.task_id
       WHERE s.total_cost_usd IS NOT NULL`
    ).all() as Array<{
      task_id: string;
      task_created_at: string;
      agent_session_id: string | null;
      record_id: string;
      total_cost_usd: number | null;
      total_input_tokens: number | null;
      total_output_tokens: number | null;
      model_display_name: string | null;
      total_duration_ms: number | null;
      exit_code: number | null;
      started_at: string;
      exited_at: string | null;
      suspended_at: string | null;
      tool_call_count: number | null;
      lines_added: number | null;
      lines_removed: number | null;
      files_changed: number | null;
      row_num: number;
    }>;

    // Group by task_id: latest record provides cumulative metrics, all records contribute to aggregates
    const taskGroups = new Map<string, Array<typeof rows[number]>>();
    for (const row of rows) {
      const group = taskGroups.get(row.task_id);
      if (group) {
        group.push(row);
      } else {
        taskGroups.set(row.task_id, [row]);
      }
    }

    const result: Record<string, SessionSummary> = {};
    for (const [taskId, group] of taskGroups) {
      const latest = group.find((row) => row.row_num === 1)!;
      let totalToolCalls = 0;
      let totalLinesAdded = 0;
      let totalLinesRemoved = 0;
      let maxFilesChanged = 0;
      let earliestStartedAt = latest.started_at;
      let latestEndedAt: string | null = null;

      for (const row of group) {
        totalToolCalls += row.tool_call_count ?? 0;
        totalLinesAdded += row.lines_added ?? 0;
        totalLinesRemoved += row.lines_removed ?? 0;
        maxFilesChanged = Math.max(maxFilesChanged, row.files_changed ?? 0);
        if (row.started_at < earliestStartedAt) earliestStartedAt = row.started_at;
        const endedAt = row.exited_at ?? row.suspended_at;
        if (endedAt && (!latestEndedAt || endedAt > latestEndedAt)) latestEndedAt = endedAt;
      }

      result[taskId] = {
        sessionId: latest.agent_session_id ?? latest.record_id,
        totalCostUsd: latest.total_cost_usd ?? 0,
        totalInputTokens: latest.total_input_tokens ?? 0,
        totalOutputTokens: latest.total_output_tokens ?? 0,
        modelDisplayName: latest.model_display_name ?? '',
        durationMs: latest.total_duration_ms ?? 0,
        toolCallCount: totalToolCalls,
        linesAdded: totalLinesAdded,
        linesRemoved: totalLinesRemoved,
        filesChanged: maxFilesChanged,
        taskCreatedAt: latest.task_created_at,
        startedAt: earliestStartedAt,
        exitedAt: latestEndedAt,
        exitCode: latest.exit_code,
      };
    }
    return result;
  }

  /**
   * Get aggregated cost/token stats for sessions started on or after
   * the given ISO date string. Pass null to include all sessions.
   */
  getStatsAfter(since: string | null): PeriodUsageStats {
    const row = since
      ? this.db.prepare(`
          SELECT
            COALESCE(SUM(total_cost_usd), 0) AS totalCostUsd,
            COALESCE(SUM(total_input_tokens), 0) AS totalInputTokens,
            COALESCE(SUM(total_output_tokens), 0) AS totalOutputTokens
          FROM sessions
          WHERE total_cost_usd IS NOT NULL AND started_at >= ?
        `).get(since) as PeriodUsageStats
      : this.db.prepare(`
          SELECT
            COALESCE(SUM(total_cost_usd), 0) AS totalCostUsd,
            COALESCE(SUM(total_input_tokens), 0) AS totalInputTokens,
            COALESCE(SUM(total_output_tokens), 0) AS totalOutputTokens
          FROM sessions
          WHERE total_cost_usd IS NOT NULL
        `).get() as PeriodUsageStats;
    return row ?? { totalCostUsd: 0, totalInputTokens: 0, totalOutputTokens: 0 };
  }
}
