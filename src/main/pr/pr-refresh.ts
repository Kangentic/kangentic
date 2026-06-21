/**
 * Background PR refresh-and-discover sweep. For each eligible task it re-resolves
 * the PR via the `linkPR` backbone, which both refreshes an already-linked PR's
 * state (so a PR merged/closed off-app is reflected on the board) AND discovers a
 * PR for a still-unlinked task that has a live worktree (e.g. an agent created
 * the PR mid-session on a renamed branch and no other trigger caught it). Runs
 * fire-and-forget on project open/switch and on a periodic timer (see
 * pr-refresh-scheduler.ts).
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
 * A task is worth a background sweep when its PR can still change or be found:
 *   - a non-terminal linked PR (`pr_number`) - state can change off-app;
 *   - a live worktree (`worktree_path`) - an actively-worked task whose PR may
 *     have been created but not yet linked (the discovery case); the worktree's
 *     live HEAD branch resolves the PR even after the agent renamed the branch.
 *     Only active tasks have a worktree (To Do clears it, Done reclaims it), so
 *     this stays a small bounded set, further bounded by the per-task 60s TTL and
 *     the global `gh` concurrency cap;
 *   - a PR URL anchor in the description.
 * Terminal merged/closed PRs never change and are skipped first. A task with none
 * of these has nothing to resolve. (`tasks.list()` already excludes archived
 * tasks.) `head_sha` is deliberately NOT an anchor here: nearly every historical
 * task carries one, so it would make the sweep unbounded.
 */
function isEligibleForRefresh(task: Task): boolean {
  if (task.pr_state === 'merged' || task.pr_state === 'closed') return false;
  if (task.pr_number != null) return true;
  if (task.worktree_path != null) return true;
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
