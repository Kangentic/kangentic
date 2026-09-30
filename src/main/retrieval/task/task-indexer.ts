import type Database from 'better-sqlite3';
import { getProjectDb } from '../../db/database';
import { RetrievalStore } from '../retrieval-store';
import { timeSyncWork } from '../../diagnostics/event-loop-lag';
import { writeInSlices, type PreparedWrite } from '../timed-slices';
import { parseLabels, recordChangedMs, taskRecordChunks, TASK_RECORD_VERSION, type TaskRecordSource } from './task-record';

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
  clock: () => number;
  yieldToEventLoop: () => Promise<void>;
}

const defaultDeps: TaskIndexerDeps = {
  getDb: getProjectDb,
  now: () => new Date().toISOString(),
  clock: () => performance.now(),
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

/** Every task and backlog item as a record source, each task with its summary. */
export function readTaskRecordSources(db: Database.Database): TaskRecordSource[] {
  const tasks = db
    .prepare(
      `SELECT t.id, t.title, t.description, t.labels, t.created_at AS createdAt, t.updated_at AS updatedAt,
              d.summary AS summary, d.created_at AS summaryAt
       FROM tasks t LEFT JOIN memory_task_summaries d ON d.task_id = t.id`,
    )
    .all() as Array<RecordRow & { summary: string | null; summaryAt: string | null }>;
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
    ...tasks.map((row) => ({ ...toSource(row, row.id, row.id), summary: row.summary, summaryAt: row.summaryAt })),
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
    sources = timeSyncWork('records:task-read', () => readTaskRecordSources(db));
    signatures = timeSyncWork('records:task-signatures', () => store.indexSignatures(CORPUS));
  } catch (error) {
    console.warn('[retrieval] task record sweep could not read the board:', error);
    return result;
  }

  const stale = sources.filter((source) => {
    const signature = signatures.get(source.docId);
    return !signature
      || signature.sourcePath !== RECORD_SOURCE
      || signature.sourceMtimeMs !== recordChangedMs(source);
  });

  const prepareRecord = (source: TaskRecordSource): PreparedWrite => {
    const chunks = taskRecordChunks(source);
    const textBytes = chunks.reduce((total, chunk) => total + chunk.text.length, 0);
    return {
      rows: chunks.length + 1,
      bytes: textBytes,
      write: () => {
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
            sourceMtimeMs: recordChangedMs(source),
            sourceSize: textBytes,
            entryCount: 1,
            chunkCount: chunks.length,
            status: 'ok',
            indexedAt: deps.now(),
          });
          result.indexed += 1;
        } catch (error) {
          console.warn(`[retrieval] task record ${source.docId} failed to index:`, error);
        }
      },
    };
  };
  if (!await writeInSlices(db, stale, prepareRecord, 'records:task-slice', shouldContinue, deps)) return result;

  // Records whose task or backlog item is gone: deleted, or promoted from the
  // backlog (which gives the task a new id and removes the backlog row).
  const live = new Set(sources.map((source) => source.docId));
  const gone = [...new Set([...signatures.keys(), ...store.documentIds(CORPUS)])].filter((docId) => !live.has(docId));
  const prepareRemoval = (docId: string): PreparedWrite => ({
    rows: store.documentChunkCount(CORPUS, docId) + 1,
    bytes: 0,
    write: () => {
      try {
        store.deleteDocument(CORPUS, docId);
        result.removed += 1;
      } catch (error) {
        console.warn(`[retrieval] task record ${docId} failed to remove:`, error);
      }
    },
  });
  await writeInSlices(db, gone, prepareRemoval, 'records:task-remove', shouldContinue, deps);
  return result;
}
