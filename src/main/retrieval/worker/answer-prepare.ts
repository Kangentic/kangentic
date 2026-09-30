/**
 * Ask's reads, in the retrieval worker: each project's map, the board table
 * built from it, the conversations inside the map's filters, the related work,
 * and the handed tasks' summaries. Main keeps everything that is not the index:
 * the answering agent and its warm session, the refs the prompt writes, the
 * prompt, and the stream to the renderer (`ipc/handlers/search.ts`).
 *
 * One call, so a question costs one round trip before the agent starts. It
 * stops early where the handler used to, before any search runs: every map in
 * scope still building, or a table with no rows to answer from.
 */

import type Database from 'better-sqlite3';
import {
  boardRecordTasks,
  readBoardTaskFacts,
  searchRelatedWork,
  searchRelatedWorkAcross,
  toProjectRelatedWork,
  type ProjectRelatedWork,
} from '../related-work';
import { buildAnswerTaskTable, mergeAnswerTaskTables, type AnswerTaskTable } from '../answer-tasks';
import { SummaryStore } from '../summary/summary-store';
import { precomputedEmbedder, type QueryVectors } from '../query-vectors';
import { timeSyncWork } from '../../diagnostics/event-loop-lag';
import type { KnowledgeGraphProjection } from '../../../shared/types';

/** A project in a question's scope whose map has not been built yet: it brings
 *  its board tasks and no conversations. */
const EMPTY_PROJECTION = { nodes: [], clusterings: [] };

export interface AnswerPrepareParams {
  /** The projects asked across, in scope order, each with the ticket prefix
   *  its rows carry across projects (null for one project). */
  projects: Array<{ id: string; name: string; refPrefix: string | null }>;
  /** The region granularity the reader is looking at. */
  granularity: string;
  /** The conversations inside the map's filters, or null when unfiltered. */
  scopeDocKeys: string[] | null;
  question: string;
  /** Earlier questions in the chat, so a follow-up searches the same subject. */
  anchorQuestions: string[];
  /** Task keys a follow-up keeps from the turn before. */
  pinnedKeys: string[];
  /** Vectors main embedded from `relatedQueryTexts`, in that order. */
  queryVectors: QueryVectors | null;
  /** Source code is indexed, so code passages are searched. */
  code: boolean;
  /** The chat's warm session already holds a table, so a table with no rows
   *  now is not the end of the question. */
  primed: boolean;
}

export interface PreparedAnswer {
  /** `map-building`: no project in scope has a map yet. `no-rows`: nothing to
   *  answer from. Either way nothing was searched. */
  status: 'ready' | 'map-building' | 'no-rows';
  /** The board table, built fresh for this turn's facts. */
  table: AnswerTaskTable;
  /** The conversations inside the filters, for the search trace. */
  nodesInScope: Array<{ docKey: string; sessionId: string | null; taskId: string | null }>;
  related: ProjectRelatedWork;
  /** Each handed task's summary, by `${projectId}:${taskId}`. */
  summaries: Map<string, string>;
}

type ProjectionReader = (projectId: string) => KnowledgeGraphProjection | null;

function emptyRelated(): ProjectRelatedWork {
  return { ranked: [], handed: [], passages: new Map(), code: [], semantic: false, elapsedMs: 0 };
}

export async function prepareAnswer(
  params: AnswerPrepareParams,
  getDb: (projectId: string) => Database.Database,
  readProjection: ProjectionReader,
): Promise<PreparedAnswer> {
  const scope = params.scopeDocKeys ? new Set(params.scopeDocKeys) : null;
  const acrossProjects = params.projects.length > 1;
  const parts = params.projects.map((project) => ({ project, projection: readProjection(project.id) }));
  const emptyTable: AnswerTaskTable = { rows: [], droppedTasks: 0, conversationCount: 0, scoped: scope !== null, earliestMs: null, latestMs: null };
  if (parts.every((part) => !part.projection)) {
    return { status: 'map-building', table: emptyTable, nodesInScope: [], related: emptyRelated(), summaries: new Map() };
  }

  // The board: EVERY task inside the map's filters, not a retrieved subset.
  // Across projects each project's table is built on its own (its own regions,
  // its own board) and the tables merged, every ticket carrying its project.
  const tables = parts.map((part) => {
    const boardTasks = timeSyncWork('answer:board-tasks', () => readBoardTaskFacts(part.project.id, getDb));
    return timeSyncWork('answer:table', () => buildAnswerTaskTable(part.projection ?? EMPTY_PROJECTION, params.granularity, scope, boardTasks));
  });
  const table = acrossProjects
    ? mergeAnswerTaskTables(parts.map((part, index) => ({
      table: tables[index],
      projectId: part.project.id,
      name: part.project.name,
      refPrefix: part.project.refPrefix,
    })))
    : tables[0];
  if (table.rows.length === 0 && !params.primed) {
    return { status: 'no-rows', table, nodesInScope: [], related: emptyRelated(), summaries: new Map() };
  }

  // Unscoped, a task's own record reaches it even when none of its
  // conversations was indexed; the map's filters select conversations, so
  // under a filter only tasks with one inside it count (the board table's rule).
  const projectNodes = parts.map((part) => ({
    projectId: part.project.id,
    nodes: (part.projection?.nodes ?? []).filter((node) => !scope || scope.has(node.docKey)),
    ...(scope ? {} : { recordOnlyTasks: timeSyncWork('answer:record-tasks', () => boardRecordTasks(part.project.id, getDb)) }),
  }));
  const nodesInScope = projectNodes.flatMap((entry) => entry.nodes);

  // A failed search costs the related work, not the answer: the table still
  // settles every board question, and the agent can still search.
  let related: ProjectRelatedWork;
  try {
    const searchInput = {
      question: params.question,
      anchorQuestions: params.anchorQuestions,
      embedder: params.queryVectors ? precomputedEmbedder(params.queryVectors) : null,
      queryVectors: params.queryVectors ? params.queryVectors.vectors.map(([, vector]) => vector) : [],
      pinnedKeys: new Set(params.pinnedKeys),
      code: params.code,
      getDb,
    };
    related = acrossProjects
      ? await searchRelatedWorkAcross({ ...searchInput, projects: projectNodes })
      : toProjectRelatedWork(
        await searchRelatedWork({
          ...searchInput,
          projectId: parts[0].project.id,
          nodes: nodesInScope,
          recordOnlyTasks: projectNodes[0]?.recordOnlyTasks,
        }),
        parts[0].project.id,
      );
  } catch (error) {
    console.warn('[knowledge-graph] related work search failed, answering from the table:', error);
    related = emptyRelated();
  }

  // Each handed task's summary, read per project: a task id belongs to one.
  const summaries = timeSyncWork('answer:summaries', () => {
    const found = new Map<string, string>();
    const taskIdsByProject = new Map<string, string[]>();
    for (const task of related.handed) {
      if (!task.taskId) continue;
      const list = taskIdsByProject.get(task.projectId) ?? [];
      list.push(task.taskId);
      taskIdsByProject.set(task.projectId, list);
    }
    for (const [projectId, taskIds] of taskIdsByProject) {
      try {
        for (const [taskId, summary] of new SummaryStore(getDb(projectId)).summariesFor(taskIds)) {
          found.set(`${projectId}:${taskId}`, summary);
        }
      } catch {
        // The related work stands without its summaries.
      }
    }
    return found;
  });

  return {
    status: 'ready',
    table,
    nodesInScope: nodesInScope.map((node) => ({ docKey: node.docKey, sessionId: node.sessionId ?? null, taskId: node.taskId ?? null })),
    related,
    summaries,
  };
}
