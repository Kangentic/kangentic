import type Database from 'better-sqlite3';

/**
 * Where the conversation vectors live on one connection.
 *
 * Releases before #529 created `memory_chunks_vec` at vec0's default chunk
 * size of 1,024, so the first vector in each new chunk zero-fills 4 MB inside
 * the embedding write's transaction: a median 13 ms lock hold per batch with
 * a 2 MB page cache, against 0.13 ms at 128 (rig on 30k real vectors). vec0
 * sets the chunk size at CREATE and 0.1.9 has no rename, so the retrieval
 * worker copies those vectors into `memory_vec_conversation` at 128
 * (`vec.migrateLayout`) and switches to it in one write. Until then the old
 * table serves every read, and every write and delete goes to both.
 *
 * The layout is per connection, not per `RetrievalStore`: the worker builds
 * several stores on one connection, and a store that missed the copy starting
 * would write a vector to the old table only.
 */

/** The table releases before #529 created at chunk size 1,024. */
export const LEGACY_CONVERSATION_VEC_TABLE = 'memory_chunks_vec';
/** vec0's shadow table holding the old table's vector blocks, 4 MB a row. */
export const LEGACY_CONVERSATION_VEC_BLOCKS = `${LEGACY_CONVERSATION_VEC_TABLE}_vector_chunks00`;
/** The conversation table from #529 on (`vecTableName('conversation')`). */
export const CONVERSATION_VEC_TABLE = 'memory_vec_conversation';
/** `memory_meta` key, present while the copy runs: the last chunk id copied. */
export const CONVERSATION_VEC_COPY_KEY = 'vec_conversation_copy_through';

export interface VecLayout {
  /** The table conversation reads use. */
  conversationTable: string;
  /** The table a running copy fills, which every write and delete also reaches. */
  copyTarget: string | null;
}

const layouts = new WeakMap<object, VecLayout>();

function tableExists(db: Database.Database, name: string): boolean {
  return db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name) !== undefined;
}

/** This connection's layout, read from the schema on first use. */
export function vecLayout(db: Database.Database): VecLayout {
  const known = layouts.get(db);
  if (known) return known;
  let layout: VecLayout = { conversationTable: CONVERSATION_VEC_TABLE, copyTarget: null };
  try {
    const legacy = tableExists(db, LEGACY_CONVERSATION_VEC_TABLE);
    const current = tableExists(db, CONVERSATION_VEC_TABLE);
    const copying = db.prepare('SELECT 1 FROM memory_meta WHERE key = ?').get(CONVERSATION_VEC_COPY_KEY) !== undefined;
    if (legacy && (!current || copying)) {
      layout = { conversationTable: LEGACY_CONVERSATION_VEC_TABLE, copyTarget: current && copying ? CONVERSATION_VEC_TABLE : null };
    }
  } catch {
    // A database without the index tables (a fake in unit tests): the new name.
  }
  layouts.set(db, layout);
  return layout;
}

/** Replace this connection's layout after a switch, a reset or a drop. */
export function setVecLayout(db: Database.Database, layout: VecLayout): void {
  layouts.set(db, layout);
}

/** True once the copy has switched reads over and the old table is still there to free. */
export function legacyConversationVecPending(db: Database.Database): boolean {
  return vecLayout(db).conversationTable !== LEGACY_CONVERSATION_VEC_TABLE && tableExists(db, LEGACY_CONVERSATION_VEC_TABLE);
}
