import { v4 as uuidv4 } from 'uuid';
import type Database from 'better-sqlite3';
import type { SentSessionMessage } from '../../../shared/types';

const COLUMNS =
  'id, session_id, caller_session_id, caller_task_id, caller_project_id, message, status, error, created_at';

/**
 * Provenance for messages sent into a session.
 *
 * `kangentic_send_session_message` delivers its text with no in-band marker, so
 * these rows are the only place that records a turn arrived from another agent
 * rather than from the human at the keyboard. Keeping the marker out of the
 * message costs zero tokens and cannot be forged by the receiving agent, but it
 * means this table is load-bearing: without a row, a sent turn is
 * indistinguishable from a typed one.
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
  insert(record: Omit<SentSessionMessage, 'id' | 'created_at'>): SentSessionMessage | null {
    const sessionExists = this.db
      .prepare('SELECT 1 FROM sessions WHERE id = ?')
      .get(record.session_id);
    if (!sessionExists) return null;

    const id = uuidv4();
    const createdAt = new Date().toISOString();
    this.db.prepare(`
      INSERT INTO session_messages_sent (${COLUMNS})
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      record.session_id,
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
    return { id, ...record, created_at: createdAt };
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
   * Every send attempt across ALL of a task's sessions, oldest first.
   *
   * Task-scoped rather than session-scoped because that is the question being
   * asked when debugging: a task accumulates sessions across resumes and agent
   * handoffs, and "did my message reach task #13?" should not depend on the
   * caller first working out which session was live at the time.
   */
  listForTask(taskId: string): SentSessionMessage[] {
    const prefixed = COLUMNS.split(', ').map((column) => `messages.${column}`).join(', ');
    return this.db.prepare(
      `SELECT ${prefixed} FROM session_messages_sent messages
       JOIN sessions ON sessions.id = messages.session_id
       WHERE sessions.task_id = ?
       ORDER BY messages.created_at, messages.rowid`,
    ).all(taskId) as SentSessionMessage[];
  }
}
