import { v4 as uuidv4 } from 'uuid';
import type Database from 'better-sqlite3';
import type { SentSessionMessage } from '../../../shared/types';

const COLUMNS =
  'id, session_id, task_id, caller_session_id, caller_task_id, caller_project_id, message, status, error, created_at';

/** Who sent a held message. Null fields mean a human sent it with no Kangentic session of their own. */
export interface HeldMessageCaller {
  caller_session_id: string | null;
  caller_task_id: string | null;
  caller_project_id: string | null;
}

/**
 * Provenance for messages sent into a session.
 *
 * `kangentic_send_session_message` delivers its text with no in-band marker, so
 * these rows are the only place that records a turn arrived from another agent
 * rather than from the human at the keyboard. Keeping the marker out of the
 * message costs zero tokens and cannot be forged by the receiving agent, but it
 * means this table is load-bearing: without a row, a sent turn is
 * indistinguishable from a typed one.
 *
 * A message held for a task with no running agent is a row here too, and the
 * row IS the hold: `held` with no session until the task's next agent gets it.
 * Every write that moves a held row on is a compare-and-swap on
 * `status = 'held'`, so a clear that ran first is never undone by a delivery
 * that settles later.
 */
export class SentSessionMessageRepository {
  constructor(private db: Database.Database) {}

  /**
   * Record one send attempt against the session it targeted.
   *
   * Returns null, and writes nothing, when no `sessions` row exists for
   * `session_id`. That happens when a caller names a session id that was never
   * real (a typo, or an id from another project). `session_id` carries a
   * foreign key so these rows are cleaned up with their session, which means
   * such an insert would otherwise raise an FK violation - an exception on a
   * routine bad argument, swallowed into a log line. Skipping is the honest
   * behavior: there is no session to attach provenance to, and the caller
   * already received the refusal synchronously.
   *
   * Note this does NOT affect the realistic dead-session case: a session that
   * exited or was suspended still has its row, so its refusal is recorded.
   */
  insert(record: Omit<SentSessionMessage, 'id' | 'created_at' | 'task_id'> & { session_id: string }): SentSessionMessage | null {
    const session = this.db
      .prepare('SELECT task_id FROM sessions WHERE id = ?')
      .get(record.session_id) as { task_id: string } | undefined;
    if (!session) return null;

    const id = uuidv4();
    const createdAt = new Date().toISOString();
    this.db.prepare(`
      INSERT INTO session_messages_sent (${COLUMNS})
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      record.session_id,
      session.task_id,
      // Every nullable field is coalesced before binding, matching the other
      // repositories: better-sqlite3 throws on an `undefined` parameter, so a
      // caller that omits an optional-looking field would crash the insert
      // rather than storing NULL.
      record.caller_session_id ?? null,
      record.caller_task_id ?? null,
      record.caller_project_id ?? null,
      record.message,
      record.status,
      record.error ?? null,
      createdAt,
    );
    return { id, ...record, task_id: session.task_id, created_at: createdAt };
  }

  /** Hold a message for a task's next agent: a `held` row with no session yet. */
  insertHeld(input: { taskId: string; message: string } & HeldMessageCaller): SentSessionMessage {
    const id = uuidv4();
    const createdAt = new Date().toISOString();
    const row: SentSessionMessage = {
      id,
      session_id: null,
      task_id: input.taskId,
      caller_session_id: input.caller_session_id ?? null,
      caller_task_id: input.caller_task_id ?? null,
      caller_project_id: input.caller_project_id ?? null,
      message: input.message,
      status: 'held',
      error: null,
      created_at: createdAt,
    };
    this.db.prepare(`
      INSERT INTO session_messages_sent (${COLUMNS})
      VALUES (?, NULL, ?, ?, ?, ?, ?, 'held', NULL, ?)
    `).run(id, row.task_id, row.caller_session_id, row.caller_task_id, row.caller_project_id, row.message, createdAt);
    return row;
  }

  /** A task's held messages, oldest first: the order they go to its next agent in. */
  listHeldForTask(taskId: string): SentSessionMessage[] {
    return this.db.prepare(
      `SELECT ${COLUMNS} FROM session_messages_sent WHERE task_id = ? AND status = 'held' ORDER BY created_at, rowid`,
    ).all(taskId) as SentSessionMessage[];
  }

  /**
   * Mark held messages delivered to the session that got them. Only rows still
   * `held` change, so the count is what this call delivered.
   */
  markDeliveredFromHold(ids: readonly string[], sessionId: string): number {
    return this.updateHeld(ids, `status = 'delivered_from_hold', session_id = ?, error = NULL`, [sessionId]);
  }

  /** Mark held messages whose delivery began and did not finish. */
  markHeldFailed(ids: readonly string[], error: string): number {
    return this.updateHeld(ids, `status = 'failed', error = ?`, [error]);
  }

  /** Clear every message still held for a task. Returns how many were cleared. */
  markClearedForTask(taskId: string): number {
    return this.db.prepare(
      `UPDATE session_messages_sent SET status = 'cleared' WHERE task_id = ? AND status = 'held'`,
    ).run(taskId).changes;
  }

  /**
   * Every send attempt against a session, oldest first.
   *
   * `rowid` breaks the tie because `created_at` is millisecond-resolution and a
   * burst of sends lands several rows in the same millisecond; ordering by the
   * timestamp alone leaves those in an order SQLite does not promise, which the
   * `tail` slice in `kangentic_get_session_messages_sent` would then truncate
   * arbitrarily.
   */
  listForSession(sessionId: string): SentSessionMessage[] {
    return this.db.prepare(
      `SELECT ${COLUMNS} FROM session_messages_sent WHERE session_id = ? ORDER BY created_at, rowid`,
    ).all(sessionId) as SentSessionMessage[];
  }

  /**
   * Every send attempt across ALL of a task's sessions, oldest first, held
   * messages included.
   *
   * Task-scoped rather than session-scoped because that is the question being
   * asked when debugging: a task accumulates sessions across resumes and agent
   * handoffs, and "did my message reach task #13?" should not depend on the
   * caller first working out which session was live at the time.
   */
  listForTask(taskId: string): SentSessionMessage[] {
    return this.db.prepare(
      `SELECT ${COLUMNS} FROM session_messages_sent WHERE task_id = ? ORDER BY created_at, rowid`,
    ).all(taskId) as SentSessionMessage[];
  }

  private updateHeld(ids: readonly string[], assignments: string, values: unknown[]): number {
    if (ids.length === 0) return 0;
    const placeholders = ids.map(() => '?').join(', ');
    return this.db.prepare(
      `UPDATE session_messages_sent SET ${assignments} WHERE status = 'held' AND id IN (${placeholders})`,
    ).run(...values, ...ids).changes;
  }
}
