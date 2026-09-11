/**
 * Per-project background remote-fetch scheduler. Every "behind" number the app
 * shows (the Changes panel header, the spawn-time base-drift note, the MCP
 * worktree list) is measured against remote-tracking refs, and those refs were
 * only ever refreshed when someone opened a panel or dropped a task on Done.
 * Opening a project nobody had touched in a week left every count a week stale
 * until then. This sweeps the FOCUSED project's remotes on open and on a timer,
 * so the signal is current with nobody opening anything.
 *
 * It only fetches. It never pulls, merges, or rebases: keeping a tree current
 * under a running agent is out of scope (#558), and the remedy stays explicit
 * ("Update from base").
 *
 * The timer lifecycle (`startForProject` / `stop`, the single active project,
 * the deferred first sweep) mirrors `src/main/pr/pr-refresh-scheduler.ts` line
 * for line, including its timer-leak safety (see
 * src/main/diagnostics/project-log-context.ts and src/main/shutdown.ts). The
 * sweep body differs: it queues through the git lock, described below.
 *  - the `setInterval` is created OUTSIDE `runWithProjectLogContext`; each tick
 *    wraps its work inside it (a timer created inside a run would leak that
 *    project's log context into every future tick),
 *  - the interval is `.unref()`'d so it never keeps the event loop alive past a
 *    clean Electron quit, and
 *  - it is explicitly cleared on project switch/delete and on shutdown.
 *
 * The sweep runs through `WorktreeManager.withGitLock` at BACKGROUND priority,
 * so it never delays a user-initiated git op that is waiting and never
 * contends with a `worktree add` on the `.git` lock. Two limits are known and
 * accepted: BACKGROUND orders WAITING jobs only, so a sweep that is already
 * running holds the queue for up to its two 5s caps; and a project switch
 * during the lock wait still fetches the old project once (throttled,
 * read-only, harmless). The 30s throttle inside `fetchAllRemotesIfStale` is a
 * floor under the schedule, not the schedule.
 */

import { runWithProjectLogContext } from '../diagnostics/project-log-context';
import { fetchAllRemotesIfStale } from './fetch-throttle';
import { WorktreeManager, GitQueuePriority } from './worktree-manager';
import type { IpcContext } from '../ipc/ipc-context';
import type { Project } from '../../shared/types';

let activeTimer: NodeJS.Timeout | null = null;
let activeProjectId: string | null = null;

/** Read the per-project fetch interval (minutes); null/<=0 means "off". */
function readIntervalMinutes(context: IpcContext, projectPath: string): number | null {
  try {
    return context.configManager.getEffectiveConfig(projectPath).git.autoFetchIntervalMinutes;
  } catch {
    return null;
  }
}

/** Run one sweep, tagged with the project's log context, guarded against a stale switch. */
function sweep(context: IpcContext, project: Project): void {
  if (context.currentProjectId !== project.id) return;
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

export const gitFetchScheduler = {
  /**
   * Run an immediate sweep for `project` and arm its periodic timer. Called on
   * every PROJECT_OPEN (cold restart AND warm switch-back) and after a config
   * change so a new interval takes effect without reopening. Synchronous-cheap:
   * the sweep itself is deferred off the IPC critical path.
   */
  startForProject(context: IpcContext, project: Project): void {
    // Tear down any prior project's timer first (single active-project model).
    gitFetchScheduler.stop();
    activeProjectId = project.id;

    // Defer the first sweep so PROJECT_OPEN is not delayed; the switch-guard
    // mirrors the deferred board-config block in handlers/projects.ts.
    setImmediate(() => sweep(context, project));

    const minutes = readIntervalMinutes(context, project.path);
    if (minutes == null || minutes <= 0) return; // Off: on-load sweep only, no timer.

    activeTimer = setInterval(() => sweep(context, project), minutes * 60_000);
    // Never let the timer block a clean quit; it is also explicitly cleared on
    // switch/delete/shutdown.
    activeTimer.unref();
  },

  /**
   * Stop the active timer. With a `projectId`, no-ops unless that project owns
   * the active timer (so deleting a non-focused project never kills the focused
   * project's timer). With no argument, always stops (shutdown / unconditional).
   */
  stop(projectId?: string): void {
    if (projectId != null && projectId !== activeProjectId) return;
    if (activeTimer) {
      clearInterval(activeTimer);
      activeTimer = null;
    }
    activeProjectId = null;
  },
};
