import fs from 'node:fs';
import { readWorktreeWork } from '../../git/worktree-head';
import type { TaskRunningWork, TaskWorktreeRead } from '../../agent/commands/types';
import type { Task } from '../../../shared/types';

export interface RunningWorkDeps {
  /** Asked of the registry, never `task.session_id`, which outlives a natural exit. */
  hasLiveOrStartingSession: (taskId: string) => boolean;
  /** The base a task with no recorded cut is relative to. */
  defaultBaseBranchOf: (task: Task) => string;
}

async function readTaskWorktree(task: Task, deps: RunningWorkDeps): Promise<TaskWorktreeRead | null> {
  // No `worktree_path` means no commits to lose: both teardowns reach the branch
  // only through it.
  if (!task.worktree_path) return null;
  const baseBranch = task.resolved_base_branch || deps.defaultBaseBranchOf(task);
  if (!fs.existsSync(task.worktree_path)) {
    // The folder is gone but the row still names it. `removeWorktree` answers
    // true for a gone path, so the teardown goes on to delete the branch, and
    // the commits on that branch were never read here.
    return task.branch_name
      ? { readable: true, branch: task.branch_name, baseBranch, commitsNotOnBase: null, uncommittedFiles: 0 }
      : null;
  }
  const work = await readWorktreeWork(task.worktree_path, baseBranch);
  return work ? { readable: true, baseBranch, ...work } : { readable: false };
}

/**
 * A task's running work, for the guard that keeps an agent from ending it
 * (`running-work-guard.ts`).
 *
 * The session is read last and synchronously, after the git reads, and the
 * caller resumes in a microtask, so no PTY host reply lands between this answer
 * and its decision. It is a read at the call, not a hold. A spawn still being
 * prepared has no session yet, and a move the caller fires takes the task lock
 * later, behind anything already queued there.
 */
export async function readTaskRunningWork(task: Task, deps: RunningWorkDeps): Promise<TaskRunningWork> {
  const worktree = await readTaskWorktree(task, deps);
  return { liveAgent: deps.hasLiveOrStartingSession(task.id), worktree };
}
