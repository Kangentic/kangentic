import type Database from 'better-sqlite3';
import type { PerToolStat, SessionRecord, SessionRecordStatus, SessionSummary, SuspendedBy } from '../../../shared/types';

/**
 * Fields accepted by insert(). Caller must provide `id` (the PTY session ID)
 * to unify the DB record key with the SessionManager/TranscriptWriter key.
 * Excludes metric columns (set via updateMetrics) and the applied model/effort
 * (set via updateAppliedSettings, mirroring how metrics are maintained).
 */
type SessionInsertInput = Omit<SessionRecord,
  'total_cost_usd' | 'total_input_tokens' | 'total_output_tokens' | 'model_id' | 'model_display_name' | 'applied_model' | 'applied_effort' | 'total_duration_ms' | 'tool_call_count' | 'lines_added' | 'lines_removed' | 'files_changed' | 'tool_breakdown' | 'compaction_count'
>;

export interface SessionMetricsInput {
  totalCostUsd: number | null;
  totalInputTokens: number | null;
  totalOutputTokens: number | null;
  modelId: string | null;
  modelDisplayName: string | null;
  totalDurationMs: number | null;
  toolCallCount: number | null;
  /** JSON-serialized PerToolStat[]; null for sessions with no tool events. */
  toolBreakdown: string | null;
  /** Context compactions during this run (PreCompact hooks). Defaults to 0. */
  compactionCount: number;
}

/**
 * Type guard for a single tool_breakdown entry. Required fields must be
 * present and correctly typed; optional fields (costUsd / inputTokens /
 * outputTokens) are only validated when present so future writers can
 * extend the shape without tripping the guard.
 */
function isPerToolStat(value: unknown): value is PerToolStat {
  if (value === null || typeof value !== 'object') return false;
  const candidate = value as Record<string, unknown>;
  if (typeof candidate.toolName !== 'string') return false;
  if (typeof candidate.callCount !== 'number') return false;
  if (typeof candidate.totalDurationMs !== 'number') return false;
  if (typeof candidate.interruptedCount !== 'number') return false;
  if (candidate.costUsd !== undefined && typeof candidate.costUsd !== 'number') return false;
  if (candidate.inputTokens !== undefined && typeof candidate.inputTokens !== 'number') return false;
  if (candidate.outputTokens !== undefined && typeof candidate.outputTokens !== 'number') return false;
  return true;
}

/**
 * Parse a `tool_breakdown` JSON column into typed `PerToolStat[]`. Tolerant
 * of malformed payloads (rows from older versions or hand-edited DBs) so
 * one corrupt record can't crash the Session Summary panel. Entries that
 * fail the shape guard are dropped silently rather than rendered as blank
 * rows with undefined React keys.
 */
function parseToolBreakdown(raw: string | null): PerToolStat[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isPerToolStat);
  } catch {
    return [];
  }
}

export class SessionRepository {
  constructor(private db: Database.Database) {}

  insert(record: SessionInsertInput): SessionRecord {
    this.db.prepare(`
      INSERT INTO sessions (id, task_id, session_type, isolated_swimlane_id, agent_session_id, command, cwd, permission_mode, prompt, status, exit_code, started_at, suspended_at, exited_at, suspended_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      record.id,
      record.task_id,
      record.session_type,
      record.isolated_swimlane_id,
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
      ...record,
      total_cost_usd: null,
      total_input_tokens: null,
      total_output_tokens: null,
      model_id: null,
      model_display_name: null,
      applied_model: null,
      applied_effort: null,
      total_duration_ms: null,
      tool_call_count: null,
      lines_added: null,
      lines_removed: null,
      files_changed: null,
      tool_breakdown: null,
      compaction_count: 0,
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

  /**
   * Get OS-killed ("interrupted") agent sessions: status='exited' with an
   * ABNORMAL exit code, still resumable, that are the LATEST record for their
   * (task, session_type, isolation) group.
   *
   * A hard shutdown (OS restart, power loss, SIGKILL) kills the PTY before the
   * clean-quit path can mark the record 'suspended', so the onExit handler
   * records it 'exited' with an abnormal code (Windows 1073807364, Unix
   * 137/143/130). Those rows are invisible to getResumable()/getOrphaned(), so
   * startup recovery would otherwise abandon the conversation and spawn a fresh
   * empty session. This gather routes them through the same recovery pipeline.
   *
   * The abnormal predicate is the cross-platform `exit_code != 0` (treats every
   * OS's kill code uniformly; deliberately not keyed to any specific code). A
   * null code and a clean exit 0 are excluded: startup resumes interrupted
   * agents only, never ones the user deliberately /exit-ed. The latest-in-group
   * subquery prevents resurrecting an older abnormal session that a newer record
   * of any status (e.g. a later clean exit) has shadowed. `IS` is SQLite
   * null-safe equality, so the isolation match folds NULL (main) correctly.
   *
   * On the rare tie where two same-group records share an identical started_at,
   * both are returned; the startup dedup keeps one per track downstream.
   */
  getInterruptedExited(): SessionRecord[] {
    return this.db.prepare(
      `SELECT * FROM sessions AS s
       WHERE s.status = 'exited'
         AND s.session_type != 'run_script'
         AND s.agent_session_id IS NOT NULL
         AND s.exit_code IS NOT NULL
         AND s.exit_code != 0
         AND s.started_at = (
           SELECT MAX(s2.started_at) FROM sessions AS s2
           WHERE s2.task_id = s.task_id
             AND s2.session_type = s.session_type
             AND s2.isolated_swimlane_id IS s.isolated_swimlane_id
         )`
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

  /** All session records, regardless of status. Used by project relocation to rewrite stored cwds. */
  listAll(): SessionRecord[] {
    return this.db.prepare('SELECT * FROM sessions').all() as SessionRecord[];
  }

  /** Find the latest session record for a given task */
  getLatestForTask(taskId: string): SessionRecord | undefined {
    return this.db.prepare(
      `SELECT * FROM sessions WHERE task_id = ? ORDER BY started_at DESC LIMIT 1`
    ).get(taskId) as SessionRecord | undefined;
  }

  /** All session records for a task, newest first. Used by index-based pickers (sessionIndex). */
  listForTaskNewestFirst(taskId: string): SessionRecord[] {
    return this.db.prepare(
      `SELECT * FROM sessions WHERE task_id = ? ORDER BY started_at DESC`
    ).all(taskId) as SessionRecord[];
  }

  /**
   * Find the latest session record for a task, scoped to session_type AND the
   * isolated swimlane (null = the main session). This is the resume-decision
   * lookup: cross-agent (session_type) and cross-isolation mismatches are
   * structurally impossible. An isolated column resumes its own session while the
   * main session records stay untouched. Uses `IS ?` so a null param matches the
   * main-session rows (`isolated_swimlane_id IS NULL`).
   */
  getLatestForTaskByTypeAndIsolation(taskId: string, sessionType: string, isolatedSwimlaneId: string | null): SessionRecord | undefined {
    return this.db.prepare(
      `SELECT * FROM sessions WHERE task_id = ? AND session_type = ? AND isolated_swimlane_id IS ? ORDER BY started_at DESC LIMIT 1`
    ).get(taskId, sessionType, isolatedSwimlaneId) as SessionRecord | undefined;
  }

  /**
   * Find a session record by either its Kangentic id or its agent_session_id.
   * Used by lookup paths that accept "any session identifier" - e.g. the
   * MCP get_transcript handler accepting either flavor of UUID. Picks the
   * most recent match if both columns happen to collide on the same id.
   */
  findByAnyId(sessionId: string): SessionRecord | undefined {
    return this.db.prepare(
      `SELECT * FROM sessions WHERE id = ? OR agent_session_id = ? ORDER BY started_at DESC LIMIT 1`
    ).get(sessionId, sessionId) as SessionRecord | undefined;
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

  /** Get all distinct session record IDs (for stale directory cleanup). */
  listAllSessionIds(): string[] {
    const rows = this.db.prepare(
      `SELECT DISTINCT id FROM sessions`
    ).all() as Array<{ id: string }>;
    return rows.map(r => r.id);
  }

  /** Update the metric columns for a session record. */
  updateMetrics(id: string, metrics: SessionMetricsInput): void {
    this.db.prepare(`
      UPDATE sessions SET
        total_cost_usd = ?,
        total_input_tokens = ?,
        total_output_tokens = ?,
        model_id = ?,
        model_display_name = ?,
        total_duration_ms = ?,
        tool_call_count = ?,
        tool_breakdown = ?,
        compaction_count = ?
      WHERE id = ?
    `).run(
      metrics.totalCostUsd,
      metrics.totalInputTokens,
      metrics.totalOutputTokens,
      metrics.modelId,
      metrics.modelDisplayName,
      metrics.totalDurationMs,
      metrics.toolCallCount,
      metrics.toolBreakdown,
      metrics.compactionCount,
      id,
    );
  }

  /**
   * Record the model/effort the session is now actually running at. Called at
   * spawn/resume (with the resolved spawn overrides) and after every live
   * settings switch (column-move injection, column-edit propagation, ContextBar
   * pick). Only the provided field(s) are written, so a switch that changes just
   * effort leaves the recorded model intact. `null` means agent default / no
   * flag. This is the ground truth `prepareInjectionPlan` diffs against.
   */
  updateAppliedSettings(id: string, applied: { model?: string | null; effort?: string | null }): void {
    const sets: string[] = [];
    const params: Array<string | null> = [];
    if (applied.model !== undefined) {
      sets.push('applied_model = ?');
      params.push(applied.model);
    }
    if (applied.effort !== undefined) {
      sets.push('applied_effort = ?');
      params.push(applied.effort);
    }
    if (sets.length === 0) return;
    params.push(id);
    this.db.prepare(`UPDATE sessions SET ${sets.join(', ')} WHERE id = ?`).run(...params);
  }

  /**
   * Override ONLY the cumulative token columns for a session record, with the
   * transcript-derived lifetime totals. Called fire-and-forget after the
   * snapshot capture (see `refineTranscriptTokens`): the live statusLine token
   * counts are a current-context snapshot, so the transcript is the
   * authoritative lifetime source on Claude Code 2.1.132+. Keyed by record id,
   * so it is safe to land after the session is removed from the manager.
   */
  updateTranscriptTokens(id: string, tokens: { totalInputTokens: number; totalOutputTokens: number }): void {
    this.db.prepare(
      'UPDATE sessions SET total_input_tokens = ?, total_output_tokens = ? WHERE id = ?',
    ).run(tokens.totalInputTokens, tokens.totalOutputTokens, id);
  }

  /**
   * Backfill ONLY the tool-count columns from the transcript-derived
   * cumulative, fire-and-forget after `captureSessionMetrics` (see
   * `refineTranscriptToolCounts` in `session-metrics.ts`). Guarded to fill
   * ONLY an empty count (NULL or 0) so a working live accumulator - higher
   * fidelity when it worked (real durations + a separate interrupted tally) -
   * is never overwritten by the transcript's coarser callCount-only figure.
   * Count and breakdown are written together so
   * `SUM(breakdown.callCount) == tool_call_count` stays consistent.
   */
  updateTranscriptToolCounts(id: string, counts: { toolCallCount: number; toolBreakdown: PerToolStat[] }): void {
    this.db.prepare(
      `UPDATE sessions SET tool_call_count = ?, tool_breakdown = ?
       WHERE id = ? AND (tool_call_count IS NULL OR tool_call_count = 0)`,
    ).run(
      counts.toolCallCount,
      counts.toolBreakdown.length > 0 ? JSON.stringify(counts.toolBreakdown) : null,
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
   * Get the LIFETIME session summary for a task, aggregated across every session
   * record so totals strictly increase as the task is worked across restarts.
   *
   * Each `--resume` (even within one app run, and across restarts) is a fresh
   * session row holding ONE CLI process's captured cumulative, so:
   *   - cost / duration / compactions / tool calls / lines are SUMmed across rows
   *     (each row is an independent process contribution), files_changed is MAX;
   *   - tokens are special: the live statusLine `context_window` counts are a
   *     current-context snapshot (NOT cumulative on Claude Code 2.1.132+), so
   *     each row instead stores the transcript-derived CUMULATIVE tokens for its
   *     own session lineage (written by `refineTranscriptTokens`). Summing every
   *     row would double-count a session resumed across restarts, so we take the
   *     latest row per `agent_session_id` and SUM across distinct sessions
   *     (additive over a task's main + isolated-swimlane sessions).
   *   - model / exit code / tool breakdown come from the latest record (the most
   *     recent run's values), and the timeline spans the task's whole life.
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
         COALESCE(SUM(total_cost_usd), 0) AS total_cost_usd,
         COALESCE(SUM(total_duration_ms), 0) AS total_duration_ms,
         COALESCE(SUM(tool_call_count), 0) AS total_tool_calls,
         COALESCE(SUM(compaction_count), 0) AS total_compactions,
         COALESCE(SUM(lines_added), 0) AS total_lines_added,
         COALESCE(SUM(lines_removed), 0) AS total_lines_removed,
         MAX(COALESCE(files_changed, 0)) AS max_files_changed,
         MIN(started_at) AS earliest_started_at,
         MAX(COALESCE(exited_at, suspended_at)) AS latest_ended_at
       FROM sessions
       WHERE task_id = ? AND total_cost_usd IS NOT NULL`
    ).get(taskId) as {
      total_cost_usd: number;
      total_duration_ms: number;
      total_tool_calls: number;
      total_compactions: number;
      total_lines_added: number;
      total_lines_removed: number;
      max_files_changed: number;
      earliest_started_at: string;
      latest_ended_at: string | null;
    };

    // Lifetime tokens: latest row per session lineage, then summed across
    // lineages (see the doc comment above for why this is not a flat SUM).
    const tokens = this.db.prepare(
      `SELECT COALESCE(SUM(input_tokens), 0) AS total_input_tokens,
              COALESCE(SUM(output_tokens), 0) AS total_output_tokens
       FROM (
         SELECT total_input_tokens AS input_tokens,
                total_output_tokens AS output_tokens,
                ROW_NUMBER() OVER (PARTITION BY COALESCE(agent_session_id, id) ORDER BY started_at DESC) AS rn
         FROM sessions
         WHERE task_id = ? AND total_cost_usd IS NOT NULL
       )
       WHERE rn = 1`
    ).get(taskId) as { total_input_tokens: number; total_output_tokens: number };

    return {
      sessionId: latestRecord.agent_session_id ?? latestRecord.id,
      totalCostUsd: aggregated.total_cost_usd,
      totalInputTokens: tokens.total_input_tokens,
      totalOutputTokens: tokens.total_output_tokens,
      modelDisplayName: latestRecord.model_display_name ?? '',
      durationMs: aggregated.total_duration_ms,
      toolCallCount: aggregated.total_tool_calls,
      compactionCount: aggregated.total_compactions,
      linesAdded: aggregated.total_lines_added,
      linesRemoved: aggregated.total_lines_removed,
      filesChanged: aggregated.max_files_changed,
      taskCreatedAt: latestRecord.task_created_at,
      startedAt: aggregated.earliest_started_at,
      exitedAt: aggregated.latest_ended_at,
      exitCode: latestRecord.exit_code,
      toolBreakdown: parseToolBreakdown(latestRecord.tool_breakdown),
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
         s.tool_breakdown,
         s.compaction_count,
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
      tool_breakdown: string | null;
      compaction_count: number | null;
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
      // Lifetime aggregation - mirrors getSummaryForTask: SUM cost / duration /
      // compactions / tool calls / lines across every run, MAX files_changed,
      // and tokens are the latest row per session lineage SUMmed across lineages
      // (a flat SUM would double-count a session resumed across restarts).
      let totalCostUsd = 0;
      let totalDurationMs = 0;
      let totalCompactions = 0;
      let totalToolCalls = 0;
      let totalLinesAdded = 0;
      let totalLinesRemoved = 0;
      let maxFilesChanged = 0;
      let totalInputTokens = 0;
      let totalOutputTokens = 0;
      let earliestStartedAt = latest.started_at;
      let latestEndedAt: string | null = null;
      // Rows are ordered started_at DESC within the task, so the FIRST row seen
      // for a lineage is its latest - the one carrying the transcript cumulative.
      const seenLineages = new Set<string>();

      for (const row of group) {
        totalCostUsd += row.total_cost_usd ?? 0;
        totalDurationMs += row.total_duration_ms ?? 0;
        totalCompactions += row.compaction_count ?? 0;
        totalToolCalls += row.tool_call_count ?? 0;
        totalLinesAdded += row.lines_added ?? 0;
        totalLinesRemoved += row.lines_removed ?? 0;
        maxFilesChanged = Math.max(maxFilesChanged, row.files_changed ?? 0);
        if (row.started_at < earliestStartedAt) earliestStartedAt = row.started_at;
        const endedAt = row.exited_at ?? row.suspended_at;
        if (endedAt && (!latestEndedAt || endedAt > latestEndedAt)) latestEndedAt = endedAt;
        const lineageKey = row.agent_session_id ?? row.record_id;
        if (!seenLineages.has(lineageKey)) {
          seenLineages.add(lineageKey);
          totalInputTokens += row.total_input_tokens ?? 0;
          totalOutputTokens += row.total_output_tokens ?? 0;
        }
      }

      result[taskId] = {
        sessionId: latest.agent_session_id ?? latest.record_id,
        totalCostUsd,
        totalInputTokens,
        totalOutputTokens,
        modelDisplayName: latest.model_display_name ?? '',
        durationMs: totalDurationMs,
        toolCallCount: totalToolCalls,
        compactionCount: totalCompactions,
        linesAdded: totalLinesAdded,
        linesRemoved: totalLinesRemoved,
        filesChanged: maxFilesChanged,
        taskCreatedAt: latest.task_created_at,
        startedAt: earliestStartedAt,
        exitedAt: latestEndedAt,
        exitCode: latest.exit_code,
        toolBreakdown: parseToolBreakdown(latest.tool_breakdown),
      };
    }
    return result;
  }

}
