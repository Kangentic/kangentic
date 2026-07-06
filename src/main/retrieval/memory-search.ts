import type Database from 'better-sqlite3';
import { getProjectDb } from '../db/database';
import { agentRegistry } from '../agent/agent-registry';
import type { Project } from '../../shared/types';
import { RetrievalStore } from './retrieval-store';
import { escapeFtsMatchQuery } from './fts-query';
import { reciprocalRankFusion } from './fusion';
import type { Embedder, StoredChunk } from './types';

/** Per-list candidate depth before fusion. */
const PER_LIST_LIMIT = 32;
const DEFAULT_K = 20;
/** Semantic (vec0) over-fetch depth when scoping to one task: vec0's KNN has no
 *  per-query WHERE filter, so a task-scoped semantic search asks for far more
 *  candidates than PER_LIST_LIMIT and narrows to the task's chunks afterward. */
const TASK_SCOPED_SEMANTIC_OVERFETCH = 300;

export interface TranscriptSearchHit {
  chunkId: number;
  projectId: string;
  projectName: string;
  sessionId: string;
  taskId: string | null;
  taskTitle: string;
  agentName: string;
  role: string;
  turnUuid: string | null;
  turnTs: number | null;
  snippet: string;
  matchStart: number;
  matchEnd: number;
  score: number;
  matchKind: 'lexical' | 'semantic' | 'hybrid';
  /** How many chunks in this session matched the query. The hit is the single
   *  best-scoring chunk for its session; `matchCount` lets the UI show "N matches"
   *  instead of repeating the same conversation once per chunk. */
  matchCount: number;
}

export interface SearchConversationMemoryInput {
  /** Already-trimmed query. Empty short-circuits to []. */
  query: string;
  projects: Project[];
  /** Total hits across all projects. Defaults to 20. */
  k?: number;
  /** Max ms to wait for a query embedding before falling back to lexical-only
   *  for this query. Ignored when no embedder is available. */
  embedWaitMs?: number;
  /** DB-factory injection for tests. Defaults to getProjectDb. */
  getDb?: (projectId: string) => Database.Database;
  /** Semantic embedder, or null/absent for lexical-only. The embedder carries
   *  the active model's `noiseFloor`, which calibrates the relevance filter. */
  embedder?: Embedder | null;
  /** Restrict results to one task's conversation history (its internal id, not
   *  the display "#N"). Lexical filtering happens in the SQL query itself, so
   *  ranking/limit apply within the task; semantic filtering over-fetches a
   *  wider KNN candidate set (vec0 has no per-query WHERE filter) and narrows
   *  it down afterward. */
  taskId?: string;
}

function agentDisplayName(sessionType: string): string {
  return agentRegistry.getBySessionType(sessionType)?.displayName ?? sessionType;
}

/** Locate the first query token inside a snippet to place the <mark>. Returns
 *  0/0 (no highlight) when nothing matches, e.g. a semantic-only snippet. */
function markRange(snippet: string, query: string): { start: number; end: number } {
  const token = query.trim().split(/\s+/)[0]?.toLowerCase() ?? '';
  if (!token) return { start: 0, end: 0 };
  const start = snippet.toLowerCase().indexOf(token);
  if (start < 0) return { start: 0, end: 0 };
  return { start, end: start + token.length };
}

/** Head of a chunk's text as a fallback snippet for semantic-only hits. */
function headSnippet(text: string, maxChars = 160): string {
  const collapsed = text.replace(/\s+/g, ' ').trim();
  return collapsed.length > maxChars ? `${collapsed.slice(0, maxChars)}…` : collapsed;
}

/**
 * Hybrid lexical + semantic search over the conversation memory index, across
 * one or more project DBs. Embeds the query once (when an embedder is available
 * and answers within embedWaitMs), runs FTS5 + vec KNN per project, fuses with
 * RRF, then merges across projects by score and cuts to k. Every failure path
 * degrades to lexical-only; it never throws for an empty/absent index.
 */
export async function searchConversationMemory(
  input: SearchConversationMemoryInput,
): Promise<TranscriptSearchHit[]> {
  const query = input.query.trim();
  if (!query) return [];

  const getDb = input.getDb ?? getProjectDb;
  const k = input.k ?? DEFAULT_K;
  const matchQuery = escapeFtsMatchQuery(query);
  // The active model's anisotropy floor calibrates the relevance filter (0 = off).
  const semanticFloor = input.embedder?.noiseFloor ?? 0;

  // Embed the query once for all projects (semantic path).
  let queryVector: Float32Array | null = null;
  if (input.embedder) {
    try {
      const vectors = await input.embedder.embed([query], { timeoutMs: input.embedWaitMs, isQuery: true });
      queryVector = vectors && vectors.length > 0 ? vectors[0] : null;
    } catch {
      queryVector = null;
    }
  }

  const allHits: TranscriptSearchHit[] = [];
  for (const project of input.projects) {
    let store: RetrievalStore;
    try {
      store = new RetrievalStore(getDb(project.id));
    } catch {
      continue;
    }

    // Scoping to one task: skip this project entirely when it holds none of
    // the task's chunks, and over-fetch the semantic candidate pool since
    // vec0's KNN cannot be pre-filtered by task_id.
    let taskChunkIds: Set<number> | null = null;
    if (input.taskId) {
      taskChunkIds = store.getChunkIdsForTask(input.taskId);
      if (taskChunkIds.size === 0) continue;
    }

    const lexical = matchQuery ? safeLexical(store, matchQuery, input.taskId) : [];
    let semantic = queryVector
      ? relevantSemantic(store, queryVector, semanticFloor, taskChunkIds ? TASK_SCOPED_SEMANTIC_OVERFETCH : PER_LIST_LIMIT)
      : [];
    if (taskChunkIds) {
      semantic = semantic
        .filter((hit) => taskChunkIds.has(hit.chunkId))
        .map((hit, index) => ({ ...hit, rank: index + 1 }));
    }
    if (lexical.length === 0 && semantic.length === 0) continue;

    const fused = reciprocalRankFusion(lexical, semantic);
    const chunkIds = fused.map((hit) => hit.chunkId);
    const chunks = new Map<number, StoredChunk>();
    for (const chunk of store.getChunks(chunkIds)) chunks.set(chunk.id, chunk);

    const snippetByChunk = new Map<number, string>();
    for (const hit of lexical) snippetByChunk.set(hit.chunkId, hit.snippet);

    // Hydrate task titles + agent names for the matched sessions/tasks.
    const db = getDb(project.id);
    const taskTitles = new Map<string, string>();
    const sessionTypes = new Map<string, string>();
    const titleStmt = db.prepare('SELECT title FROM tasks WHERE id = ?');
    const sessionTypeStmt = db.prepare('SELECT session_type FROM sessions WHERE id = ?');
    for (const chunk of chunks.values()) {
      if (chunk.taskId && !taskTitles.has(chunk.taskId)) {
        const row = titleStmt.get(chunk.taskId) as { title: string } | undefined;
        taskTitles.set(chunk.taskId, row?.title ?? '(unknown task)');
      }
      if (chunk.sessionId && !sessionTypes.has(chunk.sessionId)) {
        const row = sessionTypeStmt.get(chunk.sessionId) as { session_type: string } | undefined;
        sessionTypes.set(chunk.sessionId, row?.session_type ?? '');
      }
    }

    for (const hit of fused) {
      const chunk = chunks.get(hit.chunkId);
      if (!chunk || !chunk.sessionId) continue;
      const lexicalSnippet = snippetByChunk.get(hit.chunkId);
      const snippet = lexicalSnippet ?? headSnippet(chunk.text);
      const range = lexicalSnippet ? markRange(snippet, query) : { start: 0, end: 0 };
      allHits.push({
        chunkId: chunk.id,
        projectId: project.id,
        projectName: project.name,
        sessionId: chunk.sessionId,
        taskId: chunk.taskId,
        taskTitle: chunk.taskId ? taskTitles.get(chunk.taskId) ?? '(unknown task)' : '(unknown task)',
        agentName: agentDisplayName(sessionTypes.get(chunk.sessionId) ?? ''),
        role: chunk.role,
        turnUuid: chunk.turnUuidStart,
        turnTs: chunk.tsStart,
        snippet,
        matchStart: range.start,
        matchEnd: range.end,
        score: hit.score,
        matchKind: hit.matchKind,
        matchCount: 1,
      });
    }
  }

  allHits.sort((a, b) => b.score - a.score);

  // Collapse to one hit per session - the best-scoring chunk - carrying a
  // `matchCount` of the total chunks that matched, so a conversation with many
  // matches shows once with a count instead of N near-duplicate rows.
  const bestBySession = new Map<string, TranscriptSearchHit>();
  for (const hit of allHits) {
    const existing = bestBySession.get(hit.sessionId);
    if (existing) {
      existing.matchCount += 1;
    } else {
      bestBySession.set(hit.sessionId, { ...hit, matchCount: 1 });
    }
  }
  return [...bestBySession.values()].sort((a, b) => b.score - a.score).slice(0, k);
}

function safeLexical(store: RetrievalStore, matchQuery: string, taskId?: string) {
  try {
    return store.searchLexical(matchQuery, PER_LIST_LIMIT, taskId);
  } catch {
    // A malformed MATCH slips through, or the FTS table is missing on an old DB.
    return [];
  }
}

function safeSemantic(store: RetrievalStore, queryVector: Float32Array, limit: number) {
  try {
    return store.searchSemantic(queryVector, limit);
  } catch {
    return [];
  }
}

/**
 * Calibrated relevance cutoff on the model-independent 0-1 scale. Conservative
 * on purpose: it rejects clear non-matches (which sit at the model's noise floor,
 * so relevance ~= 0) while keeping anything plausibly related, because ranking +
 * RRF fusion order the rest and an over-tight cut that returns nothing for a real
 * query is worse than a couple of weak tail hits. This is the single "strictness"
 * constant (no user knob): these models are meant to be used by relative ranking,
 * not an absolute cosine threshold.
 */
const SEMANTIC_RELEVANCE_CUTOFF = 0.15;

/** Semantic hits whose CALIBRATED relevance clears the cutoff, re-ranked densely
 *  so RRF sees contiguous ranks. Embeddings are normalized and the vec table uses
 *  L2 distance, so cosine similarity is `1 - d^2 / 2`. These sentence encoders are
 *  anisotropic: unrelated text pairs cluster at a high, model-specific cosine
 *  (`noiseFloor`, e.g. ~0.6 for bge), not 0, so a raw cosine threshold is not
 *  portable across models. We rescale cosine against the floor into a
 *  model-independent relevance `(cos - floor) / (1 - floor)`, clamped implicitly
 *  by the cutoff, so gibberish (which lands at the floor -> relevance ~0) is
 *  dropped on every model. A floor <= 0 (or >= 1) disables the filter. */
function relevantSemantic(store: RetrievalStore, queryVector: Float32Array, noiseFloor: number, limit: number) {
  const hits = safeSemantic(store, queryVector, limit);
  const denom = 1 - noiseFloor;
  if (!(noiseFloor > 0) || denom <= 0) return hits;
  return hits
    .filter((hit) => {
      const cosine = 1 - (hit.distance * hit.distance) / 2;
      return (cosine - noiseFloor) / denom >= SEMANTIC_RELEVANCE_CUTOFF;
    })
    .map((hit, index) => ({ ...hit, rank: index + 1 }));
}

/**
 * Expand a matched chunk into its neighboring chunks (for the MCP recall tool's
 * context window). Corpus-scoped to conversations.
 */
export function expandChunk(
  projectId: string,
  chunkId: number,
  radius: number,
  getDb: (projectId: string) => Database.Database = getProjectDb,
): StoredChunk[] {
  try {
    const store = new RetrievalStore(getDb(projectId));
    return store.getNeighbors(chunkId, radius);
  } catch {
    return [];
  }
}
