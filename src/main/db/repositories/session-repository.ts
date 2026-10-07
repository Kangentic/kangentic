import type Database from 'better-sqlite3';
import type { PerToolStat, SessionRecord, SessionRecordStatus, SessionSummary, SuspendedBy } from '../../../shared/types';
import { mergeToolBreakdowns, type ToolCallTotals } from '../../../shared/tool-call-totals';
import { writeTransaction } from '../transaction';

/**
 * Fields accepted by insert(). Caller must provide `id` (the PTY session ID)
 * to unify the DB record key with the SessionManager/TranscriptWriter key.
 * Excludes metric columns (set via updateMetrics), the applied model/effort
 * (set via updateAppliedSettings, mirroring how metrics are maintained), and
 * the PTY grid (set via updatePtyGrid from the session manager's grid events).
 */
type SessionInsertInput = Omit<SessionRecord,
  'total_cost_usd' | 'total_input_tokens' | 'total_output_tokens' | 'model_id' | 'model_display_name' | 'applied_model' | 'applied_effort' | 'total_duration_ms' | 'tool_call_count' | 'lines_added' | 'lines_removed' | 'files_changed' | 'tool_breakdown' | 'compaction_count' | 'last_pty_cols' | 'last_pty_rows' | 'result_tokens_read_at'
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
 * present and correctly typed; optional fields (waitedCount / costUsd /
 * inputTokens / outputTokens / resultTokens) are only validated when present
 * so future writers can extend the shape without tripping the guard.
 */
function isPerToolStat(value: unknown): value is PerToolStat {
  if (value === null || typeof value !== 'object') return false;
  const candidate = value as Record<string, unknown>;
  if (typeof candidate.toolName !== 'string') return false;
  if (typeof candidate.callCount !== 'number') return false;
  if (typeof candidate.totalDurationMs !== 'number') return false;
  if (typeof candidate.interruptedCount !== 'number') return false;
  if (candidate.waitedCount !== undefined && typeof candidate.waitedCount !== 'number') return false;
  if (candidate.costUsd !== undefined && typeof candidate.costUsd !== 'number') return false;
  if (candidate.inputTokens !== undefined && typeof candidate.inputTokens !== 'number') return false;
  if (candidate.outputTokens !== undefined && typeof candidate.outputTokens !== 'number') return false;
  if (candidate.resultTokens !== undefined && typeof candidate.resultTokens !== 'number') return false;
  return true;
}

/**
 * Parse a `tool_breakdown` JSON column into typed `PerToolStat[]`. Tolerant
 * of malformed payloads (rows from older versions or hand-edited DBs) so
 * one corrupt record can't crash the Session Summary panel. Entries that
 * fail the shape guard are dropped silently rather than rendered as blank
 * rows with undefined React keys.
 */
export function parseToolBreakdown(raw: string | null): PerToolStat[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isPerToolStat);
  } catch {
    return [];
  }
}

/**
 * The columns of an earlier run's record that the track's tool totals and the
 * earlier-run Tokens fill read. The tool-call popover reads its track on every
 * tool call, so the large text columns (`prompt`, `command`) are not selected.
 */
export type EarlierRunRecord = Pick<SessionRecord,
  'id' | 'session_type' | 'agent_session_id' | 'cwd' | 'started_at' | 'tool_call_count' | 'tool_breakdown' | 'result_tokens_read_at'
>;

/**
 * Sum the stored tool columns of several records: the count from
 * `tool_call_count`, the rows merged by tool name. Each record holds one run.
 */
function sumRecordToolTotals(records: Array<Pick<SessionRecord, 'tool_call_count' | 'tool_breakdown'>>): ToolCallTotals {
  let toolCallCount = 0;
  for (const record of records) toolCallCount += record.tool_call_count ?? 0;
  return {
    toolCallCount,
    toolBreakdown: mergeToolBreakdowns(records.map((record) => parseToolBreakdown(record.tool_breakdown))),
  };
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
      last_pty_cols: null,
      last_pty_rows: null,
      result_tokens_read_at: null,
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
   * Every record on a session track except one, oldest first. A track is the
   * task plus its isolated swimlane (null = the main session), across agents:
   * the records a resumed session continues from. The excluded id is the live
   * record, whose stored tool columns are a snapshot of the live accumulator
   * and would otherwise count twice. `IS ?` matches a null swimlane.
   */
  listEarlierRunRecords(taskId: string, isolatedSwimlaneId: string | null, excludeRecordId: string): EarlierRunRecord[] {
    return this.db.prepare(
      `SELECT id, session_type, agent_session_id, cwd, started_at, tool_call_count, tool_breakdown, result_tokens_read_at
       FROM sessions WHERE task_id = ? AND isolated_swimlane_id IS ? AND id != ? ORDER BY started_at`
    ).all(taskId, isolatedSwimlaneId, excludeRecordId) as EarlierRunRecord[];
  }

  /**
   * Whether a record that started before this one belongs to the same agent
   * conversation (`agent_session_id`), which makes this record a resume of it.
   * The CLI writes every run of a conversation to one transcript, so an agent
   * that cannot scope a transcript read by time counts those earlier runs'
   * calls too.
   */
  hasEarlierRecordOfConversation(recordId: string, agentSessionId: string): boolean {
    const row = this.db.prepare(
      `SELECT 1 AS found FROM sessions
       WHERE agent_session_id = ? AND id != ?
         AND started_at < (SELECT started_at FROM sessions WHERE id = ?)
       LIMIT 1`
    ).get(agentSessionId, recordId, recordId);
    return row !== undefined;
  }

  /** The stored tool totals of a track's earlier runs (see `listEarlierRunRecords`). */
  getEarlierRunToolTotals(taskId: string, isolatedSwimlaneId: string | null, excludeRecordId: string): ToolCallTotals {
    return sumRecordToolTotals(this.listEarlierRunRecords(taskId, isolatedSwimlaneId, excludeRecordId));
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
   * Record the model/effort the session was asked to run at. Called at
   * spawn/resume with the resolved spawn overrides; a model or effort change
   * on a live task session restarts it, so the respawn is what records the new
   * value. Only the provided field(s) are written. `null` means agent default /
   * no flag. `prepareInjectionPlan` diffs against this (behind the agent's own
   * reported effort, when it reports one).
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
   * Record the PTY grid the session now has, keyed by record id (which is the
   * PTY session id). Written from the session manager's grid events, so it
   * matches no row for a spawn announced before its record is inserted, and for
   * a Command Terminal session, which has no record; both are harmless no-ops.
   */
  updatePtyGrid(id: string, grid: { cols: number; rows: number }): void {
    this.db.prepare('UPDATE sessions SET last_pty_cols = ?, last_pty_rows = ? WHERE id = ?')
      .run(grid.cols, grid.rows, id);
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
   * Backfill the tool columns from the transcript-derived cumulative,
   * fire-and-forget after `captureSessionMetrics` (see
   * `refineTranscriptToolCounts` in `session-metrics.ts`). Two branches:
   *
   * - An EMPTY live count (NULL or 0) takes the transcript's count and rows
   *   outright. Count and breakdown are written together so
   *   `SUM(breakdown.callCount) == tool_call_count` stays consistent.
   * - A healthy live count is never overwritten: the live accumulator is
   *   higher fidelity when it worked (real durations + a separate interrupted
   *   tally). Only the transcript's `resultTokens` estimates are merged onto
   *   the live rows, matched by tool name, since the live hook events carry no
   *   token data at all.
   */
  updateTranscriptToolCounts(id: string, counts: { toolCallCount: number; toolBreakdown: PerToolStat[] }): void {
    const filled = this.db.prepare(
      `UPDATE sessions SET tool_call_count = ?, tool_breakdown = ?
       WHERE id = ? AND (tool_call_count IS NULL OR tool_call_count = 0)`,
    ).run(
      counts.toolCallCount,
      counts.toolBreakdown.length > 0 ? JSON.stringify(counts.toolBreakdown) : null,
      id,
    );
    if (filled.changes > 0) return;

    const resultTokensByTool: Record<string, number> = {};
    for (const stat of counts.toolBreakdown) {
      if (typeof stat.resultTokens === 'number') resultTokensByTool[stat.toolName] = stat.resultTokens;
    }
    this.mergeTranscriptResultTokens(id, resultTokensByTool);
  }

  /**
   * Put transcript-derived `resultTokens` estimates onto a record's stored
   * rows, matched by tool name. Counts, durations and every other field stay
   * as stored, and a tool with no stored row is dropped. Returns true when the
   * row changed.
   *
   * SETS each value, never adds to it. Two writers can reach the same record:
   * the run-end refine and the earlier-run Tokens fill
   * (`fillEarlierRunResultTokens`), both reading the same run's window, and
   * only setting keeps the second write from doubling the first.
   */
  mergeTranscriptResultTokens(id: string, resultTokensByTool: Record<string, number>): boolean {
    if (Object.keys(resultTokensByTool).length === 0) return false;
    const storedRows = this.readToolBreakdownForUpdate(id);
    if (!storedRows) return false;
    let changed = false;
    for (const storedRow of storedRows) {
      // Own keys only: a tool named like an Object.prototype member must not
      // read the inherited function.
      if (!Object.hasOwn(resultTokensByTool, storedRow.toolName)) continue;
      const resultTokens = resultTokensByTool[storedRow.toolName];
      if (typeof resultTokens === 'number' && storedRow.resultTokens !== resultTokens) {
        storedRow.resultTokens = resultTokens;
        changed = true;
      }
    }
    if (!changed) return false;
    this.db.prepare('UPDATE sessions SET tool_breakdown = ? WHERE id = ?').run(JSON.stringify(storedRows), id);
    return true;
  }

  /**
   * Record that a transcript read for this record's Tokens estimates answered
   * and left it nothing to keep, so the earlier-run fill does not read that
   * transcript again (see `SessionRecord.result_tokens_read_at`).
   */
  markResultTokensRead(id: string): void {
    this.db.prepare('UPDATE sessions SET result_tokens_read_at = ? WHERE id = ?').run(new Date().toISOString(), id);
  }

  /**
   * Ids of finished records (exited or suspended) that carry a stored
   * `tool_breakdown`: the rows the one-time duration repair replays. A running
   * record is still being measured and is left alone.
   */
  listToolBreakdownRecordIds(): string[] {
    const rows = this.db.prepare(
      `SELECT id FROM sessions
       WHERE tool_breakdown IS NOT NULL AND status IN ('exited', 'suspended')
       ORDER BY started_at`,
    ).all() as Array<{ id: string }>;
    return rows.map((row) => row.id);
  }

  /**
   * Replace a record's stored per-tool durations with ones replayed from its
   * own event log, for rows saved while tool events were paired by name.
   *
   * A row takes the replayed `totalDurationMs` and `waitedCount` only when the
   * replay saw the same calls (`callCount` and `interruptedCount` match), which
   * is what shows it replayed the same events; any other row keeps what it had.
   * The two travel together because the duration leaves out exactly the calls
   * the count names. Nothing else is touched: counts, `resultTokens` and every
   * other field stay as stored.
   * The current column is read here, at write time, so a value written since
   * the replay was computed is not lost. A stored array holding an entry the
   * shape guard rejects is left whole rather than rewritten without it.
   * Returns true when the row changed.
   */
  patchToolBreakdownDurations(id: string, replayed: PerToolStat[]): boolean {
    const stored = this.readToolBreakdownForUpdate(id);
    if (!stored) return false;
    const replayedByTool = new Map(replayed.map((stat) => [stat.toolName, stat]));
    let changed = false;
    for (const storedRow of stored) {
      const replayedRow = replayedByTool.get(storedRow.toolName);
      if (!replayedRow) continue;
      if (replayedRow.callCount !== storedRow.callCount || replayedRow.interruptedCount !== storedRow.interruptedCount) continue;
      if (replayedRow.totalDurationMs === storedRow.totalDurationMs && replayedRow.waitedCount === storedRow.waitedCount) continue;
      storedRow.totalDurationMs = replayedRow.totalDurationMs;
      if (replayedRow.waitedCount === undefined) delete storedRow.waitedCount;
      else storedRow.waitedCount = replayedRow.waitedCount;
      changed = true;
    }
    if (!changed) return false;
    this.db.prepare('UPDATE sessions SET tool_breakdown = ? WHERE id = ?').run(JSON.stringify(stored), id);
    return true;
  }

  /**
   * A record's stored `tool_breakdown`, read for a read-modify-write. Null when
   * the column is empty or unparseable, or holds an entry the shape guard
   * rejects: `parseToolBreakdown` drops such an entry, so a writer that wrote
   * its result back would delete it. Such a row is left whole instead.
   */
  private readToolBreakdownForUpdate(id: string): PerToolStat[] | null {
    const row = this.db.prepare('SELECT tool_breakdown FROM sessions WHERE id = ?')
      .get(id) as { tool_breakdown: string | null } | undefined;
    if (!row?.tool_breakdown) return null;
    let parsed: unknown;
    try {
      parsed = JSON.parse(row.tool_breakdown);
    } catch {
      return null;
    }
    if (!Array.isArray(parsed) || parsed.length === 0 || !parsed.every(isPerToolStat)) return null;
    return parsed as PerToolStat[];
  }

  /**
   * Update git diff stats for a single session record, unconditionally.
   * Superseded as the churn-write entry point by `setTaskGitStats` (which keeps
   * exactly one non-zero row per task lineage); kept as the low-level single-row
   * primitive, mirroring `UsageHistoryRepository.updateGitStats`.
   */
  updateGitStats(id: string, stats: { linesAdded: number; linesRemoved: number; filesChanged: number }): void {
    this.db.prepare(`
      UPDATE sessions SET lines_added = ?, lines_removed = ?, files_changed = ?
      WHERE id = ?
    `).run(stats.linesAdded, stats.linesRemoved, stats.filesChanged, id);
  }

  /**
   * Write git churn to exactly ONE row per task lineage: `canonicalRecordId`
   * gets the stats, every other record id in `recordIds` is zeroed. Mirrors
   * `UsageHistoryRepository.setTaskGitStats` for the `sessions` table. This
   * also fixes a latent over-count in `getSummaryForTask` / `listAllSummaries`,
   * which SUM `lines_added`/`lines_removed` across every record: once churn is
   * consolidated onto a single record, that SUM equals the branch's actual
   * churn instead of adding the same branch-cumulative number in more than
   * once across resume legs.
   *
   * Unlike `UsageHistoryRepository.setTaskGitStats`, this omits the
   * `changes === 0` guard on the canonical UPDATE: a task's `sessions` rows
   * always exist for every id in `recordIds` (they are read from
   * `listForTaskNewestFirst`) and are only ever deleted atomically as a whole
   * (`deleteByTaskId`), so the canonical UPDATE always matches a row.
   */
  setTaskGitStats(recordIds: string[], canonicalRecordId: string, stats: { linesAdded: number; linesRemoved: number; filesChanged: number }): void {
    const write = writeTransaction(this.db, (allRecordIds: string[], canonicalId: string) => {
      this.db.prepare(`
        UPDATE sessions SET lines_added = ?, lines_removed = ?, files_changed = ?
        WHERE id = ?
      `).run(stats.linesAdded, stats.linesRemoved, stats.filesChanged, canonicalId);

      const siblings = allRecordIds.filter((recordId) => recordId !== canonicalId);
      if (siblings.length === 0) return;
      const placeholders = siblings.map(() => '?').join(', ');
      this.db.prepare(`
        UPDATE sessions SET lines_added = 0, lines_removed = 0, files_changed = 0
        WHERE id IN (${placeholders})
      `).run(...siblings);
    });
    write(recordIds, canonicalRecordId);
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
   *   - the tool breakdown merges every row's per-tool stats by tool name, over
   *     the same records the tool-call count sums, so the table adds up to it;
   *   - model / exit code come from the latest record (the most recent run's
   *     values), and the timeline spans the task's whole life.
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
      toolBreakdown: this.mergedToolBreakdownsByTask(taskId).get(taskId) ?? [],
    };
  }

  /**
   * Every costed record's per-tool rows merged by tool name, keyed by task:
   * the record set the summaries' `tool_call_count` sum covers, so each task's
   * table adds up to its count. One task's when `taskId` is given, else every
   * task's. Parsed in JS with the shared merge, so a malformed entry is dropped
   * the same way for both summaries.
   */
  private mergedToolBreakdownsByTask(taskId?: string): Map<string, PerToolStat[]> {
    const statement = this.db.prepare(
      `SELECT task_id, tool_breakdown FROM sessions
       WHERE total_cost_usd IS NOT NULL AND tool_breakdown IS NOT NULL${taskId === undefined ? '' : ' AND task_id = ?'}`
    );
    const breakdownRows = (taskId === undefined ? statement.all() : statement.all(taskId)) as Array<{ task_id: string; tool_breakdown: string }>;
    const breakdownsByTask = new Map<string, PerToolStat[][]>();
    for (const breakdownRow of breakdownRows) {
      const groups = breakdownsByTask.get(breakdownRow.task_id) ?? [];
      groups.push(parseToolBreakdown(breakdownRow.tool_breakdown));
      breakdownsByTask.set(breakdownRow.task_id, groups);
    }
    const mergedByTask = new Map<string, PerToolStat[]>();
    for (const [groupTaskId, groups] of breakdownsByTask) mergedByTask.set(groupTaskId, mergeToolBreakdowns(groups));
    return mergedByTask;
  }

  /**
   * Get summaries for all tasks that have metric data, keyed by task_id.
   * Aggregates per-PTY metrics across all session records per task.
   *
   * The aggregation runs entirely in SQL (generalizing getSummaryForTask with
   * GROUP BY task_id) so the synchronous main-process JS work is O(tasks), not
   * O(historical session rows). Semantics mirror getSummaryForTask exactly:
   * SUM cost / duration / compactions / tool calls / lines across every run,
   * MAX files_changed, MIN/MAX timeline; tokens take the latest row per session
   * lineage (COALESCE(agent_session_id, id)) summed across lineages, because a
   * flat SUM would double-count a session resumed across restarts; scalars
   * (model / exit code) come from the latest record. The tool breakdown merges
   * every costed row's stats by tool name, in JS with the shared merge, so a
   * malformed entry is dropped exactly as getSummaryForTask drops it; that
   * parse is O(rows with a breakdown), which is why this runs in the
   * retrieval worker.
   */
  listAllSummaries(): Record<string, SessionSummary> {
    const rows = this.db.prepare(
      `WITH costed AS (
         SELECT id, task_id, agent_session_id, total_cost_usd, total_input_tokens,
                total_output_tokens, model_display_name, total_duration_ms, exit_code,
                started_at, exited_at, suspended_at, tool_call_count, lines_added,
                lines_removed, files_changed, compaction_count
         FROM sessions
         WHERE total_cost_usd IS NOT NULL
       ),
       agg AS (
         SELECT task_id,
                COALESCE(SUM(total_cost_usd), 0) AS total_cost_usd,
                COALESCE(SUM(total_duration_ms), 0) AS total_duration_ms,
                COALESCE(SUM(tool_call_count), 0) AS total_tool_calls,
                COALESCE(SUM(compaction_count), 0) AS total_compactions,
                COALESCE(SUM(lines_added), 0) AS total_lines_added,
                COALESCE(SUM(lines_removed), 0) AS total_lines_removed,
                MAX(COALESCE(files_changed, 0)) AS max_files_changed,
                MIN(started_at) AS earliest_started_at,
                MAX(COALESCE(exited_at, suspended_at)) AS latest_ended_at
         FROM costed
         GROUP BY task_id
       ),
       lineage_tokens AS (
         SELECT task_id,
                COALESCE(SUM(input_tokens), 0) AS total_input_tokens,
                COALESCE(SUM(output_tokens), 0) AS total_output_tokens
         FROM (
           SELECT task_id,
                  total_input_tokens AS input_tokens,
                  total_output_tokens AS output_tokens,
                  ROW_NUMBER() OVER (
                    PARTITION BY task_id, COALESCE(agent_session_id, id)
                    ORDER BY started_at DESC
                  ) AS rn
           FROM costed
         )
         WHERE rn = 1
         GROUP BY task_id
       ),
       latest AS (
         SELECT task_id, agent_session_id, id AS record_id, model_display_name,
                exit_code,
                ROW_NUMBER() OVER (PARTITION BY task_id ORDER BY started_at DESC) AS rn
         FROM costed
       )
       SELECT
         agg.task_id,
         t.created_at AS task_created_at,
         agg.total_cost_usd,
         agg.total_duration_ms,
         agg.total_tool_calls,
         agg.total_compactions,
         agg.total_lines_added,
         agg.total_lines_removed,
         agg.max_files_changed,
         agg.earliest_started_at,
         agg.latest_ended_at,
         lineage_tokens.total_input_tokens,
         lineage_tokens.total_output_tokens,
         latest.agent_session_id,
         latest.record_id,
         latest.model_display_name,
         latest.exit_code
       FROM agg
       JOIN lineage_tokens ON lineage_tokens.task_id = agg.task_id
       JOIN latest ON latest.task_id = agg.task_id AND latest.rn = 1
       JOIN tasks t ON t.id = agg.task_id`
    ).all() as Array<{
      task_id: string;
      task_created_at: string;
      total_cost_usd: number;
      total_duration_ms: number;
      total_tool_calls: number;
      total_compactions: number;
      total_lines_added: number;
      total_lines_removed: number;
      max_files_changed: number;
      earliest_started_at: string;
      latest_ended_at: string | null;
      total_input_tokens: number;
      total_output_tokens: number;
      agent_session_id: string | null;
      record_id: string;
      model_display_name: string | null;
      exit_code: number | null;
    }>;

    const mergedBreakdownsByTask = this.mergedToolBreakdownsByTask();
    const result: Record<string, SessionSummary> = {};
    for (const row of rows) {
      result[row.task_id] = {
        sessionId: row.agent_session_id ?? row.record_id,
        totalCostUsd: row.total_cost_usd,
        totalInputTokens: row.total_input_tokens,
        totalOutputTokens: row.total_output_tokens,
        modelDisplayName: row.model_display_name ?? '',
        durationMs: row.total_duration_ms,
        toolCallCount: row.total_tool_calls,
        compactionCount: row.total_compactions,
        linesAdded: row.total_lines_added,
        linesRemoved: row.total_lines_removed,
        filesChanged: row.max_files_changed,
        taskCreatedAt: row.task_created_at,
        startedAt: row.earliest_started_at,
        exitedAt: row.latest_ended_at,
        exitCode: row.exit_code,
        toolBreakdown: mergedBreakdownsByTask.get(row.task_id) ?? [],
      };
    }
    return result;
  }

}
