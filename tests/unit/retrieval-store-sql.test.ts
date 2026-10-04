import { passThroughTransaction } from './helpers/transaction-double';
import { afterEach, describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type Database from 'better-sqlite3';
import { runProjectMigrations } from '../../src/main/db/migrations/project-schema';
import { CHUNKS_PER_TRANSACTION, DELETES_PER_TRANSACTION, RetrievalStore, type DocSumWrite } from '../../src/main/retrieval/retrieval-store';
import { markVecCapable } from '../../src/main/retrieval/vec-support';
import type { ChunkInput, CorpusDocumentRef } from '../../src/main/retrieval/types';

import { openTestDatabase } from './helpers/test-database';
import { ConversationIndexer } from '../../src/main/retrieval/conversation/conversation-indexer';

/**
 * Most of this file drives the store through a hand-rolled `prepare()` that
 * records the SQL text and bound params and returns scripted rows. These lock
 * the JS contract: upsertDocument's (seq, contentHash) diff, the 1-based lexical
 * ranks, and the read-path SQL shape / bound bounds, which is to say the SQL text
 * and the parameters the store sends. They do not run that SQL.
 *
 * The "(real database)" blocks and the real vec0 block run the REAL project
 * migrations and the REAL store on real better-sqlite3, the driver production
 * uses, where what a statement must get right is which rows it touches, which a
 * recording double cannot see.
 */

const openDatabases: Database.Database[] = [];
const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const database of openDatabases.splice(0)) database.close();
  for (const directory of temporaryDirectories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

/** A real database, closed after the test: in memory unless `filename` is given.
 *  `vec` loads sqlite-vec. */
function openTracked(options: { vec?: boolean; filename?: string } = {}): Database.Database {
  const database = openTestDatabase(options.filename ?? ':memory:', { vec: options.vec });
  openDatabases.push(database);
  return database;
}

/** A database file path in a directory removed after the test, for a test that
 *  needs a second connection to the same database. */
function temporaryDatabaseFile(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'kangentic-retrieval-store-'));
  temporaryDirectories.push(directory);
  return path.join(directory, 'project.db');
}

interface RecordedCall {
  sql: string;
  args: unknown[];
  method: 'get' | 'all' | 'run';
}

type RowResult = { lastInsertRowid?: number | bigint; changes?: number };

function makeRecordingDb(handlers: {
  get?: (sql: string, args: unknown[]) => unknown;
  all?: (sql: string, args: unknown[]) => unknown[];
  run?: (sql: string, args: unknown[]) => RowResult;
}): { db: Database.Database; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  const db = {
    prepare(sql: string) {
      return {
        get: (...args: unknown[]) => {
          calls.push({ sql, args, method: 'get' });
          return handlers.get?.(sql, args);
        },
        all: (...args: unknown[]) => {
          calls.push({ sql, args, method: 'all' });
          return handlers.all?.(sql, args) ?? [];
        },
        run: (...args: unknown[]) => {
          calls.push({ sql, args, method: 'run' });
          return handlers.run?.(sql, args) ?? { changes: 0, lastInsertRowid: 0 };
        },
      };
    },
    // transaction(fn) returns a callable that runs fn and returns its value.
    transaction: passThroughTransaction,
  } as unknown as Database.Database;
  return { db, calls };
}

const ref: CorpusDocumentRef = {
  corpus: 'conversation',
  docId: 'doc-1',
  sessionId: 'session-1',
  taskId: 'task-1',
  agentSessionId: 'agent-1',
  metaJson: null,
};

function chunk(seq: number, contentHash: string): ChunkInput {
  return {
    seq,
    text: `text-${seq}`,
    contentHash,
    tokenEstimate: 10,
    role: 'user',
    tsStart: 1,
    tsEnd: 2,
    turnUuidStart: `u${seq}`,
    turnUuidEnd: `u${seq}`,
  };
}

function findRun(calls: RecordedCall[], needle: string): RecordedCall | undefined {
  return calls.find((call) => call.method === 'run' && call.sql.includes(needle));
}

describe('RetrievalStore.upsertDocument diff', () => {
  it('deletes from the first divergent seq and inserts only the new chunk, leaving the identical prefix', () => {
    const existing = [
      { id: 10, seq: 0, content_hash: 'hashA', turn_uuid_start: 'u0', turn_uuid_end: 'u0' },
      { id: 11, seq: 1, content_hash: 'hashB', turn_uuid_start: 'u1', turn_uuid_end: 'u1' },
    ];
    const { db, calls } = makeRecordingDb({
      all: (sql) => (sql.includes('content_hash') ? existing : []),
      run: (sql) => (sql.includes('INSERT INTO memory_chunks') ? { lastInsertRowid: 200, changes: 1 } : { changes: 1 }),
    });

    // seq0 identical (hashA), seq1 diverges (hashB -> hashC).
    const result = new RetrievalStore(db).upsertDocument(ref, [chunk(0, 'hashA'), chunk(1, 'hashC')]);

    // Only the old seq1 row is deleted; only the new seq1 chunk is inserted.
    expect(result.deletedIds).toEqual([11]);
    expect(result.insertedIds).toEqual([200]);

    const deleteCall = findRun(calls, 'DELETE FROM memory_chunks WHERE id IN');
    expect(deleteCall?.args).toEqual([11]);

    const insertCalls = calls.filter((call) => call.sql.includes('INSERT INTO memory_chunks'));
    expect(insertCalls).toHaveLength(1);
    // Bound params: seq at index 2, contentHash at index 8.
    expect(insertCalls[0].args[2]).toBe(1);
    expect(insertCalls[0].args[8]).toBe('hashC');
  });

  it('preserves an identical document (no delete/insert) but re-points its ownership at the current session', () => {
    const existing = [
      { id: 10, seq: 0, content_hash: 'hashA', turn_uuid_start: 'u0', turn_uuid_end: 'u0' },
      { id: 11, seq: 1, content_hash: 'hashB', turn_uuid_start: 'u1', turn_uuid_end: 'u1' },
    ];
    const { db, calls } = makeRecordingDb({
      all: (sql) => (sql.includes('content_hash') ? existing : []),
    });

    const result = new RetrievalStore(db).upsertDocument(ref, [chunk(0, 'hashA'), chunk(1, 'hashB')]);

    // No chunk churn: the identical prefix keeps its rows (and their embeddings).
    expect(result.deletedIds).toEqual([]);
    expect(result.insertedIds).toEqual([]);
    expect(findRun(calls, 'DELETE FROM memory_chunks')).toBeUndefined();
    expect(calls.some((call) => call.sql.includes('INSERT INTO memory_chunks'))).toBe(false);

    // But ownership is re-pointed at the current session/task. A resumed session
    // re-indexes the same agent transcript (same doc_id) under a NEW session row;
    // the untouched prefix must follow it so the Terminal/History badge and the
    // session-delete trigger (which keys on session_id) track the live session.
    const ownershipUpdate = findRun(calls, 'UPDATE memory_chunks SET session_id');
    // From seq 0 (the whole document was passed) up to the divergence.
    expect(ownershipUpdate?.args).toEqual(['session-1', 'task-1', 'conversation', 'doc-1', 0, 2, 'session-1', 'task-1']);
    // Rows that already have the owner are left alone.
    expect(ownershipUpdate?.sql).toContain('AND (session_id IS NOT ? OR task_id IS NOT ?)');

    // The anchors already match, so nothing is re-anchored.
    expect(findRun(calls, 'UPDATE memory_chunks SET turn_uuid_start')).toBeUndefined();
  });

  it('writes nothing for a prefix that already has its owner and anchors', () => {
    // An ordinary turn of a live conversation: the earlier chunks are
    // unchanged, and rewriting their owner each turn rewrote the whole document.
    const existing = [
      { id: 10, seq: 0, content_hash: 'hashA', turn_uuid_start: 'u0', turn_uuid_end: 'u0', session_id: 'session-1', task_id: 'task-1' },
      { id: 11, seq: 1, content_hash: 'hashB', turn_uuid_start: 'u1', turn_uuid_end: 'u1', session_id: 'session-1', task_id: 'task-1' },
    ];
    const { db, calls } = makeRecordingDb({
      all: (sql) => (sql.includes('content_hash') ? existing : []),
    });

    new RetrievalStore(db).upsertDocument(ref, [chunk(0, 'hashA'), chunk(1, 'hashB')]);

    expect(calls.filter((call) => call.method === 'run')).toEqual([]);
  });

  it('inserts a long document in transactions of CHUNKS_PER_TRANSACTION chunks', () => {
    const { db, calls } = makeRecordingDb({
      all: () => [],
      run: () => ({ lastInsertRowid: 1, changes: 1 }),
    });
    // Each transaction run notes how many inserts it wrote.
    const insertsPerTransaction: number[] = [];
    const countingDb = {
      prepare: db.prepare.bind(db),
      transaction: (body: () => unknown) => passThroughTransaction(() => {
        const before = calls.length;
        const value = body();
        insertsPerTransaction.push(calls.slice(before).filter((call) => call.sql.includes('INSERT INTO memory_chunks')).length);
        return value;
      }),
    } as unknown as Database.Database;

    const chunks = Array.from({ length: CHUNKS_PER_TRANSACTION * 2 + 3 }, (_, seq) => chunk(seq, `hash${seq}`));
    const result = new RetrievalStore(countingDb).upsertDocument(ref, chunks);

    expect(result.insertedIds).toHaveLength(chunks.length);
    expect(insertsPerTransaction).toEqual([CHUNKS_PER_TRANSACTION, CHUNKS_PER_TRANSACTION, 3]);
  });

  it('re-anchors an identical prefix whose turn uuids changed, without touching its embeddings', () => {
    // `content_hash` is sha1(TEXT) only, so a chunk whose text is unchanged
    // while its turn uuids changed is invisible to the divergence walk and
    // used to keep its stale anchors forever - which is exactly what a
    // uuid-scheme change produces, and why "Rebuild index" could not fix one.
    const existing = [
      { id: 10, seq: 0, content_hash: 'hashA', turn_uuid_start: 'codex-0', turn_uuid_end: 'codex-0' },
      { id: 11, seq: 1, content_hash: 'hashB', turn_uuid_start: 'codex-1', turn_uuid_end: 'codex-1' },
    ];
    const { db, calls } = makeRecordingDb({
      all: (sql) => (sql.includes('content_hash') ? existing : []),
    });

    const result = new RetrievalStore(db).upsertDocument(ref, [chunk(0, 'hashA'), chunk(1, 'hashB')]);

    // Still no churn: the rows (and their embeddings) stay put.
    expect(result.deletedIds).toEqual([]);
    expect(result.insertedIds).toEqual([]);
    expect(findRun(calls, 'DELETE FROM memory_chunks')).toBeUndefined();
    expect(calls.some((call) => call.sql.includes('INSERT INTO memory_chunks'))).toBe(false);

    // ...but both rows are re-anchored in place, keyed by row id.
    const reanchorCalls = calls.filter(
      (call) => call.method === 'run' && call.sql.includes('UPDATE memory_chunks SET turn_uuid_start'),
    );
    expect(reanchorCalls.map((call) => call.args)).toEqual([
      ['u0', 'u0', 10],
      ['u1', 'u1', 11],
    ]);
    // `content_hash` is never rewritten, so no chunk is re-embedded. Asserted
    // over EVERY statement the pass issued, not just the re-anchor ones: the
    // re-anchor sql is a fixed literal that structurally cannot mention
    // `content_hash`, so scoping this to those calls could never fail.
    expect(calls.some((call) => call.sql.includes('SET content_hash'))).toBe(false);
  });

  it('appends a new trailing chunk without deleting the identical prefix', () => {
    const existing = [{ id: 10, seq: 0, content_hash: 'hashA', turn_uuid_start: 'u0', turn_uuid_end: 'u0' }];
    const { db, calls } = makeRecordingDb({
      all: (sql) => (sql.includes('content_hash') ? existing : []),
      run: (sql) => (sql.includes('INSERT INTO memory_chunks') ? { lastInsertRowid: 300, changes: 1 } : { changes: 1 }),
    });

    const result = new RetrievalStore(db).upsertDocument(ref, [chunk(0, 'hashA'), chunk(1, 'hashNew')]);

    expect(result.deletedIds).toEqual([]);
    expect(result.insertedIds).toEqual([300]);
    expect(findRun(calls, 'DELETE FROM memory_chunks')).toBeUndefined();
    const insertCalls = calls.filter((call) => call.sql.includes('INSERT INTO memory_chunks'));
    expect(insertCalls).toHaveLength(1);
    expect(insertCalls[0].args[2]).toBe(1);
  });
});

describe('RetrievalStore.resetIndexState (non-destructive rebuild)', () => {
  it('clears only the index-state signatures, never the chunks or vectors', () => {
    const { db, calls } = makeRecordingDb({});
    new RetrievalStore(db).resetIndexState();

    const runs = calls.filter((call) => call.method === 'run');
    // Exactly one statement, and it targets memory_index_state only. The chunks
    // and vectors are left in place so a re-sweep keeps a session's chunks as a
    // fallback: a rebuild can never drop a past conversation.
    expect(runs).toHaveLength(1);
    expect(runs[0].sql).toContain('DELETE FROM memory_index_state');
    expect(calls.some((call) => call.sql.includes('memory_chunks'))).toBe(false);
  });
});

describe('RetrievalStore.writeEmbeddings (vec0 has no UPSERT)', () => {
  it('re-embeds each chunk with DELETE + plain INSERT, never an ON CONFLICT upsert', () => {
    // vec0 virtual tables throw "UPSERT not implemented for virtual table" on an
    // INSERT ... ON CONFLICT DO UPDATE, which silently killed every embed pass
    // (no vectors written -> semantic search always empty). The fix is DELETE
    // then INSERT. Force vecReady: mark the fake connection vec-capable and have
    // the constructor's sqlite_master probe report the table already exists.
    const { db, calls } = makeRecordingDb({
      get: (sql) =>
        sql.includes('sqlite_master')
          ? { name: 'memory_vec_conversation' }
          : sql.includes('content_hash')
            ? { content_hash: 'hash-7', corpus: 'conversation' }
            : undefined,
    });
    markVecCapable(db);

    new RetrievalStore(db).writeEmbeddings(
      [{ chunkId: 7, vector: new Float32Array([0.1, 0.2, 0.3]), contentHash: 'hash-7' }],
      'bge-base@q8',
    );

    // No UPSERT syntax anywhere: vec0 rejects it.
    expect(calls.some((call) => /ON CONFLICT|UPSERT/i.test(call.sql))).toBe(false);

    // The rowid is deleted first, then inserted fresh, both against the vec table.
    const deleteCall = findRun(calls, 'DELETE FROM memory_vec_conversation');
    const insertCall = findRun(calls, 'INSERT INTO memory_vec_conversation');
    expect(deleteCall).toBeDefined();
    expect(insertCall).toBeDefined();
    expect(calls.indexOf(deleteCall as RecordedCall)).toBeLessThan(calls.indexOf(insertCall as RecordedCall));

    // vec0 rowids are bound as BigInt (a JS number is rejected).
    expect(deleteCall?.args[0]).toBe(7n);
    expect(insertCall?.args[0]).toBe(7n);

    // The chunk is marked embedded with the model tag.
    const markCall = findRun(calls, 'UPDATE memory_chunks SET embedded_model');
    expect(markCall?.args).toEqual(['bge-base@q8', 7]);
  });

  it('writes a task chunk into the task corpus table, never the conversation one', () => {
    const { db, calls } = makeRecordingDb({
      get: (sql) =>
        sql.includes('sqlite_master')
          ? { name: 'present' }
          : sql.includes('content_hash')
            ? { content_hash: 'hash-9', corpus: 'task' }
            : undefined,
    });
    markVecCapable(db);

    new RetrievalStore(db).writeEmbeddings(
      [{ chunkId: 9, vector: new Float32Array([0.1, 0.2, 0.3]), contentHash: 'hash-9' }],
      'bge-base@q8',
    );

    expect(findRun(calls, 'INSERT INTO memory_vec_task')?.args[0]).toBe(9n);
    expect(findRun(calls, 'INSERT INTO memory_vec_conversation')).toBeUndefined();
  });

  it('skips a chunk whose content_hash changed since it was fetched, without writing a stale vector', () => {
    // Guards the concurrency-correctness fix for the background embedding
    // drain: memory_chunks.id is INTEGER PRIMARY KEY WITHOUT AUTOINCREMENT, so
    // a concurrent re-index (upsertDocument) can delete-then-reinsert a
    // churning chunk's row and have SQLite reuse the freed rowid for a
    // DIFFERENT chunk before this write lands. Re-validating content_hash
    // inside the same transaction must skip the row rather than stamp a
    // stale vector onto the new chunk's rowid.
    const { db, calls } = makeRecordingDb({
      get: (sql) =>
        sql.includes('sqlite_master')
          ? { name: 'memory_vec_conversation' }
          : sql.includes('content_hash')
            ? { content_hash: 'hash-NEW' } // the row changed after the fetch
            : undefined,
    });
    markVecCapable(db);

    new RetrievalStore(db).writeEmbeddings(
      [{ chunkId: 7, vector: new Float32Array([0.1, 0.2, 0.3]), contentHash: 'hash-STALE' }],
      'bge-base@q8',
    );

    expect(findRun(calls, 'DELETE FROM memory_vec_conversation')).toBeUndefined();
    expect(findRun(calls, 'INSERT INTO memory_vec_conversation')).toBeUndefined();
    expect(findRun(calls, 'UPDATE memory_chunks SET embedded_model')).toBeUndefined();
  });

  it('skips a chunk that no longer exists (deleted concurrently)', () => {
    const { db, calls } = makeRecordingDb({
      get: (sql) => (sql.includes('sqlite_master') ? { name: 'memory_vec_conversation' } : undefined),
    });
    markVecCapable(db);

    new RetrievalStore(db).writeEmbeddings(
      [{ chunkId: 7, vector: new Float32Array([0.1, 0.2, 0.3]), contentHash: 'hash-7' }],
      'bge-base@q8',
    );

    expect(findRun(calls, 'INSERT INTO memory_vec_conversation')).toBeUndefined();
    expect(findRun(calls, 'UPDATE memory_chunks SET embedded_model')).toBeUndefined();
  });
});

describe('RetrievalStore.countChunksNeedingEmbedding', () => {
  it('counts never-embedded chunks and chunks under another tag, by corpus, as index ranges', () => {
    const { db, calls } = makeRecordingDb({
      get: (sql) => (sql.includes('sqlite_master') ? { name: 'memory_vec_conversation' } : undefined),
      all: (sql) => (sql.includes('COUNT(*)') ? [{ corpus: 'conversation', count: 3 }, { corpus: 'code', count: 40 }] : []),
    });
    markVecCapable(db);

    const waiting = new RetrievalStore(db).countChunksNeedingEmbedding('bge-base@q8');

    expect(Object.fromEntries(waiting)).toEqual({ conversation: 3, code: 40 });
    const countCall = calls.find((call) => call.method === 'all' && call.sql.includes('COUNT(*)'));
    // `!=` is not an index range; `<` and `>` are. It runs on every Settings
    // status poll, so a bare `corpus` group would read every chunk row.
    expect(countCall?.sql).toContain('embedded_model IS NULL OR embedded_model < ? OR embedded_model > ?');
    expect(countCall?.sql).toContain('GROUP BY +corpus');
    expect(countCall?.args).toEqual(['bge-base@q8', 'bge-base@q8']);
  });

  it('counts nothing when the vec table is not ready', () => {
    const { db } = makeRecordingDb({});
    expect(new RetrievalStore(db).countChunksNeedingEmbedding('bge-base@q8').size).toBe(0);
  });
});

describe('RetrievalStore.searchLexical', () => {
  it('maps FTS rows to LexicalHit with 1-based ranks and binds the query + limit', () => {
    const { db, calls } = makeRecordingDb({
      all: () => [
        { id: 5, snip: 'alpha', score: -3.2 },
        { id: 6, snip: 'beta', score: -1.1 },
        { id: 7, snip: 'gamma', score: -0.5 },
      ],
    });

    const hits = new RetrievalStore(db).searchLexical('"foo"*', 32, ['conversation']);

    expect(hits).toEqual([
      { chunkId: 5, rank: 1, bm25: -3.2, snippet: 'alpha' },
      { chunkId: 6, rank: 2, bm25: -1.1, snippet: 'beta' },
      { chunkId: 7, rank: 3, bm25: -0.5, snippet: 'gamma' },
    ]);

    const matchCall = calls.find((call) => call.sql.includes('MATCH'));
    expect(matchCall?.sql).toContain('memory_chunks_fts');
    expect(matchCall?.args).toEqual(['"foo"*', 'conversation', 32]);
  });

  it('returns an empty list when the FTS query matches nothing', () => {
    const { db } = makeRecordingDb({ all: () => [] });
    expect(new RetrievalStore(db).searchLexical('"nope"*', 32, ['conversation'])).toEqual([]);
  });

  it('matches only the corpora it is given, since the FTS table covers every corpus', () => {
    const { db, calls } = makeRecordingDb({ all: () => [] });

    new RetrievalStore(db).searchLexical('"foo"*', 32, ['conversation', 'task']);

    const matchCall = calls.find((call) => call.sql.includes('MATCH'));
    expect(matchCall?.sql).toContain('memory_chunks.corpus IN (?,?)');
    expect(matchCall?.args).toEqual(['"foo"*', 'conversation', 'task', 32]);
  });

  it('asks nothing of the database for no corpora', () => {
    const { db, calls } = makeRecordingDb({ all: () => [] });
    expect(new RetrievalStore(db).searchLexical('"foo"*', 32, [])).toEqual([]);
    expect(calls).toHaveLength(0);
  });

  it('runs the full-text match first, whatever the planner would choose', () => {
    // Planned the other way (corpus index first, the match once per chunk row)
    // the same search took 2 to 29 s on 93k chunks under an older SQLite.
    const { db, calls } = makeRecordingDb({ all: () => [] });

    new RetrievalStore(db).searchLexical('"foo"*', 32, ['conversation']);

    const matchCall = calls.find((call) => call.sql.includes('MATCH'));
    expect(matchCall?.sql).toMatch(/FROM memory_chunks_fts\s+CROSS JOIN memory_chunks/);
  });

  it('joins against memory_chunks and binds taskId when scoping to one task', () => {
    const { db, calls } = makeRecordingDb({
      all: () => [{ id: 9, snip: 'delta', score: -2.0 }],
    });

    const hits = new RetrievalStore(db).searchLexical('"foo"*', 32, ['conversation'], 'task-42');

    expect(hits).toEqual([{ chunkId: 9, rank: 1, bm25: -2.0, snippet: 'delta' }]);
    const matchCall = calls.find((call) => call.sql.includes('MATCH'));
    expect(matchCall?.sql).toContain('JOIN memory_chunks ON memory_chunks.id = memory_chunks_fts.rowid');
    expect(matchCall?.sql).toContain('memory_chunks.task_id = ?');
    expect(matchCall?.args).toEqual(['"foo"*', 'conversation', 'task-42', 32]);
  });
});

describe('RetrievalStore.searchLexicalPerCorpus', () => {
  it('scans once for every corpus named and ranks each within itself, up to its own limit', () => {
    const { db, calls } = makeRecordingDb({
      all: () => [
        { id: 1, corpus: 'task', score: -9 },
        { id: 2, corpus: 'commit', score: -8 },
        { id: 3, corpus: 'task', score: -7 },
        { id: 4, corpus: 'task', score: -6 },
        { id: 5, corpus: 'commit', score: -5 },
      ],
    });

    const byCorpus = new RetrievalStore(db).searchLexicalPerCorpus('"relay"', new Map([['task', 2], ['commit', 5]]));

    expect(byCorpus.get('task')).toEqual([{ chunkId: 1, rank: 1 }, { chunkId: 3, rank: 2 }]);
    expect(byCorpus.get('commit')).toEqual([{ chunkId: 2, rank: 1 }, { chunkId: 5, rank: 2 }]);
    const matchCalls = calls.filter((call) => call.sql.includes('MATCH'));
    expect(matchCalls).toHaveLength(1);
    expect(matchCalls[0].sql).toMatch(/FROM memory_chunks_fts\s+CROSS JOIN memory_chunks/);
    expect(matchCalls[0].sql).toContain('memory_chunks.corpus IN (?,?)');
    // No LIMIT (one corpus must not crowd out another) and no snippet (ranks only).
    expect(matchCalls[0].sql).not.toMatch(/LIMIT|snippet/);
    expect(matchCalls[0].args).toEqual(['"relay"', 'task', 'commit']);
  });

  it('asks nothing of the database for no corpora', () => {
    const { db, calls } = makeRecordingDb({ all: () => [] });
    expect(new RetrievalStore(db).searchLexicalPerCorpus('"relay"', new Map()).size).toBe(0);
    expect(calls).toHaveLength(0);
  });
});

describe('RetrievalStore.firstTaskMentioning', () => {
  it('finds the earliest conversation mention at or before a time, full-text match first', () => {
    const { db, calls } = makeRecordingDb({ get: () => ({ taskId: 'task-7', firstMs: 100 }) });

    expect(new RetrievalStore(db).firstTaskMentioning('"feat pty keep the resize"', 5_000)).toBe('task-7');

    const call = calls.find((entry) => entry.sql.includes('MATCH'));
    expect(call?.sql).toMatch(/FROM memory_chunks_fts\s+CROSS JOIN memory_chunks/);
    expect(call?.sql).toContain("memory_chunks.corpus = 'conversation'");
    expect(call?.sql).toMatch(/HAVING firstMs IS NOT NULL AND firstMs <= \?\s+ORDER BY firstMs ASC/);
    expect(call?.args).toEqual(['"feat pty keep the resize"', 5_000]);
  });

  it('is null when no conversation mentions it', () => {
    const { db } = makeRecordingDb({ get: () => undefined });
    expect(new RetrievalStore(db).firstTaskMentioning('"nothing like it"', 5_000)).toBeNull();
  });
});

describe('RetrievalStore corpus reads', () => {
  /** A store whose every vec table exists, recording its SQL. */
  function vecStore(handlers: Parameters<typeof makeRecordingDb>[0] = {}) {
    const recording = makeRecordingDb({
      ...handlers,
      get: (sql, args) => (sql.includes('sqlite_master') ? { name: 'present' } : handlers.get?.(sql, args)),
    });
    markVecCapable(recording.db);
    return { store: new RetrievalStore(recording.db), calls: recording.calls };
  }

  it('merges each corpus table by distance and re-ranks the merged list', () => {
    const { store, calls } = vecStore({
      all: (sql) => {
        if (sql.includes('FROM memory_vec_conversation')) return [{ id: 1, distance: 0.2 }, { id: 2, distance: 0.6 }];
        if (sql.includes('FROM memory_vec_task')) return [{ id: 50, distance: 0.4 }];
        return [];
      },
    });

    const hits = store.searchSemantic(new Float32Array([0.1]), 2, ['conversation', 'task']);

    expect(hits).toEqual([
      { chunkId: 1, rank: 1, distance: 0.2 },
      { chunkId: 50, rank: 2, distance: 0.4 },
    ]);
    // Each table is asked for the whole limit: its own exact top k.
    expect(calls.filter((call) => call.sql.includes('MATCH')).map((call) => call.args[1])).toEqual([2, 2]);
  });

  it('serves never-embedded conversations before task records, and source code last, each as an index seek', () => {
    const conversationRow = { ...storedRow, id: 3 };
    const taskRow = { ...storedRow, id: 90, corpus: 'task' };
    const codeRow = { ...storedRow, id: 400, corpus: 'code' };
    const { store, calls } = vecStore({
      all: (sql, args) => {
        if (!sql.includes('embedded_model IS NULL AND corpus = ?')) return [];
        return args[0] === 'conversation' ? [conversationRow] : args[0] === 'task' ? [taskRow] : args[0] === 'code' ? [codeRow] : [];
      },
    });

    const pending = store.chunksNeedingEmbedding('bge-base@q8', 5);

    expect(pending.map((chunk) => chunk.id)).toEqual([3, 90, 400]);
    const seeks = calls.filter((call) => call.sql.includes('embedded_model IS NULL AND corpus = ?'));
    // Session changes and commits are text only (`EMBEDDED_CORPORA`), so they
    // are never served; code waits behind everything a question already uses.
    expect(seeks.map((call) => call.args)).toEqual([['conversation', 5], ['task', 4], ['code', 3]]);
    // The whole-table `!=` scan is gone.
    expect(calls.some((call) => call.sql.includes('embedded_model != ?'))).toBe(false);
  });

  it('keeps the map signature and coverage fingerprint on conversations alone', () => {
    const { store, calls } = vecStore({ get: () => ({ id: 0, count: 0, maxId: 0 }), all: () => [] });

    store.maxChunkId('conversation');
    store.coverageFingerprint();

    const chunkReads = calls.filter((call) => call.sql.includes('FROM memory_chunks') && !call.sql.includes('sqlite_master'));
    expect(chunkReads.length).toBeGreaterThan(0);
    // Every read that counts chunks or states is scoped: a task edit re-indexes
    // a task record, and must not rebuild the map or its coverage.
    for (const call of chunkReads) {
      expect(call.sql.includes("corpus = 'conversation'") || call.args.includes('conversation')).toBe(true);
    }
    const stateRead = calls.find((call) => call.sql.includes('FROM memory_index_state'));
    expect(stateRead?.sql).toContain("corpus = 'conversation'");
  });

  it('purges only the corpora named, vectors included, a page of ids at a time', async () => {
    // Each corpus holds one page of chunks, then none.
    const pagesServed = new Map<string, number>();
    const { store, calls } = vecStore({
      all: (sql, args) => {
        if (!sql.includes('SELECT id FROM memory_chunks WHERE corpus = ?')) return [];
        const corpus = args[0] as string;
        const served = pagesServed.get(corpus) ?? 0;
        pagesServed.set(corpus, served + 1);
        return served === 0 ? [{ id: corpus === 'conversation' ? 1 : 2 }] : [];
      },
    });

    await store.purgeCorpora(['conversation', 'change'], async () => undefined);

    const chunkDeletes = calls.filter((call) => call.method === 'run' && call.sql.startsWith('DELETE FROM memory_chunks WHERE id IN'));
    expect(chunkDeletes.map((call) => call.args)).toEqual([[1], [2]]);
    expect(findRun(calls, 'DELETE FROM memory_index_state WHERE corpus IN')?.args).toEqual(['conversation', 'change']);
    expect(findRun(calls, 'DELETE FROM memory_vec_conversation')).toBeDefined();
    expect(findRun(calls, 'DELETE FROM memory_vec_change')).toBeDefined();
    expect(findRun(calls, 'DELETE FROM memory_vec_task')).toBeUndefined();
  });

  it('removes a replaced document\'s vectors from its own corpus table only', () => {
    const existing = [{ id: 70, seq: 0, content_hash: 'old', turn_uuid_start: null, turn_uuid_end: null }];
    const { store, calls } = vecStore({
      all: (sql) => (sql.includes('content_hash') ? existing : []),
    });

    store.upsertDocument({ ...ref, corpus: 'task', docId: 'task-1' }, [chunk(0, 'new')]);

    expect(findRun(calls, 'DELETE FROM memory_vec_task WHERE rowid IN')?.args).toEqual([70n]);
    expect(findRun(calls, 'DELETE FROM memory_vec_conversation')).toBeUndefined();
  });
});

describe('RetrievalStore.getChunkIdsForTask', () => {
  it('returns the set of chunk ids for one task, binding taskId', () => {
    const { db, calls } = makeRecordingDb({
      all: () => [{ id: 1 }, { id: 2 }, { id: 3 }],
    });

    const ids = new RetrievalStore(db).getChunkIdsForTask('task-42');

    expect(ids).toEqual(new Set([1, 2, 3]));
    const selectCall = calls.find((call) => call.method === 'all');
    expect(selectCall?.sql).toContain('WHERE task_id = ?');
    expect(selectCall?.args).toEqual(['task-42']);
  });

  it('returns an empty set when the task has no chunks', () => {
    const { db } = makeRecordingDb({ all: () => [] });
    expect(new RetrievalStore(db).getChunkIdsForTask('task-none')).toEqual(new Set());
  });
});

const storedRow = {
  id: 42,
  corpus: 'conversation',
  doc_id: 'doc-1',
  seq: 5,
  session_id: 'session-1',
  task_id: 'task-1',
  agent_session_id: 'agent-1',
  role: 'assistant',
  text: 'hello there',
  content_hash: 'h5',
  token_estimate: 12,
  ts_start: 100,
  ts_end: 200,
  turn_uuid_start: 'u5',
  turn_uuid_end: 'u5',
  embedded_model: null,
};

describe('RetrievalStore.getChunks', () => {
  it('short-circuits to [] for an empty id list without touching the DB', () => {
    const { db, calls } = makeRecordingDb({});
    expect(new RetrievalStore(db).getChunks([])).toEqual([]);
    expect(calls).toHaveLength(0);
  });

  it('builds an IN clause with one placeholder per id and maps snake_case rows', () => {
    const { db, calls } = makeRecordingDb({ all: () => [storedRow] });

    const chunks = new RetrievalStore(db).getChunks([1, 2]);

    const selectCall = calls.find((call) => call.method === 'all');
    expect(selectCall?.sql).toContain('WHERE id IN (?,?)');
    expect(selectCall?.args).toEqual([1, 2]);

    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toEqual({
      id: 42,
      corpus: 'conversation',
      docId: 'doc-1',
      seq: 5,
      sessionId: 'session-1',
      taskId: 'task-1',
      agentSessionId: 'agent-1',
      role: 'assistant',
      text: 'hello there',
      contentHash: 'h5',
      tokenEstimate: 12,
      tsStart: 100,
      tsEnd: 200,
      turnUuidStart: 'u5',
      turnUuidEnd: 'u5',
      embeddedModel: null,
    });
  });
});

describe('RetrievalStore.coverageFingerprint', () => {
  it('counts embedded conversation chunks off the covering index', () => {
    // A bare `corpus = 'conversation'` seeks (corpus) and reads every
    // conversation chunk's row: 264 ms on a 93k-chunk index, on every snapshot
    // read. `+corpus` keeps it on (embedded_model, corpus): 5.4 ms.
    const { db, calls } = makeRecordingDb({ get: () => ({ count: 0, maxId: 0 }), all: () => [] });
    new RetrievalStore(db).coverageFingerprint();
    const embedded = calls.find((call) => call.sql.includes('embedded_model IS NOT NULL'));
    expect(embedded?.sql).toContain("+corpus = 'conversation'");
  });
});

describe('RetrievalStore.corpusTotals', () => {
  it('counts embedded chunks off the covering index, not by reading every row', () => {
    // Grouped by a bare `corpus`, the planner reads every chunk row through the
    // (corpus) index: 277 ms on a 97k-chunk index, on main, on every Index read
    // while task records embed. `+corpus` keeps it on the covering
    // (embedded_model, corpus) index: 21 ms.
    const { db, calls } = makeRecordingDb({
      all: (sql) => (sql.includes('DISTINCT corpus') ? [{ corpus: 'conversation', count: 2 }] : [{ corpus: 'conversation', count: 5 }]),
    });

    const totals = new RetrievalStore(db).corpusTotals();

    const embedded = calls.find((call) => call.sql.includes('embedded_model IS NOT NULL'));
    expect(embedded?.sql).toMatch(/GROUP BY \+corpus/);
    expect(totals).toEqual([{ corpus: 'conversation', documents: 2, chunks: 5, embeddedChunks: 5 }]);
  });
});

describe('a deleted session leaves the index by the sweep, not by trigger (real database)', () => {
  function stateFor(docId: string, sessionId: string) {
    return {
      corpus: 'conversation',
      docId,
      sessionId,
      sourcePath: '/mock/transcript.jsonl',
      sourceMtimeMs: 1,
      sourceSize: 2,
      entryCount: 1,
      chunkCount: 1,
      status: 'ok',
      indexedAt: '2026-09-30T00:00:00.000Z',
    };
  }

  it('keeps a deleted session\'s chunks until the sweep, which finds and deletes them', async () => {
    const database = openTracked();
    runProjectMigrations(database);
    const store = new RetrievalStore(database);
    const count = (sql: string): number => (database.prepare(sql).get() as { count: number }).count;
    database.exec(`INSERT INTO swimlanes (id, name, position, created_at) VALUES ('lane-1', 'To Do', 0, '2026-09-30T00:00:00.000Z')`);
    for (const id of ['task-1', 'task-2']) {
      database.exec(`INSERT INTO tasks (id, display_id, title, description, swimlane_id, position, created_at, updated_at)
        VALUES ('${id}', ${id === 'task-1' ? 1 : 2}, '${id}', '', 'lane-1', 0, '2026-09-30T00:00:00.000Z', '2026-09-30T00:00:00.000Z')`);
    }
    for (const [sessionId, taskId] of [['session-kept', 'task-1'], ['session-gone', 'task-2']]) {
      database.exec(`INSERT INTO sessions (id, task_id, session_type, command, cwd, status, started_at)
        VALUES ('${sessionId}', '${taskId}', 'claude_agent', 'claude', '/mock', 'exited', '2026-09-30T00:00:00.000Z')`);
    }
    store.upsertDocument({ ...ref, docId: 'agent-kept', sessionId: 'session-kept' }, [chunk(0, 'hashA')]);
    store.upsertDocument({ ...ref, docId: 'agent-gone', sessionId: 'session-gone' }, [chunk(0, 'hashB')]);
    store.upsertDocument({ ...ref, corpus: 'change', docId: 'session-gone', sessionId: 'session-gone' }, [chunk(0, 'hashC')]);
    store.setIndexState(stateFor('agent-kept', 'session-kept'));
    store.setIndexState(stateFor('agent-gone', 'session-gone'));
    store.setIndexState({ ...stateFor('session-gone', 'session-gone'), corpus: 'change' });

    database.exec(`DELETE FROM sessions WHERE id = 'session-gone'`);

    // No trigger: the delete touched no index row.
    expect(count('SELECT COUNT(*) AS count FROM memory_chunks')).toBe(3);
    // The conversation and the files it changed, as the old trigger removed.
    expect(store.deletedSessionDocuments(100)).toEqual(expect.arrayContaining([
      { corpus: 'conversation', docId: 'agent-gone' },
      { corpus: 'change', docId: 'session-gone' },
    ]));
    const indexer = new ConversationIndexer({ getDb: () => database });
    await expect(indexer.purgeDeletedSessions('project-1', () => true)).resolves.toBe(2);
    expect(count(`SELECT COUNT(*) AS count FROM memory_chunks WHERE session_id = 'session-gone'`)).toBe(0);
    expect(count(`SELECT COUNT(*) AS count FROM memory_index_state WHERE session_id = 'session-gone'`)).toBe(0);
    expect(count(`SELECT COUNT(*) AS count FROM memory_chunks WHERE doc_id = 'agent-kept'`)).toBe(1);
    expect(store.deletedSessionDocuments(100)).toEqual([]);
  });

  it('finds a deleted session\'s chunks with no index state only when asked to read the chunks, and spares a document a live session owns', async () => {
    const database = openTracked();
    runProjectMigrations(database);
    const store = new RetrievalStore(database);
    const count = (sql: string): number => (database.prepare(sql).get() as { count: number }).count;
    database.exec(`INSERT INTO swimlanes (id, name, position, created_at) VALUES ('lane-1', 'To Do', 0, '2026-09-30T00:00:00.000Z')`);
    database.exec(`INSERT INTO tasks (id, display_id, title, description, swimlane_id, position, created_at, updated_at)
      VALUES ('task-1', 1, 'task-1', '', 'lane-1', 0, '2026-09-30T00:00:00.000Z', '2026-09-30T00:00:00.000Z')`);
    database.exec(`INSERT INTO sessions (id, task_id, session_type, command, cwd, status, started_at)
      VALUES ('session-live', 'task-1', 'claude_agent', 'claude', '/mock', 'exited', '2026-09-30T00:00:00.000Z')`);
    // A writer died after its chunks and before its state row.
    store.upsertDocument({ ...ref, docId: 'agent-stateless', sessionId: 'session-gone' }, [chunk(0, 'hashA')]);
    // A live conversation with one chunk still naming its old, deleted owner.
    store.upsertDocument({ ...ref, docId: 'agent-live', sessionId: 'session-live' }, [chunk(0, 'hashB')]);
    store.setIndexState(stateFor('agent-live', 'session-live'));
    database.exec(`UPDATE memory_chunks SET session_id = 'session-old' WHERE doc_id = 'agent-live'`);

    const indexer = new ConversationIndexer({ getDb: () => database });
    await expect(indexer.purgeDeletedSessions('project-1', () => true)).resolves.toBe(0);
    await expect(indexer.purgeDeletedSessions('project-1', () => true, { fromChunks: true })).resolves.toBe(1);
    expect(count(`SELECT COUNT(*) AS count FROM memory_chunks WHERE doc_id = 'agent-stateless'`)).toBe(0);
    expect(count(`SELECT COUNT(*) AS count FROM memory_chunks WHERE doc_id = 'agent-live'`)).toBe(1);
  });
});

describe('a vec table this connection cannot open (real database)', () => {
  // The vec table exists (created by a connection that loaded sqlite-vec), and
  // the connection under test never loaded it. A plain table stands in for it:
  // without sqlite-vec a real vec0 table cannot be opened anyway.
  function projectWithVecTable(filename?: string) {
    const database = openTracked({ filename });
    runProjectMigrations(database);
    database.exec('CREATE TABLE memory_vec_conversation (rowid INTEGER PRIMARY KEY, embedding BLOB)');
    const count = (sql: string): number => (database.prepare(sql).get() as { count: number }).count;
    // Every chunk of `docId` embedded, with a vector at its id.
    const embed = (docId: string): void => {
      database.prepare(`UPDATE memory_chunks SET embedded_model = 'model-a' WHERE doc_id = ?`).run(docId);
      database.prepare(`INSERT INTO memory_vec_conversation (rowid, embedding) SELECT id, x'00' FROM memory_chunks WHERE doc_id = ?`).run(docId);
    };
    const vectorIds = (): number[] => (database.prepare('SELECT rowid AS id FROM memory_vec_conversation ORDER BY rowid').all() as Array<{ id: number }>)
      .map((row) => Number(row.id));
    return { database, count, embed, vectorIds };
  }

  it('deletes chunks without their vectors, so a re-index, a delete and a purge all go through lexical-only', async () => {
    const { database, count, embed } = projectWithVecTable();
    const store = new RetrievalStore(database);
    store.upsertDocument(ref, [chunk(0, 'hashA'), chunk(1, 'hashB')]);
    embed(ref.docId);

    // A growing conversation whose tail diverged: its old tail is deleted.
    store.upsertDocument(ref, [chunk(0, 'hashA'), chunk(1, 'hashC'), chunk(2, 'hashD')]);
    expect(count('SELECT COUNT(*) AS count FROM memory_chunks')).toBe(3);

    store.deleteDocument(ref.corpus, ref.docId);
    expect(count('SELECT COUNT(*) AS count FROM memory_chunks')).toBe(0);

    store.upsertDocument({ ...ref, docId: 'doc-2' }, [chunk(0, 'hashE')]);
    await store.purgeCorpora(['conversation'], async () => undefined);
    expect(count('SELECT COUNT(*) AS count FROM memory_chunks')).toBe(0);
    // The vectors stay for the reconcile; nothing here could reach them.
    expect(count('SELECT COUNT(*) AS count FROM memory_vec_conversation')).toBe(2);
  });

  it('leaves the reconcile, once sqlite-vec loads, to remove a vector whose chunk is gone or whose id a new chunk took', async () => {
    const file = temporaryDatabaseFile();
    const { database, embed, vectorIds } = projectWithVecTable(file);
    const store = new RetrievalStore(database);
    store.upsertDocument({ ...ref, docId: 'doc-kept' }, [chunk(0, 'hashA')]);
    store.upsertDocument({ ...ref, docId: 'doc-gone' }, [chunk(0, 'hashB'), chunk(1, 'hashC')]);
    embed('doc-kept');
    embed('doc-gone');
    expect(vectorIds()).toEqual([1, 2, 3]);

    // Deleted while sqlite-vec was missing, so its two vectors stayed.
    database.exec(`DELETE FROM memory_chunks WHERE doc_id = 'doc-gone'`);
    // SQLite hands the freed top id to the next chunk, which is not embedded.
    const { insertedIds } = store.upsertDocument({ ...ref, docId: 'doc-new' }, [chunk(0, 'hashD')]);
    expect(insertedIds).toEqual([2]);

    // The next worker loads sqlite-vec on its own connection to the same file:
    // only that connection is vec-capable (a plain table stands in for the vec
    // table either way). The first one, unmarked, could never have reconciled.
    const nextWorker = openTracked({ filename: file });
    markVecCapable(nextWorker);
    await new RetrievalStore(nextWorker).reconcileVecOrphans(async () => undefined);

    // Id 3 has no chunk; id 2's vector was doc-gone's, not doc-new's.
    expect(vectorIds()).toEqual([1]);
  });

  it('reconciles a transaction at a time with a turn between, and keeps a vector the writeback gave a reused id meanwhile', async () => {
    const { database, vectorIds } = projectWithVecTable();
    // A full transaction of orphans with no chunk, then a stale vector at an
    // id a new chunk took, which is not embedded yet.
    const insertVector = database.prepare(`INSERT INTO memory_vec_conversation (rowid, embedding) VALUES (?, x'00')`);
    for (let id = 1; id <= 64; id += 1) insertVector.run(id);
    new RetrievalStore(database).upsertDocument({ ...ref, docId: 'doc-new' }, [chunk(0, 'hashA')]);
    database.exec(`UPDATE memory_chunks SET id = 100 WHERE doc_id = 'doc-new'`);
    insertVector.run(100);

    markVecCapable(database);
    let turns = 0;
    await new RetrievalStore(database).reconcileVecOrphans(async () => {
      turns += 1;
      // The embedding writeback lands during the first turn: chunk 100's
      // vector is its own now.
      if (turns === 1) database.exec(`UPDATE memory_chunks SET embedded_model = 'model-a' WHERE id = 100`);
    });

    expect(turns).toBe(2);
    expect(vectorIds()).toEqual([100]);
  });
});

describe('reconcileVecOrphans against a real vec0 table', () => {
  // The cases above stand a plain table in for the vec table, so they cannot see
  // what only vec0 does: its rowids are read back and must be bound as BigInt, and
  // a DELETE on it goes through the extension rather than a b-tree. This one runs
  // the same reconcile over the real extension and a real vec0 table.
  const DIMENSIONS = 4;
  const vectorFor = (seed: number): Float32Array => new Float32Array([seed, seed + 0.5, -seed, 1]);

  it('removes a vector with no chunk, one whose chunk is gone and one at an id a new chunk took, and keeps the one the embedded chunk owns', async () => {
    const database = openTracked({ vec: true });
    markVecCapable(database);
    runProjectMigrations(database);
    const store = new RetrievalStore(database);
    store.ensureVecTable(DIMENSIONS);
    const vectorIds = (): number[] => (database.prepare('SELECT rowid AS id FROM memory_vec_conversation ORDER BY rowid').all() as Array<{ id: number | bigint }>)
      .map((row) => Number(row.id));

    const keptIds = store.upsertDocument({ ...ref, docId: 'doc-kept' }, [chunk(0, 'hashA')]).insertedIds;
    const goneIds = store.upsertDocument({ ...ref, docId: 'doc-gone' }, [chunk(0, 'hashB'), chunk(1, 'hashC')]).insertedIds;
    store.writeEmbeddings([
      { chunkId: keptIds[0], vector: vectorFor(1), contentHash: 'hashA' },
      { chunkId: goneIds[0], vector: vectorFor(2), contentHash: 'hashB' },
      { chunkId: goneIds[1], vector: vectorFor(3), contentHash: 'hashC' },
    ], 'model@4');

    // Deleted while sqlite-vec was missing: the chunks go, their two vectors stay.
    database.exec(`DELETE FROM memory_chunks WHERE doc_id = 'doc-gone'`);
    // SQLite hands the freed top id to the next chunk, which has no vector yet, so
    // the vector sitting at that id is the deleted chunk's, not this one's.
    const reusedIds = store.upsertDocument({ ...ref, docId: 'doc-new' }, [chunk(0, 'hashD')]).insertedIds;
    expect(reusedIds).toEqual([goneIds[0]]);
    // A vector with no chunk at all. vec0 takes its rowid as a BigInt only.
    const orphanId = 900;
    database.prepare('INSERT INTO memory_vec_conversation (rowid, embedding) VALUES (?, ?)')
      .run(BigInt(orphanId), Buffer.from(vectorFor(9).buffer));
    expect(vectorIds()).toEqual([keptIds[0], goneIds[0], goneIds[1], orphanId]);

    await new RetrievalStore(database).reconcileVecOrphans(async () => undefined);

    // Exactly the embedded chunk's own vector survives: the orphan, the deleted
    // chunk's vector and the reused id's stale vector are all gone. Red-green by
    // the query: without `embedded_model IS NOT NULL` the reused id's vector
    // would stay, and without the `NOT IN` over the chunk ids the other two would.
    expect(vectorIds()).toEqual([keptIds[0]]);
    // And the survivor is still its own vector, readable through the extension.
    expect(new RetrievalStore(database).searchSemantic(vectorFor(1), 1, ['conversation'])[0]?.chunkId).toBe(keptIds[0]);
    // The new chunk is untouched: still waiting for its own embedding.
    expect(database.prepare('SELECT embedded_model AS model FROM memory_chunks WHERE id = ?').get(reusedIds[0])).toEqual({ model: null });
  });
});

describe('RetrievalStore.purgeCorpora (real database)', () => {
  function project() {
    const database = openTracked();
    runProjectMigrations(database);
    const store = new RetrievalStore(database);
    const count = (table: string): number => (database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number }).count;
    return { store, count };
  }

  it('clears the sums of the purged corpora only', async () => {
    const { store, count } = project();
    store.upsertDocument(ref, [chunk(0, 'hashA')]);
    store.upsertDocument({ ...ref, corpus: 'task', docId: 'task-1' }, [chunk(0, 'hashB')]);
    store.writeDocSums('conversation', [sumsWrite({ docId: ref.docId, chunkCount: 1, embeddedCount: 0 })]);
    store.writeDocSums('task', [sumsWrite({ docId: 'task-1', chunkCount: 1, embeddedCount: 0 })]);

    await store.purgeCorpora(['conversation'], async () => undefined);

    expect(count('memory_doc_sums')).toBe(1);
    expect(store.docSumPrefix('task', 'task-1')).not.toBeNull();
  });

  // A purge shares the worker's write budget: a turn after each transaction,
  // so main's own writes get the lock between them. Back to back, a large
  // index's purge left main a free moment between two transactions and no more.
  //
  // Red-green: drop the `await awaitTurn()` in purgeCorpora's page loop and the
  // first test takes no turn for the chunk pages (only the sums clear's one).
  it('takes a write turn after each page a purge deletes', async () => {
    const { store, count } = project();
    const chunkCount = DELETES_PER_TRANSACTION * 3 + 8;
    store.upsertDocument(ref, Array.from({ length: chunkCount }, (_unused, index) => chunk(index, `hash${index}`)));
    let turns = 0;

    const finished = await store.purgeCorpora(['conversation'], async () => { turns += 1; });

    expect(finished).toBe(true);
    expect(count('memory_chunks')).toBe(0);
    // Four pages of chunks, each followed by a turn.
    expect(turns).toBeGreaterThanOrEqual(Math.ceil(chunkCount / DELETES_PER_TRANSACTION));
  });

  // A purge stopped part way says so, so the caller keeps its own marker (the
  // chunker version) and the next pass purges the rest.
  it('stops a purge where shouldContinue says, and reports it unfinished', async () => {
    const { store, count } = project();
    const chunkCount = DELETES_PER_TRANSACTION * 3;
    store.upsertDocument(ref, Array.from({ length: chunkCount }, (_unused, index) => chunk(index, `hash${index}`)));
    let turns = 0;

    const finished = await store.purgeCorpora(['conversation'], async () => { turns += 1; }, () => turns < 1);

    expect(finished).toBe(false);
    expect(count('memory_chunks')).toBe(chunkCount - DELETES_PER_TRANSACTION);
  });
});

/** A sums write for a document with nothing folded, the fields a test cares
 *  about given. */
function sumsWrite(fields: Partial<DocSumWrite> & { docId: string; chunkCount: number; embeddedCount: number }): DocSumWrite {
  return {
    expectedVersion: null,
    modelTag: 'bge-base@q8-cls',
    dimensions: 2,
    indexedAt: null,
    textBytes: 0,
    foldedCount: 0,
    fullSum: null,
    prefixThroughSeq: -1,
    prefixCount: 0,
    prefixTextBytes: 0,
    prefixSum: null,
    ...fields,
  };
}

describe('RetrievalStore document sums (real database)', () => {
  const INDEXED_AT = '2026-09-30T00:00:00.000Z';

  /** A project with doc-1 of five chunks, all embedded, and its sums stored
   *  with a prefix through seq 2. */
  function project() {
    const database = openTracked();
    runProjectMigrations(database);
    const store = new RetrievalStore(database);
    store.upsertDocument(ref, [0, 1, 2, 3, 4].map((seq) => chunk(seq, `hash-${seq}`)));
    store.setIndexState({
      corpus: 'conversation', docId: ref.docId, sessionId: 'session-1', sourcePath: null, sourceMtimeMs: null,
      sourceSize: null, entryCount: 5, chunkCount: 5, status: 'ok', indexedAt: INDEXED_AT,
    });
    database.prepare("UPDATE memory_chunks SET embedded_model = 'model-a'").run();
    const written = store.writeDocSums('conversation', [sumsWrite({
      docId: ref.docId, chunkCount: 5, embeddedCount: 5, indexedAt: INDEXED_AT, foldedCount: 5,
      fullSum: new Float64Array([5, 1]), prefixThroughSeq: 2, prefixCount: 3, prefixTextBytes: 18,
      prefixSum: new Float64Array([3, 0.5]),
    })]);
    expect(written).toBe(1);
    const prefix = () => store.docSumPrefix('conversation', ref.docId);
    const fullSum = () => store.docSumsPage('conversation', '', 10)[0].fullSum;
    const setModel = (seq: number, modelTag: string | null) =>
      database.prepare('UPDATE memory_chunks SET embedded_model = ? WHERE seq = ?').run(modelTag, seq);
    const deleteSeq = (seq: number) => database.prepare('DELETE FROM memory_chunks WHERE seq = ?').run(seq);
    return { database, store, prefix, fullSum, setModel, deleteSeq };
  }

  it('stores a new row at version 0 and reads it back', () => {
    const { store, prefix } = project();
    expect(prefix()).toEqual({
      version: 0, modelTag: 'bge-base@q8-cls', dimensions: 2, prefixThroughSeq: 2, prefixCount: 3,
      prefixTextBytes: 18, prefixSum: new Float64Array([3, 0.5]),
    });
    const [row] = store.docSumsPage('conversation', '', 10);
    expect(row).toMatchObject({ docId: ref.docId, version: 0, chunkCount: 5, embeddedCount: 5, foldedCount: 5, prefixThroughSeq: 2 });
    expect(row.fullSum).toEqual(new Float64Array([5, 1]));
  });

  it('clears the full sum when any chunk is deleted, and empties the prefix only for a chunk in it', () => {
    const { prefix, fullSum, deleteSeq } = project();
    deleteSeq(3);
    expect(fullSum()).toBeNull();
    expect(prefix()).toMatchObject({ version: 1, prefixThroughSeq: 2, prefixCount: 3, prefixSum: new Float64Array([3, 0.5]) });
    // Nothing left to clear: a later delete after the prefix rewrites nothing.
    deleteSeq(4);
    expect(prefix()).toMatchObject({ version: 1 });
    deleteSeq(2);
    expect(prefix()).toMatchObject({ version: 2, prefixThroughSeq: -1, prefixCount: 0, prefixTextBytes: 0, prefixSum: null });
  });

  it('clears the full sum when a vector is lost or replaced, and the prefix only for a chunk in it', () => {
    const lost = project();
    lost.setModel(1, null);
    expect(lost.fullSum()).toBeNull();
    expect(lost.prefix()).toMatchObject({ version: 1, prefixThroughSeq: -1 });

    const switched = project();
    switched.setModel(0, 'model-b');
    expect(switched.prefix()).toMatchObject({ version: 1, prefixThroughSeq: -1 });

    // A vector replaced after the prefix moves no count and no index time, so
    // the cleared full sum is the only thing that tells the next pass.
    const after = project();
    after.setModel(4, 'model-b');
    expect(after.fullSum()).toBeNull();
    expect(after.prefix()).toMatchObject({ version: 1, prefixThroughSeq: 2 });
  });

  it('touches nothing when a chunk with no vector gains one', () => {
    // The drain's ordinary write: the counts move instead.
    const { database, fullSum, prefix, setModel } = project();
    setModel(4, null);
    database.prepare('UPDATE memory_doc_sums SET full_sum = ?').run(Buffer.from(new Float64Array([5, 1]).buffer));
    const version = prefix()!.version;
    setModel(4, 'model-a');
    expect(prefix()!.version).toBe(version);
    expect(fullSum()).toEqual(new Float64Array([5, 1]));
  });

  it('writes only when the row, the counts and the index time are still what the pass read', () => {
    const { database, store, prefix } = project();
    const update = (fields: Partial<DocSumWrite>) => store.writeDocSums('conversation', [sumsWrite({
      docId: ref.docId, chunkCount: 5, embeddedCount: 5, indexedAt: INDEXED_AT, expectedVersion: 0, ...fields,
    })]);

    // Another pass wrote first, or a trigger emptied the prefix.
    expect(update({ expectedVersion: null })).toBe(0);
    expect(update({ expectedVersion: 7 })).toBe(0);
    // The chunks moved since they were read.
    expect(update({ chunkCount: 4 })).toBe(0);
    expect(update({ embeddedCount: 4 })).toBe(0);
    // The document was indexed again since.
    expect(update({ indexedAt: '2026-09-29T00:00:00.000Z' })).toBe(0);
    expect(prefix()).toMatchObject({ version: 0, prefixThroughSeq: 2 });

    expect(update({ prefixThroughSeq: 3, prefixCount: 4 })).toBe(1);
    expect(prefix()).toMatchObject({ version: 1, prefixThroughSeq: 3, prefixCount: 4 });

    // Rebuild index clears the index times before it re-indexes: nothing moved.
    database.prepare('DELETE FROM memory_index_state').run();
    expect(update({ expectedVersion: 1, indexedAt: null })).toBe(1);
  });

  it('writes a new row only while there is still none', () => {
    const { store } = project();
    store.upsertDocument({ ...ref, docId: 'doc-2' }, [chunk(0, 'hash-a')]);
    const insert = () => store.writeDocSums('conversation', [sumsWrite({ docId: 'doc-2', chunkCount: 1, embeddedCount: 0 })]);
    expect(insert()).toBe(1);
    expect(insert()).toBe(0);
  });

  it('reads a document\'s chunks after a seq in pages, with their size in bytes', () => {
    const { database, store } = project();
    database.prepare("UPDATE memory_chunks SET text = 'café', embedded_model = NULL WHERE seq = 4").run();
    expect(store.chunkStatesAfter('conversation', ref.docId, 1, 2).map((state) => state.seq)).toEqual([2, 3]);
    const [last] = store.chunkStatesAfter('conversation', ref.docId, 3, 10);
    expect(last).toMatchObject({ seq: 4, embedded: false, textBytes: 5 });
  });

  it('deletes the sums of documents gone from the index', async () => {
    const { store } = project();
    await store.deleteDocSums('conversation', [ref.docId]);
    expect(store.docSumPrefix('conversation', ref.docId)).toBeNull();
  });

  // A map pass after a bulk delete leaves one stored row per document gone, and
  // the deletes are a few rows a transaction with a turn of the worker's write
  // budget between, instead of the lock taken back to back (the pass's
  // `awaitWriteTurn`). Four ids to a transaction, so nine take three.
  describe('deleting many sums', () => {
    const goneIds = Array.from({ length: 9 }, (_, index) => `gone-${index + 1}`);

    /** The doc-1 fixture plus nine more stored sums, for documents the index no
     *  longer holds. Read straight off the table, so "removed" cannot pass on a
     *  row that merely reads as empty. */
    function projectWithGoneSums() {
      const fixture = project();
      const written = fixture.store.writeDocSums('conversation', goneIds.map((docId) => sumsWrite({ docId, chunkCount: 0, embeddedCount: 0 })));
      expect(written).toBe(goneIds.length);
      const goneRows = (): string[] => (fixture.database
        .prepare("SELECT doc_id AS docId FROM memory_doc_sums WHERE corpus = 'conversation' AND doc_id LIKE 'gone-%' ORDER BY doc_id")
        .all() as Array<{ docId: string }>).map((row) => row.docId);
      expect(goneRows()).toEqual(goneIds);
      return { ...fixture, goneRows };
    }

    // Red-green: the delete before this change ran every batch back to back and
    // took no turn, so `turns` is 0 (the argument was not in its signature). A
    // turn taken before the first batch, or after the last, makes it 3.
    it('takes a turn between the batches and removes every sum, and nothing else', async () => {
      const { store, goneRows } = projectWithGoneSums();
      let turns = 0;

      await store.deleteDocSums('conversation', goneIds, async () => { turns += 1; });

      // Three batches (4, 4 and 1), so two gaps between them.
      expect(turns).toBe(2);
      expect(goneRows()).toEqual([]);
      // A document still in the index keeps its sums.
      expect(store.docSumPrefix('conversation', ref.docId)).not.toBeNull();
    });

    // Red-green: ignore `shouldContinue` and the last five go as well. The stop
    // is raised from the turn between the first and second batch, which is where
    // a pass hears about a project switch or a shutdown.
    it('leaves the rest when it is told to stop after the first batch', async () => {
      const { store, goneRows } = projectWithGoneSums();
      let turns = 0;
      let stopped = false;

      await store.deleteDocSums('conversation', goneIds, async () => { turns += 1; stopped = true; }, () => !stopped);

      expect(turns).toBe(1);
      expect(goneRows()).toEqual(goneIds.slice(4));
    });

    it('deletes nothing and takes no turn when it is told to stop before the first batch', async () => {
      const { store, goneRows } = projectWithGoneSums();
      let turns = 0;

      await store.deleteDocSums('conversation', goneIds, async () => { turns += 1; }, () => false);

      expect(turns).toBe(0);
      expect(goneRows()).toEqual(goneIds);
    });
  });
});
