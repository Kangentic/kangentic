import fs from 'node:fs';
import path from 'node:path';
import type { SessionManager } from '../../pty/session-manager';

/**
 * Delete the folders of sessions whose rows are going away
 * (`.kangentic/sessions/<id>`). Every path that deletes a task's `sessions` rows
 * calls it, with the ids read before the rows go: nothing names those folders
 * afterwards, and the orphan sweep refuses to clear them when they are most of
 * the folder (Sentry DESKTOP-50).
 *
 * Call it after the task's sessions have exited. An agent still in its own exit
 * can write its folder back.
 *
 * A folder whose session is still live is spared. The caller has ended the
 * sessions it meant to, so anything still running or queued here is one a
 * concurrent spawn brought to life for the task. Wiping its events.jsonl
 * mid-write severs the activity feed and makes the card falsely read idle. A
 * spared folder whose row is then deleted is still protected from the orphan
 * sweep, by its `listSessions()` guard, until the session exits.
 *
 * Best-effort: the rows are the source of truth, so a folder that will not go is
 * logged and left. Async so a bulk delete does not hold the event loop: a
 * synchronous rmSync per folder stalled every IPC call behind it for seconds.
 */
export async function removeSessionFolders(input: {
  projectPath: string;
  sessionIds: readonly string[];
  sessionManager: Pick<SessionManager, 'listSessions'>;
}): Promise<void> {
  const { projectPath, sessionIds, sessionManager } = input;
  if (sessionIds.length === 0) return;
  const liveSessionIds = new Set(
    sessionManager.listSessions()
      .filter((session) => session.status === 'running' || session.status === 'queued')
      .map((session) => session.id),
  );
  await Promise.all(sessionIds.map(async (sessionId) => {
    if (liveSessionIds.has(sessionId)) return;
    const sessionFolder = path.join(projectPath, '.kangentic', 'sessions', sessionId);
    try {
      await fs.promises.rm(sessionFolder, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    } catch (error) {
      // report-ok: a folder something still holds costs disk only. The orphan sweep clears it at the next
      // project open, or reports its own refusal when leftovers are most of the folder. `force` already
      // silences ENOENT, so what lands here is EACCES, EPERM or EBUSY past the retries.
      console.warn(`[CLEANUP] Failed to remove session dir ${sessionFolder}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }));
}
