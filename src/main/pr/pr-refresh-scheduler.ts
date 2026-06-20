/**
 * Per-project background PR-refresh scheduler. Kangentic has one focused project
 * at a time, so this keeps a single active timer: opening/switching to a project
 * runs an immediate sweep and (re)arms the periodic timer; switching away or
 * closing tears the prior timer down.
 *
 * Timer-leak safety (see src/main/diagnostics/project-log-context.ts and
 * src/main/shutdown.ts):
 *  - the `setInterval` is created OUTSIDE `runWithProjectLogContext`; each tick
 *    wraps its work inside it (a timer created inside a run would leak that
 *    project's log context into every future tick),
 *  - the interval is `.unref()`'d so it never keeps the event loop alive past a
 *    clean Electron quit (the "un-unref'd interval" zombie class), and
 *  - it is explicitly cleared on project switch/delete and on shutdown.
 */

import { runWithProjectLogContext } from '../diagnostics/project-log-context';
import { refreshProjectPRs } from './pr-refresh';
import type { IpcContext } from '../ipc/ipc-context';
import type { Project } from '../../shared/types';

let activeTimer: NodeJS.Timeout | null = null;
let activeProjectId: string | null = null;

/** Read the per-project refresh interval (minutes); null/<=0 means "off". */
function readIntervalMinutes(context: IpcContext, projectPath: string): number | null {
  try {
    return context.configManager.getEffectiveConfig(projectPath).git.prRefreshIntervalMinutes;
  } catch {
    return null;
  }
}

/** Run one sweep, tagged with the project's log context, guarded against a stale switch. */
function sweep(context: IpcContext, project: Project): void {
  if (context.currentProjectId !== project.id) return;
  runWithProjectLogContext(project.name, () => {
    void refreshProjectPRs(context, project.id).catch((error) => {
      console.error('[pr-refresh] sweep failed:', error);
    });
  });
}

export const prRefreshScheduler = {
  /**
   * Run an immediate sweep for `project` and arm its periodic timer. Called on
   * every PROJECT_OPEN (cold restart AND warm switch-back) and after a config
   * change so a new interval takes effect without reopening. Synchronous-cheap:
   * the sweep itself is deferred off the IPC critical path.
   */
  startForProject(context: IpcContext, project: Project): void {
    // Tear down any prior project's timer first (single active-project model).
    prRefreshScheduler.stop();
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
