import type { Task } from '../../shared/types';

/**
 * The folder the engine runs a task's agent and its scripts in: the task's
 * worktree, else the project checkout, else this process's folder.
 */
export function agentCwdFor(task: Pick<Task, 'worktree_path'>, projectPath: string | null | undefined): string {
  return task.worktree_path || projectPath || process.cwd();
}
