import type Database from 'better-sqlite3';
import type { ActivityState } from '../../shared/types';
import type { ActivityDisposition } from '../../shared/activity-state';

/** A new activity-disposition interval to open. */
export interface OpenIntervalInput {
  sessionId: string;
  taskId: string | null;
  /** The coarse bucket entered - see shared/activity-state.ts's dispositionOf. */
  disposition: ActivityDisposition;
  /** Granular state entered ('thinking' for an 'active' disposition; 'idle' or 'permission' for 'idle'). */
  state: ActivityState;
  /** The granular state the session was in immediately before this interval opened. */
  previousState: ActivityState;
  /** The engine's own TransitionTrigger label (e.g. 'event:idle', 'timer:stale-thinking'). */
  enterTrigger: string;
  startedMs: number;
}

export interface SessionActivityInterval {
  id: number;
  sessionId: string;
  taskId: string | null;
  disposition: ActivityDisposition;
  state: ActivityState;
  previousState: ActivityState;
  enterTrigger: string;
  startedMs: number;
  /** UTC ISO 8601 mirror of startedMs, written from the same value - see the
   *  migration comment on session_activity_intervals for why this is a
   *  derived mirror, not an independently-sourced field. */
  startedAt: string;
  /** Null while the interval is still open (the session has not left this disposition yet). */
  endedMs: number | null;
  /** UTC ISO 8601 mirror of endedMs. Null exactly when endedMs is. */
  endedAt: string | null;
  durationMs: number | null;
  /** How the interval ended - e.g. 'event:prompt' (idle -> active, a human reply), 'event:idle'
   *  (active -> idle, a real park), or 'session-exit'. Null while open. */
  exitTrigger: string | null;
  recordedAt: string;
}

interface ActivityIntervalRow {
  id: number;
  session_id: string;
  task_id: string | null;
  disposition: string;
  state: string;
  previous_state: string;
  enter_trigger: string;
  started_ms: number;
  started_at: string;
  ended_ms: number | null;
  ended_at: string | null;
  duration_ms: number | null;
  exit_trigger: string | null;
  recorded_at: string;
}

function toInterval(row: ActivityIntervalRow): SessionActivityInterval {
  return {
    id: row.id,
    sessionId: row.session_id,
    taskId: row.task_id,
    disposition: row.disposition as ActivityDisposition,
    state: row.state as ActivityState,
    previousState: row.previous_state as ActivityState,
    enterTrigger: row.enter_trigger,
    startedMs: row.started_ms,
    startedAt: row.started_at,
    endedMs: row.ended_ms,
    endedAt: row.ended_at,
    durationMs: row.duration_ms,
    exitTrigger: row.exit_trigger,
    recordedAt: row.recorded_at,
  };
}

/**
 * Durable per-project ledger over `session_activity_intervals`: one row per
 * continuous span a session spent in one `ActivityDisposition` bucket
 * ('idle' - needing the user, covering both idle and permission - or
 * 'active' - the agent working on its own). Symmetric by design: both
 * dispositions are recorded directly (see the migration comment for why
 * deriving 'active' as the inverse of 'idle' is fragile), so a consumer sums
 * this table for either without session-boundary reconciliation.
 *
 * Written at the moment the activity engine commits a disposition-changing
 * transition, so it SURVIVES the engine's own in-memory state (wiped on
 * deleteSession/dispose) and is a faithful record where `events.jsonl` is
 * not (that file logs raw hook events, not committed transitions).
 *
 * Deliberately has NO sessions-DELETE cascade: this is a durable ledger, not
 * a rebuildable index, and the whole point is that a recorded interval
 * outlives the session row that produced it.
 */
export class ActivityIntervalStore {
  constructor(private readonly db: Database.Database) {}

  /** Insert a new open interval. Idempotent in effect only if the caller
   *  guards against opening a second interval while one is already open for
   *  the session - the store itself does not deduplicate. */
  openInterval(input: OpenIntervalInput, recordedAt: string): void {
    this.db
      .prepare(
        `INSERT INTO session_activity_intervals
           (session_id, task_id, disposition, state, previous_state, enter_trigger, started_ms, started_at, recorded_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.sessionId,
        input.taskId,
        input.disposition,
        input.state,
        input.previousState,
        input.enterTrigger,
        input.startedMs,
        new Date(input.startedMs).toISOString(),
        recordedAt,
      );
  }

  /**
   * Close the session's open interval (if any). Resolves the row by
   * `WHERE session_id = ? AND ended_ms IS NULL` (indexed via
   * `idx_activity_intervals_open`) rather than a row id held in memory, so a
   * Kangentic restart between open and close cannot orphan the mapping - the
   * next close still finds the right row by session id alone. A no-op
   * (zero rows affected) when no interval is open, which is expected right
   * after a session's first real transition (the pre-first-transition seed
   * window opened nothing to close) and for a session that crashed
   * mid-interval: the row stays open forever, and consumers filter
   * `ended_ms IS NOT NULL`.
   */
  closeOpenInterval(sessionId: string, endedMs: number, exitTrigger: string): void {
    this.db
      .prepare(
        `UPDATE session_activity_intervals
           SET ended_ms = ?, ended_at = ?, duration_ms = ? - started_ms, exit_trigger = ?
         WHERE session_id = ? AND ended_ms IS NULL`,
      )
      .run(endedMs, new Date(endedMs).toISOString(), endedMs, exitTrigger, sessionId);
  }

  /** A task's activity intervals (both dispositions), oldest first. */
  getForTask(taskId: string): SessionActivityInterval[] {
    const rows = this.db
      .prepare('SELECT * FROM session_activity_intervals WHERE task_id = ? ORDER BY started_ms ASC')
      .all(taskId) as ActivityIntervalRow[];
    return rows.map(toInterval);
  }

  /** One session's activity intervals (both dispositions), oldest first. */
  getForSession(sessionId: string): SessionActivityInterval[] {
    const rows = this.db
      .prepare('SELECT * FROM session_activity_intervals WHERE session_id = ? ORDER BY started_ms ASC')
      .all(sessionId) as ActivityIntervalRow[];
    return rows.map(toInterval);
  }
}
