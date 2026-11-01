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

  /**
   * Close every interval a quit or a crash left open, once per project per
   * launch (task #952). Overnight, open rows from quits read as agents still
   * waiting, hours after their sessions had ended. Each closes at its session's
   * own end: its suspend or exit time (`app-quit`), or, with neither recorded,
   * at the interval's start (`app-crash`), so nothing invents time the session
   * may not have spent. A session in `liveSessionIds` is still running in this
   * launch (a phone started it, the project was open before) and keeps its row.
   * Returns how many rows it closed.
   */
  closeIntervalsLeftOpen(liveSessionIds: ReadonlySet<string>): number {
    const rows = this.db.prepare(
      `SELECT intervals.id, intervals.session_id, intervals.started_ms, sessions.suspended_at, sessions.exited_at
         FROM session_activity_intervals intervals
         LEFT JOIN sessions ON sessions.id = intervals.session_id
        WHERE intervals.ended_ms IS NULL`,
    ).all() as Array<{ id: number; session_id: string; started_ms: number; suspended_at: string | null; exited_at: string | null }>;
    const close = this.db.prepare(
      `UPDATE session_activity_intervals
          SET ended_ms = ?, ended_at = ?, duration_ms = ? - started_ms, exit_trigger = ?
        WHERE id = ? AND ended_ms IS NULL`,
    );
    let closed = 0;
    for (const row of rows) {
      if (liveSessionIds.has(row.session_id)) continue;
      const recordedEnd = row.suspended_at ?? row.exited_at;
      const recordedEndMs = recordedEnd ? Date.parse(recordedEnd) : Number.NaN;
      const endedMs = Number.isFinite(recordedEndMs) && recordedEndMs >= row.started_ms ? recordedEndMs : row.started_ms;
      const trigger = Number.isFinite(recordedEndMs) ? 'app-quit' : 'app-crash';
      closed += close.run(endedMs, new Date(endedMs).toISOString(), endedMs, trigger, row.id).changes;
    }
    return closed;
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

  /**
   * Total ACTIVE milliseconds in a window, and how many distinct sessions
   * contributed any interval to it - the usage dashboard's Avg Active pair.
   *
   * Active means the agent was working (`ACTIVITY_DISPOSITION` maps `thinking`
   * to `active`; `idle` and `permission` are both idle). That is the metric
   * Claude Code itself publishes as `claude_code.active_time.total`, described
   * as "actual time spent actively using Claude Code, excluding idle time".
   * The alternative the dashboard used to show, summed agent-reported wall
   * clock, counts every hour a session sat open: on the dogfooding install
   * active time is 39% of tracked wall clock.
   *
   * The session count is deliberately returned with it. This ledger does not
   * cover every session (per-interval recording shipped later than the usage
   * ledger), so the average has to be over sessions WITH coverage rather than
   * over the Sessions tile's count. Dividing one ledger's numerator by
   * another's denominator is the mixed-population bug this whole area was
   * audited for.
   *
   * Open intervals (`ended_ms IS NULL`, a session still in that state or one
   * killed mid-interval) carry a NULL `duration_ms` and are excluded, matching
   * the MCP reader in `activity-interval-commands.ts`.
   *
   * Bounds are on `started_ms`, matching the turn ledger's `ts` filtering.
   */
  getActiveTotals(sinceMs: number | null, untilMs: number | null): {
    activeMs: number;
    sessionsCovered: number;
  } {
    const clauses = ["disposition = 'active'", 'duration_ms IS NOT NULL'];
    const params: number[] = [];
    if (sinceMs !== null) {
      clauses.push('started_ms >= ?');
      params.push(sinceMs);
    }
    if (untilMs !== null) {
      clauses.push('started_ms < ?');
      params.push(untilMs);
    }
    return this.db.prepare(`
      SELECT COALESCE(SUM(duration_ms), 0) AS activeMs,
             COUNT(DISTINCT session_id) AS sessionsCovered
        FROM session_activity_intervals
       WHERE ${clauses.join(' AND ')}
    `).get(...params) as { activeMs: number; sessionsCovered: number };
  }
}

/** Projects whose quit-left activity intervals this launch already closed (task #952). */
const intervalSweptProjects = new Set<string>();

/**
 * Close the activity intervals the last quit or crash left open
 * (`closeIntervalsLeftOpen`), once per project per launch, before startup
 * recovery starts new sessions. A session this launch already runs keeps its
 * row. Logs and carries on when it cannot.
 */
export function sweepIntervalsOncePerLaunch(projectId: string, db: Database.Database, liveSessionIds: ReadonlySet<string>): void {
  if (intervalSweptProjects.has(projectId)) return;
  intervalSweptProjects.add(projectId);
  try {
    const closed = new ActivityIntervalStore(db).closeIntervalsLeftOpen(liveSessionIds);
    if (closed > 0) console.log(`[activity-intervals] Closed ${closed} activity interval(s) left open by the last quit or crash.`);
  } catch (error) {
    console.warn('[activity-intervals] Could not close the activity intervals left open:', error);
  }
}

/** Test-only: sweep every project's intervals again on its next recovery. */
export function resetIntervalSweepForTests(): void {
  intervalSweptProjects.clear();
}
