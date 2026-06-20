/**
 * Background PR-state refresh sweep. Re-resolves the PR state of every eligible
 * task in a project so a PR merged/closed externally on the host (off-app) is
 * reflected on the board. Runs fire-and-forget on project open/switch and on a
 * periodic timer (see pr-refresh-scheduler.ts).
 *
 * Reuses the `linkPR` backbone unchanged and NON-FORCE on purpose: non-force
 * re-resolves open/draft/null PRs (so open -> merged is caught), skips terminal
 * merged/closed (no wasted `gh` call), and coalesces within the 60s per-task TTL.
 */

import { getProjectRepos } from '../ipc/helpers/project-repos';
import { detectCanonicalPR } from './pr-registry';
import { linkPR } from './pr-linking';
import type { Task } from '../../shared/types';
import type { IpcContext } from '../ipc/ipc-context';

/**
 * A task is worth a background refresh when it has a non-terminal linked PR (or a
 * PR URL anchor in its description) - i.e. a state that can still change off-app.
 * Terminal merged/closed PRs never change, and tasks with no PR anchor have
 * nothing to resolve, so both are skipped to bound the `gh` load. (`tasks.list()`
 * already excludes archived tasks.)
 */
function isEligibleForRefresh(task: Task): boolean {
  if (task.pr_state === 'merged' || task.pr_state === 'closed') return false;
  if (task.pr_number != null) return true;
  return detectCanonicalPR(task.description ?? '') != null;
}

/**
 * Sweep a project's eligible tasks, re-resolving each PR's state. Sequential by
 * design: it naturally staggers the work, and the global `gh` concurrency cap (3)
 * plus the per-task 60s TTL in the backbone already bound the burst. Best-effort
 * and silent: a per-task failure is swallowed (the backbone already degrades and
 * one-time-hint-guards), and `linkPR`'s `onLinked` pushes TASK_UPDATED_BY_AGENT
 * so cards update live.
 */
export async function refreshProjectPRs(context: IpcContext, projectId: string): Promise<void> {
  let eligible: Task[];
  try {
    const { tasks } = getProjectRepos(context, projectId);
    eligible = tasks.list().filter(isEligibleForRefresh);
  } catch {
    // Project DB unavailable (e.g. closed mid-switch) - nothing to refresh.
    return;
  }

  for (const task of eligible) {
    try {
      await linkPR(context, { projectId, taskId: task.id });
    } catch {
      // Best-effort per task; never let one failure abort the sweep.
    }
  }
}
