/**
 * Related work: every task a question is about, found before any agent runs.
 *
 * The Knowledge Graph's Ask used to hand the agent a board table and a search
 * tool and let it find the relevant work itself. On a topic question that went
 * badly, measured on 700 conversations: "How many times did we change the
 * terminal renderer?" took six searches and 25 seconds and answered "0 times",
 * because each search returned at most 20 per-session snippets and nothing
 * rolled them up per task. A related set was never complete, so it could not be
 * counted or ranked.
 *
 * This does the finding here, locally, in well under a second, and hands the
 * agent the ranked set. The agent still judges which of them are really about
 * the subject, and can still search when the set misses.
 *
 * WHY THIS SHAPE, from free measurements on the real index (no agent calls):
 *
 * - DEEP POOLS. A thousand nearest chunks per query vector and five hundred
 *   keyword matches. A vec0 KNN at k=1000 costs 340 to 370 ms; the old k=32
 *   pool found 14 of 76 title-named terminal tasks, the deep one 58.
 * - TWO QUERY VECTORS: the question as asked, and its content words alone.
 *   "How many tasks touched the terminal renderer?" pulls toward Electron
 *   renderer work; "terminal renderer" does not. Together they found 47 of 76
 *   title-named terminal tasks inside the handed set against 24 for the
 *   question alone, and brought #601 into the knowledge-graph set.
 * - CORROBORATION. A task with many matching passages is more about the
 *   subject than one with a single close passage, so the count adds a log term
 *   to the best passage's calibrated relevance.
 * - KEYWORDS BY RANK, NOT COUNT. Adding a count of keyword hits put
 *   conversations that say "renderer" hundreds of times (the Electron process)
 *   at the top of a terminal-renderer question. A small bonus by bm25 RANK
 *   keeps the signal without the flood.
 * - A RELATIVE FLOOR, NOT A CLIFF. No question showed a real gap in the ranked
 *   scores (the largest drop was 6%), so a cut at the largest gap would hand
 *   the maximum every time. The handed set is the tasks within 60% of the best
 *   score, clamped to 12 to 80: 17 for the mobile relay, 45 for the held
 *   grid, 80 (from 122) for the terminal renderer.
 * - NEITHER A TIGHTER FLOOR NOR SIZE-SCALED CORROBORATION. Measured on 995
 *   conversations over six questions: a 0.7 floor handed a third fewer tasks
 *   but lost 7 of 61 title-named ones, and three ways of dividing the match
 *   count by the task's size moved recall by at most one task. A huge task
 *   such as #529 tops "how many adapters did we add?" on its best passage,
 *   not its size, and still ranks first with no corroboration term at all.
 * - TASK RECORDS, ON THE CONVERSATION SCALE. A task's own record (title,
 *   labels, description) is searched beside its conversations, and reaches a
 *   task with no conversation at all when the question is unscoped. A short
 *   record does not score like a transcript chunk, so record relevance is
 *   rescaled so its best equals the conversations' best for that question.
 *   Measured over the same six questions (683 tasks, 2,342 record chunks):
 *   title-named recall inside the handed set rose from 46 of 71 to 58, and
 *   "how many adapters did we add?" found #14 to #17, which have no indexed
 *   conversation. Records at their raw scores reached 57 of 71 but none of
 *   the four, because that question's records peaked at 0.39 against 0.54.
 *   The handed set grew from 33 tasks to 43 on average. The factor is
 *   clamped, so a record pool that barely clears the cutoff is not inflated
 *   into noise.
 * - NOT SESSION CHANGES. Ranking by the files each session changed as well
 *   lowered title-named recall from 69 of 96 to 65 over seven questions, one
 *   of them about which tasks changed a file: nearly every session changes
 *   many files, so the set only grew. They are indexed as text for the task
 *   summaries, and searched by nothing here (`EMBEDDED_CORPORA`).
 * - COMMITS, BY KEYWORD ONLY. The default branch's commits, each counted
 *   toward the task that wrote it, lifted recall from 66 of 96 to 67 over the
 *   same seven questions (the PTY session manager one) and grew the handed set
 *   by 1.9 tasks. Embedded as well they found the same 67 for 4.1 more tasks,
 *   so they get no vectors and no semantic pool.
 * - SOURCE CODE, BY MEANING, AS PASSAGES. When the default branch's code is
 *   indexed, its closest chunks go to the agent beside the tasks, never as
 *   tasks: a file belongs to no task, and the rows stay tasks. Only the
 *   question as asked is searched, the vector the floors were measured on. The
 *   floor keeps code out of board questions: on bge-large, seven board and
 *   topic questions peaked at 0.32 to 0.43 against 0.48 to 0.67 for questions
 *   about code. A question naming an identifier ("Who calls
 *   requiresUserInteraction?") reads less like its code: two of seven peaked at
 *   0.41 to 0.42 with the answer file at 0.37 to 0.38, so it gets a lower floor.
 *   bge-base and bge-small calibrate to their own noise floors, but these
 *   floors were not measured on them.
 */

import type Database from 'better-sqlite3';
import { getProjectDb } from '../db/database';
import { RetrievalStore } from './retrieval-store';
import { CONVERSATION_CORPUS, type MemoryCorpus } from './corpora';
import { SEMANTIC_RELEVANCE_CUTOFF } from './memory-search';
import { namesCodeIdentifier } from './code/code-record';
import { timeSyncWork } from '../diagnostics/event-loop-lag';
import { toBoardTaskFacts } from './board-task-facts';
import type { BoardTaskFacts } from './answer-tasks';
import type { ChunkPlacement, Embedder } from './types';
import { contentWords, passageKey, PASSAGES_SHOWN, relatedQueryTexts } from './related-query-text';

export { contentWords, passageKey, PASSAGES_SHOWN, relatedQueryTexts };

/** Nearest chunks read per query vector. */
const SEMANTIC_POOL = 1_000;
/** Keyword matches read, by bm25. */
const LEXICAL_POOL = 500;
/**
 * The corpora searched beside the conversations, each in pools of its own so
 * they never push a conversation chunk out of the deep one, and each rescaled
 * to the conversations' relevance (see the header). A project holds a few
 * thousand chunks of each at most. Every one of them reaches a row through its
 * chunks' task, so a chunk with none (a backlog item, an unlinked commit)
 * counts toward nothing. A `semanticPool` of 0 means keywords only.
 */
const SIDE_CORPORA: ReadonlyArray<{ corpus: MemoryCorpus; semanticPool: number; lexicalPool: number }> = [
  { corpus: 'task', semanticPool: 500, lexicalPool: 200 },
  { corpus: 'commit', semanticPool: 0, lexicalPool: 200 },
];
/** Bounds on the factor that puts a side corpus on the conversation scale. */
const SIDE_SCALE_MIN = 0.5;
const SIDE_SCALE_MAX = 1.5;
/** Weight of the log2 match-count term. */
const CORROBORATION_WEIGHT = 0.03;
/** Largest keyword bonus, for the best bm25 rank; it falls to nothing by `LEXICAL_RANK_SPAN`. */
const LEXICAL_WEIGHT = 0.08;
const LEXICAL_RANK_SPAN = 200;
/** A task is handed to the agent when its score is at least this share of the best. */
const RELATED_FLOOR = 0.6;
export const MIN_HANDED = 12;
export const MAX_HANDED = 80;
/** Characters of a passage, enough to judge relevance by. */
const PASSAGE_CHARS = 220;
/** Nearest code chunks read for the question: enough to fill the passages two to a file. */
const CODE_POOL = 60;
/** The least relevance a code passage is handed at (see the header). */
export const CODE_FLOOR = 0.45;
/** The same, for a question that names a code identifier. */
export const CODE_IDENTIFIER_FLOOR = 0.35;
/** Code passages handed at most: about 2,400 tokens, whole chunks. */
export const CODE_PASSAGES = 6;
/** From any one file, so one long file cannot fill them all. */
const CODE_PASSAGES_PER_FILE = 2;

/**
 * The keyword query: every content word, ORed and quoted.
 *
 * ORed, not ANDed like the palette's query: a question is a sentence, and
 * requiring every word of it matches almost nothing. Quoting each word turns
 * off FTS5 operator syntax. Null when nothing is left to search for.
 */
export function relatedKeywordQuery(text: string): string | null {
  const words = contentWords(text);
  if (words.length === 0) return null;
  return words.map((word) => `"${word.replace(/"/g, '')}"`).join(' OR ');
}

/** The part of a map node the rollup reads. */
export interface RelatedWorkNode {
  docKey: string;
  taskId: string | null;
  displayId: number | null;
  title: string | null;
}

/** One task, ranked for a question. */
export interface RelatedWorkTask {
  /** The task id, or `conversation:<docKey>` for a conversation with no task. */
  key: string;
  taskId: string | null;
  displayId: number | null;
  title: string;
  score: number;
  /** `score` over the best task's score: 1 for the best, falling to the floor. */
  strength: number;
  /** Chunks of this task that matched. */
  matches: number;
  firstMs: number | null;
  lastMs: number | null;
  /** Every conversation of the task inside the scope, so the map can light them. */
  docKeys: string[];
  /** The best-matching chunk, for its passage. A task's own record can be it. */
  bestChunkId: number | null;
  /** Where a row opens: the best-matching CONVERSATION chunk's session and
   *  turn. Null for a task matched through its record alone. */
  sessionId: string | null;
  turnUuid: string | null;
}

/** A board task a record match may land on when no conversation of it is in scope. */
export interface RelatedWorkRecordTask {
  taskId: string;
  displayId: number | null;
  title: string;
}

export interface RollUpInput {
  semantic: ReadonlyArray<{ chunkId: number; relevance: number }>;
  lexical: ReadonlyArray<{ chunkId: number; rank: number }>;
  placements: ReadonlyMap<number, ChunkPlacement>;
  /** Only the nodes in scope. A conversation chunk whose document is not here
   *  is dropped. */
  nodesByDocKey: ReadonlyMap<string, RelatedWorkNode>;
  /**
   * The tasks a task-record chunk may reach with no conversation in scope: the
   * whole board when the question is unscoped, nothing when the map is
   * filtered, because the filters select conversations and a task with none
   * cannot be inside them. The same rule the board table follows. A record of a
   * task that does have a conversation in scope always counts.
   */
  recordOnlyTasks?: ReadonlyMap<string, RelatedWorkRecordTask>;
}

/** The task a node belongs to. A conversation with no task is its own task. */
export function relatedTaskKey(node: RelatedWorkNode): string {
  return node.taskId ?? `conversation:${node.docKey}`;
}

interface Accumulator {
  key: string;
  node: RelatedWorkNode;
  best: number;
  bestChunkId: number | null;
  /** The best conversation chunk: where the row opens. */
  bestConversation: number;
  bestConversationChunkId: number | null;
  chunkIds: Set<number>;
  lexicalRank: number | null;
  firstMs: number | null;
  lastMs: number | null;
}

/**
 * Roll chunk hits up to tasks and rank them. Pure, so the ranking can be
 * pinned without a database or a model.
 */
export function rollUpRelatedWork(input: RollUpInput): RelatedWorkTask[] {
  const docKeysByTask = new Map<string, string[]>();
  const nodeByTask = new Map<string, RelatedWorkNode>();
  for (const node of input.nodesByDocKey.values()) {
    const key = relatedTaskKey(node);
    const list = docKeysByTask.get(key) ?? [];
    list.push(node.docKey);
    docKeysByTask.set(key, list);
    if (!nodeByTask.has(key)) nodeByTask.set(key, node);
  }

  /** The node a chunk counts toward, or null when it is out of scope. */
  const nodeFor = (placement: ChunkPlacement): RelatedWorkNode | null => {
    if (placement.corpus === 'conversation') return input.nodesByDocKey.get(`${placement.corpus}::${placement.docId}`) ?? null;
    // A task record or a commit: its task's own conversations when one is in
    // scope, else the board's task when the question is unscoped. A backlog
    // item and an unlinked commit have no board task, so they never reach a row.
    if (!placement.taskId) return null;
    const conversationNode = nodeByTask.get(placement.taskId);
    if (conversationNode) return conversationNode;
    const recordTask = input.recordOnlyTasks?.get(placement.taskId);
    if (!recordTask) return null;
    return { docKey: `task::${placement.taskId}`, taskId: recordTask.taskId, displayId: recordTask.displayId, title: recordTask.title };
  };

  const byTask = new Map<string, Accumulator>();
  const accumulatorFor = (chunkId: number): { entry: Accumulator; placement: ChunkPlacement } | null => {
    const placement = input.placements.get(chunkId);
    if (!placement) return null;
    const node = nodeFor(placement);
    if (!node) return null;
    const key = relatedTaskKey(node);
    let entry = byTask.get(key);
    if (!entry) {
      entry = {
        key, node, best: 0, bestChunkId: null, bestConversation: 0, bestConversationChunkId: null,
        chunkIds: new Set(), lexicalRank: null, firstMs: null, lastMs: null,
      };
      byTask.set(key, entry);
    }
    entry.chunkIds.add(chunkId);
    const at = placement.tsStart;
    if (at !== null) {
      if (entry.firstMs === null || at < entry.firstMs) entry.firstMs = at;
      if (entry.lastMs === null || at > entry.lastMs) entry.lastMs = at;
    }
    return { entry, placement };
  };

  for (const hit of input.semantic) {
    if (hit.relevance < SEMANTIC_RELEVANCE_CUTOFF) continue;
    const found = accumulatorFor(hit.chunkId);
    if (!found) continue;
    if (hit.relevance > found.entry.best) {
      found.entry.best = hit.relevance;
      found.entry.bestChunkId = hit.chunkId;
    }
    if (found.placement.corpus === 'conversation' && hit.relevance > found.entry.bestConversation) {
      found.entry.bestConversation = hit.relevance;
      found.entry.bestConversationChunkId = hit.chunkId;
    }
  }
  for (const hit of input.lexical) {
    const found = accumulatorFor(hit.chunkId);
    if (!found) continue;
    if (found.entry.lexicalRank === null || hit.rank < found.entry.lexicalRank) {
      found.entry.lexicalRank = hit.rank;
      // A keyword-only task still needs a passage to show.
      if (found.entry.bestChunkId === null) found.entry.bestChunkId = hit.chunkId;
    }
    if (found.placement.corpus === 'conversation' && found.entry.bestConversationChunkId === null) {
      found.entry.bestConversationChunkId = hit.chunkId;
    }
  }

  const scored = [...byTask.values()].map((entry) => {
    const lexicalBonus = entry.lexicalRank === null
      ? 0
      : LEXICAL_WEIGHT * Math.max(0, 1 - (entry.lexicalRank - 1) / LEXICAL_RANK_SPAN);
    const score = entry.best + CORROBORATION_WEIGHT * Math.log2(1 + entry.chunkIds.size) + lexicalBonus;
    return { entry, score };
  }).sort((left, right) => right.score - left.score);

  const top = scored[0]?.score ?? 0;
  return scored.map(({ entry, score }) => {
    const opensAt = entry.bestConversationChunkId !== null ? input.placements.get(entry.bestConversationChunkId) : undefined;
    return {
      key: entry.key,
      taskId: entry.node.taskId,
      displayId: entry.node.displayId,
      title: entry.node.title ?? 'Untitled',
      score,
      strength: top > 0 ? score / top : 0,
      matches: entry.chunkIds.size,
      firstMs: entry.firstMs,
      lastMs: entry.lastMs,
      // A task reached through its record alone has nothing on the map.
      docKeys: docKeysByTask.get(entry.key) ?? [],
      bestChunkId: entry.bestChunkId,
      sessionId: opensAt?.sessionId ?? null,
      turnUuid: opensAt?.turnUuidStart ?? null,
    };
  });
}

/**
 * The tasks the agent is handed: within `RELATED_FLOOR` of the best, clamped to
 * `MIN_HANDED`..`MAX_HANDED`, with any pinned task added (a follow-up keeps the
 * tasks the earlier answer was about, or "of those" has nothing to refer to).
 */
export function selectHandedTasks<Task extends RelatedWorkTask>(
  ranked: ReadonlyArray<Task>,
  pinnedKeys: ReadonlySet<string> = new Set(),
): Task[] {
  const top = ranked[0]?.score ?? 0;
  let count = ranked.filter((task) => task.score >= RELATED_FLOOR * top).length;
  count = Math.min(MAX_HANDED, Math.max(MIN_HANDED, count), ranked.length);
  const handed = ranked.slice(0, count);
  const present = new Set(handed.map((task) => task.key));
  for (const task of ranked.slice(count)) {
    if (pinnedKeys.has(task.key) && !present.has(task.key)) handed.push(task);
  }
  return handed;
}

/** One passage of source code handed with the related work. */
export interface CodePassage {
  /** The file, repository-relative. */
  path: string;
  /** The chunk without the path line it opens with. */
  text: string;
  relevance: number;
}

/** The least relevance a code passage needs for this question. */
export function codeFloorFor(question: string): number {
  return namesCodeIdentifier(question) ? CODE_IDENTIFIER_FLOOR : CODE_FLOOR;
}

/**
 * The code passages handed: at or above `floor`, best first, at most
 * `CODE_PASSAGES_PER_FILE` from one file (keyed by `fileKey`, which across
 * projects must name the project too) and `CODE_PASSAGES` in all.
 */
export function selectCodePassages<Passage extends { path: string; relevance: number }>(
  candidates: ReadonlyArray<Passage>,
  floor: number,
  fileKey: (passage: Passage) => string = (passage) => passage.path,
): Passage[] {
  const perFile = new Map<string, number>();
  const chosen: Passage[] = [];
  for (const passage of [...candidates].sort((left, right) => right.relevance - left.relevance)) {
    if (passage.relevance < floor || chosen.length === CODE_PASSAGES) break;
    const key = fileKey(passage);
    const taken = perFile.get(key) ?? 0;
    if (taken === CODE_PASSAGES_PER_FILE) continue;
    perFile.set(key, taken + 1);
    chosen.push(passage);
  }
  return chosen;
}

/** A code chunk's text without the path line `codeChunks` opens it with. */
function codeBody(path: string, text: string): string {
  const body = text.startsWith(`${path}\n`) ? text.slice(path.length + 1) : text;
  return body.replace(/^\n+/, '').trimEnd();
}

export interface SearchRelatedWorkInput {
  question: string;
  /** Earlier questions in the chat, so a follow-up searches the same subject. */
  anchorQuestions?: ReadonlyArray<string>;
  projectId: string;
  /** The map's nodes inside the user's filters. */
  nodes: ReadonlyArray<RelatedWorkNode>;
  /** Board tasks a task record may reach with none of their conversations in
   *  scope: every task when the question is unscoped, none when it is
   *  filtered (see `RollUpInput.recordOnlyTasks`). */
  recordOnlyTasks?: ReadonlyArray<RelatedWorkRecordTask>;
  embedder: Embedder | null;
  /** Task keys a follow-up keeps from the turn before. */
  pinnedKeys?: ReadonlySet<string>;
  embedWaitMs?: number;
  getDb?: (projectId: string) => Database.Database;
  /**
   * The question's vectors, already embedded from `relatedQueryTexts`. A search
   * across projects embeds once and passes them to each project's search; the
   * embedder is still passed, for its noise floor.
   */
  queryVectors?: ReadonlyArray<Float32Array>;
  /** Whether source code is indexed (`codeIndexOn`), so code passages are searched. */
  code?: boolean;
  /**
   * The text the keyword search runs on, when it should not be the question.
   * Related work for a task embeds the task's whole title and description but
   * searches keywords by its title: a long description ORs together a hundred
   * words and matches everything.
   */
  keywordText?: string;
}

export interface RelatedWork {
  /** Every task that matched, strongest first. */
  ranked: RelatedWorkTask[];
  /** The ones handed to the agent. */
  handed: RelatedWorkTask[];
  /** Passage text by chunk id, for the handed tasks that show one. */
  passages: Map<number, string>;
  /** Source code passages, best first. Empty unless `code` was asked for. */
  code: CodePassage[];
  /** False when no query vector was available, so only keywords ran. */
  semantic: boolean;
  elapsedMs: number;
}

/** The query vectors, or none when there is no embedder or it does not answer in time. */
async function embedQuery(
  embedder: Embedder | null,
  queryTexts: ReadonlyArray<string>,
  embedWaitMs: number | undefined,
): Promise<ReadonlyArray<Float32Array>> {
  if (!embedder || queryTexts.length === 0) return [];
  try {
    return (await embedder.embed([...queryTexts], { timeoutMs: embedWaitMs, isQuery: true })) ?? [];
  } catch {
    return [];
  }
}

/** Let queued I/O and IPC run before the next synchronous database step. */
function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

/** A passage as the prompt shows it: one line, bounded. */
function passageLine(text: string): string {
  const collapsed = text.replace(/\s+/g, ' ').trim();
  return collapsed.length > PASSAGE_CHARS ? `${collapsed.slice(0, PASSAGE_CHARS)}...` : collapsed;
}

/**
 * Find the related work for a question in one project.
 *
 * Every failure degrades rather than throws: no embedder means keywords only,
 * a missing FTS table means semantic only, and an empty index means no tasks.
 */
export async function searchRelatedWork(input: SearchRelatedWorkInput): Promise<RelatedWork> {
  const started = Date.now();
  const getDb = input.getDb ?? getProjectDb;
  const empty: RelatedWork = { ranked: [], handed: [], passages: new Map(), code: [], semantic: false, elapsedMs: 0 };

  const nodesByDocKey = new Map<string, RelatedWorkNode>();
  for (const node of input.nodes) nodesByDocKey.set(node.docKey, node);
  const recordOnlyTasks = new Map((input.recordOnlyTasks ?? []).map((task) => [task.taskId, task]));
  if (nodesByDocKey.size === 0 && recordOnlyTasks.size === 0) return { ...empty, elapsedMs: Date.now() - started };

  let store: RetrievalStore;
  try {
    store = new RetrievalStore(getDb(input.projectId));
  } catch {
    return { ...empty, elapsedMs: Date.now() - started };
  }

  const anchors = (input.anchorQuestions ?? []).join(' ');
  const vectors = input.queryVectors
    ?? await embedQuery(input.embedder, relatedQueryTexts(input.question, input.anchorQuestions ?? []), input.embedWaitMs);

  // Best relevance per chunk across both query vectors.
  //
  // Each scan is synchronous SQLite over every vector in the project (measured
  // 340 to 370 ms on 89k chunks), on main, which also carries terminal output
  // and IPC. Yielding before each one splits the work into one scan per slice
  // instead of one freeze for all of it.
  const noiseFloor = input.embedder?.noiseFloor ?? 0;
  const relevanceOf = (distance: number): number => {
    const cosine = 1 - (distance * distance) / 2;
    return noiseFloor > 0 && noiseFloor < 1 ? (cosine - noiseFloor) / (1 - noiseFloor) : cosine;
  };
  /** Best relevance per chunk across the query vectors, one corpus's pool. */
  const semanticPool = async (corpus: ReadonlyArray<MemoryCorpus>, limit: number): Promise<Map<number, number>> => {
    const relevanceByChunk = new Map<number, number>();
    for (const vector of vectors) {
      await yieldToEventLoop();
      let hits: ReturnType<RetrievalStore['searchSemantic']>;
      try {
        hits = timeSyncWork('related:semantic', () => store.searchSemantic(vector, limit, corpus));
      } catch {
        hits = [];
      }
      for (const hit of hits) {
        const relevance = relevanceOf(hit.distance);
        const previous = relevanceByChunk.get(hit.chunkId);
        if (previous === undefined || relevance > previous) relevanceByChunk.set(hit.chunkId, relevance);
      }
    }
    return relevanceByChunk;
  };
  const conversationRelevance = await semanticPool(CONVERSATION_CORPUS, SEMANTIC_POOL);
  const relevanceByChunk = new Map(conversationRelevance);

  // Each side corpus on the conversation scale: its best chunk scores what the
  // best conversation chunk does (see the header), within bounds.
  const conversationBest = Math.max(0, ...conversationRelevance.values());
  for (const side of SIDE_CORPORA) {
    if (side.semanticPool === 0) continue;
    const sideRelevance = await semanticPool([side.corpus], side.semanticPool);
    const sideBest = Math.max(0, ...sideRelevance.values());
    const scale = conversationBest > 0 && sideBest > 0
      ? Math.min(SIDE_SCALE_MAX, Math.max(SIDE_SCALE_MIN, conversationBest / sideBest))
      : 1;
    for (const [chunkId, relevance] of sideRelevance) relevanceByChunk.set(chunkId, relevance * scale);
  }

  // Source code: its own pool on the question as asked, handed as passages
  // beside the tasks (see the header). Nothing here ranks a task.
  let code: CodePassage[] = [];
  if (input.code && vectors.length > 0) {
    await yieldToEventLoop();
    try {
      const floor = codeFloorFor(input.question);
      const hits = timeSyncWork('related:code', () => store.searchSemantic(vectors[0], CODE_POOL, ['code']))
        .map((hit) => ({ chunkId: hit.chunkId, relevance: relevanceOf(hit.distance) }))
        .filter((hit) => hit.relevance >= floor);
      const chunks = new Map(store.getChunks(hits.map((hit) => hit.chunkId)).map((chunk) => [chunk.id, chunk]));
      code = selectCodePassages(hits.flatMap((hit) => {
        const chunk = chunks.get(hit.chunkId);
        return chunk ? [{ path: chunk.docId, text: codeBody(chunk.docId, chunk.text), relevance: hit.relevance }] : [];
      }), floor);
    } catch {
      // The answer stands on the tasks alone.
    }
  }

  // Keyword matches, each corpus ranked on its own so a record's rank 1 earns
  // what a conversation's does. A task keeps its best rank of them.
  const keywordQuery = relatedKeywordQuery(input.keywordText ?? `${input.question} ${anchors}`);
  let lexical: Array<{ chunkId: number; rank: number }> = [];
  if (keywordQuery) {
    await yieldToEventLoop();
    const keywordPool = (corpus: ReadonlyArray<MemoryCorpus>, limit: number): Array<{ chunkId: number; rank: number }> => {
      try {
        return timeSyncWork('related:lexical', () => store.searchLexical(keywordQuery, limit, corpus))
          .map((hit) => ({ chunkId: hit.chunkId, rank: hit.rank }));
      } catch {
        return [];
      }
    };
    const conversationKeywords = keywordPool(CONVERSATION_CORPUS, LEXICAL_POOL);
    // Each scan is 20 to 140 ms on main: a turn for everything else between them.
    await yieldToEventLoop();
    // The side corpora in one full-text scan, each still ranked on its own.
    let side: Array<{ chunkId: number; rank: number }>;
    try {
      const limits = new Map(SIDE_CORPORA.map((entry) => [entry.corpus, entry.lexicalPool]));
      side = [...timeSyncWork('related:lexical-side', () => store.searchLexicalPerCorpus(keywordQuery, limits)).values()].flat();
    } catch {
      side = [];
    }
    lexical = [...conversationKeywords, ...side];
  }

  const chunkIds = [...new Set([...relevanceByChunk.keys(), ...lexical.map((hit) => hit.chunkId)])];
  const placements = new Map<number, ChunkPlacement>();
  await yieldToEventLoop();
  try {
    for (const placement of timeSyncWork('related:placements', () => store.getChunkPlacements(chunkIds))) {
      placements.set(placement.id, placement);
    }
  } catch {
    return { ...empty, code, elapsedMs: Date.now() - started };
  }

  const ranked = rollUpRelatedWork({
    semantic: [...relevanceByChunk.entries()].map(([chunkId, relevance]) => ({ chunkId, relevance })),
    lexical,
    placements,
    nodesByDocKey,
    recordOnlyTasks,
  });
  const handed = selectHandedTasks(ranked, input.pinnedKeys);

  const passageIds = handed
    .slice(0, PASSAGES_SHOWN)
    .map((task) => task.bestChunkId)
    .filter((chunkId): chunkId is number => chunkId !== null);
  const passages = new Map<number, string>();
  try {
    for (const chunk of store.getChunks(passageIds)) passages.set(chunk.id, passageLine(chunk.text));
  } catch {
    // The ranking stands without its passages.
  }

  return { ranked, handed, passages, code, semantic: vectors.length > 0, elapsedMs: Date.now() - started };
}

/** A related task, and the project it was found in. */
export interface ProjectRelatedWorkTask extends RelatedWorkTask {
  projectId: string;
}

/** A code passage, and the project whose code it is. */
export interface ProjectCodePassage extends CodePassage {
  projectId: string;
}

/**
 * Related work that may span projects. Passages are keyed by `passageKey`,
 * not by chunk id, because chunk ids repeat between project databases.
 */
export interface ProjectRelatedWork {
  ranked: ProjectRelatedWorkTask[];
  handed: ProjectRelatedWorkTask[];
  passages: Map<string, string>;
  code: ProjectCodePassage[];
  semantic: boolean;
  elapsedMs: number;
}

/** One project's related work, stamped with that project. */
export function toProjectRelatedWork(work: RelatedWork, projectId: string): ProjectRelatedWork {
  const stamp = (task: RelatedWorkTask): ProjectRelatedWorkTask => ({ ...task, projectId });
  return {
    ranked: work.ranked.map(stamp),
    handed: work.handed.map(stamp),
    passages: new Map([...work.passages].map(([chunkId, text]) => [passageKey(projectId, chunkId), text])),
    code: work.code.map((passage) => ({ ...passage, projectId })),
    semantic: work.semantic,
    elapsedMs: work.elapsedMs,
  };
}

export interface SearchRelatedWorkAcrossInput extends Omit<SearchRelatedWorkInput, 'projectId' | 'nodes' | 'recordOnlyTasks'> {
  /** Each project in the question's scope, with its nodes inside the map's
   *  filters and the board tasks its records may reach. */
  projects: ReadonlyArray<{
    projectId: string;
    nodes: ReadonlyArray<RelatedWorkNode>;
    recordOnlyTasks?: ReadonlyArray<RelatedWorkRecordTask>;
  }>;
}

/**
 * Find the related work for a question across several projects.
 *
 * The question is embedded ONCE, and each project's index searched with those
 * vectors, so the cost of a second project is its own search and not another
 * model call. The ranked lists merge by raw score, which compares across
 * projects because every project is embedded by the same model and scored
 * against the same vectors; strength is recomputed against the merged best,
 * and the handed set chosen from the merged ranking by the single-project rule.
 * A project that fails to search drops out rather than failing the question.
 */
export async function searchRelatedWorkAcross(input: SearchRelatedWorkAcrossInput): Promise<ProjectRelatedWork> {
  const started = Date.now();
  const anchorQuestions = input.anchorQuestions ?? [];
  const vectors = input.queryVectors
    ?? await embedQuery(input.embedder, relatedQueryTexts(input.question, anchorQuestions), input.embedWaitMs);

  const ranked: ProjectRelatedWorkTask[] = [];
  const passages = new Map<string, string>();
  const code: ProjectCodePassage[] = [];
  for (const project of input.projects) {
    if (project.nodes.length === 0 && (project.recordOnlyTasks ?? []).length === 0) continue;
    let work: RelatedWork;
    try {
      work = await searchRelatedWork({
        question: input.question,
        anchorQuestions,
        projectId: project.projectId,
        nodes: project.nodes,
        recordOnlyTasks: project.recordOnlyTasks,
        embedder: input.embedder,
        queryVectors: vectors,
        embedWaitMs: input.embedWaitMs,
        getDb: input.getDb,
        code: input.code,
      });
    } catch {
      continue;
    }
    const stamped = toProjectRelatedWork(work, project.projectId);
    ranked.push(...stamped.ranked);
    for (const [key, text] of stamped.passages) passages.set(key, text);
    code.push(...stamped.code);
  }

  ranked.sort((left, right) => right.score - left.score);
  const top = ranked[0]?.score ?? 0;
  const rescored = ranked.map((task) => ({ ...task, strength: top > 0 ? task.score / top : 0 }));
  return {
    ranked: rescored,
    handed: selectHandedTasks(rescored, input.pinnedKeys),
    passages,
    // Every project scored its code against the same vectors, so the best of
    // them all are handed, under the same caps.
    code: selectCodePassages(code, codeFloorFor(input.question), (passage) => `${passage.projectId}:${passage.path}`),
    semantic: vectors.length > 0,
    elapsedMs: Date.now() - started,
  };
}

/**
 * Every board task, as the tasks a task-record match may reach in an unscoped
 * question. Empty when the project has no readable database, which leaves the
 * ranking to the conversations.
 */
export function boardRecordTasks(
  projectId: string,
  getDb: (projectId: string) => Database.Database = getProjectDb,
): RelatedWorkRecordTask[] {
  try {
    return new RetrievalStore(getDb(projectId)).boardTaskTitles();
  } catch {
    return [];
  }
}

/**
 * Every board task with its facts (cost, duration, tokens, sessions, churn,
 * outcome, pull request), for Ask's task table and the rows `kangentic_search`
 * ranks. Empty when the project database cannot be read, which leaves the
 * caller to the indexed conversations rather than failing it.
 */
export function readBoardTaskFacts(
  projectId: string,
  getDb: (projectId: string) => Database.Database = getProjectDb,
): BoardTaskFacts[] {
  try {
    return new RetrievalStore(getDb(projectId)).boardTaskFacts().map(toBoardTaskFacts);
  } catch {
    return [];
  }
}

/** A rollup node, plus the session that opens it. */
export interface IndexedConversationNode extends RelatedWorkNode {
  sessionId: string | null;
}

/**
 * Each project's conversation owners, kept until its index changes.
 *
 * Reading them groups every conversation chunk row (about 300 ms on main on a
 * 94k-chunk index), and `kangentic_search` needs them on every call, up to four
 * times per answer. The coverage fingerprint moves whenever a chunk is added,
 * removed, embedded or re-pointed to another session, and costs about 11 ms.
 * Titles are not kept, and cost about 4 ms to read: a task renamed with no
 * index change still shows its new name. One entry per project searched since
 * launch.
 */
const conversationOwnersByProject = new Map<string, {
  fingerprint: string;
  owners: ReturnType<RetrievalStore['conversationOwners']>;
}>();

/**
 * Every indexed conversation in a project as a rollup node, read off the index
 * itself rather than the Knowledge Graph's projection, so a caller with no map
 * (the `kangentic_search` tool) can rank tasks the same way Ask does. Empty
 * when the project has no index.
 */
export function indexedConversationNodes(
  projectId: string,
  getDb: (projectId: string) => Database.Database = getProjectDb,
): IndexedConversationNode[] {
  try {
    const store = new RetrievalStore(getDb(projectId));
    const fingerprint = store.coverageFingerprint();
    let cached = conversationOwnersByProject.get(projectId);
    if (!cached || cached.fingerprint !== fingerprint) {
      cached = { fingerprint, owners: timeSyncWork('related:conversation-owners', () => store.conversationOwners()) };
      conversationOwnersByProject.set(projectId, cached);
    }
    const tasks = new Map(store.boardTaskTitles().map((task) => [task.taskId, task]));
    return cached.owners.map((owner) => {
      const task = owner.taskId ? tasks.get(owner.taskId) : undefined;
      return {
        docKey: `conversation::${owner.docId}`,
        taskId: owner.taskId,
        displayId: task?.displayId ?? null,
        title: task?.title ?? null,
        sessionId: owner.sessionId,
      };
    });
  } catch {
    return [];
  }
}
