import type Database from 'better-sqlite3';
import { hasVecSupport } from '../vec-support';
import { timeSyncWork } from '../../diagnostics/event-loop-lag';
import type { StoredChunk } from '../types';

/**
 * The embedding drain's two database steps, read and write, behind an async
 * interface. On main they are calls to the retrieval worker, which owns every
 * index read and write; the worker and the unit tests run them directly
 * (`localEmbedStoreAccess`). The embedding itself stays in `embed-engine.ts`,
 * the one place that embeds (central-embedding-engine.md).
 */

/** The slice of RetrievalStore the drain's steps use. Structural, so tests
 *  inject a plain fake object. */
export interface EmbedStore {
  getMeta(key: string): string | undefined;
  setMeta(key: string, value: string): void;
  resetVec(dimensions: number, awaitTurn: () => Promise<void>): Promise<void> | void;
  ensureVecTable(dimensions: number): void;
  readonly hasVec: boolean;
  chunksNeedingEmbedding(modelTag: string, limit: number): StoredChunk[];
  writeEmbeddings(rows: EmbeddingRow[], modelTag: string): void;
}

export interface EmbeddingRow {
  chunkId: number;
  vector: Float32Array;
  contentHash: string;
}

/** What the drain embeds with, as the store needs it. */
export interface EmbedModelRef {
  dimensions: number;
  modelTag: string;
}

export interface EmbedStoreAccess {
  /**
   * Up to `limit` of a project's chunks without a vector from this model,
   * after putting its vec tables at the model's width (a different width
   * resets them). Null when the project cannot hold vectors (sqlite-vec did
   * not load), so the drain leaves it.
   */
  nextBatch(projectId: string, model: EmbedModelRef, limit: number): Promise<StoredChunk[] | null>;
  /** Store a batch's vectors. A chunk whose text changed since it was read
   *  keeps no vector (`writeEmbeddings` checks the hash). */
  write(projectId: string, rows: EmbeddingRow[], modelTag: string): Promise<void>;
}

/** The vec tables at the model's width: a new width needs a full reset, the
 *  same width only needs the table to exist. False when there is none. */
async function syncVecTable(store: EmbedStore, model: EmbedModelRef, awaitTurn: () => Promise<void>): Promise<boolean> {
  if (store.getMeta('vec_dims') !== String(model.dimensions)) {
    await store.resetVec(model.dimensions, awaitTurn);
    store.setMeta('vec_dims', String(model.dimensions));
  } else {
    store.ensureVecTable(model.dimensions);
  }
  return store.hasVec;
}

/** The steps run on a connection this process holds: the worker's, or a
 *  test's. One store per connection, since building one looks up its tables.
 *  `awaitTurnFor` paces a width reset's writes (the worker's write budget). */
export function localEmbedStoreAccess(
  getDb: (projectId: string) => Database.Database,
  createStore: (db: Database.Database) => EmbedStore,
  awaitTurnFor: (db: Database.Database) => Promise<void> = async () => undefined,
): EmbedStoreAccess {
  const stores = new WeakMap<Database.Database, EmbedStore>();
  const storeFor = (db: Database.Database): EmbedStore => {
    let store = stores.get(db);
    if (!store) {
      store = createStore(db);
      stores.set(db, store);
    }
    return store;
  };
  return {
    async nextBatch(projectId, model, limit) {
      const db = getDb(projectId);
      if (!hasVecSupport(db)) return null;
      const store = storeFor(db);
      if (!await syncVecTable(store, model, () => awaitTurnFor(db))) return null;
      return store.chunksNeedingEmbedding(model.modelTag, limit);
    },
    async write(projectId, rows, modelTag) {
      const store = storeFor(getDb(projectId));
      // The one write the drain makes, and the one that can hold the write
      // lock against main: the dev lag monitor records it when it runs long.
      timeSyncWork('embed:writeEmbeddings', () => store.writeEmbeddings(rows, modelTag));
    },
  };
}
