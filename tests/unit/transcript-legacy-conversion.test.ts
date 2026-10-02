import { describe, it, expect } from 'vitest';
import { runProjectMigrations } from '../../src/main/db/migrations/project-schema';
import { TranscriptRepository } from '../../src/main/db/repositories/transcript-repository';
import { indexHandlers } from '../../src/main/retrieval/worker/index-methods';
import type { WorkerContext } from '../../src/main/retrieval/worker/methods';
import { adaptDatabase, type NodeDatabase } from './helpers/node-sqlite-database';

/**
 * The retrieval worker's conversion of legacy raw transcripts (one growing
 * value per session) into pieces, on two real-schema projects over
 * node:sqlite. One writer used to follow the focused project, so a session's
 * transcript could land in another project's database, or partly in each.
 */

type SqliteModule = typeof import('node:sqlite');
let sqlite: SqliteModule | null = null;
try {
  sqlite = await import('node:sqlite');
} catch {
  sqlite = null;
}
const describeWithSqlite = sqlite ? describe : describe.skip;

function project(sessionIds: string[]): NodeDatabase {
  const database = new sqlite!.DatabaseSync(':memory:');
  runProjectMigrations(adaptDatabase(database));
  database.exec(`INSERT INTO swimlanes (id, name, position, created_at) VALUES ('lane-1', 'To Do', 0, '2026-09-30T00:00:00.000Z')`);
  database.exec(`INSERT INTO tasks (id, display_id, title, description, swimlane_id, position, created_at, updated_at)
    VALUES ('task-1', 1, 'task-1', '', 'lane-1', 0, '2026-09-30T00:00:00.000Z', '2026-09-30T00:00:00.000Z')`);
  for (const sessionId of sessionIds) {
    database.prepare(`INSERT INTO sessions (id, task_id, session_type, command, cwd, status, started_at)
      VALUES (?, 'task-1', 'claude_agent', 'claude', '/mock', 'exited', '2026-09-30T00:00:00.000Z')`).run(sessionId);
  }
  return database;
}

function insertLegacy(database: NodeDatabase, sessionId: string, transcript: string): void {
  database.prepare(`INSERT INTO session_transcripts (session_id, transcript, size_bytes, created_at, updated_at)
    VALUES (?, ?, ?, '2026-09-01T00:00:00.000Z', '2026-09-02T00:00:00.000Z')`).run(sessionId, transcript, transcript.length);
}

function contextFor(databases: Map<string, NodeDatabase>): WorkerContext {
  return {
    getDb: (projectId) => {
      const database = databases.get(projectId);
      if (!database) throw new Error(`unable to open database file for ${projectId}`);
      return adaptDatabase(database);
    },
    closeDb: () => undefined,
    vecLoadError: () => null,
    emit: () => undefined,
  };
}

const legacyCount = (database: NodeDatabase): number =>
  (database.prepare('SELECT COUNT(*) AS count FROM session_transcripts').get() as { count: number }).count;
const textOf = (database: NodeDatabase, sessionId: string): string | null =>
  new TranscriptRepository(adaptDatabase(database)).getTranscriptText(sessionId);
const seqsOf = (database: NodeDatabase, sessionId: string): number[] =>
  (database.prepare('SELECT seq FROM session_transcript_chunks WHERE session_id = ? ORDER BY seq').all(sessionId) as Array<{ seq: number }>)
    .map((row) => row.seq);
const tableCount = (database: NodeDatabase, tableName: string): number =>
  (database.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table' AND name = ?").get(tableName) as { count: number }).count;

describeWithSqlite('legacy transcript conversion', () => {
  it('converts in place, moves a misfiled transcript to its own project, and keeps one found nowhere', async () => {
    const projectA = project(['session-a']);
    const projectB = project(['session-b']);
    insertLegacy(projectA, 'session-a', 'a own');
    insertLegacy(projectA, 'session-b', 'misfiled from b ');
    insertLegacy(projectA, 'session-x', 'in no project');
    // Session b's own part, and what it wrote since the switch.
    insertLegacy(projectB, 'session-b', 'b own part ');
    new TranscriptRepository(adaptDatabase(projectB)).appendChunk('session-b', 'live');
    const context = contextFor(new Map([['a', projectA], ['b', projectB]]));

    const fromA = await indexHandlers['transcripts.convertLegacy']({ projectId: 'a', otherProjectIds: ['b'] }, context);
    expect(fromA).toEqual({ converted: 3, moved: 1, bytes: 'a own'.length + 'misfiled from b '.length + 'in no project'.length });
    expect(legacyCount(projectA)).toBe(0);
    expect(textOf(projectA, 'session-a')).toBe('a own');
    expect(textOf(projectA, 'session-x')).toBe('in no project');
    expect(textOf(projectA, 'session-b')).toBeNull();

    // Project b converts its own row when it opens: nothing of either part is lost.
    await indexHandlers['transcripts.convertLegacy']({ projectId: 'b', otherProjectIds: ['a'] }, context);
    expect(legacyCount(projectB)).toBe(0);
    expect(textOf(projectB, 'session-b')).toBe('b own part misfiled from b live');
    // No progress record is left behind.
    expect((projectB.prepare("SELECT COUNT(*) AS count FROM memory_meta WHERE key LIKE 'transcript_legacy:%'").get() as { count: number }).count).toBe(0);
  });

  it('never cuts a piece inside a surrogate pair, so an emoji on a piece boundary survives', async () => {
    // The real install had one: a 64K boundary fell between the two halves of
    // a red-circle emoji. Cut there, each half is stored as U+FFFD.
    const projectA = project(['session-a']);
    const piece = 64 * 1024;
    const text = 'A'.repeat(piece - 1) + '\u{1F534}' + 'B'.repeat(10);
    insertLegacy(projectA, 'session-a', text);

    await indexHandlers['transcripts.convertLegacy']({ projectId: 'a', otherProjectIds: [] }, contextFor(new Map([['a', projectA]])));

    expect(legacyCount(projectA)).toBe(0);
    expect(textOf(projectA, 'session-a')).toBe(text);
    const pieces = projectA.prepare("SELECT chars FROM session_transcript_chunks WHERE session_id = 'session-a' ORDER BY seq").all() as Array<{ chars: number }>;
    // The first piece ends a unit early, before the pair.
    expect(pieces.map((row) => row.chars)).toEqual([piece - 1, 12]);
  });

  it('resumes a conversion cut short where it stopped, writing no piece twice', async () => {
    const projectA = project(['session-a']);
    // Three pieces' worth (64 KB each), one already written before a crash.
    const piece = 64 * 1024;
    const text = 'A'.repeat(piece) + 'B'.repeat(piece) + 'C'.repeat(10);
    insertLegacy(projectA, 'session-a', text);
    projectA.prepare('INSERT INTO session_transcript_chunks (session_id, seq, chars, bytes, created_at, text) VALUES (?, ?, ?, ?, ?, ?)')
      .run('session-a', -3, piece, piece, '2026-09-01T00:00:00.000Z', 'A'.repeat(piece));
    projectA.prepare('INSERT INTO memory_meta (key, value) VALUES (?, ?)')
      .run('transcript_legacy:a:session-a', JSON.stringify({ base: -3, written: 1 }));

    await indexHandlers['transcripts.convertLegacy']({ projectId: 'a', otherProjectIds: [] }, contextFor(new Map([['a', projectA]])));

    const seqs = (projectA.prepare("SELECT seq FROM session_transcript_chunks WHERE session_id = 'session-a' ORDER BY seq").all() as Array<{ seq: number }>)
      .map((row) => row.seq);
    expect(seqs).toEqual([-3, -2, -1]);
    expect(textOf(projectA, 'session-a')).toBe(text);
    expect(legacyCount(projectA)).toBe(0);
    // The row's first and last write times survive as the pieces' range.
    const tail = new TranscriptRepository(adaptDatabase(projectA)).getTranscriptTail('session-a', 10);
    expect(tail).toMatchObject({ createdAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-02T00:00:00.000Z' });
  });

  it('takes seq 0 for a flush that lands between two conversion steps, so the rest still insert and the text reads legacy first', async () => {
    const projectA = project(['session-a']);
    const piece = 64 * 1024;
    // Two pieces: the conversion writes them at seqs -2 and -1, one transaction
    // each, and waits a write turn after every one.
    const text = 'A'.repeat(piece) + 'B'.repeat(10);
    insertLegacy(projectA, 'session-a', text);
    const transcripts = new TranscriptRepository(adaptDatabase(projectA));

    // Not awaited: the handler runs synchronously up to its first write turn,
    // so exactly its first piece is written when this call returns.
    const conversion = indexHandlers['transcripts.convertLegacy']({ projectId: 'a', otherProjectIds: [] }, contextFor(new Map([['a', projectA]])));
    // The precondition that makes the rest mean something: were both pieces
    // already written, the flush below would take seq 0 whichever way the next
    // seq is worked out.
    expect(seqsOf(projectA, 'session-a')).toEqual([-2]);

    // The terminal's flush, between the conversion's two steps. A next seq of
    // MAX(seq) + 1 would be -1 here, the seq the conversion writes next.
    transcripts.appendChunk('session-a', 'live');
    expect(seqsOf(projectA, 'session-a')).toEqual([-2, 0]);

    await expect(conversion).resolves.toEqual({ converted: 1, moved: 0, bytes: text.length });
    expect(seqsOf(projectA, 'session-a')).toEqual([-2, -1, 0]);
    expect(textOf(projectA, 'session-a')).toBe(`${text}live`);
    expect(legacyCount(projectA)).toBe(0);
    expect((projectA.prepare("SELECT COUNT(*) AS count FROM memory_meta WHERE key LIKE 'transcript_legacy:%'").get() as { count: number }).count).toBe(0);
  });

  it('converts a transcript in this project, instead of throwing, when its session is only in another project that has no pieces table yet', async () => {
    const projectA = project(['session-a']);
    insertLegacy(projectA, 'session-b', 'misfiled but unmovable');
    // A project main has not opened since the upgrade: the worker opens with
    // migrations off, so it has its sessions but neither table a move writes to.
    const unmigrated = new sqlite!.DatabaseSync(':memory:');
    unmigrated.exec('CREATE TABLE sessions (id TEXT PRIMARY KEY)');
    unmigrated.prepare('INSERT INTO sessions (id) VALUES (?)').run('session-b');
    expect(tableCount(unmigrated, 'session_transcript_chunks')).toBe(0);
    expect(tableCount(unmigrated, 'memory_meta')).toBe(0);
    const context = contextFor(new Map([['a', projectA], ['b', unmigrated]]));

    const result = await indexHandlers['transcripts.convertLegacy']({ projectId: 'a', otherProjectIds: ['b'] }, context);

    expect(result).toEqual({ converted: 1, moved: 0, bytes: 'misfiled but unmovable'.length });
    expect(legacyCount(projectA)).toBe(0);
    expect(textOf(projectA, 'session-b')).toBe('misfiled but unmovable');
    // Nothing was written into the other project.
    expect(tableCount(unmigrated, 'session_transcript_chunks')).toBe(0);
    expect(tableCount(unmigrated, 'memory_meta')).toBe(0);
  });
});
