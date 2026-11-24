import type { LeftoverProcessEntry } from '../../pty/process-tag/tagged-reap';

/**
 * What a leftover reap left running, for the worktree removal that follows it.
 * A removal the verdict names passes `reapLeftRunning`, so a failure the kept
 * process causes is counted and not reported (Sentry DESKTOP-3P). Read by every
 * terminal transition (`reapTaskLeftovers`) and by the cold-open retry of a
 * Done task's removal, which gets the startup sweep's verdict.
 */
export interface ReapVerdict {
  /** Tasks with a process still working inside their worktree after the reap. */
  tasksLeftRunningInWorktree: ReadonlySet<string>;
}

/** A reap that named no task: none ran, it failed, or it left nothing in a worktree. */
export const NOTHING_LEFT_RUNNING: ReapVerdict = { tasksLeftRunningInWorktree: new Set() };

/**
 * Whether a reap left this process working inside its task's worktree. `kept`
 * covers a process kept on purpose (shared, outside, a visible app, tmux) and
 * every process when stopping is off; `failed` is one the reap could not stop. A
 * process left in the project folder outside the worktree holds no worktree.
 */
export function isLeftInWorktree(entry: Pick<LeftoverProcessEntry, 'outcome' | 'place'>): boolean {
  return entry.place === 'worktree' && entry.outcome !== 'stopped';
}

/** The tasks a reap left a process working inside the worktree of (`isLeftInWorktree`). */
export function reapVerdictOf(entries: ReadonlyArray<Pick<LeftoverProcessEntry, 'taskId' | 'outcome' | 'place'>>): ReapVerdict {
  const tasksLeftRunningInWorktree = new Set<string>();
  for (const entry of entries) {
    if (isLeftInWorktree(entry)) tasksLeftRunningInWorktree.add(entry.taskId);
  }
  return tasksLeftRunningInWorktree.size === 0 ? NOTHING_LEFT_RUNNING : { tasksLeftRunningInWorktree };
}
