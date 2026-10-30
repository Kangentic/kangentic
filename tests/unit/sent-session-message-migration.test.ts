/**
 * Migration + real-SQL round-trip tests for the `session_messages_sent` table
 * (src/main/db/migrations/project-schema.ts) and the SentSessionMessageRepository
 * that reads/writes it (src/main/db/repositories/sent-session-message-repository.ts).
 *
 * tests/unit/mcp-steering-tools.test.ts drives the repository through a MOCKED
 * module, so it never executes the real CREATE TABLE or the real INSERT. A
 * column-name typo in the migration, a mismatch between the migration's columns
 * and the repository's column list, or deleting the CREATE TABLE block outright
 * would leave that suite green.
 *
 * This file closes that gap by running the REAL migration against a REAL
 * in-memory better-sqlite3 database and round-tripping through the REAL
 * repository. It matters more than usual here: since
 * kangentic_send_session_message delivers its message verbatim with no in-band
 * marker, a row in this table is the ONLY record that a transcript turn was
 * sent through the tool rather than typed by the human.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { runProjectMigrations } from '../../src/main/db/migrations/project-schema';
import { SentSessionMessageRepository } from '../../src/main/db/repositories/sent-session-message-repository';
import { TaskRepository } from '../../src/main/db/repositories/task-repository';

interface TableColumnInfo {
  name: string;
  notnull: number;
}

const EXPECTED_COLUMNS: Array<{ name: string; notnull: number }> = [
  { name: 'id', notnull: 0 },
  // Nullable since held messages (GitHub #452): a held row waits for the
  // task's next agent and has no session yet.
  { name: 'session_id', notnull: 0 },
  { name: 'task_id', notnull: 1 },
  { name: 'caller_session_id', notnull: 0 },
  { name: 'caller_task_id', notnull: 0 },
  { name: 'caller_project_id', notnull: 0 },
  { name: 'message', notnull: 1 },
  { name: 'status', notnull: 1 },
  { name: 'error', notnull: 0 },
  { name: 'created_at', notnull: 1 },
];

describe('session_messages_sent migration + repository round-trip', () => {
  let database: Database.Database;

  beforeEach(() => {
    database = new Database(':memory:');
    // Matches production ordering exactly (src/main/db/database.ts sets this
    // pragma immediately before calling runProjectMigrations). Without it,
    // `session_id ... REFERENCES sessions(id) ON DELETE CASCADE` is parsed but
    // never enforced - SQLite silently accepts and ignores FK clauses while
    // this pragma is off, which is exactly how a schema can drift from its own
    // migration comment ("rows are cleaned up with their session") with
    // nothing catching it.
    database.pragma('foreign_keys = ON');
    runProjectMigrations(database);
  });

  afterEach(() => {
    database.close();
  });

  it('creates the table with the columns the repository writes', () => {
    const columns = database.pragma('table_info(session_messages_sent)') as TableColumnInfo[];
    const actual = columns.map((column) => ({ name: column.name, notnull: column.notnull }));
    expect(actual).toEqual(EXPECTED_COLUMNS);
  });

  it('is idempotent across repeated migration runs', () => {
    expect(() => runProjectMigrations(database)).not.toThrow();
    const columns = database.pragma('table_info(session_messages_sent)') as TableColumnInfo[];
    expect(columns).toHaveLength(EXPECTED_COLUMNS.length);
  });

  it('indexes session_id and (task_id, status), the columns the reads filter on', () => {
    const indexes = database.pragma('index_list(session_messages_sent)') as Array<{ name: string }>;
    expect(indexes.some((index) => index.name === 'idx_session_messages_sent_session_id')).toBe(true);
    expect(indexes.some((index) => index.name === 'idx_session_messages_sent_task_status')).toBe(true);
  });

  /**
   * Seed a task in a lane `runProjectMigrations` already created. `tasks`
   * declares `swimlane_id TEXT NOT NULL REFERENCES swimlanes(id)`, so a task
   * cannot be inserted with a null lane.
   */
  function seedTask(taskId: string): void {
    const seededSwimlane = database.prepare('SELECT id FROM swimlanes LIMIT 1').get() as { id: string };
    const now = new Date().toISOString();
    // updated_at is NOT NULL with no DEFAULT on the tasks table - omitting it
    // fails the insert outright. This is independent of the foreign_keys
    // pragma above (a plain NOT NULL violation).
    database
      .prepare('INSERT INTO tasks (id, title, swimlane_id, position, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(taskId, `Task ${taskId}`, seededSwimlane.id, 0, now, now);
  }

  /**
   * `session_id` carries a foreign key, so a row cannot exist without its
   * session. Every test that inserts must seed one first.
   *
   * The full NOT NULL column set is spelled out because `sessions` declares
   * `task_id`, `session_type`, `command`, and `cwd` NOT NULL with no defaults -
   * omitting any of them (or passing a null task_id) fails the insert outright.
   * Matches the shape usage-history-migration.test.ts seeds with.
   */
  function seedSession(sessionId: string, taskId?: string): void {
    const owningTaskId = taskId ?? `task-for-${sessionId}`;
    if (!taskId) seedTask(owningTaskId);
    database
      .prepare(`
        INSERT INTO sessions (id, task_id, session_type, command, cwd, status, started_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `)
      .run(sessionId, owningTaskId, 'agent', 'claude', '/mock/project', 'running', new Date().toISOString());
  }

  it('skips the write for a session that does not exist rather than raising an FK violation', () => {
    // Live testing (2026-07-25) hit this: a fabricated session id made insert
    // throw, and the caller swallowed it into a console line. A bad argument
    // must not be an exception path.
    const repository = new SentSessionMessageRepository(database);
    let result: unknown;
    expect(() => {
      result = repository.insert({
        session_id: 'never-existed',
        caller_session_id: null,
        caller_task_id: null,
        caller_project_id: null,
        message: 'x',
        status: 'refused',
        error: 'no such session',
      });
    }).not.toThrow();
    expect(result).toBeNull();
    expect(repository.listForSession('never-existed')).toEqual([]);
  });

  it('still records a refusal for a session that exists but is no longer writable', () => {
    // The realistic dead-session case: exited or suspended, row still present.
    // This is the one that matters for "did my message go through?".
    seedSession('exited-session');
    const repository = new SentSessionMessageRepository(database);
    repository.insert({
      session_id: 'exited-session',
      caller_session_id: null,
      caller_task_id: null,
      caller_project_id: null,
      message: 'x',
      status: 'refused',
      error: 'not accepting input',
    });

    expect(repository.listForSession('exited-session')).toHaveLength(1);
  });

  it('round-trips a sent message through the real repository', () => {
    seedSession('target-session');
    const repository = new SentSessionMessageRepository(database);
    const inserted = repository.insert({
      session_id: 'target-session',
      caller_session_id: 'caller-session',
      caller_task_id: 'caller-task',
      caller_project_id: 'caller-project',
      message: 'rebase onto main',
      status: 'delivered',
      error: null,
    });

    // insert() returns null when the target session row is missing; a seeded
    // session must never take that path, so assert it before reading fields.
    expect(inserted).not.toBeNull();
    expect(inserted?.id).toBeTruthy();
    // UTC ISO 8601, never SQLite's naive CURRENT_TIMESTAMP.
    expect(inserted?.created_at).toMatch(/^\d{4}-\d{2}-\d{2}T.*Z$/);

    const rows = repository.listForSession('target-session');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      session_id: 'target-session',
      caller_session_id: 'caller-session',
      caller_task_id: 'caller-task',
      caller_project_id: 'caller-project',
      message: 'rebase onto main',
      status: 'delivered',
    });
  });

  it('stores the message byte-exact so it can be matched against a transcript turn', () => {
    seedSession('target-session');
    const repository = new SentSessionMessageRepository(database);
    // Multi-line with characters a naive escaping layer would mangle. Nothing
    // is prepended to the delivered text, so this must survive verbatim or the
    // turn can no longer be correlated back to the row that sent it.
    const message = 'line one\nline two with "quotes" and \'apostrophes\'\n  indented';
    repository.insert({
      session_id: 'target-session',
      caller_session_id: null,
      caller_task_id: null,
      caller_project_id: null,
      message,
      status: 'delivered',
      error: null,
    });

    expect(repository.listForSession('target-session')[0].message).toBe(message);
  });

  it('accepts a caller-less human send with null caller ids', () => {
    seedSession('target-session');
    const repository = new SentSessionMessageRepository(database);
    expect(() => repository.insert({
      session_id: 'target-session',
      caller_session_id: null,
      caller_task_id: null,
      caller_project_id: null,
      message: 'from a human',
      status: 'delivered',
      error: null,
    })).not.toThrow();

    expect(repository.listForSession('target-session')[0].caller_session_id).toBeNull();
  });

  it('accepts a cross-project caller id that does not exist locally', () => {
    // caller_session_id / caller_task_id are deliberately NOT foreign keys: a
    // cross-project steer originates in another project's database, so the ids
    // are unresolvable here. A FK would reject the row outright.
    seedSession('target-session');
    const repository = new SentSessionMessageRepository(database);
    expect(() => repository.insert({
      session_id: 'target-session',
      caller_session_id: 'session-in-another-project',
      caller_task_id: 'task-in-another-project',
      caller_project_id: 'another-project',
      message: 'cross-project steer',
      status: 'delivered',
      error: null,
    })).not.toThrow();
  });

  it('spans every session a task has had, so a resumed task reports its full history', () => {
    // The debugging question is "did my message reach task #13?", and a task
    // accumulates sessions across resumes and agent handoffs. Scoping to one
    // session would silently hide messages sent to an earlier one.
    seedTask('task-1');
    seedSession('session-old', 'task-1');
    seedSession('session-new', 'task-1');

    const repository = new SentSessionMessageRepository(database);
    const base = { caller_session_id: null, caller_task_id: null, caller_project_id: null, error: null };
    repository.insert({ ...base, session_id: 'session-old', message: 'to the old session', status: 'delivered' });
    repository.insert({ ...base, session_id: 'session-new', message: 'to the new session', status: 'delivered' });
    // A send against an unrelated task must not leak in.
    seedSession('unrelated');
    repository.insert({ ...base, session_id: 'unrelated', message: 'other task', status: 'delivered' });

    expect(repository.listForTask('task-1').map((row) => row.message))
      .toEqual(['to the old session', 'to the new session']);
    expect(repository.listForTask('no-such-task')).toEqual([]);
  });

  it('returns messages oldest-first and scoped to the requested session', () => {
    seedSession('session-a');
    seedSession('session-b');
    const repository = new SentSessionMessageRepository(database);
    const base = {
      caller_session_id: null,
      caller_task_id: null,
      caller_project_id: null,
      status: 'delivered' as const,
      error: null,
    };
    repository.insert({ ...base, session_id: 'session-a', message: 'first' });
    repository.insert({ ...base, session_id: 'session-b', message: 'other session' });
    repository.insert({ ...base, session_id: 'session-a', message: 'second' });

    expect(repository.listForSession('session-a').map((row) => row.message)).toEqual(['first', 'second']);
    expect(repository.listForSession('session-b').map((row) => row.message)).toEqual(['other session']);
    expect(repository.listForSession('session-none')).toEqual([]);
  });

  it('cascades: deleting the parent session deletes its session_messages_sent rows', () => {
    // docs/database/session-tables.md and the migration comment above `session_messages_sent`
    // both claim `ON DELETE CASCADE` cleans these rows up with their session.
    // That claim is only true when `PRAGMA foreign_keys = ON` is actually set
    // (see beforeEach above): SQLite parses and stores an FK clause even when
    // the pragma is off, but never enforces or acts on it, so without the
    // pragma this assertion would pass FOR THE WRONG REASON (a delete that
    // simply leaves the row behind untouched, not one that cascades).
    seedSession('cascade-target');
    const repository = new SentSessionMessageRepository(database);
    repository.insert({
      session_id: 'cascade-target',
      caller_session_id: null,
      caller_task_id: null,
      caller_project_id: null,
      message: 'will be cascaded',
      status: 'delivered',
      error: null,
    });
    expect(repository.listForSession('cascade-target')).toHaveLength(1);

    database.prepare('DELETE FROM sessions WHERE id = ?').run('cascade-target');

    // Red: removing `database.pragma('foreign_keys = ON')` from beforeEach (or
    // the `ON DELETE CASCADE` clause from the session_messages_sent migration)
    // leaves this row behind after its parent session is deleted.
    expect(repository.listForSession('cascade-target')).toEqual([]);
  });

  it('backfills the error column via ALTER TABLE for a database created before it existed', () => {
    // Simulate a database created by an install that predates the `error`
    // column: drop the table beforeEach's migration run already created (which
    // already has `error`, since CREATE TABLE IF NOT EXISTS always includes it
    // for a fresh DB) and recreate it in the pre-error shape, then re-run
    // migrations to exercise the guarded ALTER TABLE block.
    database.exec('DROP TABLE session_messages_sent');
    database.exec(`
      CREATE TABLE session_messages_sent (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        caller_session_id TEXT,
        caller_task_id TEXT,
        caller_project_id TEXT,
        message TEXT NOT NULL,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL
      )
    `);
    const columnsBefore = (database.pragma('table_info(session_messages_sent)') as TableColumnInfo[])
      .map((column) => column.name);
    expect(columnsBefore).not.toContain('error');

    // Red: deleting the guarded `ALTER TABLE session_messages_sent ADD COLUMN
    // error TEXT` block in project-schema.ts leaves `error` permanently
    // missing from a database created in this intermediate shape, and the
    // insert below would throw ("table session_messages_sent has no column
    // named error") instead of succeeding.
    expect(() => runProjectMigrations(database)).not.toThrow();

    const columnsAfter = (database.pragma('table_info(session_messages_sent)') as TableColumnInfo[])
      .map((column) => column.name);
    expect(columnsAfter).toContain('error');

    seedSession('post-backfill-session');
    const repository = new SentSessionMessageRepository(database);
    expect(() => repository.insert({
      session_id: 'post-backfill-session',
      caller_session_id: null,
      caller_task_id: null,
      caller_project_id: null,
      message: 'x',
      status: 'delivered',
      error: null,
    })).not.toThrow();
  });

  it('rebuilds a log from before held messages, keeping its rows in order with task_id taken from each session', () => {
    seedTask('task-rebuilt');
    seedSession('session-rebuilt', 'task-rebuilt');
    // The shape every database had before this migration: session_id NOT NULL, no task_id.
    database.exec('DROP TABLE session_messages_sent');
    database.exec(`
      CREATE TABLE session_messages_sent (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        caller_session_id TEXT,
        caller_task_id TEXT,
        caller_project_id TEXT,
        message TEXT NOT NULL,
        status TEXT NOT NULL,
        error TEXT,
        created_at TEXT NOT NULL
      )
    `);
    const sameMillisecond = '2026-10-01T12:00:00.000Z';
    const insertOld = database.prepare(`
      INSERT INTO session_messages_sent (id, session_id, caller_session_id, caller_task_id, caller_project_id, message, status, error, created_at)
      VALUES (?, 'session-rebuilt', NULL, NULL, NULL, ?, 'delivered', NULL, ?)
    `);
    // Ids sort opposite to insertion, so only the rowid order keeps them first-to-last.
    insertOld.run('z-first', 'first', sameMillisecond);
    insertOld.run('a-second', 'second', sameMillisecond);

    expect(() => runProjectMigrations(database)).not.toThrow();

    const columns = (database.pragma('table_info(session_messages_sent)') as TableColumnInfo[])
      .map((column) => ({ name: column.name, notnull: column.notnull }));
    expect(columns).toEqual(EXPECTED_COLUMNS);
    const rows = new SentSessionMessageRepository(database).listForTask('task-rebuilt');
    expect(rows.map((row) => [row.message, row.task_id, row.session_id])).toEqual([
      ['first', 'task-rebuilt', 'session-rebuilt'],
      ['second', 'task-rebuilt', 'session-rebuilt'],
    ]);
    // Idempotent on the new shape.
    expect(() => runProjectMigrations(database)).not.toThrow();
    expect(new SentSessionMessageRepository(database).listForTask('task-rebuilt')).toHaveLength(2);
  });

  describe('held messages', () => {
    const noCaller = { caller_session_id: null, caller_task_id: null, caller_project_id: null };

    it('holds a message for a task with no session at all, oldest first', () => {
      seedTask('task-held');
      const repository = new SentSessionMessageRepository(database);
      repository.insertHeld({ ...noCaller, taskId: 'task-held', message: 'first' });
      repository.insertHeld({ ...noCaller, taskId: 'task-held', message: 'second' });

      const held = repository.listHeldForTask('task-held');
      expect(held.map((row) => [row.message, row.status, row.session_id])).toEqual([
        ['first', 'held', null],
        ['second', 'held', null],
      ]);
      // The task's log lists them too.
      expect(repository.listForTask('task-held')).toHaveLength(2);
    });

    it('marks held messages delivered to the session that got them, once', () => {
      seedTask('task-held');
      seedSession('session-next', 'task-held');
      const repository = new SentSessionMessageRepository(database);
      const row = repository.insertHeld({ ...noCaller, taskId: 'task-held', message: 'lower the cap' });

      expect(repository.markDeliveredFromHold([row.id], 'session-next')).toBe(1);
      // A second delivery finds nothing still held.
      expect(repository.markDeliveredFromHold([row.id], 'session-next')).toBe(0);
      expect(repository.listHeldForTask('task-held')).toEqual([]);
      expect(repository.listForSession('session-next')).toEqual([
        expect.objectContaining({ message: 'lower the cap', status: 'delivered_from_hold', task_id: 'task-held' }),
      ]);
    });

    it('keeps a cleared message cleared when its delivery settles later', () => {
      seedTask('task-held');
      seedSession('session-next', 'task-held');
      const repository = new SentSessionMessageRepository(database);
      const row = repository.insertHeld({ ...noCaller, taskId: 'task-held', message: 'stale by now' });

      expect(repository.markClearedForTask('task-held')).toBe(1);
      expect(repository.markDeliveredFromHold([row.id], 'session-next')).toBe(0);
      expect(repository.markHeldFailed([row.id], 'late')).toBe(0);
      expect(repository.listForTask('task-held').map((entry) => entry.status)).toEqual(['cleared']);
    });

    it('goes with its task when the task row is deleted', () => {
      seedTask('task-held');
      const repository = new SentSessionMessageRepository(database);
      repository.insertHeld({ ...noCaller, taskId: 'task-held', message: 'for a task about to go' });

      database.prepare('DELETE FROM tasks WHERE id = ?').run('task-held');

      expect(repository.listForTask('task-held')).toEqual([]);
    });

    it('TaskRepository.delete removes the task\'s log, held and delivered rows alike, without relying on the foreign key cascade', () => {
      const repository = new SentSessionMessageRepository(database);
      const countRowsForTask = (taskId: string): number =>
        (database.prepare('SELECT COUNT(*) AS count FROM session_messages_sent WHERE task_id = ?').get(taskId) as { count: number }).count;

      // Seed with foreign keys ON so insert() can resolve its session, exactly
      // as production writes these rows.
      for (const taskId of ['task-control', 'task-deleted', 'task-bystander']) {
        seedTask(taskId);
        seedSession(`session-of-${taskId}`, taskId);
        repository.insertHeld({ ...noCaller, taskId, message: `held for ${taskId}` });
        repository.insert({
          ...noCaller,
          session_id: `session-of-${taskId}`,
          message: `delivered to ${taskId}`,
          status: 'delivered',
          error: null,
        });
        expect(countRowsForTask(taskId)).toBe(2);
      }

      // Now run as an install whose connection never set the pragma: the
      // cascade on session_messages_sent.task_id is parsed and ignored.
      database.pragma('foreign_keys = OFF');
      expect(database.pragma('foreign_keys', { simple: true })).toBe(0);

      // Control: a raw DELETE leaves both rows behind on this connection. This
      // is what proves the cascade is inert here, so the assertions below can
      // only pass through TaskRepository.delete's own explicit DELETE.
      database.prepare('DELETE FROM tasks WHERE id = ?').run('task-control');
      expect(countRowsForTask('task-control')).toBe(2);

      new TaskRepository(database).delete('task-deleted');

      // Red: removing the `DELETE FROM session_messages_sent WHERE task_id = ?`
      // statement from TaskRepository.delete (task-repository.ts) leaves both
      // rows of the deleted task here, the same way the control above does.
      expect(database.prepare('SELECT id FROM tasks WHERE id = ?').get('task-deleted')).toBeUndefined();
      expect(countRowsForTask('task-deleted')).toBe(0);
      expect(repository.listForTask('task-deleted')).toEqual([]);
      // The session row survives with the pragma off, so the delivered row is
      // reachable by its session id too, and must be gone by that route as well.
      expect(repository.listForSession('session-of-task-deleted')).toEqual([]);
      expect(repository.listHeldForTask('task-deleted')).toEqual([]);

      // Scoped to the one task: another task's log is untouched.
      expect(repository.listForTask('task-bystander').map((row) => row.status).sort()).toEqual(['delivered', 'held']);
    });
  });
});
