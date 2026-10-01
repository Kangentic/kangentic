import { describe, it, expect } from 'vitest';
import { runProjectMigrations } from '../../src/main/db/migrations/project-schema';
import { RetrievalStore } from '../../src/main/retrieval/retrieval-store';
import { markVecCapable } from '../../src/main/retrieval/vec-support';
import { vecLayout } from '../../src/main/retrieval/vec-layout';
import { indexHandlers } from '../../src/main/retrieval/worker/index-methods';
import type { WorkerContext } from '../../src/main/retrieval/worker/methods';
import type { ChunkInput, CorpusDocumentRef } from '../../src/main/retrieval/types';
import { adaptDatabase, type NodeDatabase } from './helpers/node-sqlite-database';

/**
 * The conversation vectors older releases stored at vec0 chunk size 1,024 move
 * to a table at 128 in the retrieval worker: copied in batches, every write and
 * delete reaching both tables meanwhile, reads switched in one write, then the
 * old table freed a block at a time. Real schema over node:sqlite with
 * sqlite-vec loaded; skipped where either is unavailable.
 */

type SqliteModule = typeof import('node:sqlite');
let sqlite: SqliteModule | null = null;
let vecPath: string | null = null;
try {
  sqlite = await import('node:sqlite');
  vecPath = (await import('sqlite-vec')).getLoadablePath();
} catch {
  sqlite = null;
}
const describeWithVec = sqlite && vecPath ? describe : describe.skip;

const DIMENSIONS = 4;
const ref: CorpusDocumentRef = { corpus: 'conversation', docId: 'doc-1', sessionId: null, taskId: null, agentSessionId: 'doc-1', metaJson: null };
const chunk = (seq: number): ChunkInput => ({
  seq, text: `text-${seq}`, contentHash: `hash-${seq}`, tokenEstimate: 10, role: 'user',
  tsStart: 1, tsEnd: 2, turnUuidStart: `u${seq}`, turnUuidEnd: `u${seq}`,
});
const vectorFor = (seed: number): Float32Array => new Float32Array([seed, seed + 0.5, -seed, 1]);

function legacyProject(chunkCount: number): { database: NodeDatabase; db: ReturnType<typeof adaptDatabase>; store: RetrievalStore; ids: number[] } {
  const database = new sqlite!.DatabaseSync(':memory:', { allowExtension: true });
  database.loadExtension(vecPath!);
  const db = adaptDatabase(database);
  markVecCapable(db);
  runProjectMigrations(db);
  // The table as releases before #529 made it: vec0's default chunk size.
  database.exec(`CREATE VIRTUAL TABLE memory_chunks_vec USING vec0(embedding float[${DIMENSIONS}])`);
  database.prepare("INSERT INTO memory_meta (key, value) VALUES ('vec_dims', ?)").run(String(DIMENSIONS));
  const store = new RetrievalStore(db);
  const { insertedIds } = store.upsertDocument(ref, Array.from({ length: chunkCount }, (_, index) => chunk(index)));
  store.writeEmbeddings(insertedIds.map((chunkId, index) => ({ chunkId, vector: vectorFor(index), contentHash: `hash-${index}` })), 'model@4');
  return { database, db, store, ids: insertedIds };
}

const vectorsIn = (database: NodeDatabase, table: string): Map<number, number[]> => new Map(
  (database.prepare(`SELECT rowid AS id, embedding FROM ${table}`).all() as Array<{ id: number; embedding: Uint8Array }>)
    .map((row) => [Number(row.id), Array.from(new Float32Array(row.embedding.buffer, row.embedding.byteOffset, DIMENSIONS))]),
);
const tableExists = (database: NodeDatabase, name: string): boolean =>
  database.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name) !== undefined;

describeWithVec('conversation vectors move to chunk size 128', () => {
  it('reads the old table until the switch, keeps writes and deletes made mid-copy, and frees the old table', () => {
    const { database, db, store, ids } = legacyProject(300);
    expect(vecLayout(db).conversationTable).toBe('memory_chunks_vec');
    expect(store.searchSemantic(vectorFor(7), 1, ['conversation'])[0]?.chunkId).toBe(ids[7]);

    expect(store.beginConversationVecCopy()).toBe(true);
    expect(database.prepare("SELECT sql FROM sqlite_master WHERE name = 'memory_vec_conversation'").get()).toMatchObject({ sql: expect.stringContaining('chunk_size=128') });
    expect(store.copyConversationVecBatch(100).covered).toBe(100);
    // Mid-copy: a vector behind the copy changes, one ahead of it changes,
    // and one is deleted. Another store on the connection sees the copy too.
    const other = new RetrievalStore(db);
    other.writeEmbeddings([
      { chunkId: ids[10], vector: vectorFor(1000), contentHash: 'hash-10' },
      { chunkId: ids[250], vector: vectorFor(2500), contentHash: 'hash-250' },
    ], 'model@4');
    other.upsertDocument(ref, Array.from({ length: 299 }, (_, index) => chunk(index)));
    // Reads still use the old table.
    expect(store.searchSemantic(vectorFor(1000), 1, ['conversation'])[0]?.chunkId).toBe(ids[10]);
    while (store.copyConversationVecBatch(100).covered > 0) { /* copy through */ }
    store.finishConversationVecCopy();

    expect(vecLayout(db)).toEqual({ conversationTable: 'memory_vec_conversation', copyTarget: null });
    const copied = vectorsIn(database, 'memory_vec_conversation');
    const original = vectorsIn(database, 'memory_chunks_vec');
    expect(copied).toEqual(original);
    expect(copied.size).toBe(299);
    expect(copied.get(ids[10])).toEqual(Array.from(vectorFor(1000)));
    expect(copied.has(ids[299])).toBe(false);
    expect(store.searchSemantic(vectorFor(2500), 1, ['conversation'])[0]?.chunkId).toBe(ids[250]);

    let steps = 0;
    while (store.freeLegacyConversationVecStep()) steps += 1;
    expect(steps).toBeGreaterThan(0);
    expect(tableExists(database, 'memory_chunks_vec')).toBe(false);
    expect(tableExists(database, 'memory_chunks_vec_rowids')).toBe(false);
    // A new connection reads the new layout from the schema.
    expect(new RetrievalStore(db).searchSemantic(vectorFor(3), 1, ['conversation'])[0]?.chunkId).toBe(ids[3]);
  });

  it('runs as one worker job that resumes where it stopped', async () => {
    const { database, db, ids } = legacyProject(150);
    const context = { getDb: () => db, closeDb: () => undefined, vecLoadError: () => null, emit: () => undefined } as unknown as WorkerContext;
    // A copy cut short: begun and one batch in.
    const first = new RetrievalStore(db);
    first.beginConversationVecCopy();
    first.copyConversationVecBatch(64);

    const result = await indexHandlers['vec.migrateLayout']({ projectId: 'project-1' }, context);
    expect(result).toMatchObject({ copied: 86, switched: true });
    expect(vectorsIn(database, 'memory_vec_conversation').size).toBe(150);
    expect(tableExists(database, 'memory_chunks_vec')).toBe(false);
    expect(database.prepare("SELECT COUNT(*) AS count FROM memory_meta WHERE key = 'vec_conversation_copy_through'").get()).toEqual({ count: 0 });
    expect(new RetrievalStore(db).searchSemantic(vectorFor(42), 1, ['conversation'])[0]?.chunkId).toBe(ids[42]);
    // Done: a second run has nothing to do.
    await expect(indexHandlers['vec.migrateLayout']({ projectId: 'project-1' }, context)).resolves.toEqual({ copied: 0, switched: false, freedBlocks: 0 });
  });

  it('a reset during the copy drops both tables and stops it', () => {
    const { database, db, store } = legacyProject(50);
    store.beginConversationVecCopy();
    store.copyConversationVecBatch(20);
    store.resetVec(DIMENSIONS);
    expect(tableExists(database, 'memory_chunks_vec')).toBe(false);
    expect(vecLayout(db)).toEqual({ conversationTable: 'memory_vec_conversation', copyTarget: null });
    expect(store.copyConversationVecBatch(20).covered).toBe(0);
    expect(vectorsIn(database, 'memory_vec_conversation').size).toBe(0);
  });
});
