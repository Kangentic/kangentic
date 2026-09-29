import type Database from 'better-sqlite3';
import { getProjectDb } from '../../db/database';
import { agentRegistry } from '../../agent/agent-registry';
import { RetrievalStore } from '../retrieval-store';
import { timeSyncWork } from '../../diagnostics/event-loop-lag';
import { SLICE_BUDGET_MS, writeInTimedSlices } from '../timed-slices';
import {
  CHANGE_RECORD_VERSION,
  changedFilesFromChunkTexts,
  changeRecordChunks,
  repoRelativePath,
  type FileChangeTool,
} from './change-record';

/**
 * Keeps the `change` corpus in step with the conversations: one document per
 * conversation, holding the files that session changed, under the
 * conversation's own document id so it is in scope exactly when its
 * conversation is.
 *
 * A change document is re-derived when its conversation was re-indexed since
 * (the conversation's `indexed_at` is recorded as the change row's source
 * time), so a sweep with nothing to do reads two small state tables and no
 * chunk. A live session is re-indexed every turn, so its whole text is read
 * again on the next sweep after one: that read goes a page at a time, and the
 * first sweep of a project reads every conversation that way.
 */

const CORPUS = 'change';
const RECORD_SOURCE = `change-record-v${CHANGE_RECORD_VERSION}`;
/** Chunks read at a time. Read and parsed whole, the longest conversation here
 *  (4,832 chunks, 8 MB of text) held main for 58 ms; a page is about 5 ms, and
 *  the read yields between pages once a slice's budget is spent. */
const CHUNKS_PER_PAGE = 400;

export interface ChangeSweepResult {
  /** Conversations whose change document was written (possibly as nothing). */
  indexed: number;
}

export interface ChangeIndexerDeps {
  getDb: (projectId: string) => Database.Database;
  /** The adapter's file-changing tools for a session type, or none. */
  toolsFor: (sessionType: string) => ReadonlyArray<FileChangeTool>;
  now: () => string;
  clock: () => number;
  yieldToEventLoop: () => Promise<void>;
}

const defaultDeps: ChangeIndexerDeps = {
  getDb: getProjectDb,
  toolsFor: (sessionType) => agentRegistry.getBySessionType(sessionType)?.fileChangeTools ?? [],
  now: () => new Date().toISOString(),
  clock: () => performance.now(),
  yieldToEventLoop: () => new Promise((resolve) => setImmediate(resolve)),
};

interface ConversationState {
  docId: string;
  sessionId: string | null;
  indexedAt: string;
}

/** What one conversation changed, read and ready to write. */
interface DerivedChange {
  conversation: ConversationState;
  sessionId: string | null;
  taskId: string | null;
  byPath: Map<string, number>;
  lastMs: number | null;
}

/**
 * Bring one project's session changes up to date. `projectPath` makes a file
 * in the main checkout repository-relative (a worktree's path already says
 * where the repository starts). Never throws.
 */
export async function sweepChangeRecords(
  projectId: string,
  projectPath: string | null,
  shouldContinue: () => boolean = () => true,
  deps: ChangeIndexerDeps = defaultDeps,
): Promise<ChangeSweepResult> {
  const result: ChangeSweepResult = { indexed: 0 };
  let db: Database.Database;
  let store: RetrievalStore;
  let conversations: ConversationState[];
  let signatures: ReturnType<RetrievalStore['indexSignatures']>;
  try {
    db = deps.getDb(projectId);
    store = new RetrievalStore(db);
    conversations = db
      .prepare("SELECT doc_id AS docId, session_id AS sessionId, indexed_at AS indexedAt FROM memory_index_state WHERE corpus = 'conversation'")
      .all() as ConversationState[];
    signatures = store.indexSignatures(CORPUS);
  } catch (error) {
    console.warn('[retrieval] change sweep could not read the index:', error);
    return result;
  }

  const stale = conversations.filter((conversation) => {
    const signature = signatures.get(conversation.docId);
    const indexedMs = Date.parse(conversation.indexedAt);
    return !signature
      || signature.sourcePath !== RECORD_SOURCE
      || signature.sourceMtimeMs !== (Number.isNaN(indexedMs) ? null : indexedMs);
  });
  if (stale.length === 0) return result;

  const sessionTypeStatement = db.prepare('SELECT session_type AS sessionType FROM sessions WHERE id = ?');
  let sliceStartedMs = deps.clock();
  const pauseIfSpent = async (): Promise<void> => {
    if (deps.clock() - sliceStartedMs < SLICE_BUDGET_MS) return;
    await deps.yieldToEventLoop();
    sliceStartedMs = deps.clock();
  };

  /** One conversation's changed files, read a page at a time outside any
   *  transaction. Null for a conversation with no text yet. */
  const readChange = async (conversation: ConversationState): Promise<DerivedChange | null> => {
    const rawCounts = new Map<string, number>();
    let tools: ReadonlyArray<FileChangeTool> | null = null;
    let lastSeq = -1;
    let sessionId: string | null = null;
    let taskId: string | null = null;
    let lastMs: number | null = null;
    for (;;) {
      const page = timeSyncWork('records:change-read', () => (
        store.chunkTextPage('conversation', conversation.docId, lastSeq, CHUNKS_PER_PAGE)
      ));
      if (page.length === 0) break;
      if (tools === null) {
        // Every chunk of a conversation is the same agent CLI's transcript, so
        // the first page names the tools for the rest.
        const firstSessionId = page[page.length - 1].sessionId ?? conversation.sessionId;
        const sessionType = firstSessionId
          ? (sessionTypeStatement.get(firstSessionId) as { sessionType: string } | undefined)?.sessionType
          : undefined;
        tools = sessionType ? deps.toolsFor(sessionType) : [];
      }
      for (const [rawPath, changes] of changedFilesFromChunkTexts(page.map((chunk) => chunk.text), tools)) {
        rawCounts.set(rawPath, (rawCounts.get(rawPath) ?? 0) + changes);
      }
      for (const chunk of page) {
        if (chunk.tsEnd !== null && (lastMs === null || chunk.tsEnd > lastMs)) lastMs = chunk.tsEnd;
      }
      const lastChunk = page[page.length - 1];
      lastSeq = lastChunk.seq;
      sessionId = lastChunk.sessionId;
      taskId = lastChunk.taskId;
      if (page.length < CHUNKS_PER_PAGE) break;
      await pauseIfSpent();
    }
    // No text to read: a conversation recorded before anything was indexed.
    if (lastSeq < 0) return null;
    const byPath = new Map<string, number>();
    for (const [rawPath, changes] of rawCounts) {
      const relative = repoRelativePath(rawPath, projectPath);
      if (relative) byPath.set(relative, (byPath.get(relative) ?? 0) + changes);
    }
    return { conversation, sessionId: sessionId ?? conversation.sessionId, taskId, byPath, lastMs };
  };

  const derived: DerivedChange[] = [];
  for (const conversation of stale) {
    if (!shouldContinue()) return result;
    try {
      const change = await readChange(conversation);
      if (change) derived.push(change);
    } catch (error) {
      console.warn(`[retrieval] session changes for ${conversation.docId} failed to read:`, error);
    }
    await pauseIfSpent();
  }

  const writeChange = (change: DerivedChange): void => {
    const { conversation, sessionId, taskId, byPath } = change;
    try {
      const changeChunks = changeRecordChunks(
        [...byPath].map(([path, changes]) => ({ path, changes })),
        change.lastMs,
      );
      // Written even when empty: an empty upsert clears a stale document, and
      // the state row keeps a session that changed nothing from being re-read.
      store.upsertDocument(
        { corpus: CORPUS, docId: conversation.docId, sessionId, taskId, agentSessionId: conversation.docId, metaJson: null },
        changeChunks,
      );
      const indexedMs = Date.parse(conversation.indexedAt);
      store.setIndexState({
        corpus: CORPUS,
        docId: conversation.docId,
        sessionId,
        sourcePath: RECORD_SOURCE,
        sourceMtimeMs: Number.isNaN(indexedMs) ? null : indexedMs,
        sourceSize: byPath.size,
        entryCount: byPath.size,
        chunkCount: changeChunks.length,
        status: 'ok',
        indexedAt: deps.now(),
      });
      result.indexed += 1;
    } catch (error) {
      console.warn(`[retrieval] session changes for ${conversation.docId} failed to index:`, error);
    }
  };
  await writeInTimedSlices(db, derived, writeChange, 'records:change-slice', shouldContinue, deps);
  return result;
}
