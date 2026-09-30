/**
 * Dev-only retrieval worker methods: the index half of the Test Harness's
 * seed buttons. The seeders keep the board half on main (tasks and sessions,
 * written and committed first, so the record sweep's purge of deleted
 * sessions never finds a seeded chunk without its session); what reads or
 * writes the index, vectors included, runs here, where sqlite-vec is loaded.
 *
 * Registered only while `__KANGENTIC_DEV__` is true (`worker/methods.ts`), so
 * esbuild drops this module from a production worker bundle. See
 * `.claude/rules/dev-tooling-build-exclusion.md`.
 */

import Database from 'better-sqlite3';
import { RetrievalStore } from '../../main/retrieval/retrieval-store';
import { loadVecExtensionFrom } from '../../main/retrieval/vec-support';
import { runProjectionPass, writeProjectionCache } from '../../main/retrieval/graph/projection-engine';
import { ConversationUsageStore, type TurnUsageInput } from '../../main/retrieval/conversation/conversation-usage-store';
import type { ChunkInput, CorpusDocumentRef } from '../../main/retrieval/types';
import type { MemoryCorpus } from '../../main/retrieval/corpora';
import type { WorkerContext } from '../../main/retrieval/worker/methods';

/** One seeded document: its chunks, a vector per chunk seq or null to leave
 *  that chunk for the embedding drain, and its index state's fields. */
export interface SeedDocument {
  ref: CorpusDocumentRef;
  chunks: ChunkInput[];
  vectors: Array<Float32Array | null>;
  status: 'ok' | 'missing-source';
  entryCount: number;
}

/** A source conversation to copy, and the preview session and task main made
 *  for it. `pending`: how many of its newest chunks to copy without vectors. */
export interface MirrorDocument {
  docId: string;
  previewSessionId: string;
  previewTaskId: string;
  pending: number;
}

export interface DevIndexMethods {
  /** Write seeded documents with their vectors, the vec tables made at this
   *  width first (again, when a previous seed made them another width). */
  'dev.writeDocuments': {
    params: { projectId: string; dimensions: number; modelTag: string; documents: SeedDocument[] };
    result: { chunks: number; pendingChunks: number };
  };
  /** Copy conversations, chunks and vectors, from a real project's database. */
  'dev.mirrorIndex': {
    params: {
      projectId: string;
      sourceDbPath: string;
      sourceName: string;
      dimensions: number;
      modelTag: string;
      documents: MirrorDocument[];
    };
    result: { chunks: number; pendingChunks: number };
  };
  /** Build a project's map now, at full speed (see `buildKnowledgeGraphNow`). */
  'dev.buildGraphNow': {
    params: { projectId: string };
    result: { nodes: number; edges: number; elapsedMs: number } | null;
  };
  /** Clear whole corpora of one project's index. */
  'dev.purgeCorpora': {
    params: { projectId: string; corpora: MemoryCorpus[] };
    result: void;
  };
  /** Record seeded turns in the token usage ledger. */
  'dev.recordTurns': {
    params: {
      projectId: string;
      sessions: Array<{ sessionId: string; turns: TurnUsageInput[]; indexedAt: string }>;
    };
    result: void;
  };
}

type DevIndexHandlers = {
  [Method in keyof DevIndexMethods]: (
    params: DevIndexMethods[Method]['params'],
    context: WorkerContext,
  ) => DevIndexMethods[Method]['result'] | Promise<DevIndexMethods[Method]['result']>;
};

/** A turn of the worker's event loop between documents: a seed runs for tens
 *  of seconds, and a call that waits behind it past its budget would kill the
 *  worker. */
function yieldToCalls(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

/** The vec tables at a width, made again when they were made at another. */
function vecTablesAt(store: RetrievalStore, dimensions: number): void {
  if (store.getMeta('vec_dims') !== String(dimensions)) store.resetVec(dimensions);
  else store.ensureVecTable(dimensions);
  if (!store.hasVec) throw new Error('sqlite-vec is unavailable in this preview, so vectors cannot be seeded');
  store.setMeta('vec_dims', String(dimensions));
}

/**
 * Build a project's Knowledge Graph projection IMMEDIATELY, at full speed.
 *
 * The shipped pass is duty-cycled: even a first build only takes 45% of wall
 * time, because a projection is the same class of long scan plus vector math
 * that produced felt hardware spikes when embedding ran in lifecycle hooks
 * (see `.claude/rules/central-embedding-engine.md`). On a mirrored 37k-chunk
 * corpus that is roughly a minute of work stretched over two, and a seed click
 * would land on a "Building the map" spinner rather than on the map.
 *
 * A preview is a throwaway instance whose purpose is looking at this surface,
 * so there is nothing for the throttle to protect. `dutyCycle: 1` makes the
 * pacer's sleep exactly zero. It drives the REAL engine through the real store:
 * a seeder that computed its own layout would validate the seeder instead of
 * the code that ships.
 *
 * The embedding width and tag come from what is STORED, as the graph service
 * resolves them: config can disagree with the vec table between a model switch
 * and its re-embed, and a width mismatch silently projects zero nodes. Null
 * when there is no usable index yet.
 */
async function buildGraphNow(projectId: string, context: WorkerContext): Promise<DevIndexMethods['dev.buildGraphNow']['result']> {
  const store = new RetrievalStore(context.getDb(projectId));
  if (!store.hasVec) return null;
  const embedding = store.storedEmbeddingSignature();
  if (!embedding) return null;
  const startedAt = Date.now();
  const result = await runProjectionPass({ store, modelTag: embedding.modelTag, dimensions: embedding.dimensions, dutyCycle: 1 });
  if (!result) return null;
  writeProjectionCache(store, result.projection);
  // Announced as the paced pass announces its end: an open graph would
  // otherwise keep showing the pre-seed state until reopened.
  context.emit('graph-changed', projectId);
  return { nodes: result.projection.nodes.length, edges: result.projection.edges.length, elapsedMs: Date.now() - startedAt };
}

export const devIndexHandlers: DevIndexHandlers = {
  'dev.writeDocuments': async ({ projectId, dimensions, modelTag, documents }, context) => {
    const store = new RetrievalStore(context.getDb(projectId));
    vecTablesAt(store, dimensions);
    const now = new Date().toISOString();
    let chunks = 0;
    let pendingChunks = 0;
    for (const document of documents) {
      await yieldToCalls();
      store.upsertDocument(document.ref, document.chunks);
      const vectorBySeq = new Map(document.chunks.map((chunk, index) => [chunk.seq, document.vectors[index] ?? null]));
      const stored = store.getChunksForDoc(document.ref.corpus, document.ref.docId);
      const writes = stored.flatMap((chunk) => {
        const vector = vectorBySeq.get(chunk.seq);
        return vector ? [{ chunkId: chunk.id, vector, contentHash: chunk.contentHash }] : [];
      });
      store.writeEmbeddings(writes, modelTag);
      chunks += stored.length;
      pendingChunks += stored.length - writes.length;
      store.setIndexState({
        corpus: document.ref.corpus,
        docId: document.ref.docId,
        sessionId: document.ref.sessionId,
        sourcePath: null,
        sourceMtimeMs: null,
        sourceSize: null,
        entryCount: document.entryCount,
        chunkCount: stored.length,
        status: document.status,
        indexedAt: now,
      });
    }
    return { chunks, pendingChunks };
  },

  'dev.mirrorIndex': async ({ projectId, sourceDbPath, sourceName, dimensions, modelTag, documents }, context) => {
    const vecPath = context.vecLoadablePath?.() ?? null;
    if (!vecPath) throw new Error('sqlite-vec was not found, so the real index\'s vectors cannot be read');
    const sourceDb = new Database(sourceDbPath, { readonly: true, fileMustExist: true });
    try {
      loadVecExtensionFrom(sourceDb, vecPath);
      const store = new RetrievalStore(context.getDb(projectId));
      vecTablesAt(store, dimensions);
      const readChunks = sourceDb.prepare(
        `SELECT id, seq, role, text, content_hash AS contentHash, token_estimate AS tokenEstimate,
                ts_start AS tsStart, ts_end AS tsEnd, turn_uuid_start AS turnUuidStart, turn_uuid_end AS turnUuidEnd
         FROM memory_chunks
         WHERE corpus = 'conversation' AND doc_id = ? AND embedded_model IS NOT NULL
         ORDER BY seq ASC`,
      );
      const readVector = sourceDb.prepare('SELECT embedding FROM memory_chunks_vec WHERE rowid = ?');
      const now = new Date().toISOString();
      let chunks = 0;
      let pendingChunks = 0;
      for (const document of documents) {
        await yieldToCalls();
        const sourceChunks = readChunks.all(document.docId) as Array<ChunkInput & { id: number }>;
        if (sourceChunks.length === 0) continue;
        store.upsertDocument(
          {
            corpus: 'conversation',
            docId: document.docId,
            sessionId: document.previewSessionId,
            taskId: document.previewTaskId,
            agentSessionId: document.docId,
            metaJson: JSON.stringify({ devSeed: 'knowledge-graph-real', sourceProject: sourceName }),
          },
          sourceChunks.map(({ id: _sourceId, ...chunk }) => chunk),
        );
        // The newest chunks of the newest documents stay pending for the drain.
        const vectorChunks = sourceChunks.slice(0, sourceChunks.length - document.pending);
        const firstPendingSeq = document.pending > 0
          ? sourceChunks[sourceChunks.length - document.pending].seq
          : Number.POSITIVE_INFINITY;
        // Vectors are matched by CONTENT HASH, not by position: `upsertDocument`
        // assigns fresh rowids here, and a chunk skipped for any reason would
        // shift every later vector onto the wrong chunk.
        const sourceVectorByHash = new Map<string, Buffer>();
        for (const chunk of vectorChunks) {
          const row = readVector.get(chunk.id) as { embedding: Buffer } | undefined;
          if (row) sourceVectorByHash.set(chunk.contentHash, row.embedding);
        }
        const writes: Array<{ chunkId: number; vector: Float32Array; contentHash: string }> = [];
        for (const stored of store.getChunksForDoc('conversation', document.docId)) {
          if (stored.seq >= firstPendingSeq) continue;
          const embedding = sourceVectorByHash.get(stored.contentHash);
          if (!embedding) continue;
          const vector = new Float32Array(embedding.byteLength / 4);
          vector.set(new Float32Array(embedding.buffer, embedding.byteOffset, embedding.byteLength / 4));
          writes.push({ chunkId: stored.id, vector, contentHash: stored.contentHash });
        }
        store.writeEmbeddings(writes, modelTag);
        chunks += sourceChunks.length;
        pendingChunks += sourceChunks.length - writes.length;
        store.setIndexState({
          corpus: 'conversation',
          docId: document.docId,
          sessionId: document.previewSessionId,
          sourcePath: null,
          sourceMtimeMs: null,
          sourceSize: null,
          entryCount: sourceChunks.length,
          chunkCount: sourceChunks.length,
          // The mirrored transcript file does not exist in the preview, which
          // is the real corpus's dominant state and worth exercising.
          status: 'missing-source',
          indexedAt: now,
        });
      }
      return { chunks, pendingChunks };
    } finally {
      sourceDb.close();
    }
  },

  'dev.buildGraphNow': ({ projectId }, context) => buildGraphNow(projectId, context),

  'dev.purgeCorpora': ({ projectId, corpora }, context) => {
    new RetrievalStore(context.getDb(projectId)).purgeCorpora(corpora);
  },

  'dev.recordTurns': async ({ projectId, sessions }, context) => {
    const turnUsage = new ConversationUsageStore(context.getDb(projectId));
    for (const session of sessions) {
      await yieldToCalls();
      turnUsage.recordTurns({ agentSessionId: null, sessionId: session.sessionId, taskId: null }, session.turns, session.indexedAt);
    }
  },
};
