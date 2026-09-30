import type Database from 'better-sqlite3';
import { RetrievalStore } from './retrieval-store';
import { SummaryStore } from './summary/summary-store';
import { createTaskChangeTextsReader, rankChangedFiles } from './summary/summary-sources';
import { commitSubjectOf, subjectForAgents } from './commit/commit-record';

/**
 * What the Knowledge Graph knows about one task, for the task reads agents make
 * over MCP (`kangentic_find_task`, `kangentic_get_current_task`): the summary
 * an agent wrote when it finished, the default-branch commits linked to it, and
 * the files its sessions changed. Everything here is read from the index, so a
 * caller shows it only while the index is on.
 */
export interface TaskKnowledge {
  /** The summary and when it was written; null when none is written. */
  summary: { text: string; writtenAt: string } | null;
  /** Linked commits, newest first, at most `TASK_KNOWLEDGE_COMMITS`. */
  commits: Array<{ sha: string; subject: string; committedAt: string }>;
  commitCount: number;
  /** Changed files, most-changed first, at most `TASK_KNOWLEDGE_FILES`. */
  changedFiles: string[];
  changedFileCount: number;
}

/** Commits listed per task; the count says how many more there are. */
export const TASK_KNOWLEDGE_COMMITS = 3;
/** Files listed per task, the same eight a summary is written from. */
export const TASK_KNOWLEDGE_FILES = 8;

/** Every requested task's knowledge, by task id. Index lookups only. */
export function readTaskKnowledge(db: Database.Database, taskIds: ReadonlyArray<string>): Map<string, TaskKnowledge> {
  const knowledge = new Map<string, TaskKnowledge>();
  if (taskIds.length === 0) return knowledge;
  const store = new RetrievalStore(db);
  const summaries = new SummaryStore(db).entriesFor(taskIds);
  const changeTextsOf = createTaskChangeTextsReader(db);
  for (const taskId of taskIds) {
    const commits = store.commitsForTask(taskId);
    const files = rankChangedFiles(changeTextsOf(taskId));
    const summary = summaries.get(taskId);
    knowledge.set(taskId, {
      summary: summary ? { text: summary.summary, writtenAt: summary.createdAt } : null,
      commits: commits.slice(0, TASK_KNOWLEDGE_COMMITS).map((commit) => ({
        sha: commit.sha,
        subject: subjectForAgents(commitSubjectOf(commit.text)),
        committedAt: new Date(commit.committedMs).toISOString(),
      })),
      commitCount: commits.length,
      changedFiles: files.slice(0, TASK_KNOWLEDGE_FILES),
      changedFileCount: files.length,
    });
  }
  return knowledge;
}
