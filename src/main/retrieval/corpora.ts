/**
 * The corpora the retrieval store holds, and where each keeps its vectors.
 *
 * Every corpus shares `memory_chunks` and its FTS index, told apart by the
 * `corpus` column. Vectors live in one vec0 table PER corpus rather than one
 * table with a corpus column, for two measured reasons (the real index, 91,963
 * vectors at 1024 dimensions, sqlite-vec 0.1.9):
 *
 * - No migration. Reading a vector back out of the existing table costs 1.14 ms
 *   a row, so copying it into a table with a corpus column would have been about
 *   105 seconds of synchronous reads on main. The conversation table stays
 *   exactly as it was.
 * - Exact per-corpus search. A KNN over a small table of its own (3.0 ms for
 *   2.9k rows) is as fast as a partition key and faster than a metadata filter
 *   (11.8 ms), and it is exact: a task search never competes with ninety
 *   thousand conversation chunks for its top k.
 */

/** Every corpus, in the order the embedding drain serves them. */
export const MEMORY_CORPORA = ['conversation', 'task', 'change'] as const;

export type MemoryCorpus = typeof MEMORY_CORPORA[number];

/** The conversation corpus alone: what the map is drawn from. */
export const CONVERSATION_CORPUS: ReadonlyArray<MemoryCorpus> = ['conversation'];

/**
 * The vec0 table holding one corpus's vectors, rowid = chunk id.
 *
 * Conversations keep the original table name. The others are deliberately NOT
 * `memory_chunks_vec_<corpus>`: vec0 names its own shadow tables
 * `memory_chunks_vec_<suffix>`, and a corpus table in that namespace would read
 * as one of them to anyone scanning `sqlite_master`.
 */
export function vecTableName(corpus: MemoryCorpus): string {
  return corpus === 'conversation' ? 'memory_chunks_vec' : `memory_vec_${corpus}`;
}

export function isMemoryCorpus(value: string): value is MemoryCorpus {
  return (MEMORY_CORPORA as ReadonlyArray<string>).includes(value);
}
