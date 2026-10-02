/**
 * What the retrieval worker answers: each method's params and result types,
 * and its handler. The worker entry (`retrieval-worker.ts`) only dispatches to
 * these, so they import cleanly with no `process.parentPort` and the unit tests
 * run them directly on a node:sqlite database.
 *
 * A handler is a thin wrapper over the retrieval code that already existed on
 * main. It reaches a project's database through `context.getDb`, which is
 * `getProjectDb` in the worker (a second connection, no migrations) and an
 * adapted node:sqlite database in tests.
 */

import type Database from 'better-sqlite3';
import { RetrievalStore } from '../retrieval-store';
import { searchConversationMemory, type TranscriptSearchHit } from '../memory-search';
import { precomputedEmbedder, type QueryVectors } from '../query-vectors';
import {
  boardRecordTasks,
  indexedConversationNodes,
  readBoardTaskFacts,
  searchRelatedWork,
  PASSAGES_SHOWN,
  type RelatedWork,
} from '../related-work';
import { searchCommits, type CommitHit } from '../commit/commit-search';
import { SummaryStore } from '../summary/summary-store';
import { readTaskKnowledge, type TaskKnowledge } from '../task-knowledge';
import type { BoardTaskFacts } from '../answer-tasks';
import type { Embedder, StoredChunk } from '../types';
import type { KnowledgeGraphQueryHit, KnowledgeGraphSnapshotWire, SessionSummary, SubagentUsageTotals, TaskFanOut } from '../../../shared/types';
import { ConversationUsageStore } from '../conversation/conversation-usage-store';
import type { RetrievalEventName } from './protocol';
import { createIndexStatusReader, type IndexStatus, type IndexStatusParams } from './index-status';
import { createGraphService } from '../graph/graph-service';
import { timeSyncWork } from '../../diagnostics/event-loop-lag';
import { awaitWriteTurn } from '../write-budget';
import { prepareAnswer, type AnswerPrepareParams, type PreparedAnswer } from './answer-prepare';
import { indexHandlers, type IndexMethods } from './index-methods';
import { transcriptHandlers, type TranscriptMethods } from './transcript-methods';
import { devIndexHandlers, type DevIndexMethods } from '../../../devtools/worker/dev-index-methods';
import { localEmbedStoreAccess, type EmbeddingRow } from '../embedder/embed-store-access';
import { localSummaryPassStore, type SummaryRow } from '../summary/summary-pass-store';
import { readSummaryFingerprint, type SummaryCandidate } from '../summary/summary-sources';
import { localUsageReader, type UsageReadName } from '../../usage-stats/project-usage-reader';
import { SessionRepository } from '../../db/repositories/session-repository';

const indexStatus = createIndexStatusReader();

type GraphService = ReturnType<typeof createGraphService>;

/**
 * The Knowledge Graph's map service, one per worker context (the worker has
 * one; a test may make several). It runs the passes and names the regions on
 * its own timers, so the config those read is the last value main sent:
 * `summaryNamesOn` rides on every call that can start naming.
 */
const graphs = new WeakMap<WorkerContext, { service: GraphService; summaryNamesOn: boolean }>();

/** The context's graph service, with the naming setting main just sent. */
function graphFor(context: WorkerContext, summaryNamesOn: boolean): GraphService {
  let holder = graphs.get(context);
  if (!holder) {
    const created: { service: GraphService; summaryNamesOn: boolean } = {
      service: createGraphService({ getDb: context.getDb, onChanged: (projectId) => context.emit('graph-changed', projectId) }),
      summaryNamesOn,
    };
    created.service.setSummaryNamesOn(() => created.summaryNamesOn);
    graphs.set(context, created);
    holder = created;
  }
  holder.summaryNamesOn = summaryNamesOn;
  return holder.service;
}

/** The last checkpoint logged per project, so a quiet WAL logs once. */
const lastCheckpointLogged = new Map<string, string>();

/** Dev builds: each project's WAL size and what a checkpoint copied, when it
 *  changed since the last line. */
function logCheckpoint(result: { projectId: string; walFrames: number; checkpointed: number; busy: boolean }): void {
  const line = `WAL ${result.walFrames} pages, ${result.checkpointed} copied${result.busy ? ', busy' : ''}`;
  if (lastCheckpointLogged.get(result.projectId) === line) return;
  lastCheckpointLogged.set(result.projectId, line);
  console.log(`[retrieval] checkpoint ${result.projectId.slice(0, 8)}: ${line}`);
}

/** A project as a search names it. */
export interface ProjectRef {
  id: string;
  name: string;
}

/** What a handler may use besides its params. */
export interface WorkerContext {
  getDb(projectId: string): Database.Database;
  /** Close the worker's connection to a project's database, if open. */
  closeDb(projectId: string): void;
  /** Why sqlite-vec last failed to load into a connection, or null. */
  vecLoadError(): string | null;
  /** Where sqlite-vec loads from, for a connection a dev seeder opens itself. */
  vecLoadablePath?(): string | null;
  /** Tell main something changed that it did not ask about. */
  emit(event: RetrievalEventName, projectId: string): void;
}

/** One project's row in the Knowledge Graph's Projects picker. */
export interface ProjectIndexSummaryRow {
  projectId: string;
  conversations: number;
  taskRecords: number;
  lastIndexedAt: string | null;
}

export interface RetrievalMethods extends IndexMethods, TranscriptMethods, DevIndexMethods {
  /** The embedding drain's read: the next chunks without a vector from this
   *  model, the vec tables put at its width first. Null: no vectors here. */
  'embed.nextBatch': {
    params: { projectId: string; dimensions: number; modelTag: string; limit: number };
    result: StoredChunk[] | null;
  };
  /** The embedding drain's write: one batch's vectors. */
  'embed.write': {
    params: { projectId: string; rows: EmbeddingRow[]; modelTag: string };
    result: void;
  };
  /** What a summary pass skips on when unchanged since it caught up. */
  'summary.fingerprint': {
    params: { projectId: string };
    result: string;
  };
  /** The summary pass's inputs (`SummaryPassStore.candidates`). */
  'summary.candidates': {
    params: { projectId: string; skip: string[] };
    result: SummaryCandidate[];
  };
  /** The summary pass's writes, one transaction; how many were saved. */
  'summary.save': {
    params: { projectId: string; rows: SummaryRow[] };
    result: number;
  };
  /** Every task's lifetime session summary, keyed by task id
   *  (`SessionRepository.listAllSummaries`, 66 to 71 ms on a long history). */
  'sessions.summaries': {
    params: { projectId: string };
    result: Record<string, SessionSummary>;
  };
  /** One of the usage dashboard's per-project reads (`ProjectUsageReader`),
   *  by name: main's `AsyncProjectUsageReader` types each result. */
  'usage.read': {
    params: { projectId: string; read: UsageReadName; args: unknown[] };
    result: unknown;
  };
  /** Let go of a project's database before main deletes its files. */
  'project.close': {
    params: { projectId: string };
    result: void;
  };
  /** A PASSIVE checkpoint of each project database main has open, for both
   *  processes' writes: main's own auto-checkpoint is off while the worker is
   *  up. PASSIVE never waits for or blocks a writer. A project whose database
   *  is gone is skipped. */
  'db.checkpoint': {
    params: { projectIds: string[] };
    result: Array<{ projectId: string; walFrames: number; checkpointed: number; busy: boolean } | null>;
  };
  /** The Knowledge Graph's snapshot, with the map as JSON only when the
   *  caller's key does not match (`graphService.getSnapshotWire`). Never runs
   *  the pass. */
  'graph.snapshot': {
    params: {
      projectId: string;
      modelTag: string;
      summaryNamesOn: boolean;
      summariesSkipped: number;
      knownProjectionKey: string | null;
    };
    result: KnowledgeGraphSnapshotWire;
  };
  /** Start a background map pass unless one is running. Returns at once: a
   *  cold pass runs for a minute, and its end arrives as `graph-changed`. */
  'graph.refresh': {
    params: { projectId: string; modelTag: string; dimensions: number; summaryNamesOn: boolean };
    result: void;
  };
  /** Ask's reads before its agent starts (`answer-prepare.ts`). */
  'answer.prepare': {
    params: AnswerPrepareParams & { summaryNamesOn: boolean };
    result: PreparedAnswer;
  };
  /** Summaries were written: name the regions again (urgent when caught up). */
  'graph.requestRegionNames': {
    params: { projectId: string; urgent: boolean; summaryNamesOn: boolean };
    result: void;
  };
  /** The index's half of the status poll (`index-status.ts`). */
  'status.index': {
    params: IndexStatusParams;
    result: IndexStatus & { vecError: string | null };
  };
  /** One task's written summary, or null. */
  'summary.forTask': {
    params: { projectId: string; taskId: string };
    result: string | null;
  };
  /** One task's subagent usage from the turn ledger, for
   *  `kangentic_get_task_stats`: totals per subagent type, and each fan-out
   *  (read only when the task has subagent turns). */
  'usage.taskSubagents': {
    params: { projectId: string; taskId: string };
    result: { bySubagentType: SubagentUsageTotals[]; fanOuts: TaskFanOut[] };
  };
  /** What the index knows about some tasks, for `kangentic_find_task` and
   *  `kangentic_get_current_task`: summary, linked commits, changed files. */
  'task.knowledge': {
    params: { projectId: string; taskIds: string[] };
    result: Map<string, TaskKnowledge>;
  };
  /** The Projects picker: what each project's index holds. A project whose
   *  database will not open answers null rather than failing the list. */
  'projects.summaries': {
    params: { projectIds: string[] };
    result: Array<ProjectIndexSummaryRow | null>;
  };
  /** Conversation search (Quick Find, `kangentic_search`, prior work): hybrid
   *  keyword and vector search, one best hit per session. */
  'search.conversations': {
    params: {
      query: string;
      projects: ProjectRef[];
      k?: number;
      taskId?: string;
      queryVectors: QueryVectors | null;
    };
    result: TranscriptSearchHit[];
  };
  /** Commits by subject, body or sha prefix, per project, in order. A project
   *  whose index cannot be read answers none. */
  'search.commits': {
    params: { projects: ProjectRef[]; query: string; taskId?: string };
    result: Array<CommitHit & { projectName: string }>;
  };
  /**
   * `kangentic_search`'s task ranking (groupBy "task", relatedToTask): one
   * project's related work, ranked as Ask ranks it, with what its rows show.
   * `excludeTaskId` leaves one task out entirely, its conversations and its
   * record. The query vectors are used in the order sent.
   */
  'related.rank': {
    params: {
      projectId: string;
      question: string;
      keywordText?: string;
      excludeTaskId?: string;
      queryVectors: QueryVectors | null;
      /** How many of the handed rows the caller shows: facts and summaries
       *  are read for these only. */
      rows?: number;
      /** Read each shown row's facts and its summary (for the strongest). */
      withExtras: boolean;
    };
    result: RankedRelatedWork;
  };
  /**
   * The task window's prior work: earlier conversations near one task, one row
   * per other task, strongest first. `query` is the task's own text; its own
   * conversations are dropped after ranking, since they match it best.
   */
  'task.priorWork': {
    params: {
      project: ProjectRef;
      taskId: string;
      query: string;
      queryVectors: QueryVectors | null;
      /** Fetched before the task's own conversations are dropped. */
      overfetch: number;
      rows: number;
    };
    result: KnowledgeGraphQueryHit[];
  };
}

/** A ranking with what `kangentic_search` prints beside it. */
export interface RankedRelatedWork {
  related: RelatedWork;
  /** The session each handed task's conversations open, by doc key. */
  sessionIdByDocKey: Map<string, string>;
  factsByTaskId: Map<string, BoardTaskFacts>;
  summaryByTaskId: Map<string, string>;
}

/** The vectors a search runs on, in the order main embedded them, and the
 *  embedder a search reads its noise floor from. */
function vectorsOf(queryVectors: QueryVectors | null): { embedder: Embedder | null; vectors: Float32Array[] } {
  if (!queryVectors) return { embedder: null, vectors: [] };
  return { embedder: precomputedEmbedder(queryVectors), vectors: queryVectors.vectors.map(([, vector]) => vector) };
}

type Handler<Params, Result> = (params: Params, context: WorkerContext) => Result | Promise<Result>;

/** Every product method has a handler; the dev seeders' methods exist only in
 *  a dev build, and the worker answers a missing one as unknown. */
export type RetrievalHandlers = {
  [Method in Exclude<keyof RetrievalMethods, keyof DevIndexMethods>]: Handler<RetrievalMethods[Method]['params'], RetrievalMethods[Method]['result']>;
} & {
  [Method in keyof DevIndexMethods]?: Handler<DevIndexMethods[Method]['params'], DevIndexMethods[Method]['result']>;
};

/** The drain's and the summary pass's steps on the worker's own connections,
 *  one of each per worker context. */
const embedStores = new WeakMap<WorkerContext, ReturnType<typeof localEmbedStoreAccess>>();
const summaryStores = new WeakMap<WorkerContext, ReturnType<typeof localSummaryPassStore>>();

function embedStoreFor(context: WorkerContext): ReturnType<typeof localEmbedStoreAccess> {
  let access = embedStores.get(context);
  if (!access) {
    access = localEmbedStoreAccess(context.getDb, (db) => new RetrievalStore(db));
    embedStores.set(context, access);
  }
  return access;
}

function summaryStoreFor(context: WorkerContext): ReturnType<typeof localSummaryPassStore> {
  let store = summaryStores.get(context);
  if (!store) {
    store = localSummaryPassStore(context.getDb);
    summaryStores.set(context, store);
  }
  return store;
}

export const retrievalHandlers: RetrievalHandlers = {
  // Folded to `{}` in a production build, which drops the dev module.
  ...(__KANGENTIC_DEV__ ? devIndexHandlers : {}),
  ...indexHandlers,
  ...transcriptHandlers,
  'embed.nextBatch': ({ projectId, dimensions, modelTag, limit }, context) => (
    embedStoreFor(context).nextBatch(projectId, { dimensions, modelTag }, limit)
  ),
  // The writeback takes its turn of the lock with the worker's other
  // background writes (`write-budget.ts`). When to embed stays the engine's.
  'embed.write': async ({ projectId, rows, modelTag }, context) => {
    let db: Database.Database | null = null;
    try {
      db = context.getDb(projectId);
    } catch {
      // The write below reports a project that is gone.
    }
    if (db) await awaitWriteTurn(db);
    return embedStoreFor(context).write(projectId, rows, modelTag);
  },
  'summary.fingerprint': ({ projectId }, context) => readSummaryFingerprint(context.getDb(projectId)),
  'summary.candidates': ({ projectId, skip }, context) => summaryStoreFor(context).candidates(projectId, skip),
  'summary.save': ({ projectId, rows }, context) => summaryStoreFor(context).save(projectId, rows),
  'sessions.summaries': ({ projectId }, context) => new SessionRepository(context.getDb(projectId)).listAllSummaries(),
  'usage.read': ({ projectId, read, args }, context) => {
    const reader = localUsageReader(context.getDb(projectId));
    if (!Object.hasOwn(reader, read)) throw new Error(`Unknown usage read: ${String(read)}`);
    return timeSyncWork(`usage:${read}`, () => (reader[read] as (...readArgs: unknown[]) => unknown)(...args));
  },
  'project.close': ({ projectId }, context) => {
    context.closeDb(projectId);
    indexStatus.forget(projectId);
    // Only a context that ever read a graph has one to forget; never create one here.
    graphs.get(context)?.service.forget(projectId);
  },
  'graph.snapshot': ({ projectId, modelTag, summaryNamesOn, summariesSkipped, knownProjectionKey }, context) => (
    graphFor(context, summaryNamesOn).getSnapshotWire(projectId, modelTag, { summariesSkipped, knownProjectionKey })
  ),
  'graph.refresh': ({ projectId, modelTag, dimensions, summaryNamesOn }, context) => {
    graphFor(context, summaryNamesOn).markDirty(projectId, modelTag, dimensions);
  },
  'answer.prepare': ({ summaryNamesOn, ...params }, context) => {
    // Each map named as the reader sees it, so an answer names a region the
    // way the map does.
    const graph = graphFor(context, summaryNamesOn);
    return prepareAnswer(params, context.getDb, (projectId) => graph.getProjection(projectId));
  },
  'graph.requestRegionNames': ({ projectId, urgent, summaryNamesOn }, context) => {
    graphFor(context, summaryNamesOn).requestRegionNames(projectId, urgent);
  },
  'db.checkpoint': ({ projectIds }, context) => projectIds.map((projectId) => {
    try {
      const db = context.getDb(projectId);
      const [row] = timeSyncWork('db:checkpoint', () => db.pragma('wal_checkpoint(PASSIVE)') as Array<{ busy: number; log: number; checkpointed: number }>);
      const result = { projectId, walFrames: row?.log ?? 0, checkpointed: row?.checkpointed ?? 0, busy: (row?.busy ?? 0) !== 0 };
      if (__KANGENTIC_DEV__) logCheckpoint(result);
      return result;
    } catch {
      return null;
    }
  }),
  'status.index': (params, context) => ({ ...indexStatus.read(context.getDb(params.projectId), params), vecError: context.vecLoadError() }),
  'summary.forTask': ({ projectId, taskId }, context) => new SummaryStore(context.getDb(projectId)).summariesFor([taskId]).get(taskId) ?? null,
  'task.knowledge': ({ projectId, taskIds }, context) => readTaskKnowledge(context.getDb(projectId), taskIds),
  'usage.taskSubagents': ({ projectId, taskId }, context) => {
    const usageStore = new ConversationUsageStore(context.getDb(projectId));
    const bySubagentType = usageStore.getSubagentTotalsByType(null, null, taskId);
    const subagentTurns = bySubagentType.reduce((total, row) => total + row.turnCount, 0);
    return { bySubagentType, fanOuts: subagentTurns > 0 ? usageStore.getTaskFanOuts(taskId) : [] };
  },
  'projects.summaries': ({ projectIds }, context) => projectIds.map((projectId) => {
    try {
      return { projectId, ...new RetrievalStore(context.getDb(projectId)).projectIndexSummary() };
    } catch {
      return null;
    }
  }),
  'search.conversations': ({ query, projects, k, taskId, queryVectors }, context) => searchConversationMemory({
    query,
    projects,
    k,
    taskId,
    embedder: queryVectors ? precomputedEmbedder(queryVectors) : null,
    getDb: context.getDb,
  }),
  'search.commits': ({ projects, query, taskId }, context) => projects.flatMap((project) => {
    try {
      return searchCommits(context.getDb(project.id), query, { taskId }).map((hit) => ({ ...hit, projectName: project.name }));
    } catch {
      return [];
    }
  }),
  'related.rank': async (params, context) => {
    const { projectId, excludeTaskId } = params;
    const nodes = indexedConversationNodes(projectId, context.getDb).filter((node) => !excludeTaskId || node.taskId !== excludeTaskId);
    // Unscoped: every board task is in reach of its own record, so a task with
    // no indexed conversation still ranks.
    const recordOnlyTasks = boardRecordTasks(projectId, context.getDb).filter((record) => record.taskId !== excludeTaskId);
    const { embedder, vectors } = vectorsOf(params.queryVectors);
    const related = await searchRelatedWork({
      question: params.question,
      keywordText: params.keywordText,
      projectId,
      nodes,
      recordOnlyTasks,
      embedder,
      queryVectors: vectors,
      getDb: context.getDb,
    });
    const shown = related.handed.slice(0, params.rows ?? related.handed.length);
    const handedDocKeys = new Set(shown.flatMap((task) => task.docKeys));
    const sessionIdByDocKey = new Map<string, string>();
    for (const node of nodes) {
      if (node.sessionId && handedDocKeys.has(node.docKey)) sessionIdByDocKey.set(node.docKey, node.sessionId);
    }
    const factsByTaskId = new Map<string, BoardTaskFacts>();
    let summaryByTaskId = new Map<string, string>();
    if (params.withExtras) {
      const shownTaskIds = new Set(shown.flatMap((task) => (task.taskId ? [task.taskId] : [])));
      for (const facts of readBoardTaskFacts(projectId, context.getDb)) {
        if (shownTaskIds.has(facts.taskId)) factsByTaskId.set(facts.taskId, facts);
      }
      // Written summaries show whatever the Task summaries switch says: it
      // stops new ones, and the written ones keep helping, as they do in Ask.
      const withSummary = shown
        .slice(0, PASSAGES_SHOWN)
        .flatMap((task) => (task.taskId ? [task.taskId] : []));
      try {
        summaryByTaskId = new SummaryStore(context.getDb(projectId)).summariesFor(withSummary);
      } catch {
        // The rows stand without summaries.
      }
    }
    return { related, sessionIdByDocKey, factsByTaskId, summaryByTaskId };
  },
  'task.priorWork': async ({ project, taskId, query, queryVectors, overfetch, rows }, context) => {
    const hits = await searchConversationMemory({
      query,
      projects: [project],
      embedder: queryVectors ? precomputedEmbedder(queryVectors) : null,
      // Over-fetch: this task's own conversations are usually the strongest
      // matches (its description IS the query), so they must be dropped after
      // ranking, not before.
      k: overfetch,
      getDb: context.getDb,
    });
    const docKeys = new RetrievalStore(context.getDb(project.id)).docKeysForChunks(hits.map((hit) => hit.chunkId));
    // One row per TASK, not per session: a task usually has several sessions,
    // and for "what have I already worked on" the task is the unit. Hits arrive
    // score-ordered, so the first one kept per task is its strongest.
    const seenTaskIds = new Set<string>();
    return hits
      .filter((hit) => {
        if (hit.taskId === taskId) return false;
        if (hit.taskId !== null) {
          if (seenTaskIds.has(hit.taskId)) return false;
          seenTaskIds.add(hit.taskId);
        }
        return true;
      })
      .slice(0, rows)
      .flatMap((hit): KnowledgeGraphQueryHit[] => {
        const docKey = docKeys.get(hit.chunkId);
        if (docKey === undefined) return [];
        return [{
          docKey,
          sessionId: hit.sessionId,
          taskId: hit.taskId,
          taskTitle: hit.taskTitle,
          agentName: hit.agentName,
          snippet: hit.snippet,
          score: hit.score,
          matchKind: hit.matchKind,
          matchCount: hit.matchCount,
          turnTs: hit.turnTs,
        }];
      });
  },
};
