import type { TaskKnowledge } from '../../retrieval/task-knowledge';
import type { TaskKnowledgeRead } from './types';

/**
 * The Knowledge Graph's lines under a task in `kangentic_find_task` and
 * `kangentic_get_current_task`: its summary, the commits linked to it, and the
 * files its sessions changed. The agent reads the message text, never the data
 * object, so this is where the knowledge reaches it.
 */

/** Matches that get the lines; a longer list says how to look one up. */
export const TASK_KNOWLEDGE_MATCH_LIMIT = 5;

const SETTINGS = 'Settings > Knowledge Graph';

function isoDay(iso: string): string {
  return iso.slice(0, 10);
}

/**
 * One task's lines, indented under its task line. A summary is written when a
 * task finishes, so only a finished task gets a summary line, and says so when
 * it has none.
 */
export function taskKnowledgeLines(knowledge: TaskKnowledge, finished: boolean, summariesOn: boolean): string[] {
  const lines: string[] = [];
  if (finished) {
    if (knowledge.summary) {
      lines.push(`  summary (${isoDay(knowledge.summary.writtenAt)}): ${knowledge.summary.text}`);
    } else {
      lines.push(summariesOn
        ? '  summary: not written yet'
        : `  summary: none written (Task summaries are switched off in ${SETTINGS})`);
    }
  }
  if (knowledge.commitCount > 0) {
    const listed = knowledge.commits
      .map((commit) => `${commit.sha.slice(0, 10)} ${isoDay(commit.committedAt)} ${commit.subject}`)
      .join('; ');
    const more = knowledge.commitCount - knowledge.commits.length;
    lines.push(`  commits linked by subject (${knowledge.commitCount}, newest first): ${listed}${more > 0 ? `; and ${more} more` : ''}`);
  } else if (finished) {
    lines.push('  commits: none linked to this task');
  }
  if (knowledge.changedFileCount > 0) {
    const more = knowledge.changedFileCount - knowledge.changedFiles.length;
    lines.push(`  changed files (${knowledge.changedFileCount}, most-changed first): ${knowledge.changedFiles.join(', ')}${more > 0 ? `; and ${more} more` : ''}`);
  }
  return lines;
}

/**
 * The lines for a list of matched tasks, keyed by task id, and the notes that
 * close the message: the index being off, or matches past the limit.
 */
export async function taskKnowledgeFor(
  readTaskKnowledge: ((taskIds: string[]) => Promise<TaskKnowledgeRead> | TaskKnowledgeRead) | undefined,
  tasks: ReadonlyArray<{ id: string; finished: boolean }>,
): Promise<{ linesByTask: Map<string, string[]>; notes: string[]; knowledgeByTask: Map<string, TaskKnowledge> }> {
  const linesByTask = new Map<string, string[]>();
  const knowledgeByTask = new Map<string, TaskKnowledge>();
  const notes: string[] = [];
  if (!readTaskKnowledge || tasks.length === 0) return { linesByTask, notes, knowledgeByTask };
  const shown = tasks.slice(0, TASK_KNOWLEDGE_MATCH_LIMIT);
  const read = await readTaskKnowledge(shown.map((task) => task.id));
  if (!read.indexOn) {
    notes.push(`The Knowledge Graph index is off (${SETTINGS}), so no summary, linked commits or changed files are shown.`);
    return { linesByTask, notes, knowledgeByTask };
  }
  for (const task of shown) {
    const knowledge = read.byTask.get(task.id);
    if (!knowledge) continue;
    knowledgeByTask.set(task.id, knowledge);
    const lines = taskKnowledgeLines(knowledge, task.finished, read.summariesOn);
    if (lines.length > 0) linesByTask.set(task.id, lines);
  }
  if (tasks.length > shown.length) {
    notes.push(`Summaries, commits and changed files show for the first ${TASK_KNOWLEDGE_MATCH_LIMIT} matches. Look one up by displayId for its details.`);
  }
  return { linesByTask, notes, knowledgeByTask };
}
