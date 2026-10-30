import type { Task } from '../../../shared/types';
import type { IpcContext } from '../ipc-context';
import { withTaskLock } from '../task-lifecycle-lock';
import { wakeWorkflowEngine } from '../../workflows/workflow-wake';
import { notifyWorkflowOfTask } from '../../workflows/workflow-changed';
import { getProjectRepos } from './project-repos';
import { cleanupTaskResources } from './task-cleanup';

/**
 * Delete one board task and everything it holds: its attachments, its
 * sessions, its worktree and branch, then the row. TASK_DELETE runs it, and so
 * does a workflow delete that takes its tasks that never started with it.
 * TASK_BULK_DELETE keeps its own copy of these steps, because it puts a
 * deadline on each cleanup and deletes the row even when the cleanup fails. A
 * step added here belongs there too.
 *
 * `onlyIf` is asked inside the task's lock, of the row as it is then. When it
 * answers false nothing is deleted and the call resolves false. A caller that
 * chose the task before the lock (a workflow delete) uses it, since a drag or
 * a spawn can change the task in between.
 *
 * Announcing the delete is the caller's: TASK_DELETE announces from its own
 * `finally`, because a cleanup that throws has already changed the card.
 */
export async function deleteTaskWithCleanup(
  context: IpcContext,
  projectId: string | null,
  projectPath: string | null,
  taskId: string,
  onlyIf?: (task: Task) => boolean,
): Promise<boolean> {
  const { tasks, attachments } = getProjectRepos(context, projectId);
  // Serialize against any in-flight session lifecycle op for this task so
  // the long awaits inside cleanup don't race with spawn/resume/etc.
  let deletedTask: Task | undefined;
  let refused = false;
  await withTaskLock(taskId, async () => {
    const task = tasks.getById(taskId);
    if (task && onlyIf && !onlyIf(task)) {
      refused = true;
      return;
    }
    deletedTask = task;
    if (task) {
      attachments.deleteByTaskId(taskId);
      await cleanupTaskResources(context, task, tasks, projectId, projectPath);
    }
    tasks.delete(taskId);
  });
  if (refused) return false;
  drainAutoNameAskedIds(context, [taskId]);
  // A deleted blocker's links went with it, so what waited for it may start.
  wakeWorkflowEngine();
  notifyWorkflowOfTask(deletedTask, projectId);
  return true;
}

/**
 * Remove the given task IDs from `AppConfig.autoNameAskedTaskIds` so the
 * persisted "don't re-ask" set does not accumulate stale entries for tasks
 * the user has deleted. No-op when the config field is absent, no IDs match,
 * or the configManager isn't fully wired (defensive: this drain is a best-
 * effort cleanup, not load-bearing for the delete operation).
 */
export function drainAutoNameAskedIds(context: IpcContext, taskIds: string[]): void {
  if (taskIds.length === 0) return;
  const configManager = context.configManager;
  if (typeof configManager?.load !== 'function' || typeof configManager?.save !== 'function') return;
  let config: { autoNameAskedTaskIds?: string[] };
  try {
    config = configManager.load();
  } catch {
    return;
  }
  const current = config.autoNameAskedTaskIds ?? [];
  if (current.length === 0) return;
  const removeSet = new Set(taskIds);
  const next = current.filter((entry) => !removeSet.has(entry));
  if (next.length === current.length) return;
  // Best-effort: save() no longer throws (see write-failure-notice.ts), and a
  // failed write here just means the next launch sees a slightly larger
  // asked-set - not worth surfacing to the user beyond the shared toast.
  configManager.save({ autoNameAskedTaskIds: next });
}
