import { describe, it, expect } from 'vitest';
import { runProjectMigrations } from '../../src/main/db/migrations/project-schema';
import { TranscriptRepository } from '../../src/main/db/repositories/transcript-repository';
import { adaptDatabase, type NodeDatabase } from './helpers/node-sqlite-database';

/**
 * A session's raw terminal transcript, stored as ordered pieces (one row per
 * flush), with a legacy single-value row read as its oldest part until the
 * retrieval worker converts it. Run on the real project schema over
 * node:sqlite (better-sqlite3 cannot load under vitest's Node).
 */

type SqliteModule = typeof import('node:sqlite');
let sqlite: SqliteModule | null = null;
try {
  sqlite = await import('node:sqlite');
} catch {
  sqlite = null;
}
const describeWithSqlite = sqlite ? describe : describe.skip;

function project(): { database: NodeDatabase; transcripts: TranscriptRepository } {
  const database = new sqlite!.DatabaseSync(':memory:');
  const db = adaptDatabase(database);
  runProjectMigrations(db);
  return { database, transcripts: new TranscriptRepository(db) };
}

function insertLegacy(database: NodeDatabase, sessionId: string, transcript: string): void {
  database.prepare(`INSERT INTO session_transcripts (session_id, transcript, size_bytes, created_at, updated_at)
    VALUES (?, ?, ?, '2026-09-01T00:00:00.000Z', '2026-09-02T00:00:00.000Z')`).run(sessionId, transcript, transcript.length);
}

describeWithSqlite('TranscriptRepository', () => {
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

  it('reads the tail from the newest pieces only, and reports the whole length', () => {
    const { transcripts } = project();
    for (const piece of ['aaaa', 'bbbb', 'cccc']) transcripts.appendChunk('session-1', piece);

    const tail = transcripts.getTranscriptTail('session-1', 6);
    expect(tail).toMatchObject({ tail: 'bbcccc', fullLength: 12, sizeBytes: 12 });
    expect(transcripts.getTranscriptTail('session-1', 100)?.tail).toBe('aaaabbbbcccc');
    expect(transcripts.getTranscriptTail('missing', 100)).toBeNull();
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
});
