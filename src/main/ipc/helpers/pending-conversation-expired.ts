import type { ConversationExpiredNotice, Task } from '../../../shared/types';

/**
 * Expired-conversation notices main holds until the renderer takes them.
 *
 * A push alone lost the notice at startup. Recovery of the auto-opened project
 * runs inside the preload `createWindow` starts, before `did-finish-load`, so
 * the push could land before the renderer subscribed, or before
 * `PROJECT_AUTO_OPENED` made the project current, and the renderer drops a
 * notice for a project that is not current. Main therefore queues each notice
 * before it pushes, and the renderer drains the project's queue
 * (`TASK_TAKE_CONVERSATION_EXPIRED`) when the push names the current project
 * and whenever a project becomes current. The drain runs in one synchronous
 * `ipcMain.handle`, so each notice is handed out exactly once however the two
 * callers race. `sendOpenWarnings` in board-config-manager.ts is the same
 * store-then-push shape without the drain.
 *
 * Keyed by task, so a task that starts over twice before anyone looks keeps
 * only its latest notice, and a project never holds more than one per task.
 */
const pendingByProject = new Map<string, Map<string, ConversationExpiredNotice>>();

export function queueConversationExpired(notice: ConversationExpiredNotice): void {
  let pending = pendingByProject.get(notice.projectId);
  if (!pending) {
    pending = new Map();
    pendingByProject.set(notice.projectId, pending);
  }
  // Re-inserted rather than overwritten, so the latest start-over sorts last.
  pending.delete(notice.taskId);
  pending.set(notice.taskId, notice);
}

/** The project's queued notices, oldest first, removed from the queue. */
export function takeConversationExpired(projectId: string): ConversationExpiredNotice[] {
  const pending = pendingByProject.get(projectId);
  if (!pending) return [];
  pendingByProject.delete(projectId);
  return [...pending.values()];
}

/**
 * The notices whose task is still on the board. A notice for a background
 * project can wait days, and a task deleted or archived in that time would
 * toast a title that is no longer there. Synchronous, so the take that calls
 * it stays one step. When the board cannot be read the notices are kept: a
 * stale toast costs less than a lost one.
 */
export function keepNoticesForLiveTasks(
  notices: ConversationExpiredNotice[],
  readTasks: () => { getById(taskId: string): Pick<Task, 'archived_at'> | undefined },
): ConversationExpiredNotice[] {
  try {
    const tasks = readTasks();
    return notices.filter((notice) => {
      const task = tasks.getById(notice.taskId);
      return task !== undefined && !task.archived_at;
    });
  } catch (error) {
    console.warn('[CONVERSATION-EXPIRED] Could not read the board to filter queued notices:', error);
    return notices;
  }
}

/** Drop a deleted project's notices. */
export function clearConversationExpired(projectId: string): void {
  pendingByProject.delete(projectId);
}

/** Test-only: empty every queue between unit test cases. */
export function __resetPendingConversationExpiredForTest(): void {
  pendingByProject.clear();
}
