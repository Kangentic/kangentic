/**
 * Per-project background remote-fetch scheduler. Every "behind" number the app
 * shows (the Changes panel header, the spawn-time base-drift note, the MCP
 * worktree list) is measured against remote-tracking refs, and those refs were
 * only ever refreshed when someone opened a panel or dropped a task on Done.
 * Opening a project nobody had touched in a week left every count a week stale
 * until then. This sweeps the FOCUSED project's remotes on open and, with
 * `git.autoFetch` on, again 5 minutes after the project's last full fetch.
 *
 * The clock is the repo's, not the scheduler's: `lastAllRemotesFetchAt` reads
 * the throttle cache every all-remotes fetch stamps (opening the Changes panel,
 * the Done check, the drag prefetch, this sweep), keyed by the git common dir
 * so a worktree's fetch counts for its project. A fetch somebody else just made
 * pushes the next sweep back instead of repeating it. A base-branch fetch
 * (`fetchIfStale`, when a worktree is created) refreshes one branch only and
 * does not count. A fetch that FAILED stamps nothing, so the scheduler also
 * counts from its own last attempt; otherwise an offline repo would retry on
 * every tick.
 *
 * It only fetches. It never pulls, merges, or rebases: keeping a tree current
 * under a running agent is out of scope (#558), and the remedy stays explicit
 * ("Update from base").
 *
 * The lifecycle (`startForProject` / `stop`, the single active project, the
 * deferred first sweep) mirrors `src/main/pr/pr-refresh-scheduler.ts`,
 * including its timer-leak safety (see src/main/diagnostics/project-log-context.ts
 * and src/main/shutdown.ts):
 *  - each `setTimeout` is created OUTSIDE `runWithProjectLogContext`; the sweep
 *    wraps its work inside it (a timer created inside a run would leak that
 *    project's log context into every future tick),
 *  - every timer is `.unref()`'d so it never keeps the event loop alive past a
 *    clean Electron quit, and
 *  - it is explicitly cleared on project switch/delete and on shutdown.
 *
 * The sweep runs through `WorktreeManager.withGitLock` at BACKGROUND priority,
 * so it never delays a user-initiated git op that is waiting and never
 * contends with a `worktree add` on the `.git` lock. Two limits are known and
 * accepted: BACKGROUND orders WAITING jobs only, so a sweep that is already
 * running holds the queue for up to its two 5s caps; and a project switch
 * during the lock wait still fetches the old project once (throttled,
 * read-only, harmless).
 */

import { runWithProjectLogContext } from '../diagnostics/project-log-context';
import { fetchAllRemotesIfStale, lastAllRemotesFetchAt } from './fetch-throttle';
import { WorktreeManager, GitQueuePriority } from './worktree-manager';
import type { IpcContext } from '../ipc/ipc-context';
import type { Project } from '../../shared/types';
import { AUTO_FETCH_INTERVAL_MS } from '../../shared/refresh-intervals';

// Shared, so the Settings copy names the cadence this runs on.
export { AUTO_FETCH_INTERVAL_MS };

let activeTimer: NodeJS.Timeout | null = null;
let activeProjectId: string | null = null;
/** When this scheduler last started a sweep, for the failed-fetch case above. */
let lastAttemptAt = 0;
/**
 * Bumped by every `stop`. A config save restarts the SAME project, so a tick
 * still reading the clock when the switch went off would otherwise sweep and
 * re-arm the timer the restart decided against.
 */
let generation = 0;

/** Whether the project keeps its remotes current in the background. */
function autoFetchEnabled(context: IpcContext, projectPath: string): boolean {
  try {
    return context.configManager.getEffectiveConfig(projectPath).git.autoFetch === true;
  } catch {
    return false;
  }
}

/** Run one sweep, tagged with the project's log context, guarded against a stale switch. */
function sweep(context: IpcContext, project: Project): void {
  if (context.currentProjectId !== project.id) return;
  lastAttemptAt = Date.now();
  runWithProjectLogContext(project.name, () => {
    void WorktreeManager.withGitLock(
      project.path,
      // Non-interactive by construction: a fetch on a timer has no user gesture
      // behind it, so a credential prompt (terminal or GUI) must be impossible.
      () => fetchAllRemotesIfStale(project.path, { nonInteractive: true }),
      { priority: GitQueuePriority.BACKGROUND, label: 'auto-fetch' },
    ).catch((error) => {
      // fetchAllRemotesIfStale never rejects; this covers the lock itself
      // (a queue cleared by a project delete mid-wait), so no tick can escape.
      console.error('[auto-fetch] sweep failed:', error);
    });
  });
}

function arm(context: IpcContext, project: Project, delayMs: number): void {
  activeTimer = setTimeout(() => { void tick(context, project); }, Math.max(0, delayMs));
  // Never let the timer block a clean quit; it is also explicitly cleared on
  // switch/delete/shutdown.
  activeTimer.unref();
}

/**
 * Wake at the due time, re-read the clock (another caller may have fetched in
 * the meantime), and either sweep or sleep until the new due time.
 */
async function tick(context: IpcContext, project: Project): Promise<void> {
  activeTimer = null;
  if (activeProjectId !== project.id) return;
  const tickGeneration = generation;
  const lastFetchAt = await lastAllRemotesFetchAt(project.path).catch(() => null);
  // Stopped, switched, or restarted while the clock was being read.
  if (generation !== tickGeneration || activeProjectId !== project.id || activeTimer) return;
  const dueAt = Math.max(lastFetchAt ?? 0, lastAttemptAt) + AUTO_FETCH_INTERVAL_MS;
  const waitMs = dueAt - Date.now();
  if (waitMs > 0) {
    arm(context, project, waitMs);
    return;
  }
  sweep(context, project);
  arm(context, project, AUTO_FETCH_INTERVAL_MS);
}

export const gitFetchScheduler = {
  /**
   * Run an immediate sweep for `project` and, with `git.autoFetch` on, arm the
   * clock. Called on every PROJECT_OPEN (cold restart AND warm switch-back) and
   * after a config change so a flipped switch takes effect without reopening.
   * Synchronous-cheap: the sweep itself is deferred off the IPC critical path.
   */
  startForProject(context: IpcContext, project: Project): void {
    // Tear down any prior project's timer first (single active-project model).
    gitFetchScheduler.stop();
    activeProjectId = project.id;

    // Defer the first sweep so PROJECT_OPEN is not delayed; the switch-guard
    // mirrors the deferred board-config block in handlers/projects.ts.
    setImmediate(() => sweep(context, project));

    if (!autoFetchEnabled(context, project.path)) return; // Off: on-load sweep only, no timer.
    arm(context, project, AUTO_FETCH_INTERVAL_MS);
  },

  /**
   * Stop the active timer. With a `projectId`, no-ops unless that project owns
   * the active timer (so deleting a non-focused project never kills the focused
   * project's timer). With no argument, always stops (shutdown / unconditional).
   */
  stop(projectId?: string): void {
    if (projectId != null && projectId !== activeProjectId) return;
    generation += 1;
    if (activeTimer) {
      clearTimeout(activeTimer);
      activeTimer = null;
    }
    activeProjectId = null;
  },
};
