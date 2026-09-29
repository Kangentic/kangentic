import type Database from 'better-sqlite3';
import { summaryInputHash, type SummaryInput } from './summary-prompt';
import { commitSubjectOf } from '../commit/commit-record';

/**
 * What each finished task's summary is written from, read from the project
 * database. A task is finished when it sits in a Done column, archived or not.
 *
 * Every read is an index lookup: sessions by task, then chunks by document.
 * `memory_chunks` carries no task index, so reading it by task would scan the
 * whole table once per task.
 */

/** Latest sessions whose closing message a summary reads. */
const CLOSING_SESSIONS = 3;
/** Most-changed files a summary reads. */
const CHANGED_FILES = 8;
/** Tasks read between yields. */
const TASKS_PER_SLICE = 40;

export interface SummaryCandidate {
  input: SummaryInput;
  hash: string;
  /** The task's latest session, epoch ms: recent work is summarized first. */
  lastActivityMs: number;
}

/** Labels the transcript chunker opens each fragment with. */
const FRAGMENT_START = /\n(?=(?:User|Assistant|Assistant \(thinking\)|Tool|Tool result|Tool error|\[[^\]\n]+\]): )/;

/** The last thing the agent said in a chunk of conversation text, or null. */
export function lastAssistantMessage(text: string): string | null {
  const fragments = `\n${text}`.split(FRAGMENT_START);
  for (let index = fragments.length - 1; index >= 0; index -= 1) {
    const fragment = fragments[index].replace(/^\n/, '');
    if (fragment.startsWith('Assistant: ')) {
      const message = fragment.slice('Assistant: '.length).trim();
      if (message) return message;
    }
  }
  return null;
}

/** The files a session-changes document lists, in its order. */
export function changedFilesOf(changeText: string): string[] {
  return changeText
    .split('\n')
    .slice(1)
    .map((line) => line.replace(/ \([^()]*\)$/, '').trim())
    .filter((line) => line.length > 0);
}

/**
 * What every finished task's summary is written from, summed up in one read, so
 * a pass can tell nothing has changed without reading every input.
 *
 * It moves when a task enters or leaves a Done column, or is deleted from one
 * (the count, and `move()` stamps the task it moves); when a finished task's
 * title or description is edited (its `updated_at`); and when a conversation
 * or session-changes document of a finished task is indexed again (the closing
 * messages and changed files a summary reads); and when a commit is indexed or
 * tied to its task (the commit subjects it reads). Indexing a RUNNING task's
 * conversation does not move it, since that task is not in Done, which is what
 * keeps a busy board's turn-by-turn indexing from waking the summary pass.
 *
 * One query, measured at 5.2 ms on a 673-task board against 38 to 44 ms for
 * the full input read it lets a pass skip.
 */
export function readSummaryFingerprint(db: Database.Database): string {
  const row = db
    .prepare(
      `SELECT COUNT(DISTINCT t.id) AS tasks, MAX(t.updated_at) AS taskEdit, MAX(m.indexed_at) AS docIndexed,
              (SELECT MAX(indexed_at) FROM memory_index_state WHERE corpus = 'commit') AS commitIndexed
       FROM tasks t
       JOIN swimlanes w ON w.id = t.swimlane_id
       LEFT JOIN sessions s ON s.task_id = t.id AND s.agent_session_id IS NOT NULL
       LEFT JOIN memory_index_state m ON m.doc_id = s.agent_session_id AND m.corpus IN ('conversation', 'change')
       WHERE w.role = 'done'`,
    )
    .get() as { tasks: number; taskEdit: string | null; docIndexed: string | null; commitIndexed: string | null };
  return `${row.tasks}|${row.taskEdit ?? ''}|${row.docIndexed ?? ''}|${row.commitIndexed ?? ''}`;
}

/** Each task's commit subjects on the default branch, newest first. One read
 *  of the commit corpus for a whole pass: it has no task index, so a read per
 *  task would walk every commit once per task. */
function readCommitSubjectsByTask(db: Database.Database): Map<string, string[]> {
  const byTask = new Map<string, string[]>();
  const rows = db
    .prepare(
      `SELECT task_id AS taskId, text FROM memory_chunks
       WHERE corpus = 'commit' AND seq = 0 AND task_id IS NOT NULL
       ORDER BY ts_start DESC`,
    )
    .all() as Array<{ taskId: string; text: string }>;
  for (const row of rows) {
    const subject = commitSubjectOf(row.text);
    if (!subject) continue;
    const list = byTask.get(row.taskId) ?? [];
    list.push(subject);
    byTask.set(row.taskId, list);
  }
  return byTask;
}

/** Every finished task's summary input, with its hash. */
export async function readSummaryCandidates(
  db: Database.Database,
  yieldToEventLoop: () => Promise<void> = () => new Promise((resolve) => setImmediate(resolve)),
): Promise<SummaryCandidate[]> {
  const tasks = db
    .prepare(
      `SELECT t.id AS taskId, t.title AS title, t.description AS description
       FROM tasks t JOIN swimlanes w ON w.id = t.swimlane_id
       WHERE w.role = 'done'`,
    )
    .all() as Array<{ taskId: string; title: string; description: string | null }>;
  const sessionsOf = db.prepare(
    `SELECT agent_session_id AS docId, COALESCE(exited_at, suspended_at, started_at) AS at
     FROM sessions WHERE task_id = ? AND agent_session_id IS NOT NULL
     ORDER BY started_at DESC`,
  );
  const changeTextOf = db.prepare("SELECT text FROM memory_chunks WHERE corpus = 'change' AND doc_id = ? ORDER BY seq");
  const lastChunksOf = db.prepare("SELECT text FROM memory_chunks WHERE corpus = 'conversation' AND doc_id = ? ORDER BY seq DESC LIMIT 2");
  const commitsByTask = readCommitSubjectsByTask(db);

  const candidates: SummaryCandidate[] = [];
  for (let start = 0; start < tasks.length; start += TASKS_PER_SLICE) {
    for (const task of tasks.slice(start, start + TASKS_PER_SLICE)) {
      const sessions = sessionsOf.all(task.taskId) as Array<{ docId: string; at: string | null }>;
      // A resumed session shares its transcript with the one before it.
      const docIds = [...new Set(sessions.map((session) => session.docId))];
      const lastActivityMs = sessions.reduce((latest, session) => {
        const at = session.at ? Date.parse(session.at) : Number.NaN;
        return Number.isNaN(at) ? latest : Math.max(latest, at);
      }, 0);

      const fileSessions = new Map<string, number>();
      for (const docId of docIds) {
        const text = (changeTextOf.all(docId) as Array<{ text: string }>).map((row) => row.text).join('\n');
        for (const file of new Set(changedFilesOf(text))) fileSessions.set(file, (fileSessions.get(file) ?? 0) + 1);
      }
      const changedFiles = [...fileSessions]
        .sort((left, right) => right[1] - left[1])
        .slice(0, CHANGED_FILES)
        .map(([file]) => file);

      const closingMessages: string[] = [];
      for (const docId of docIds.slice(0, CLOSING_SESSIONS)) {
        const chunks = (lastChunksOf.all(docId) as Array<{ text: string }>).map((row) => row.text);
        // Newest chunk first; the one before it covers a chunk that ends on a tool call.
        const message = chunks.map(lastAssistantMessage).find((found): found is string => found !== null);
        if (message) closingMessages.push(message);
      }

      const input: SummaryInput = {
        taskId: task.taskId,
        title: task.title,
        description: task.description ?? '',
        changedFiles,
        commits: commitsByTask.get(task.taskId) ?? [],
        closingMessages,
      };
      candidates.push({ input, hash: summaryInputHash(input), lastActivityMs });
    }
    await yieldToEventLoop();
  }
  return candidates;
}
