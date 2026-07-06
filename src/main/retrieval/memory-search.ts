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
  /** Semantic embedder, or null/absent for lexical-only. */
  embedder?: Embedder | null;
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

    const lexical = matchQuery ? safeLexical(store, matchQuery) : [];
    const semantic = queryVector ? safeSemantic(store, queryVector) : [];
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
    for (const chunk of chunks.values()) {
      if (chunk.taskId && !taskTitles.has(chunk.taskId)) {
        const row = db.prepare('SELECT title FROM tasks WHERE id = ?').get(chunk.taskId) as
          | { title: string }
          | undefined;
        taskTitles.set(chunk.taskId, row?.title ?? '(unknown task)');
      }
      if (chunk.sessionId && !sessionTypes.has(chunk.sessionId)) {
        const row = db.prepare('SELECT session_type FROM sessions WHERE id = ?').get(chunk.sessionId) as
          | { session_type: string }
          | undefined;
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

function safeLexical(store: RetrievalStore, matchQuery: string) {
  try {
    return store.searchLexical(matchQuery, PER_LIST_LIMIT);
  } catch {
    // A malformed MATCH slips through, or the FTS table is missing on an old DB.
    return [];
  }
}

function safeSemantic(store: RetrievalStore, queryVector: Float32Array) {
  try {
    return store.searchSemantic(queryVector, PER_LIST_LIMIT);
  } catch {
    return [];
  }
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
