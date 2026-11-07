import { worktreeFolderFromPath } from '../../../shared/worktree-folder';
import { worktreeSkipBeforeBase } from '../../git/worktree-manager';
import type { SpareInputs, SpareProjectHooks } from '../../git/spare-worktree';
import type { TaskRepository } from '../../db/repositories/task-repository';
import type { Task } from '../../../shared/types';
import { resolveProjectDefaultBaseBranch } from './default-base-branch';
import type { IpcContext } from '../ipc-context';
import type { VerifiedOwnership } from '../../project-ownership/project-ownership';

/**
 * The project-side half of spare worktrees (`src/main/git/spare-worktree.ts`):
 * what a spare is built from, which tasks may take one, and which folders the
 * task rows name. Spares are on only when the context carries the pool
 * (`IpcContext.spareWorktrees`).
 */

/**
 * What this project's spare is built from, or null when it should have none:
 * no Post-Worktree Script, or worktrees off. There is no setting of its own.
 */
export function spareInputsFor(context: IpcContext, projectPath: string): SpareInputs | null {
  const git = context.configManager.getEffectiveConfig(projectPath).git;
  const initScript = git.initScript?.trim();
  if (!initScript || !git.worktreesEnabled) return null;
  return {
    baseBranch: resolveProjectDefaultBaseBranch(context, projectPath),
    initScript,
    linkNodeModules: git.linkNodeModules ?? true,
    copyFiles: [...(git.copyFiles ?? [])],
    linkFolders: [...(git.linkFolders ?? [])],
  };
}

/**
 * Whether `task` may take a spare: it has never had a worktree (no
 * `worktree_folder`, so not a restore out of Done, a To Do reset or a legacy
 * task, and the write-once column is free), no custom branch, no base branch of
 * its own, and the project would give it a new worktree at all (worktrees on,
 * a plain repo). The caller has already ruled out a remote agent.
 */
export function isSpareEligible(task: Task, projectPath: string, worktreesEnabled: boolean): boolean {
  if (task.worktree_path || task.worktree_folder || task.branch_name || task.base_branch) return false;
  return worktreeSkipBeforeBase(task, projectPath, worktreesEnabled) === null;
}

/** Every worktree folder these rows name, by `worktree_folder` or `worktree_path`. */
export function worktreeFoldersOf(rows: Array<Pick<Task, 'worktree_folder' | 'worktree_path'>>): Set<string> {
  const folders = new Set<string>();
  for (const row of rows) {
    if (row.worktree_folder) folders.add(row.worktree_folder);
    const fromPath = worktreeFolderFromPath(row.worktree_path);
    if (fromPath) folders.add(fromPath);
  }
  return folders;
}

/** Every worktree folder a task row names. */
export function referencedWorktreeFolders(tasks: Pick<TaskRepository, 'list' | 'listArchived'>): Set<string> {
  return worktreeFoldersOf([...tasks.list(), ...tasks.listArchived()]);
}

/** What the pool asks of this project, read fresh each time it asks. */
export function spareHooksFor(
  context: IpcContext,
  projectPath: string,
  tasks: Pick<TaskRepository, 'list' | 'listArchived'>,
): SpareProjectHooks {
  return {
    inputs: () => spareInputsFor(context, projectPath),
    referencedFolders: () => referencedWorktreeFolders(tasks),
  };
}

/**
 * The startup pass, at a cold project open: delete spares whose build was cut
 * off or whose settings are stale. Not awaited by the open; a claim only takes
 * spares with a current ready record, and both sides go through the creation
 * registry and the git queue. Never throws into the open, whose session
 * recovery runs right after it.
 *
 * Takes the proof: this pass discards a spare whose record does not match this
 * instance's settings, whatever the database says, so a second instance would
 * discard the owner's spares.
 */
export function sweepSpareWorktreesAtOpen(
  context: IpcContext,
  ownership: VerifiedOwnership,
  tasks: Pick<TaskRepository, 'list' | 'listArchived'>,
): void {
  const pool = context.spareWorktrees;
  if (!pool) return;
  const { projectPath } = ownership;
  const hooks = spareHooksFor(context, projectPath, tasks);
  let inputs: SpareInputs | null;
  try {
    inputs = hooks.inputs();
  } catch (error) {
    console.warn(`[SPARE] startup pass skipped for ${projectPath}: could not read its settings:`, error);
    return;
  }
  void pool.sweep(projectPath, inputs, hooks.referencedFolders)
    .catch((error: unknown) => console.warn(`[SPARE] startup pass failed for ${projectPath}:`, error));
}

/**
 * Stop the project's spare builds and discard every spare no task names, for a
 * project delete or relocate. Awaited, so the link-safe deleter has them before
 * the caller deletes or moves the folder. Never rejects.
 *
 * `tasks` null is the project delete: its rows are going, so no folder counts
 * as named and every spare folder is moved aside for the link-safe deleter. A
 * task list that cannot be read keeps every spare instead.
 */
export async function discardProjectSpares(
  context: IpcContext,
  projectPath: string,
  tasks: Pick<TaskRepository, 'list' | 'listArchived'> | null,
): Promise<void> {
  const pool = context.spareWorktrees;
  if (!pool) return;
  await pool.stop(projectPath);
  let referenced: ReadonlySet<string> = new Set<string>();
  if (tasks) {
    try {
      referenced = referencedWorktreeFolders(tasks);
    } catch (error) {
      console.warn(`[SPARE] Could not read the task rows of ${projectPath}; keeping its spares:`, error);
      return;
    }
  }
  await pool.sweep(projectPath, null, () => referenced);
}
