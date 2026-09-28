import type Database from 'better-sqlite3';
import { getProjectDb } from '../../db/database';
import { RetrievalStore } from '../retrieval-store';
import { parseLabels, taskRecordChunks, TASK_RECORD_VERSION, type TaskRecordSource } from './task-record';

/**
 * Keeps the `task` corpus in step with the board: one document per task and
 * per backlog item, re-read when its `updated_at` moves, removed when it is
 * gone.
 *
 * Cheap enough to run whenever anything might have changed. A sweep with
 * nothing to do is two reads (the records' ids and edit times, and the index's
 * signatures) and no writes; the first sweep of a project chunks every record
 * once. A record whose edit changed only a lane or an order leaves its text
 * alone, so the diff-upsert writes nothing and nothing re-embeds.
 */

const CORPUS = 'task';
/** Records chunked between yields, so a first sweep never holds main. */
const RECORDS_PER_SLICE = 50;
/** Recorded as each record's source, so a format change re-reads every one. */
const RECORD_SOURCE = `task-record-v${TASK_RECORD_VERSION}`;
/** A backlog item's document id, distinct from any task id. */
export const BACKLOG_DOC_PREFIX = 'backlog:';

export interface TaskSweepResult {
  /** Records whose chunks were written. */
  indexed: number;
  /** Records removed because their task or backlog item is gone. */
  removed: number;
}

export interface TaskIndexerDeps {
  getDb: (projectId: string) => Database.Database;
  now: () => string;
  yieldToEventLoop: () => Promise<void>;
}

const defaultDeps: TaskIndexerDeps = {
  getDb: getProjectDb,
  now: () => new Date().toISOString(),
  yieldToEventLoop: () => new Promise((resolve) => setImmediate(resolve)),
};

interface RecordRow {
  id: string;
  title: string;
  description: string;
  labels: string | null;
  createdAt: string;
  updatedAt: string;
}

/** Every task and backlog item as a record source. */
export function readTaskRecordSources(db: Database.Database): TaskRecordSource[] {
  const tasks = db
    .prepare('SELECT id, title, description, labels, created_at AS createdAt, updated_at AS updatedAt FROM tasks')
    .all() as RecordRow[];
  let backlog: RecordRow[] = [];
  try {
    backlog = db
      .prepare('SELECT id, title, description, labels, created_at AS createdAt, updated_at AS updatedAt FROM backlog_tasks')
      .all() as RecordRow[];
  } catch {
    // A project database from before the backlog existed.
  }
  const toSource = (row: RecordRow, docId: string, taskId: string | null): TaskRecordSource => ({
    docId,
    taskId,
    title: row.title,
    description: row.description ?? '',
    labels: parseLabels(row.labels),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  });
  return [
    ...tasks.map((row) => toSource(row, row.id, row.id)),
    ...backlog.map((row) => toSource(row, `${BACKLOG_DOC_PREFIX}${row.id}`, null)),
  ];
}

/**
 * Bring one project's task records up to date. Never throws: a project whose
 * database cannot be read is left as it is.
 */
export async function sweepTaskRecords(
  projectId: string,
  shouldContinue: () => boolean = () => true,
  deps: TaskIndexerDeps = defaultDeps,
): Promise<TaskSweepResult> {
  const result: TaskSweepResult = { indexed: 0, removed: 0 };
  let db: Database.Database;
  let sources: TaskRecordSource[];
  let store: RetrievalStore;
  let signatures: ReturnType<RetrievalStore['indexSignatures']>;
  try {
    db = deps.getDb(projectId);
    store = new RetrievalStore(db);
    sources = readTaskRecordSources(db);
    signatures = store.indexSignatures(CORPUS);
  } catch (error) {
    console.warn('[retrieval] task record sweep could not read the board:', error);
    return result;
  }

  const stale = sources.filter((source) => {
    const signature = signatures.get(source.docId);
    const updatedMs = Date.parse(source.updatedAt);
    return !signature
      || signature.sourcePath !== RECORD_SOURCE
      || signature.sourceMtimeMs !== (Number.isNaN(updatedMs) ? null : updatedMs);
  });

  for (let start = 0; start < stale.length; start += RECORDS_PER_SLICE) {
    if (!shouldContinue()) return result;
    for (const source of stale.slice(start, start + RECORDS_PER_SLICE)) {
      const chunks = taskRecordChunks(source);
      const updatedMs = Date.parse(source.updatedAt);
      try {
        store.upsertDocument(
          { corpus: CORPUS, docId: source.docId, sessionId: null, taskId: source.taskId, agentSessionId: null, metaJson: null },
          chunks,
        );
        store.setIndexState({
          corpus: CORPUS,
          docId: source.docId,
          sessionId: null,
          sourcePath: RECORD_SOURCE,
          sourceMtimeMs: Number.isNaN(updatedMs) ? null : updatedMs,
          sourceSize: chunks.reduce((total, chunk) => total + chunk.text.length, 0),
          entryCount: 1,
          chunkCount: chunks.length,
          status: 'ok',
          indexedAt: deps.now(),
        });
        result.indexed += 1;
      } catch (error) {
        console.warn(`[retrieval] task record ${source.docId} failed to index:`, error);
      }
    }
    await deps.yieldToEventLoop();
  }

  // Records whose task or backlog item is gone: deleted, or promoted from the
  // backlog (which gives the task a new id and removes the backlog row).
  const live = new Set(sources.map((source) => source.docId));
  const indexed = new Set([...signatures.keys(), ...store.documentIds(CORPUS)]);
  for (const docId of indexed) {
    if (live.has(docId)) continue;
    if (!shouldContinue()) return result;
    try {
      store.deleteDocument(CORPUS, docId);
      result.removed += 1;
    } catch (error) {
      console.warn(`[retrieval] task record ${docId} failed to remove:`, error);
    }
  }
  return result;
}
