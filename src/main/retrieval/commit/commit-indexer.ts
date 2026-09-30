import type Database from 'better-sqlite3';
import { getProjectDb } from '../../db/database';
import { RetrievalStore } from '../retrieval-store';
import { writeInSlices, type PreparedWrite } from '../timed-slices';
import { readBranchHead, runGit, type BranchHead } from '../branch-git';
import {
  COMMIT_LOG_FORMAT,
  COMMIT_RECORD_VERSION,
  LINK_GRACE_MS,
  commitChunks,
  commitLinkPhrase,
  parseCommitLog,
  type CommitEntry,
} from './commit-record';

/**
 * Keeps the `commit` corpus in step with the project's default branch: one
 * document per first-parent commit, tied to the task that wrote it
 * (`commit-record.ts`).
 *
 * Git runs as a child process, never on main's thread, and a sweep whose branch
 * has not moved since the last one costs a single `rev-parse`, plus a retry of
 * the young unlinked commits when a conversation was indexed since the last
 * retry (5 of them here, about 10 ms of lookups). A branch that
 * moved forward is read from the last indexed commit on; one that was rewritten
 * (a force push, a different default branch) is read whole and reconciled, so a
 * commit no longer on it leaves the index. The first sweep of a project links
 * every commit, about 2 ms a subject: 2,419 of them took 4.4 s of reads in
 * total, each made before its slice's write transaction begins.
 */

const CORPUS = 'commit';
const RECORD_SOURCE = `commit-record-v${COMMIT_RECORD_VERSION}`;
/** Where the last sweep's branch and head are kept. */
const HEAD_META_KEY = 'commit_index_head';
/** The newest conversation indexing the last relink pass saw. */
const RELINK_MARKER_KEY = 'commit_relink_marker';
/** The newest first-parent commits indexed. A history longer than this keeps its
 *  most recent part: the tasks a board holds are recent work. */
export const MAX_COMMITS = 5_000;
/** An unlinked commit this young is tried again on each sweep: its conversation
 *  may not have been indexed yet when the commit landed. */
export const RELINK_WINDOW_MS = 14 * 24 * 60 * 60 * 1000;

export interface CommitSweepResult {
  /** Commits written. */
  indexed: number;
  /** Commits removed because the branch no longer holds them. */
  removed: number;
  /** Previously unlinked commits now tied to a task. */
  relinked: number;
  /** The branch needs a full read and `allowFullRead` was false: nothing was read. */
  deferred: boolean;
}

export interface CommitSweepOptions {
  /** False stops between slices (a project switch, a shutdown). */
  shouldContinue?: () => boolean;
  /**
   * False puts off a read of the WHOLE branch (the first one, or after a
   * rewrite), which writes every commit. Measured during the preview's
   * startup it held main for single slices of 345 to 1,548 ms, twice, where
   * the same read with the app settled never passed 50 ms. A forward move of a
   * few commits and the no-move check still run.
   */
  allowFullRead?: boolean;
}

export interface CommitIndexerDeps {
  getDb: (projectId: string) => Database.Database;
  /** The first of `origin/<base>` and `<base>` that resolves, or null. */
  readHead: (projectPath: string, baseBranch: string) => Promise<BranchHead | null>;
  /** First-parent commits on `head`, newest first, after `sinceSha` when given. */
  readLog: (projectPath: string, head: string, sinceSha: string | null, maxCount: number) => Promise<CommitEntry[]>;
  isAncestor: (projectPath: string, ancestor: string, head: string) => Promise<boolean>;
  now: () => number;
  clock: () => number;
  yieldToEventLoop: () => Promise<void>;
}

const defaultDeps: CommitIndexerDeps = {
  getDb: getProjectDb,
  readHead: readBranchHead,
  readLog: async (projectPath, head, sinceSha, maxCount) => parseCommitLog(await runGit(projectPath, [
    'log', '--first-parent', `--max-count=${maxCount}`, `--format=${COMMIT_LOG_FORMAT}`,
    sinceSha ? `${sinceSha}..${head}` : head,
  ])),
  isAncestor: async (projectPath, ancestor, head) => {
    try {
      await runGit(projectPath, ['merge-base', '--is-ancestor', ancestor, head]);
      return true;
    } catch {
      return false;
    }
  },
  now: () => Date.now(),
  clock: () => performance.now(),
  yieldToEventLoop: () => new Promise((resolve) => setImmediate(resolve)),
};

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

/**
 * Bring one project's commits up to date with its default branch. A project
 * that is not a git repository, or has no such branch, is left as it is.
 * Never throws.
 */
export async function sweepCommitRecords(
  projectId: string,
  projectPath: string | null,
  baseBranch: string,
  options: CommitSweepOptions = {},
  deps: CommitIndexerDeps = defaultDeps,
): Promise<CommitSweepResult> {
  const shouldContinue = options.shouldContinue ?? (() => true);
  const result: CommitSweepResult = { indexed: 0, removed: 0, relinked: 0, deferred: false };
  if (!projectPath) return result;
  let db: Database.Database;
  let store: RetrievalStore;
  try {
    db = deps.getDb(projectId);
    store = new RetrievalStore(db);
  } catch (error) {
    console.warn('[retrieval] commit sweep could not open the index:', error);
    return result;
  }

  const head = await deps.readHead(projectPath, baseBranch).catch(() => null);
  if (!head || !shouldContinue()) return result;
  const stored = readStoredHead(store);
  // A cleared index (Rebuild, or the Privacy purge) drops the commits' state
  // rows but not the stored head, and a head that has not moved would then
  // never be read again. No rows at all means nothing is indexed yet.
  const anyIndexed = db.prepare("SELECT 1 FROM memory_index_state WHERE corpus = 'commit' LIMIT 1").get() !== undefined;
  const sameBranch = stored !== null && anyIndexed && stored.ref === head.ref && stored.version === COMMIT_RECORD_VERSION;

  if (!(sameBranch && stored.sha === head.sha)) {
    // Forward from the last indexed commit when the branch only moved forward;
    // otherwise the whole history, reconciled against what the index holds.
    const incremental = sameBranch && await deps.isAncestor(projectPath, stored.sha, head.sha).catch(() => false);
    if (!incremental && options.allowFullRead === false) {
      result.deferred = true;
      return result;
    }
    let commits: CommitEntry[];
    try {
      commits = await deps.readLog(projectPath, head.sha, incremental ? stored.sha : null, MAX_COMMITS);
    } catch (error) {
      console.warn('[retrieval] commit sweep could not read the branch:', error);
      return result;
    }
    if (!shouldContinue()) return result;

    const signatures = store.indexSignatures(CORPUS);
    const fresh = commits.filter((commit) => signatures.get(commit.sha)?.sourcePath !== RECORD_SOURCE);
    // The task lookup is a full-text read of about 2 ms a subject, so it runs
    // here, outside the write transaction.
    const prepareCommit = (commit: CommitEntry): PreparedWrite => {
      const chunks = commitChunks(commit);
      const phrase = commitLinkPhrase(commit.subject);
      const taskId = phrase ? store.firstTaskMentioning(phrase, commit.committedMs + LINK_GRACE_MS) : null;
      const textBytes = chunks.reduce((total, chunk) => total + chunk.text.length, 0);
      return {
        rows: chunks.length + 1,
        bytes: textBytes,
        write: () => {
          try {
            store.upsertDocument(
              { corpus: CORPUS, docId: commit.sha, sessionId: null, taskId, agentSessionId: null, metaJson: null },
              chunks,
            );
            store.setIndexState({
              corpus: CORPUS,
              docId: commit.sha,
              sessionId: null,
              sourcePath: RECORD_SOURCE,
              sourceMtimeMs: commit.committedMs,
              sourceSize: textBytes,
              // Whether it found its task: the relink pass reads it back.
              entryCount: taskId ? 1 : 0,
              chunkCount: chunks.length,
              status: 'ok',
              indexedAt: new Date(deps.now()).toISOString(),
            });
            result.indexed += 1;
          } catch (error) {
            console.warn(`[retrieval] commit ${commit.sha} failed to index:`, error);
          }
        },
      };
    };
    // Oldest first, so an interrupted first sweep leaves a contiguous history.
    if (!await writeInSlices(db, [...fresh].reverse(), prepareCommit, 'records:commit-slice', shouldContinue, deps)) {
      return result;
    }

    if (!incremental) {
      const onBranch = new Set(commits.map((commit) => commit.sha));
      const gone = [...new Set([...signatures.keys(), ...store.documentIds(CORPUS)])].filter((docId) => !onBranch.has(docId));
      const prepareRemoval = (docId: string): PreparedWrite => ({
        rows: store.documentChunkCount(CORPUS, docId) + 1,
        bytes: 0,
        write: () => {
          try {
            store.deleteDocument(CORPUS, docId);
            result.removed += 1;
          } catch (error) {
            console.warn(`[retrieval] commit ${docId} failed to remove:`, error);
          }
        },
      });
      if (!await writeInSlices(db, gone, prepareRemoval, 'records:commit-remove', shouldContinue, deps)) return result;
    }
    store.setMeta(HEAD_META_KEY, JSON.stringify({ ref: head.ref, sha: head.sha, version: COMMIT_RECORD_VERSION }));
  }

  result.relinked = await relinkYoungCommits(db, store, shouldContinue, deps);
  return result;
}

/**
 * Tie recent commits that found no task to one, now that more conversations
 * may be indexed. Only the young ones: an old commit's conversation is either
 * indexed by now or never will be. And only when a conversation was indexed
 * since the last pass, since nothing else can change the answer: a sweep runs
 * after every board burst, question and summary pass, and retrying the same
 * handful of commits each time was about 10 ms of lookups for nothing.
 */
async function relinkYoungCommits(
  db: Database.Database,
  store: RetrievalStore,
  shouldContinue: () => boolean,
  deps: CommitIndexerDeps,
): Promise<number> {
  let relinked = 0;
  let marker: string;
  try {
    marker = (db
      .prepare("SELECT MAX(indexed_at) AS latest FROM memory_index_state WHERE corpus = 'conversation'")
      .get() as { latest: string | null }).latest ?? '';
  } catch {
    return 0;
  }
  if (store.getMeta(RELINK_MARKER_KEY) === marker) return 0;
  let unlinked: Array<{ docId: string; committedMs: number }>;
  try {
    unlinked = db
      .prepare(
        `SELECT doc_id AS docId, source_mtime_ms AS committedMs FROM memory_index_state
         WHERE corpus = 'commit' AND entry_count = 0 AND source_mtime_ms >= ?`,
      )
      .all(deps.now() - RELINK_WINDOW_MS) as Array<{ docId: string; committedMs: number }>;
  } catch {
    return 0;
  }
  if (unlinked.length === 0) {
    store.setMeta(RELINK_MARKER_KEY, marker);
    return 0;
  }
  const subjectOf = db.prepare("SELECT text FROM memory_chunks WHERE corpus = 'commit' AND doc_id = ? AND seq = 0");
  // `indexed_at` moves too: the task's summary reads its commits, and the
  // summary pass's fingerprint watches that column.
  const markLinked = db.prepare("UPDATE memory_index_state SET entry_count = 1, indexed_at = ? WHERE corpus = 'commit' AND doc_id = ?");
  const prepareRelink = (commit: { docId: string; committedMs: number }): PreparedWrite | null => {
    const text = (subjectOf.get(commit.docId) as { text: string } | undefined)?.text ?? '';
    const phrase = commitLinkPhrase(text.split('\n')[0] ?? '');
    const taskId = phrase ? store.firstTaskMentioning(phrase, commit.committedMs + LINK_GRACE_MS) : null;
    if (!taskId) return null;
    return {
      // A commit is one chunk, and its state row.
      rows: 2,
      bytes: 0,
      write: () => {
        try {
          store.setDocumentTask(CORPUS, commit.docId, taskId);
          markLinked.run(new Date(deps.now()).toISOString(), commit.docId);
          relinked += 1;
        } catch (error) {
          console.warn(`[retrieval] commit ${commit.docId} failed to relink:`, error);
        }
      },
    };
  };
  // Only a finished pass is remembered, so one cut short runs again next time.
  if (await writeInSlices(db, unlinked, prepareRelink, 'records:commit-relink', shouldContinue, deps)) {
    store.setMeta(RELINK_MARKER_KEY, marker);
  }
  return relinked;
}
