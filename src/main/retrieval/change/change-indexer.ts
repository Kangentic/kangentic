import type Database from 'better-sqlite3';
import { getProjectDb } from '../../db/database';
import { agentRegistry } from '../../agent/agent-registry';
import { RetrievalStore } from '../retrieval-store';
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
 * chunk. The first sweep of a project reads every conversation's chunk text
 * once, in slices.
 */

const CORPUS = 'change';
/** Conversations derived between yields. */
const DOCUMENTS_PER_SLICE = 20;
const RECORD_SOURCE = `change-record-v${CHANGE_RECORD_VERSION}`;

export interface ChangeSweepResult {
  /** Conversations whose change document was written (possibly as nothing). */
  indexed: number;
}

export interface ChangeIndexerDeps {
  getDb: (projectId: string) => Database.Database;
  /** The adapter's file-changing tools for a session type, or none. */
  toolsFor: (sessionType: string) => ReadonlyArray<FileChangeTool>;
  now: () => string;
  yieldToEventLoop: () => Promise<void>;
}

const defaultDeps: ChangeIndexerDeps = {
  getDb: getProjectDb,
  toolsFor: (sessionType) => agentRegistry.getBySessionType(sessionType)?.fileChangeTools ?? [],
  now: () => new Date().toISOString(),
  yieldToEventLoop: () => new Promise((resolve) => setImmediate(resolve)),
};

interface ConversationState {
  docId: string;
  sessionId: string | null;
  indexedAt: string;
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
  for (let start = 0; start < stale.length; start += DOCUMENTS_PER_SLICE) {
    if (!shouldContinue()) return result;
    for (const conversation of stale.slice(start, start + DOCUMENTS_PER_SLICE)) {
      try {
        const chunks = store.getChunksForDoc('conversation', conversation.docId);
        // No text to read: a conversation recorded before anything was indexed.
        if (chunks.length === 0) continue;
        const sessionId = chunks[chunks.length - 1].sessionId ?? conversation.sessionId;
        const taskId = chunks[chunks.length - 1].taskId;
        const sessionType = sessionId
          ? (sessionTypeStatement.get(sessionId) as { sessionType: string } | undefined)?.sessionType
          : undefined;
        const tools = sessionType ? deps.toolsFor(sessionType) : [];
        const byPath = new Map<string, number>();
        for (const [rawPath, changes] of changedFilesFromChunkTexts(chunks.map((chunk) => chunk.text), tools)) {
          const relative = repoRelativePath(rawPath, projectPath);
          if (relative) byPath.set(relative, (byPath.get(relative) ?? 0) + changes);
        }
        const lastMs = chunks.reduce<number | null>((latest, chunk) => (
          chunk.tsEnd !== null && (latest === null || chunk.tsEnd > latest) ? chunk.tsEnd : latest
        ), null);
        const changeChunks = changeRecordChunks(
          [...byPath].map(([path, changes]) => ({ path, changes })),
          lastMs,
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
    }
    await deps.yieldToEventLoop();
  }
  return result;
}
