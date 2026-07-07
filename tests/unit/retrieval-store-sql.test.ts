import { describe, it, expect } from 'vitest';
import type Database from 'better-sqlite3';
import { RetrievalStore } from '../../src/main/retrieval/retrieval-store';
import { markVecCapable } from '../../src/main/retrieval/vec-support';
import type { ChunkInput, CorpusDocumentRef } from '../../src/main/retrieval/types';

/**
 * better-sqlite3 cannot load under vitest's system Node, so the store's SQL is
 * exercised via a hand-rolled `prepare()` that records the SQL text and bound
 * params and returns scripted rows. These lock the JS contract: upsertDocument's
 * (seq, contentHash) diff, the 1-based lexical ranks, and the read-path SQL
 * shape / bound bounds. (The real SQL executes at the E2E tier against a live
 * DB.) Mirrors tests/unit/transcript-repository.test.ts.
 */

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
    transaction: (fn: () => unknown) => fn,
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
      { id: 10, seq: 0, content_hash: 'hashA' },
      { id: 11, seq: 1, content_hash: 'hashB' },
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
      { id: 10, seq: 0, content_hash: 'hashA' },
      { id: 11, seq: 1, content_hash: 'hashB' },
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
    expect(ownershipUpdate?.args).toEqual(['session-1', 'task-1', 'conversation', 'doc-1', 2]);
  });

  it('appends a new trailing chunk without deleting the identical prefix', () => {
    const existing = [{ id: 10, seq: 0, content_hash: 'hashA' }];
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
          ? { name: 'memory_chunks_vec' }
          : sql.includes('content_hash')
            ? { content_hash: 'hash-7' }
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
    const deleteCall = findRun(calls, 'DELETE FROM memory_chunks_vec');
    const insertCall = findRun(calls, 'INSERT INTO memory_chunks_vec');
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
          ? { name: 'memory_chunks_vec' }
          : sql.includes('content_hash')
            ? { content_hash: 'hash-NEW' } // the row changed after the fetch
            : undefined,
    });
    markVecCapable(db);

    new RetrievalStore(db).writeEmbeddings(
      [{ chunkId: 7, vector: new Float32Array([0.1, 0.2, 0.3]), contentHash: 'hash-STALE' }],
      'bge-base@q8',
    );

    expect(findRun(calls, 'DELETE FROM memory_chunks_vec')).toBeUndefined();
    expect(findRun(calls, 'INSERT INTO memory_chunks_vec')).toBeUndefined();
    expect(findRun(calls, 'UPDATE memory_chunks SET embedded_model')).toBeUndefined();
  });

  it('skips a chunk that no longer exists (deleted concurrently)', () => {
    const { db, calls } = makeRecordingDb({
      get: (sql) => (sql.includes('sqlite_master') ? { name: 'memory_chunks_vec' } : undefined),
    });
    markVecCapable(db);

    new RetrievalStore(db).writeEmbeddings(
      [{ chunkId: 7, vector: new Float32Array([0.1, 0.2, 0.3]), contentHash: 'hash-7' }],
      'bge-base@q8',
    );

    expect(findRun(calls, 'INSERT INTO memory_chunks_vec')).toBeUndefined();
    expect(findRun(calls, 'UPDATE memory_chunks SET embedded_model')).toBeUndefined();
  });
});

describe('RetrievalStore.countChunksNeedingEmbedding', () => {
  it('returns the COUNT(*) for the same WHERE clause as chunksNeedingEmbedding', () => {
    const { db, calls } = makeRecordingDb({
      get: (sql) =>
        sql.includes('sqlite_master')
          ? { name: 'memory_chunks_vec' }
          : sql.includes('COUNT(*)')
            ? { count: 3 }
            : undefined,
    });
    markVecCapable(db);

    const count = new RetrievalStore(db).countChunksNeedingEmbedding('bge-base@q8');

    expect(count).toBe(3);
    const countCall = calls.find((call) => call.method === 'get' && call.sql.includes('COUNT(*)'));
    expect(countCall?.sql).toContain('embedded_model IS NULL OR embedded_model != ?');
    expect(countCall?.args).toEqual(['bge-base@q8']);
  });

  it('returns 0 when the vec table is not ready', () => {
    const { db } = makeRecordingDb({});
    expect(new RetrievalStore(db).countChunksNeedingEmbedding('bge-base@q8')).toBe(0);
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

    const hits = new RetrievalStore(db).searchLexical('"foo"*', 32);

    expect(hits).toEqual([
      { chunkId: 5, rank: 1, bm25: -3.2, snippet: 'alpha' },
      { chunkId: 6, rank: 2, bm25: -1.1, snippet: 'beta' },
      { chunkId: 7, rank: 3, bm25: -0.5, snippet: 'gamma' },
    ]);

    const matchCall = calls.find((call) => call.sql.includes('MATCH'));
    expect(matchCall?.sql).toContain('memory_chunks_fts');
    expect(matchCall?.args).toEqual(['"foo"*', 32]);
  });

  it('returns an empty list when the FTS query matches nothing', () => {
    const { db } = makeRecordingDb({ all: () => [] });
    expect(new RetrievalStore(db).searchLexical('"nope"*', 32)).toEqual([]);
  });

  it('joins against memory_chunks and binds taskId when scoping to one task', () => {
    const { db, calls } = makeRecordingDb({
      all: () => [{ id: 9, snip: 'delta', score: -2.0 }],
    });

    const hits = new RetrievalStore(db).searchLexical('"foo"*', 32, 'task-42');

    expect(hits).toEqual([{ chunkId: 9, rank: 1, bm25: -2.0, snippet: 'delta' }]);
    const matchCall = calls.find((call) => call.sql.includes('MATCH'));
    expect(matchCall?.sql).toContain('JOIN memory_chunks ON memory_chunks.id = memory_chunks_fts.rowid');
    expect(matchCall?.sql).toContain('memory_chunks.task_id = ?');
    expect(matchCall?.args).toEqual(['"foo"*', 'task-42', 32]);
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

describe('RetrievalStore.getNeighbors', () => {
  it('resolves the anchor then binds seq +/- radius as the BETWEEN bounds', () => {
    const anchor = { corpus: 'conversation', doc_id: 'doc-1', seq: 5 };
    const { db, calls } = makeRecordingDb({
      get: (sql) => (sql.includes('SELECT corpus, doc_id, seq') ? anchor : undefined),
      all: (sql) => (sql.includes('BETWEEN') ? [storedRow] : []),
    });

    const neighbors = new RetrievalStore(db).getNeighbors(42, 2);

    const betweenCall = calls.find((call) => call.method === 'all' && call.sql.includes('BETWEEN'));
    // corpus, doc_id, seq-radius (3), seq+radius (7).
    expect(betweenCall?.args).toEqual(['conversation', 'doc-1', 3, 7]);
    expect(neighbors).toHaveLength(1);
    expect(neighbors[0].id).toBe(42);
    expect(neighbors[0].seq).toBe(5);
  });

  it('returns [] when the anchor chunk does not exist', () => {
    const { db } = makeRecordingDb({ get: () => undefined });
    expect(new RetrievalStore(db).getNeighbors(999, 3)).toEqual([]);
  });
});
