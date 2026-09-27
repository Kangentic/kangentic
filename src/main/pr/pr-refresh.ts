/**
 * Background PR refresh-and-discover sweep. For each eligible task it re-resolves
 * the PR via the `linkPR` backbone, which both refreshes an already-linked PR's
 * state (so a PR merged/closed off-app is reflected on the board) AND discovers a
 * PR for a still-unlinked task that has a live worktree (e.g. an agent created
 * the PR mid-session on a renamed branch and no other trigger caught it).
 * `refreshProjectPRs` checks every eligible task once, one after another, on
 * project open/switch; after that the refresh queue checks one PR at a time as
 * each falls due, using `pickNextDuePR` (see pr-refresh-scheduler.ts).
 *
 * Reuses the `linkPR` backbone unchanged and NON-FORCE on purpose: non-force
 * re-resolves open/draft/null PRs (so open -> merged is caught), skips terminal
 * merged/closed (no wasted `gh` call), and coalesces within the 60s per-task TTL.
 */

import { getProjectRepos } from '../ipc/helpers/project-repos';
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
 *   - a recorded `pushed_branch` outside a Done lane - the same discovery case
 *     for a task with NO worktree, whose only anchor is the branch its own push
 *     named. Done is excluded because `pushed_branch` survives Done (it is a
 *     remote fact), and a Done task that never linked would otherwise be swept
 *     forever; the worktree anchor gets that bound for free from Done reclaiming
 *     the directory.
 * Terminal merged/closed PRs never change and are skipped first, as are tasks
 * sitting in a To Do lane (To Do resets a task, so there is no PR to link there -
 * the same gate `autoLinkPRForTask` applies to every implicit trigger). A task
 * with none of these has nothing to resolve. (`tasks.list()` already excludes
 * archived tasks.) `head_sha` is deliberately NOT an anchor here: nearly every
 * historical task carries one, so it would make the sweep unbounded. Neither is a
 * PR URL in the description - see the ladder comment in `pr-linking.ts` for why
 * scraping prose stamped cited PRs onto unrelated tasks.
 */
function isEligibleForRefresh(task: Task, laneRole: { isTodo: boolean; isDone: boolean }): boolean {
  if (laneRole.isTodo) return false;
  if (task.pr_state === 'merged' || task.pr_state === 'closed') return false;
  if (task.pr_number != null) return true;
  if (task.worktree_path != null) return true;
  return task.pushed_branch != null && !laneRole.isDone;
}

/**
 * Sweep a project's eligible tasks, re-resolving each PR's state. Sequential by
 * design: it naturally staggers the work, and the global `gh` concurrency cap (3)
 * plus the per-task 60s TTL in the backbone already bound the burst. Best-effort
 * and silent: a per-task failure is swallowed (the backbone already degrades and
 * one-time-hint-guards), and `linkPR`'s `onLinked` pushes TASK_PR_LINK_CHANGED
 * so cards update live. That channel is deliberately toast-free: a sweep that
 * finds N changed tasks would otherwise raise N "Task updated by agent" toasts
 * for work no agent did.
 */
export async function refreshProjectPRs(context: IpcContext, projectId: string): Promise<void> {
  for (const task of listRefreshEligibleTasks(context, projectId)) {
    try {
      await linkPR(context, { projectId, taskId: task.id });
    } catch {
      // Best-effort per task; never let one failure abort the sweep.
    }
  }
}

/**
 * The next task whose PR is due a check, or null when none is: the one checked
 * longest ago among those whose last check is at least `intervalMs` old. A task
 * never checked this session is due at once and goes first. Pure, so the queue
 * (`pr-refresh-scheduler.ts`) is testable without timers.
 */
export function pickNextDuePR(
  eligibleTaskIds: readonly string[],
  lastCheckedAt: (taskId: string) => number | undefined,
  now: number,
  intervalMs: number,
): string | null {
  let chosen: string | null = null;
  let chosenCheckedAt = Infinity;
  for (const taskId of eligibleTaskIds) {
    const checkedAt = lastCheckedAt(taskId) ?? -Infinity;
    if (now - checkedAt < intervalMs) continue;
    if (checkedAt < chosenCheckedAt) {
      chosen = taskId;
      chosenCheckedAt = checkedAt;
    }
  }
  return chosen;
}

/**
 * When the next eligible PR falls due, or null with nothing eligible. Lets the
 * queue sleep until then instead of waking every gap to find nothing to do.
 */
export function nextPRDueAt(
  eligibleTaskIds: readonly string[],
  lastCheckedAt: (taskId: string) => number | undefined,
  now: number,
  intervalMs: number,
): number | null {
  let earliest: number | null = null;
  for (const taskId of eligibleTaskIds) {
    const checkedAt = lastCheckedAt(taskId);
    const dueAt = checkedAt === undefined ? now : checkedAt + intervalMs;
    if (earliest === null || dueAt < earliest) earliest = dueAt;
  }
  return earliest;
}

/**
 * The project's tasks whose PR can still change or be found (see
 * `isEligibleForRefresh`), or none when the project DB is unavailable.
 */
export function listRefreshEligibleTasks(context: IpcContext, projectId: string): Task[] {
  try {
    const { tasks, swimlanes } = getProjectRepos(context, projectId);
    // Resolve the To Do and Done lanes once rather than per task - the sweep can
    // run over every task on the board. Guarded separately from the task read:
    // the lane gate is a filter, so losing it must degrade to "no lane is To Do
    // or Done" rather than take the whole sweep down with it.
    let todoLaneIds: Set<string>;
    let doneLaneIds: Set<string>;
    try {
      const lanes = swimlanes.list();
      todoLaneIds = new Set(lanes.filter((lane) => lane.role === 'todo').map((lane) => lane.id));
      doneLaneIds = new Set(lanes.filter((lane) => lane.role === 'done').map((lane) => lane.id));
    } catch {
      todoLaneIds = new Set();
      doneLaneIds = new Set();
    }
    return tasks.list().filter((task) => isEligibleForRefresh(task, {
      isTodo: todoLaneIds.has(task.swimlane_id),
      isDone: doneLaneIds.has(task.swimlane_id),
    }));
  } catch {
    // Project DB unavailable (e.g. closed mid-switch) - nothing to refresh.
    return [];
  }
}
