import { afterEach, describe, it, expect } from 'vitest';
import type DatabaseType from 'better-sqlite3';
import { runProjectMigrations } from '../../src/main/db/migrations/project-schema';
import { TranscriptRepository } from '../../src/main/db/repositories/transcript-repository';
import { SessionRepository } from '../../src/main/db/repositories/session-repository';
import { openTestDatabase } from './helpers/test-database';

/**
 * A session's raw terminal transcript, stored as ordered pieces (one row per
 * flush), with a legacy single-value row read as its oldest part until the
 * retrieval worker converts it. Run on the real project schema over real
 * better-sqlite3, the driver production uses.
 */

const openDatabases: DatabaseType.Database[] = [];

afterEach(() => {
  for (const database of openDatabases.splice(0)) database.close();
});

function project(): { database: DatabaseType.Database; sessions: SessionRepository; transcripts: TranscriptRepository } {
  const database = openTestDatabase();
  openDatabases.push(database);
  runProjectMigrations(database);
  return { database, sessions: new SessionRepository(database), transcripts: new TranscriptRepository(database) };
}

function insertLegacy(database: DatabaseType.Database, sessionId: string, transcript: string): void {
  database.prepare(`INSERT INTO session_transcripts (session_id, transcript, size_bytes, created_at, updated_at)
    VALUES (?, ?, ?, '2026-09-01T00:00:00.000Z', '2026-09-02T00:00:00.000Z')`).run(sessionId, transcript, transcript.length);
}

describe('TranscriptRepository', () => {
  it('appends each flush as the next piece, one row each, and reads them back in order', () => {
    const { database, transcripts } = project();
    transcripts.appendChunk('session-1', 'first ');
    transcripts.appendChunk('session-1', 'second ');
    transcripts.appendChunk('session-1', 'third');
    transcripts.appendChunk('session-2', 'other');

    const seqs = (database.prepare("SELECT seq FROM session_transcript_chunks WHERE session_id = 'session-1' ORDER BY seq").all() as Array<{ seq: number }>)
      .map((row) => row.seq);
    expect(seqs).toEqual([0, 1, 2]);
    expect(transcripts.getTranscriptText('session-1')).toBe('first second third');
    expect(transcripts.getSizeBytes('session-1')).toBe('first second third'.length);
    expect(transcripts.getTranscriptText('missing')).toBeNull();
  });

  it('starts a session whose only pieces are a legacy conversion\'s (negative seqs) at seq 0, never below it', () => {
    const { database, transcripts } = project();
    const insertPiece = database.prepare('INSERT INTO session_transcript_chunks (session_id, seq, chars, bytes, created_at, text) VALUES (?, ?, ?, ?, ?, ?)');
    // A conversion part-way through: its pieces sit at -3, -2, -1 and it has
    // written only the first. MAX(seq) + 1 would give -2, the next one it writes.
    insertPiece.run('session-1', -3, 4, 4, '2026-09-01T00:00:00.000Z', 'old ');
    const seqsOf = (): number[] => (database.prepare("SELECT seq FROM session_transcript_chunks WHERE session_id = 'session-1' ORDER BY seq").all() as Array<{ seq: number }>)
      .map((row) => row.seq);

    transcripts.appendChunk('session-1', 'new ');
    expect(seqsOf()).toEqual([-3, 0]);

    // The rest of the conversion's pieces still insert beside it.
    insertPiece.run('session-1', -2, 4, 4, '2026-09-01T00:00:00.000Z', 'mid ');
    insertPiece.run('session-1', -1, 4, 4, '2026-09-01T00:00:00.000Z', 'end ');
    // Once a piece is at 0 or above, the next is one past the highest.
    transcripts.appendChunk('session-1', 'live');
    expect(seqsOf()).toEqual([-3, -2, -1, 0, 1]);
    expect(transcripts.getTranscriptText('session-1')).toBe('old mid end new live');
  });

  it('reads the tail from the newest pieces only, and reports the whole length', () => {
    const { transcripts } = project();
    for (const piece of ['aaaa', 'bbbb', 'cccc']) transcripts.appendChunk('session-1', piece);

    const tail = transcripts.getTranscriptTail('session-1', 6);
    expect(tail).toMatchObject({ tail: 'bbcccc', fullLength: 12, sizeBytes: 12 });
    expect(transcripts.getTranscriptTail('session-1', 100)?.tail).toBe('aaaabbbbcccc');
    expect(transcripts.getTranscriptTail('missing', 100)).toBeNull();
  });

  // A tail of no characters is empty, and the transcript's size is still
  // reported. The way it goes wrong is the whole transcript coming back: a
  // negative or zero budget fed to a `slice(-budget)` (`slice(-0)` is the whole
  // string) or to the legacy row's `substr(transcript, ?)` (a start of 0 or
  // below reads all of it). The clamp (`Math.max(0, maxChars)`) is one of three
  // guards that each give an empty tail on their own, with the `budget > 0` gate
  // on the pieces read and the final trim to the budget, so this pins the
  // behavior and no one-line revert flips it. It goes red when a rewrite drops
  // the gate and the trim together (or replaces them with `slice(-budget)`).
  // One session per way a transcript is stored: pieces, legacy plus pieces,
  // legacy alone.
  it.each([-50, 0])('reads an empty tail and the whole length when maxChars is %i, never the transcript', (maxChars) => {
    const { database, transcripts } = project();
    for (const piece of ['aaaa', 'bbbb', 'cccc']) transcripts.appendChunk('pieces-only', piece);
    insertLegacy(database, 'legacy-and-pieces', 'legacy-start ');
    transcripts.appendChunk('legacy-and-pieces', 'new-piece');
    insertLegacy(database, 'legacy-only', 'only legacy');

    expect(transcripts.getTranscriptTail('pieces-only', maxChars)).toMatchObject({ tail: '', fullLength: 12, sizeBytes: 12 });
    expect(transcripts.getTranscriptTail('legacy-and-pieces', maxChars)).toMatchObject({ tail: '', fullLength: 22, sizeBytes: 22 });
    expect(transcripts.getTranscriptTail('legacy-only', maxChars)).toMatchObject({ tail: '', fullLength: 11, sizeBytes: 11 });
    // A session with nothing captured is still null, whatever the budget.
    expect(transcripts.getTranscriptTail('missing', maxChars)).toBeNull();
  });

  it('reads a legacy row as the oldest part, and its tail only when the pieces fall short', () => {
    const { database, transcripts } = project();
    insertLegacy(database, 'session-1', 'legacy-start ');
    transcripts.appendChunk('session-1', 'new-piece');

    expect(transcripts.getTranscriptText('session-1')).toBe('legacy-start new-piece');
    expect(transcripts.getTranscriptTail('session-1', 9)?.tail).toBe('new-piece');
    const reachingBack = transcripts.getTranscriptTail('session-1', 13);
    expect(reachingBack).toMatchObject({ tail: 'art new-piece', fullLength: 22, createdAt: '2026-09-01T00:00:00.000Z' });
    // A legacy row alone still answers.
    insertLegacy(database, 'session-2', 'only legacy');
    expect(transcripts.getTranscriptTail('session-2', 6)).toMatchObject({ tail: 'legacy', fullLength: 11, sizeBytes: 11 });
  });

  it('keeps a transcript after its session is deleted, in both tables', () => {
    const { database, transcripts } = project();
    database.exec(`INSERT INTO swimlanes (id, name, position, created_at) VALUES ('lane-1', 'To Do', 0, '2026-09-30T00:00:00.000Z')`);
    database.exec(`INSERT INTO tasks (id, display_id, title, description, swimlane_id, position, created_at, updated_at)
      VALUES ('task-1', 1, 'task-1', '', 'lane-1', 0, '2026-09-30T00:00:00.000Z', '2026-09-30T00:00:00.000Z')`);
    database.exec(`INSERT INTO sessions (id, task_id, session_type, command, cwd, status, started_at)
      VALUES ('session-1', 'task-1', 'claude_agent', 'claude', '/mock', 'exited', '2026-09-30T00:00:00.000Z')`);
    insertLegacy(database, 'session-1', 'old ');
    transcripts.appendChunk('session-1', 'new');

    database.exec(`DELETE FROM sessions WHERE id = 'session-1'`);

    expect(transcripts.getTranscriptText('session-1')).toBe('old new');
  });

  // The test above runs a raw `DELETE FROM sessions` and is the pin on the
  // schema (no foreign key, no delete trigger on either transcript table). This
  // one deletes the way the app does, through `SessionRepository.deleteByTaskId`,
  // so a cascade or a transcript delete added to that path cannot take the
  // transcript with its session unnoticed. It does not cover the retrieval
  // worker: nothing there may delete a raw transcript either.
  it('keeps a transcript after its task\'s sessions are deleted through the repository', () => {
    const { database, sessions, transcripts } = project();
    database.exec(`INSERT INTO swimlanes (id, name, position, created_at) VALUES ('lane-1', 'To Do', 0, '2026-09-30T00:00:00.000Z')`);
    database.exec(`INSERT INTO tasks (id, display_id, title, description, swimlane_id, position, created_at, updated_at)
      VALUES ('task-1', 1, 'task-1', '', 'lane-1', 0, '2026-09-30T00:00:00.000Z', '2026-09-30T00:00:00.000Z')`);
    database.exec(`INSERT INTO sessions (id, task_id, session_type, command, cwd, status, started_at)
      VALUES ('session-1', 'task-1', 'claude_agent', 'claude', '/mock', 'exited', '2026-09-30T00:00:00.000Z')`);
    insertLegacy(database, 'session-1', 'old ');
    transcripts.appendChunk('session-1', 'new');
    const countRows = (table: string): number =>
      (database.prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE session_id = 'session-1'`).get() as { count: number }).count;
    expect(sessions.listForTaskNewestFirst('task-1')).toHaveLength(1);

    sessions.deleteByTaskId('task-1');

    // The delete took effect: no session record is left for the task.
    expect(sessions.listForTaskNewestFirst('task-1')).toEqual([]);
    expect((database.prepare('SELECT COUNT(*) AS count FROM sessions').get() as { count: number }).count).toBe(0);
    // The transcript outlived it, in both tables.
    expect(countRows('session_transcripts')).toBe(1);
    expect(countRows('session_transcript_chunks')).toBe(1);
    expect(transcripts.getTranscriptText('session-1')).toBe('old new');
    expect(transcripts.getTranscriptTail('session-1', 100)).toMatchObject({ tail: 'old new', fullLength: 7 });
  });
});
