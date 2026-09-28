import type Database from 'better-sqlite3';
import { digestInputHash, type DigestInput } from './digest-prompt';

/**
 * What each finished task's digest is written from, read from the project
 * database. A task is finished when it sits in a Done column, archived or not.
 *
 * Every read is an index lookup: sessions by task, then chunks by document.
 * `memory_chunks` carries no task index, so reading it by task would scan the
 * whole table once per task.
 */

/** Latest sessions whose closing message a digest reads. */
const CLOSING_SESSIONS = 3;
/** Most-changed files a digest reads. */
const CHANGED_FILES = 8;
/** Tasks read between yields. */
const TASKS_PER_SLICE = 40;

export interface DigestCandidate {
  input: DigestInput;
  hash: string;
  /** The task's latest session, epoch ms: recent work is digested first. */
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

/** Every finished task's digest input, with its hash. */
export async function readDigestCandidates(
  db: Database.Database,
  yieldToEventLoop: () => Promise<void> = () => new Promise((resolve) => setImmediate(resolve)),
): Promise<DigestCandidate[]> {
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

  const candidates: DigestCandidate[] = [];
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

      const input: DigestInput = {
        taskId: task.taskId,
        title: task.title,
        description: task.description ?? '',
        changedFiles,
        closingMessages,
      };
      candidates.push({ input, hash: digestInputHash(input), lastActivityMs });
    }
    await yieldToEventLoop();
  }
  return candidates;
}
