/**
 * The corpora the retrieval store holds, and where each keeps its vectors.
 *
 * Every corpus shares `memory_chunks` and its FTS index, told apart by the
 * `corpus` column. Vectors live in one vec0 table PER corpus rather than one
 * table with a corpus column, for two measured reasons (the real index, 91,963
 * vectors at 1024 dimensions, sqlite-vec 0.1.9):
 *
 * - No corpus column to add. Reading a vector back out of a vec0 table costs
 *   about 1 to 4 ms a row, so adding one would have meant copying every
 *   conversation vector. (The conversation table is copied once anyway, to a
 *   smaller vec0 chunk size, by the worker's paced `vec.migrateLayout`.)
 * - Exact per-corpus search. A KNN over a small table of its own (3.0 ms for
 *   2.9k rows) is as fast as a partition key and faster than a metadata filter
 *   (11.8 ms), and it is exact: a task search never competes with ninety
 *   thousand conversation chunks for its top k.
 */

/** Every corpus, in the order the embedding drain serves them. Source code is
 *  last: its first fill is about 12k chunks (half an hour on a GPU), and
 *  conversations and task records must never wait behind it. */
export const MEMORY_CORPORA = ['conversation', 'task', 'change', 'commit', 'code'] as const;

export type MemoryCorpus = typeof MEMORY_CORPORA[number];

/** The conversation corpus alone: what the map is drawn from. */
export const CONVERSATION_CORPUS: ReadonlyArray<MemoryCorpus> = ['conversation'];

/**
 * The corpora that get vectors. Session changes do not: measured free on the
 * real index over seven questions (998 conversations, 1,159 change chunks),
 * ranking by them as well as by task records lowered title-named recall inside
 * the handed set from 69 of 96 to 65, even on a question about which tasks
 * changed a file, because nearly every session changes many files. They stay
 * indexed as text, which is what the task summaries read, and embedding them
 * would buy nothing a search uses.
 *
 * Commits on the default branch do not either. Measured the same way (seven
 * questions, 96 title-named tasks, 1,422 linked commits): searched by keyword
 * beside the task records they lifted recall from 66 to 67 and grew the handed
 * set by 1.9 tasks; embedded as well, the same 67 for 4.1 more tasks and 1,426
 * embeddings. So they are searched by keyword only (`related-work.ts`).
 *
 * Source code is the opposite: searched by meaning only, and kept out of the
 * full-text index. Over 17 code questions whose answer file the project's own
 * rules name (12,186 chunks), meaning put that file first 7 times and in the
 * top five 16 times; keywords, 4 and 12; the two fused, 6 and 15.
 */
export const EMBEDDED_CORPORA: ReadonlyArray<MemoryCorpus> = ['conversation', 'task', 'code'];

export function isEmbeddedCorpus(corpus: MemoryCorpus): boolean {
  return EMBEDDED_CORPORA.includes(corpus);
}

/**
 * The vec0 table holding one corpus's vectors, rowid = chunk id, at chunk
 * size 128.
 *
 * Deliberately NOT `memory_chunks_vec_<corpus>`: vec0 names the shadow tables
 * of the conversation table older releases made (`memory_chunks_vec`)
 * `memory_chunks_vec_<suffix>`, and a corpus table in that namespace would
 * read as one of them to anyone scanning `sqlite_master`. A connection whose
 * conversation vectors are still in that older table reads it until the copy
 * switches over (`vec-layout.ts`); a store asks `vecLayout` for the
 * conversation table rather than this name.
 */
export function vecTableName(corpus: MemoryCorpus): string {
  return `memory_vec_${corpus}`;
}

export function isMemoryCorpus(value: string): value is MemoryCorpus {
  return (MEMORY_CORPORA as ReadonlyArray<string>).includes(value);
}
