import type Database from 'better-sqlite3';
import { getProjectDb } from '../../db/database';
import { RetrievalStore } from '../retrieval-store';
import { writeInSlices, type PreparedWrite } from '../timed-slices';
import { listTree, readBlobs, readBranchHead, type BranchHead, type TreeEntry } from '../branch-git';
import { CODE_MAX_FILE_BYTES, CODE_RECORD_VERSION, codeChunks, isIndexableCodePath } from './code-record';

/**
 * Keeps the `code` corpus in step with the project's default branch, as
 * committed: one document per indexable file (`code-record.ts`), embedded by
 * the central engine, last in its drain.
 *
 * A file is re-read only when its blob changed. The blob id is a hash of the
 * file's content, recorded on its index state, so one rule covers a branch
 * that moved forward, one that was force-pushed and a different default branch
 * alike, the way Cursor's hash tree finds the files it must re-embed. A sweep
 * whose branch has not moved since the last one costs a single `rev-parse`;
 * one that moved lists the tree (one `git ls-tree`) and reads only the changed
 * blobs, through one `git cat-file --batch` process per 16 MB batch. An unchanged passage in a
 * changed file keeps its vector (the diff-upsert keys on content).
 */

const CORPUS = 'code';
const SOURCE_PREFIX = `code-record-v${CODE_RECORD_VERSION}:`;
/** Where the last sweep's branch and head are kept. */
const HEAD_META_KEY = 'code_index_head';

export interface CodeSweepResult {
  /** Files written (a binary one as a document with no chunks). */
  indexed: number;
  /** Files removed because the branch no longer holds them, or no longer indexes them. */
  removed: number;
  /** Nothing is indexed yet and `allowFullRead` was false: nothing was read. */
  deferred: boolean;
}

export interface CodeSweepOptions {
  shouldContinue?: () => boolean;
  /** False puts off the first read of the whole tree (see `CommitSweepOptions`). */
  allowFullRead?: boolean;
}

export interface CodeIndexerDeps {
  getDb: (projectId: string) => Database.Database;
  readHead: (projectPath: string, baseBranch: string) => Promise<BranchHead | null>;
  listTree: (projectPath: string, commit: string) => Promise<TreeEntry[]>;
  readBlobs: (projectPath: string, blobs: ReadonlyArray<string>) => Promise<Map<string, Buffer>>;
  now: () => number;
  clock: () => number;
  yieldToEventLoop: () => Promise<void>;
}

const defaultDeps: CodeIndexerDeps = {
  getDb: getProjectDb,
  readHead: readBranchHead,
  listTree,
  readBlobs,
  now: () => Date.now(),
  clock: () => performance.now(),
  yieldToEventLoop: () => new Promise((resolve) => setImmediate(resolve)),
};

/** The files of a tree the index holds. */
export function indexableEntries(entries: ReadonlyArray<TreeEntry>): TreeEntry[] {
  return entries.filter((entry) => entry.size <= CODE_MAX_FILE_BYTES && isIndexableCodePath(entry.path));
}

/** File bytes one `git cat-file` read brings into main before they are written.
 *  A file is at most `CODE_MAX_FILE_BYTES`, so a batch overshoots by one file at most. */
const BLOB_BATCH_BYTES = 16 * 1024 * 1024;

/** Entries in order, cut into runs whose sizes sum to at most `limitBytes`. */
export function batchesBySize(entries: ReadonlyArray<TreeEntry>, limitBytes: number): TreeEntry[][] {
  const batches: TreeEntry[][] = [];
  let current: TreeEntry[] = [];
  let currentBytes = 0;
  for (const entry of entries) {
    if (current.length > 0 && currentBytes + entry.size > limitBytes) {
      batches.push(current);
      current = [];
      currentBytes = 0;
    }
    current.push(entry);
    currentBytes += entry.size;
  }
  if (current.length > 0) batches.push(current);
  return batches;
}

/**
 * Bring one project's source code up to date with its default branch. A
 * project that is not a git repository, or has no such branch, is left as it
 * is. Never throws.
 */
export async function sweepCodeRecords(
  projectId: string,
  projectPath: string | null,
  baseBranch: string,
  options: CodeSweepOptions = {},
  deps: CodeIndexerDeps = defaultDeps,
): Promise<CodeSweepResult> {
  const shouldContinue = options.shouldContinue ?? (() => true);
  const result: CodeSweepResult = { indexed: 0, removed: 0, deferred: false };
  if (!projectPath) return result;
  let db: Database.Database;
  let store: RetrievalStore;
  try {
    db = deps.getDb(projectId);
    store = new RetrievalStore(db);
  } catch (error) {
    console.warn('[retrieval] code sweep could not open the index:', error);
    return result;
  }

  const head = await deps.readHead(projectPath, baseBranch).catch(() => null);
  if (!head || !shouldContinue()) return result;
  // No state rows at all means nothing is indexed yet, whatever the stored
  // head says (a cleared index keeps the meta row).
  const anyIndexed = db.prepare("SELECT 1 FROM memory_index_state WHERE corpus = 'code' LIMIT 1").get() !== undefined;
  const stored = readStoredHead(store);
  if (anyIndexed && stored?.ref === head.ref && stored.sha === head.sha && stored.version === CODE_RECORD_VERSION) return result;
  if (!anyIndexed && options.allowFullRead === false) {
    result.deferred = true;
    return result;
  }

  let entries: TreeEntry[];
  try {
    entries = indexableEntries(await deps.listTree(projectPath, head.sha));
  } catch (error) {
    console.warn('[retrieval] code sweep could not list the branch:', error);
    return result;
  }
  if (!shouldContinue()) return result;

  const signatures = store.indexSignatures(CORPUS);
  const changed = entries.filter((entry) => signatures.get(entry.path)?.sourcePath !== `${SOURCE_PREFIX}${entry.blob}`);
  const onBranch = new Set(entries.map((entry) => entry.path));
  const gone = [...new Set([...signatures.keys(), ...store.documentIds(CORPUS)])].filter((docId) => !onBranch.has(docId));

  // Read and written a batch at a time, so a first sweep of a large tree holds
  // one batch of file contents in main, never the whole changed set at once.
  for (const batch of batchesBySize(changed, BLOB_BATCH_BYTES)) {
    let contents: Map<string, Buffer>;
    try {
      contents = await deps.readBlobs(projectPath, [...new Set(batch.map((entry) => entry.blob))]);
    } catch (error) {
      console.warn('[retrieval] code sweep could not read the branch\'s files:', error);
      return result;
    }
    if (!shouldContinue()) return result;

    const prepareFile = (entry: TreeEntry): PreparedWrite | null => {
      const content = contents.get(entry.blob);
      if (!content) return null;
      const chunks = codeChunks(entry.path, content.toString('utf8'));
      return {
        rows: chunks.length + 1,
        bytes: entry.size,
        write: () => {
          try {
            store.upsertDocument(
              { corpus: CORPUS, docId: entry.path, sessionId: null, taskId: null, agentSessionId: null, metaJson: null },
              chunks,
            );
            store.setIndexState({
              corpus: CORPUS,
              docId: entry.path,
              sessionId: null,
              sourcePath: `${SOURCE_PREFIX}${entry.blob}`,
              sourceMtimeMs: null,
              sourceSize: entry.size,
              entryCount: 1,
              chunkCount: chunks.length,
              status: 'ok',
              indexedAt: new Date(deps.now()).toISOString(),
            });
            result.indexed += 1;
          } catch (error) {
            console.warn(`[retrieval] ${entry.path} failed to index:`, error);
          }
        },
      };
    };
    if (!await writeInSlices(db, batch, prepareFile, 'records:code-slice', shouldContinue, deps)) return result;
  }

  const prepareRemoval = (docId: string): PreparedWrite => ({
    rows: store.documentChunkCount(CORPUS, docId) + 1,
    bytes: 0,
    write: () => {
      try {
        store.deleteDocument(CORPUS, docId);
        result.removed += 1;
      } catch (error) {
        console.warn(`[retrieval] ${docId} failed to remove:`, error);
      }
    },
  });
  if (!await writeInSlices(db, gone, prepareRemoval, 'records:code-remove', shouldContinue, deps)) return result;

  store.setMeta(HEAD_META_KEY, JSON.stringify({ ref: head.ref, sha: head.sha, version: CODE_RECORD_VERSION }));
  return result;
}

/** Everything the code corpus holds, gone: source code switched off. The
 *  index is derived from the branch, so switching it back on rebuilds it. */
export function purgeCodeRecords(projectId: string, getDb: (projectId: string) => Database.Database = getProjectDb): boolean {
  try {
    const db = getDb(projectId);
    const anything = db.prepare("SELECT 1 FROM memory_index_state WHERE corpus = 'code' LIMIT 1").get() !== undefined
      || db.prepare("SELECT 1 FROM memory_chunks WHERE corpus = 'code' LIMIT 1").get() !== undefined;
    if (!anything) return false;
    new RetrievalStore(db).purgeCorpora([CORPUS]);
    return true;
  } catch (error) {
    console.warn('[retrieval] code index could not be cleared:', error);
    return false;
  }
}

/** The branch the code index last read (`origin/main`), or null before one. */
export function indexedCodeBranch(store: RetrievalStore): string | null {
  return readStoredHead(store)?.ref ?? null;
}

interface StoredHead {
  ref: string;
  sha: string;
  version: number;
}

function readStoredHead(store: RetrievalStore): StoredHead | null {
  try {
    const parsed = JSON.parse(store.getMeta(HEAD_META_KEY) ?? 'null') as Partial<StoredHead> | null;
    if (!parsed || typeof parsed.ref !== 'string' || typeof parsed.sha !== 'string' || typeof parsed.version !== 'number') return null;
    return { ref: parsed.ref, sha: parsed.sha, version: parsed.version };
  } catch {
    return null;
  }
}
