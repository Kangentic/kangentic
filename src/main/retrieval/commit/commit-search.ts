import type Database from 'better-sqlite3';
import { RetrievalStore } from '../retrieval-store';
import { escapeFtsMatchQuery } from '../fts-query';
import { commitSubjectOf, subjectForAgents } from './commit-record';

/**
 * Commits on the default branch that match a query, for `kangentic_search`:
 * the other way into the commit links (`find_task` lists a task's commits; this
 * finds the task a commit came from). Only in the MCP tool: the palette's hit
 * union stays as it is.
 */

/** Commit hits a search returns. */
export const COMMIT_HITS = 10;
/** A query that could be a commit's sha: 7 to 40 hex digits. */
const SHA_PREFIX = /^[0-9a-f]{7,40}$/i;

export interface CommitHit {
  sha: string;
  /** Its subject as an agent is shown it (`subjectForAgents`). */
  subject: string;
  committedMs: number;
  /** The task it is linked to, by where its subject was first written; null when none. */
  taskId: string | null;
  displayId: number | null;
  taskTitle: string | null;
}

/**
 * The commits a query matches, newest sha-prefix matches first, then keyword
 * matches on the subject and body by bm25. A query that looks like a sha is
 * looked up as one AS WELL as searched as text, so a bare number keeps its
 * keyword matches. `taskId` keeps only one task's commits.
 */
export function searchCommits(
  db: Database.Database,
  query: string,
  options: { taskId?: string; limit?: number } = {},
): CommitHit[] {
  const limit = options.limit ?? COMMIT_HITS;
  const trimmed = query.trim();
  const store = new RetrievalStore(db);
  const found = new Map<string, { text: string; committedMs: number; taskId: string | null }>();

  if (SHA_PREFIX.test(trimmed)) {
    for (const row of store.commitsByShaPrefix(trimmed, limit)) {
      if (options.taskId && row.taskId !== options.taskId) continue;
      found.set(row.sha, { text: row.text, committedMs: row.committedMs, taskId: row.taskId });
    }
  }

  const matchQuery = escapeFtsMatchQuery(trimmed);
  if (matchQuery && found.size < limit) {
    const hits = store.searchLexical(matchQuery, limit, ['commit'], options.taskId);
    const chunks = new Map(store.getChunks(hits.map((hit) => hit.chunkId)).map((chunk) => [chunk.id, chunk]));
    for (const hit of hits) {
      const chunk = chunks.get(hit.chunkId);
      if (!chunk || found.has(chunk.docId) || found.size >= limit) continue;
      found.set(chunk.docId, { text: chunk.text, committedMs: chunk.tsStart ?? 0, taskId: chunk.taskId });
    }
  }
  if (found.size === 0) return [];

  const taskIds = [...new Set([...found.values()].map((entry) => entry.taskId).filter((taskId): taskId is string => taskId !== null))];
  const tasks = new Map<string, { displayId: number | null; title: string }>();
  if (taskIds.length > 0) {
    const rows = db
      .prepare(`SELECT id, display_id AS displayId, title FROM tasks WHERE id IN (${taskIds.map(() => '?').join(',')})`)
      .all(...taskIds) as Array<{ id: string; displayId: number | null; title: string }>;
    for (const row of rows) tasks.set(row.id, { displayId: row.displayId, title: row.title });
  }

  return [...found].map(([sha, entry]) => {
    const task = entry.taskId ? tasks.get(entry.taskId) : undefined;
    return {
      sha,
      subject: subjectForAgents(commitSubjectOf(entry.text)),
      committedMs: entry.committedMs,
      taskId: task ? entry.taskId : null,
      displayId: task?.displayId ?? null,
      taskTitle: task?.title ?? null,
    };
  });
}
