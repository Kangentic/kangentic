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
import type { RetrievalEventName } from './protocol';

/** What a handler may use besides its params. */
export interface WorkerContext {
  getDb(projectId: string): Database.Database;
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

export interface RetrievalMethods {
  /** The Projects picker: what each project's index holds. A project whose
   *  database will not open answers null rather than failing the list. */
  'projects.summaries': {
    params: { projectIds: string[] };
    result: Array<ProjectIndexSummaryRow | null>;
  };
}

type Handler<Params, Result> = (params: Params, context: WorkerContext) => Result | Promise<Result>;

export type RetrievalHandlers = {
  [Method in keyof RetrievalMethods]: Handler<RetrievalMethods[Method]['params'], RetrievalMethods[Method]['result']>;
};

export const retrievalHandlers: RetrievalHandlers = {
  'projects.summaries': ({ projectIds }, context) => projectIds.map((projectId) => {
    try {
      return { projectId, ...new RetrievalStore(context.getDb(projectId)).projectIndexSummary() };
    } catch {
      return null;
    }
  }),
};
