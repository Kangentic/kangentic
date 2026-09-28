/**
 * Related work: every task a question is about, found before any agent runs.
 *
 * The Memory Graph's Ask used to hand the agent a board table and a search
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
 *   question alone, and brought #601 into the memory-graph set.
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
 */

import type Database from 'better-sqlite3';
import { getProjectDb } from '../db/database';
import { RetrievalStore } from './retrieval-store';
import { SEMANTIC_RELEVANCE_CUTOFF } from './memory-search';
import type { ChunkPlacement, Embedder } from './types';

/** Nearest chunks read per query vector. */
const SEMANTIC_POOL = 1_000;
/** Keyword matches read, by bm25. */
const LEXICAL_POOL = 500;
/** Weight of the log2 match-count term. */
const CORROBORATION_WEIGHT = 0.03;
/** Largest keyword bonus, for the best bm25 rank; it falls to nothing by `LEXICAL_RANK_SPAN`. */
const LEXICAL_WEIGHT = 0.08;
const LEXICAL_RANK_SPAN = 200;
/** A task is handed to the agent when its score is at least this share of the best. */
const RELATED_FLOOR = 0.6;
export const MIN_HANDED = 12;
export const MAX_HANDED = 80;
/** Handed tasks that carry their best passage into the prompt; the rest carry facts only. */
export const PASSAGES_SHOWN = 12;
/** Characters of a passage, enough to judge relevance by. */
const PASSAGE_CHARS = 220;

/**
 * Words that shape a question without saying what it is about. Removed before
 * the keyword search and the content-word embedding, or "most", "tasks" and
 * "touched" would match every conversation in the index.
 */
const QUESTION_WORDS = new Set((
  'a an and are as at be been being but by can could did do does doing done for from had has have how i if in '
  + 'into is it its me most my no not of on or our so than that the their them then there these they this those '
  + 'to was we were what when where which who why will with would you your task tasks work worked related relate '
  + 'about any all many much times time ever more some touched touch change changed changes spend spent cost '
  + 'costs expensive cheapest longest biggest largest used took take show list find tell give'
).split(' '));

/** The words a question is about, lower-cased, in order, without duplicates. */
export function contentWords(text: string): string[] {
  const words = text
    .toLowerCase()
    .replace(/[^a-z0-9_\-\s]/g, ' ')
    .split(/\s+/)
    .filter((word) => word.length > 1 && !QUESTION_WORDS.has(word));
  return [...new Set(words)];
}

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
  /** The best-matching chunk, for its passage and for where a row opens. */
  bestChunkId: number | null;
  sessionId: string | null;
  turnUuid: string | null;
}

export interface RollUpInput {
  semantic: ReadonlyArray<{ chunkId: number; relevance: number }>;
  lexical: ReadonlyArray<{ chunkId: number; rank: number }>;
  placements: ReadonlyMap<number, ChunkPlacement>;
  /** Only the nodes in scope. A chunk whose document is not here is dropped. */
  nodesByDocKey: ReadonlyMap<string, RelatedWorkNode>;
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
  for (const node of input.nodesByDocKey.values()) {
    const key = relatedTaskKey(node);
    const list = docKeysByTask.get(key) ?? [];
    list.push(node.docKey);
    docKeysByTask.set(key, list);
  }

  const byTask = new Map<string, Accumulator>();
  const accumulatorFor = (chunkId: number): { entry: Accumulator; placement: ChunkPlacement } | null => {
    const placement = input.placements.get(chunkId);
    if (!placement) return null;
    const node = input.nodesByDocKey.get(`${placement.corpus}::${placement.docId}`);
    if (!node) return null;
    const key = relatedTaskKey(node);
    let entry = byTask.get(key);
    if (!entry) {
      entry = { key, node, best: 0, bestChunkId: null, chunkIds: new Set(), lexicalRank: null, firstMs: null, lastMs: null };
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
  }
  for (const hit of input.lexical) {
    const found = accumulatorFor(hit.chunkId);
    if (!found) continue;
    if (found.entry.lexicalRank === null || hit.rank < found.entry.lexicalRank) {
      found.entry.lexicalRank = hit.rank;
      // A keyword-only task still needs a passage to show.
      if (found.entry.bestChunkId === null) found.entry.bestChunkId = hit.chunkId;
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
    const placement = entry.bestChunkId !== null ? input.placements.get(entry.bestChunkId) : undefined;
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
      docKeys: docKeysByTask.get(entry.key) ?? [entry.node.docKey],
      bestChunkId: entry.bestChunkId,
      sessionId: placement?.sessionId ?? null,
      turnUuid: placement?.turnUuidStart ?? null,
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

export interface SearchRelatedWorkInput {
  question: string;
  /** Earlier questions in the chat, so a follow-up searches the same subject. */
  anchorQuestions?: ReadonlyArray<string>;
  projectId: string;
  /** The map's nodes inside the user's filters. */
  nodes: ReadonlyArray<RelatedWorkNode>;
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
}

export interface RelatedWork {
  /** Every task that matched, strongest first. */
  ranked: RelatedWorkTask[];
  /** The ones handed to the agent. */
  handed: RelatedWorkTask[];
  /** Passage text by chunk id, for the handed tasks that show one. */
  passages: Map<number, string>;
  /** False when no query vector was available, so only keywords ran. */
  semantic: boolean;
  elapsedMs: number;
}

/**
 * What the question is embedded as: the question itself, and its content words
 * with the earlier questions' (so a follow-up searches the same subject).
 */
export function relatedQueryTexts(question: string, anchorQuestions: ReadonlyArray<string>): string[] {
  const topic = contentWords(`${question} ${anchorQuestions.join(' ')}`).join(' ');
  return [question.trim(), topic].filter((text, index, all) => text && all.indexOf(text) === index);
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
  const empty: RelatedWork = { ranked: [], handed: [], passages: new Map(), semantic: false, elapsedMs: 0 };

  const nodesByDocKey = new Map<string, RelatedWorkNode>();
  for (const node of input.nodes) nodesByDocKey.set(node.docKey, node);
  if (nodesByDocKey.size === 0) return { ...empty, elapsedMs: Date.now() - started };

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
  const noiseFloor = input.embedder?.noiseFloor ?? 0;
  const relevanceByChunk = new Map<number, number>();
  for (const vector of vectors) {
    let hits: ReturnType<RetrievalStore['searchSemantic']>;
    try {
      hits = store.searchSemantic(vector, SEMANTIC_POOL);
    } catch {
      hits = [];
    }
    for (const hit of hits) {
      const cosine = 1 - (hit.distance * hit.distance) / 2;
      const relevance = noiseFloor > 0 && noiseFloor < 1 ? (cosine - noiseFloor) / (1 - noiseFloor) : cosine;
      const previous = relevanceByChunk.get(hit.chunkId);
      if (previous === undefined || relevance > previous) relevanceByChunk.set(hit.chunkId, relevance);
    }
  }

  const keywordQuery = relatedKeywordQuery(`${input.question} ${anchors}`);
  let lexical: Array<{ chunkId: number; rank: number }> = [];
  if (keywordQuery) {
    try {
      lexical = store.searchLexical(keywordQuery, LEXICAL_POOL).map((hit) => ({ chunkId: hit.chunkId, rank: hit.rank }));
    } catch {
      lexical = [];
    }
  }

  const chunkIds = [...new Set([...relevanceByChunk.keys(), ...lexical.map((hit) => hit.chunkId)])];
  const placements = new Map<number, ChunkPlacement>();
  try {
    for (const placement of store.getChunkPlacements(chunkIds)) placements.set(placement.id, placement);
  } catch {
    return { ...empty, elapsedMs: Date.now() - started };
  }

  const ranked = rollUpRelatedWork({
    semantic: [...relevanceByChunk.entries()].map(([chunkId, relevance]) => ({ chunkId, relevance })),
    lexical,
    placements,
    nodesByDocKey,
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

  return { ranked, handed, passages, semantic: vectors.length > 0, elapsedMs: Date.now() - started };
}

/** A related task, and the project it was found in. */
export interface ProjectRelatedWorkTask extends RelatedWorkTask {
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
  semantic: boolean;
  elapsedMs: number;
}

/** Where a task's best passage is kept in `ProjectRelatedWork.passages`. */
export function passageKey(projectId: string, chunkId: number): string {
  return `${projectId}:${chunkId}`;
}

/** One project's related work, stamped with that project. */
export function toProjectRelatedWork(work: RelatedWork, projectId: string): ProjectRelatedWork {
  const stamp = (task: RelatedWorkTask): ProjectRelatedWorkTask => ({ ...task, projectId });
  return {
    ranked: work.ranked.map(stamp),
    handed: work.handed.map(stamp),
    passages: new Map([...work.passages].map(([chunkId, text]) => [passageKey(projectId, chunkId), text])),
    semantic: work.semantic,
    elapsedMs: work.elapsedMs,
  };
}

export interface SearchRelatedWorkAcrossInput extends Omit<SearchRelatedWorkInput, 'projectId' | 'nodes' | 'queryVectors'> {
  /** Each project in the question's scope, with its nodes inside the map's filters. */
  projects: ReadonlyArray<{ projectId: string; nodes: ReadonlyArray<RelatedWorkNode> }>;
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
  const vectors = await embedQuery(input.embedder, relatedQueryTexts(input.question, anchorQuestions), input.embedWaitMs);

  const ranked: ProjectRelatedWorkTask[] = [];
  const passages = new Map<string, string>();
  for (const project of input.projects) {
    if (project.nodes.length === 0) continue;
    // Each search is synchronous SQLite (a KNN over the whole project, about
    // 350 ms on the largest index), and with the vectors already in hand
    // nothing in it awaits. Yielding between projects lets terminal output and
    // IPC through, so asking across every project freezes main for one
    // project's search at a time, never all of them back to back.
    await new Promise<void>((resolve) => setImmediate(resolve));
    let work: RelatedWork;
    try {
      work = await searchRelatedWork({
        question: input.question,
        anchorQuestions,
        projectId: project.projectId,
        nodes: project.nodes,
        embedder: input.embedder,
        queryVectors: vectors,
        embedWaitMs: input.embedWaitMs,
        getDb: input.getDb,
      });
    } catch {
      continue;
    }
    const stamped = toProjectRelatedWork(work, project.projectId);
    ranked.push(...stamped.ranked);
    for (const [key, text] of stamped.passages) passages.set(key, text);
  }

  ranked.sort((left, right) => right.score - left.score);
  const top = ranked[0]?.score ?? 0;
  const rescored = ranked.map((task) => ({ ...task, strength: top > 0 ? task.score / top : 0 }));
  return {
    ranked: rescored,
    handed: selectHandedTasks(rescored, input.pinnedKeys),
    passages,
    semantic: vectors.length > 0,
    elapsedMs: Date.now() - started,
  };
}

/** A rollup node, plus the session that opens it. */
export interface IndexedConversationNode extends RelatedWorkNode {
  sessionId: string | null;
}

/**
 * Every indexed conversation in a project as a rollup node, read off the index
 * itself rather than the Memory Graph's projection, so a caller with no map
 * (the `kangentic_search` tool) can rank tasks the same way Ask does. Empty
 * when the project has no index.
 */
export function indexedConversationNodes(
  projectId: string,
  getDb: (projectId: string) => Database.Database = getProjectDb,
): IndexedConversationNode[] {
  try {
    return new RetrievalStore(getDb(projectId)).documentMetadata()
      .filter((row) => row.corpus === 'conversation')
      .map((row) => ({
        docKey: `${row.corpus}::${row.docId}`,
        taskId: row.taskId,
        displayId: row.displayId,
        title: row.title,
        sessionId: row.sessionId,
      }));
  } catch {
    return [];
  }
}
