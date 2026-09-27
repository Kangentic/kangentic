/**
 * Per-project background PR refresh. Kangentic has one focused project at a
 * time, so this keeps a single active queue: opening/switching to a project
 * checks every eligible PR once, and switching away or closing tears it down.
 *
 * With `git.prAutoRefresh` on, a queue then keeps each PR current on its OWN
 * clock rather than sweeping them all together on a timer:
 *  - a PR falls due `PR_REFRESH_INTERVAL_MS` after its last check, and that
 *    clock is reset by ANY check (`lastPRCheckAt` in pr-linking.ts): this
 *    queue, the 30 s re-poll while CI runs, an agent's `gh pr create`, a manual
 *    refresh, a column move. A PR checked a moment ago is not checked again.
 *  - one check at a time, the longest-unchecked due PR first, and at least
 *    `PR_REFRESH_MIN_GAP_MS` between the end of one and the start of the next.
 *    That caps the load at 360 calls an hour whatever the board holds; past 12
 *    open PRs each one's interval stretches instead of the cost growing.
 *  - with nothing due, the queue sleeps until the next PR falls due.
 * A sweep that fired every PR back to back each interval (what this replaced)
 * spent the whole budget in one burst and re-checked a PR CI had just settled.
 *
 * Timer-leak safety (see src/main/diagnostics/project-log-context.ts and
 * src/main/shutdown.ts):
 *  - each `setTimeout` is created OUTSIDE `runWithProjectLogContext`; each
 *    check wraps its work inside it (a timer created inside a run would leak
 *    that project's log context into every future tick),
 *  - every timer is `.unref()`'d so it never keeps the event loop alive past a
 *    clean Electron quit (the "un-unref'd interval" zombie class), and
 *  - it is explicitly cleared on project switch/delete and on shutdown.
 */

import { runWithProjectLogContext } from '../diagnostics/project-log-context';
import { refreshProjectPRs, listRefreshEligibleTasks, pickNextDuePR, nextPRDueAt } from './pr-refresh';
import { linkPR, cancelPendingVerdictRepolls, lastPRCheckAt, prunePRCheckStamps, clearPRCheckStamps } from './pr-linking';
import type { IpcContext } from '../ipc/ipc-context';
import type { Project } from '../../shared/types';

/** How long after its last check a PR falls due again. */
export const PR_REFRESH_INTERVAL_MS = 2 * 60_000;
/** The least time between one queued check finishing and the next starting. */
export const PR_REFRESH_MIN_GAP_MS = 10_000;

let activeTimer: NodeJS.Timeout | null = null;
let activeProjectId: string | null = null;

/** Whether the project keeps its PRs current in the background. */
function autoRefreshEnabled(context: IpcContext, projectPath: string): boolean {
  try {
    return context.configManager.getEffectiveConfig(projectPath).git.prAutoRefresh === true;
  } catch {
    return false;
  }
}

function isActive(context: IpcContext, project: Project): boolean {
  return activeProjectId === project.id && context.currentProjectId === project.id;
}

function arm(context: IpcContext, project: Project, delayMs: number): void {
  activeTimer = setTimeout(() => { void tick(context, project); }, Math.max(PR_REFRESH_MIN_GAP_MS, delayMs));
  // Never let the timer block a clean quit; it is also explicitly cleared on
  // switch/delete/shutdown.
  activeTimer.unref();
}

/** Check the longest-unchecked due PR, or sleep until one falls due. */
async function tick(context: IpcContext, project: Project): Promise<void> {
  activeTimer = null;
  if (!isActive(context, project)) return;

  const eligibleTaskIds = listRefreshEligibleTasks(context, project.id).map((task) => task.id);
  // Stamps for tasks that left the queue (merged, moved to To Do, deleted)
  // would otherwise sit in the map for the life of the process.
  prunePRCheckStamps(new Set(eligibleTaskIds));

  const now = Date.now();
  const dueTaskId = pickNextDuePR(eligibleTaskIds, lastPRCheckAt, now, PR_REFRESH_INTERVAL_MS);
  if (!dueTaskId) {
    // Nothing due: sleep until the next PR is, and look again at least once an
    // interval so a task that just gained a worktree or a PR joins the queue.
    const dueAt = nextPRDueAt(eligibleTaskIds, lastPRCheckAt, now, PR_REFRESH_INTERVAL_MS);
    arm(context, project, Math.min(PR_REFRESH_INTERVAL_MS, (dueAt ?? now + PR_REFRESH_INTERVAL_MS) - now));
    return;
  }

  // Awaited outside the run, so the continuation (and the timer it arms) does
  // not inherit the project's log context.
  const check = runWithProjectLogContext(project.name, () => linkPR(context, { projectId: project.id, taskId: dueTaskId }));
  await check.catch((error: unknown) => {
    console.error('[pr-refresh] check failed:', error);
  });
  // Stopped, switched, or restarted while the check ran.
  if (!isActive(context, project) || activeTimer) return;
  arm(context, project, PR_REFRESH_MIN_GAP_MS);
}

/** Check every eligible PR once, then hand over to the queue when it is on. */
function openSweep(context: IpcContext, project: Project, queueEnabled: boolean): void {
  if (!isActive(context, project)) return;
  const sweep = runWithProjectLogContext(project.name, () => refreshProjectPRs(context, project.id));
  // The handlers attach OUTSIDE the run on purpose: a promise reaction takes the
  // async context current when it is attached, and the timer `arm` creates must
  // not inherit the project's log context.
  void sweep
    .catch((error: unknown) => {
      console.error('[pr-refresh] sweep failed:', error);
    })
    .finally(() => {
      // Armed only after the sweep, so the queue never races it for the same
      // unchecked PR.
      if (queueEnabled && isActive(context, project) && !activeTimer) {
        arm(context, project, PR_REFRESH_MIN_GAP_MS);
      }
    });
}

export const prRefreshScheduler = {
  /**
   * Check every eligible PR for `project` and, with `git.prAutoRefresh` on,
   * start its queue. Called on every PROJECT_OPEN (cold restart AND warm
   * switch-back) and after a config change so a flipped switch takes effect
   * without reopening. Synchronous-cheap: the checks are deferred off the IPC
   * critical path.
   */
  startForProject(context: IpcContext, project: Project): void {
    // Tear down any prior project's queue first (single active-project model).
    prRefreshScheduler.stop();
    activeProjectId = project.id;
    const queueEnabled = autoRefreshEnabled(context, project.path);

    // Defer the first sweep so PROJECT_OPEN is not delayed; the switch-guard
    // mirrors the deferred board-config block in handlers/projects.ts.
    setImmediate(() => openSweep(context, project, queueEnabled));
  },

  /**
   * Stop the active queue. With a `projectId`, no-ops unless that project owns
   * it (so deleting a non-focused project never kills the focused project's
   * queue). With no argument, always stops (shutdown / unconditional).
   */
  stop(projectId?: string): void {
    if (projectId != null && projectId !== activeProjectId) return;
    if (activeTimer) {
      clearTimeout(activeTimer);
      activeTimer = null;
    }
    activeProjectId = null;
    clearPRCheckStamps();
    // The linker's merge-verdict re-polls (the unknown holds and the in-flight
    // chains) belong to the project that was being swept; a switch-back's
    // on-open sweep asks afresh and re-arms any chain that still applies.
    cancelPendingVerdictRepolls();
  },
};
