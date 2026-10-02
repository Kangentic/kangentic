/**
 * Whether a task runs in its own git worktree. Main (`ensureWorktree`) and the
 * renderer (the New Task dialog, the task edit form, the branch hint) both
 * decide through this, so the hint can never promise a worktree the spawn then
 * skips.
 *
 * `git.worktreesEnabled` is the feature switch, not a default. Off, no task
 * gets a worktree, including one created earlier with Worktree picked; the
 * dialog hides the choice. On, a task's own choice wins and an unset choice
 * means Worktree. A task that already has a live worktree keeps it either way,
 * because `ensureWorktree` reuses a live directory before it asks this.
 */
export function taskUsesWorktree(worktreesEnabled: boolean, taskChoice: boolean | null | undefined): boolean {
  if (!worktreesEnabled) return false;
  return taskChoice ?? true;
}

/** The stored tri-state column (`tasks.use_worktree`, 1 / 0 / NULL) as the choice `taskUsesWorktree` reads. */
export function storedWorktreeChoice(useWorktree: number | null | undefined): boolean | null {
  return useWorktree == null ? null : Boolean(useWorktree);
}
