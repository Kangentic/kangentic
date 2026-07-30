import path from 'node:path';
import { slugify } from '../../shared/slugify';
import type { TaskRepository } from '../db/repositories/task-repository';
import type { Task } from '../../shared/types';

/** The directory every one of a project's worktrees lives directly inside. */
export function worktreesRootFor(projectPath: string): string {
  return path.join(projectPath, '.kangentic', 'worktrees');
}

/**
 * Make sure a task knows which directory name its worktree uses, recovering it
 * from session history when the task predates the numeric scheme and has
 * already been through Done (which nulls `worktree_path`). Mutates `task` in
 * place so the subsequent `ensureWorktree` call sees the recovered name.
 *
 * A no-op for any task that already knows its folder, and for genuinely new
 * tasks, which take `String(display_id)` at creation.
 *
 * Call this at every worktree-creation entry point. Skipping it would relocate a
 * legacy task's worktree on its way out of Done, orphaning the agent transcript
 * keyed to the old cwd.
 */
export function prepareWorktreeFolder(
  task: Task,
  tasks: TaskRepository,
  projectPath: string,
): void {
  if (task.worktree_folder || task.worktree_path) return;
  const recovered = tasks.recoverLegacyWorktreeFolder(task.id, worktreesRootFor(projectPath));
  if (recovered) task.worktree_folder = recovered;
}

/** A task whose worktree location must be guessed rather than read. */
type WorktreeCandidateTask = Pick<Task, 'id' | 'title' | 'display_id'>
  & Partial<Pick<Task, 'worktree_path' | 'worktree_folder'>>;

/**
 * The auto-generated branch name for a task, as `createWorktree` would compose
 * it (without the base-branch namespace, which cleanup does not know).
 *
 * Kept deliberately separate from the folder name. They used to be the same
 * string, so cleanup could derive one from the other; now that folders are
 * numeric, doing so would try to delete a branch called "460".
 */
export function legacyAutoBranchNameFor(task: Pick<Task, 'id' | 'title'>): string {
  return `${slugify(task.title) || 'task'}-${task.id.slice(0, 8)}`;
}

/**
 * Every directory a task's worktree could plausibly occupy, most authoritative
 * first, for the best-effort cleanup passes that run when `worktree_path` cannot
 * be trusted (a creation that failed before the DB write, or a Backlog reset
 * that already cleared the row).
 *
 * Probing a set rather than recomputing one name is what makes cleanup correct
 * across the scheme change: a task may sit in a legacy title-derived directory,
 * in its pinned `worktree_folder`, or in the numeric directory a fresh creation
 * would choose.
 */
export function candidateWorktreePathsFor(
  task: WorktreeCandidateTask,
  projectPath: string,
): string[] {
  const worktreesRoot = worktreesRootFor(projectPath);
  const folderNames: string[] = [];
  if (task.worktree_folder) folderNames.push(task.worktree_folder);
  if (Number.isInteger(task.display_id) && task.display_id > 0) {
    folderNames.push(String(task.display_id));
  }
  folderNames.push(legacyAutoBranchNameFor(task));

  const candidates = new Set<string>();
  if (task.worktree_path) candidates.add(task.worktree_path);
  for (const folderName of folderNames) candidates.add(path.join(worktreesRoot, folderName));
  return [...candidates];
}
