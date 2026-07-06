/**
 * Corpus-agnostic retrieval types. The retrieval module is split into a core
 * (this file + retrieval-store + fts-query + fusion + memory-search) that
 * knows nothing about agents or sessions, and corpus adapters (today:
 * `conversation/`) that produce chunks and doc identity. A future corpus (repo
 * files, docs) reuses the core unchanged by providing its own chunker and doc
 * refs; the "corpus" is just a string column plus a second caller of the store.
 */

/** What a corpus adapter hands the store for one document. The core owns
 *  nothing about how the text was produced. */
export interface ChunkInput {
  /** Position within the document (0-based, dense). */
  seq: number;
  /** Normalized text; the only indexed field. */
  text: string;
  /** sha1(text). Drives incremental re-index diffing. */
  contentHash: string;
  tokenEstimate: number;
  /** Adapter-defined role ('user' | 'assistant' | 'mixed' | ...). */
  role: string;
  /** Epoch ms of the first/last contributing unit, or null. */
  tsStart: number | null;
  tsEnd: number | null;
  /** Adapter-defined anchors (TranscriptEntry uuids for conversations). */
  turnUuidStart: string | null;
  turnUuidEnd: string | null;
}

/**
 * Document identity + display refs. `sessionId`/`taskId` are nullable so future
 * corpora (repo files, docs) reuse the same table; `metaJson` holds
 * corpus-specific extras.
 */
export interface CorpusDocumentRef {
  /** 'conversation' today. */
  corpus: string;
  /** Conversation corpus: the Kangentic session id. */
  docId: string;
  /** Enables the sessions DELETE trigger cleanup. */
  sessionId: string | null;
  taskId: string | null;
  agentSessionId: string | null;
  metaJson: string | null;
}

/** A chunk read back from the store, with its stable rowid identity. */
export interface StoredChunk extends ChunkInput {
  id: number;
  corpus: string;
  docId: string;
  sessionId: string | null;
  taskId: string | null;
  agentSessionId: string | null;
  embeddedModel: string | null;
}

export interface LexicalHit {
  chunkId: number;
  /** 1-based rank within the lexical result list (best = 1). */
  rank: number;
  /** bm25 score (SQLite: lower is better; we surface the raw value). */
  bm25: number;
  snippet: string;
}

export interface SemanticHit {
  chunkId: number;
  /** 1-based rank within the semantic result list (best = 1). */
  rank: number;
  /** L2 distance from the query vector (lower = closer). */
  distance: number;
}

/** Per-document index bookkeeping row. */
export interface IndexStateRow {
  corpus: string;
  docId: string;
  sessionId: string | null;
  sourcePath: string | null;
  sourceMtimeMs: number | null;
  sourceSize: number | null;
  entryCount: number;
  chunkCount: number;
  status: 'ok' | 'unsupported' | 'missing-source' | 'error';
  indexedAt: string;
}

/**
 * The embedder boundary. In production this is the utilityProcess client; in
 * tests it is a deterministic fake. `embed` resolves null when the embedder is
 * unavailable (no model, crashed, disabled, or slower than the caller's
 * budget), so every caller degrades to lexical-only.
 */
export interface Embedder {
  /** `isQuery` selects the retrieval-tuned query instruction for asymmetric
   *  models (bge/gte); passages (default) get no prefix. */
  embed(
    texts: string[],
    opts?: { timeoutMs?: number; isQuery?: boolean },
  ): Promise<Float32Array[] | null>;
  readonly dimensions: number;
  /** e.g. 'bge-small@q8'. Persisted per chunk so a model change re-embeds. */
  readonly modelTag: string;
  /** Cosine that unrelated text pairs cluster at for this model (anisotropy
   *  floor). The search filter rescales raw cosine against it into a
   *  model-independent 0-1 relevance. 0 disables the relevance filter. */
  readonly noiseFloor: number;
}
