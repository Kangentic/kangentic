import type { Task } from '../../shared/types';

/**
 * Whether Send to Backlog asks before it runs. A demote tears down the task's
 * session and worktree, so it asks only when the task holds one of them, and
 * never once the user turned the question off with Don't ask again (the
 * `skipDeleteConfirm` switch Delete shares).
 *
 * One rule for every surface that offers the action: the board card, a task
 * detail window, and an Agent Monitor row.
 */
export function sendToBacklogAsksFirst(
  task: Pick<Task, 'session_id' | 'worktree_path'>,
  skipDeleteConfirm: boolean,
): boolean {
  if (skipDeleteConfirm) return false;
  return !!task.session_id || !!task.worktree_path;
}
