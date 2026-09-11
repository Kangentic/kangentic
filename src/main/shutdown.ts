import { closeAll, getProjectDb } from './db/database';
import { browserPaneRegistry } from './browser/browser-pane-registry';
import { destroyAllLanes } from './browser/browser-lane-manager';
import { popOutWindowManager } from './pop-out/pop-out-window-manager';
import { SessionRepository } from './db/repositories/session-repository';
import { TaskRepository } from './db/repositories/task-repository';
import { UsageHistoryRepository } from './db/repositories/usage-history-repository';
import { markRecordSuspended, markRecordExited } from './transition-engine/session-lifecycle';
import { captureSessionMetrics } from './ipc/handlers/session-metrics';
import { stopMetricsSnapshotTimer } from './ipc/handlers/metrics-snapshot-timer';
import type { SessionManager } from './pty/session-manager';
import type { PtyKillReport } from './pty/shutdown/session-shutdown';
import type { BoardConfigManager } from './config/board-config-manager';
import type { DiffWatcher } from './git/diff-watcher';
import type { TerminalSubmitScheduler } from './transition-engine/terminal-submit-scheduler';

interface ShutdownDependencies {
  getSessionManager: () => SessionManager;
  getBoardConfigManager: () => BoardConfigManager;
  getDiffWatcher: () => DiffWatcher | null;
  getTerminalSubmitScheduler: () => TerminalSubmitScheduler;
  getCurrentProjectId: () => string | null;
  deleteProjectFromIndex: (projectId: string) => void;
  stopUpdaterTimers: () => void;
  stopAnnouncementTimers: () => void;
  clearPendingTimers: () => void;
  isEphemeral: boolean;
  /**
   * Whether a young session's force-kill may ride the before-quit drain's
   * timer (see SessionManager.killAll). True only on a route where that drain
   * runs: a user quit and the macOS/Linux powerMonitor shutdown. False for a
   * Windows session-end and for SIGINT/SIGTERM, which exit with no drain and
   * so must leave nothing deferred.
   */
  allowGrace: boolean;
}

const HARD_SHUTDOWN_DEADLINE_MS = 6000;

/**
 * Run one best-effort cleanup step inside syncShutdownCleanup.
 *
 * A throwing step must never skip the steps after it. The PTY kill near the end
 * is load-bearing: an unkilled PTY hangs Electron's teardown until the 6s hard
 * failsafe force-exits with code 1, because node-pty's ThreadSafeFunction
 * finalizer joins the thread waiting on the child. Before this wrapper existed,
 * a single throw from any of the handle-closing steps landed in the function's
 * outer catch and left every PTY alive.
 *
 * The step name goes into the log line so a shutdown that lost a step says which
 * one, rather than only that "something" failed.
 */
function runCleanupStep(name: string, step: () => void): void {
  try {
    step();
  } catch (error) {
    console.error(`[SHUTDOWN] cleanup:step-failed ${name}`, error);
  }
}

/**
 * Synchronous shutdown: mark sessions as suspended in DB, kill PTYs, close DBs.
 *
 * CRITICAL: This must be fully synchronous. The previous approach used
 * event.preventDefault() + async shutdown + process.exit(), but that cancelled
 * Electron's normal quit flow. If the async chain stalled (analytics network
 * call, PTY wait, uncaught error), the app became a permanent zombie - all
 * Chromium child processes (GPU, utility, crashpad) stayed alive because
 * Electron never reached its own cleanup. By doing only sync work and letting
 * the quit proceed, Electron's normal shutdown tears down all child processes.
 *
 * The one sanctioned exception lives OUTSIDE this function: after it returns,
 * the before-quit handler (pty/shutdown/before-quit-handler.ts) holds the
 * quit for the timer-bounded PTY exit-callback drain and then re-issues
 * app.quit(). That is why this returns the kill report the drain waits on.
 *
 * Every cleanup step before the PTY kill runs through runCleanupStep, so one
 * failing handle-closer cannot leave every PTY alive and hang teardown until
 * the hard failsafe. The lone bare call in that region is the getSessionManager()
 * read, which is not a cleanup step: wrapping it would buy nothing, because a
 * throw there leaves nothing to kill with either way.
 */
export function syncShutdownCleanup(dependencies: ShutdownDependencies): PtyKillReport {
  console.log('[SHUTDOWN] cleanup:start');
  let ptyKillReport: PtyKillReport = { pids: [], killedCount: 0, deferredCount: 0 };
  // Clear pending timers that could fire during shutdown
  runCleanupStep('clearPendingTimers', () => dependencies.clearPendingTimers());
  runCleanupStep('stopUpdaterTimers', () => dependencies.stopUpdaterTimers());
  runCleanupStep('stopAnnouncementTimers', () => dependencies.stopAnnouncementTimers());
  // Stop the periodic metrics snapshot so no tick races the sync shutdown writes.
  runCleanupStep('stopMetricsSnapshotTimer', () => stopMetricsSnapshotTimer());

  try {
    // Detach any CDP debuggers attached to embedded Browser panes. Synchronous
    // per .claude/rules/synchronous-shutdown.md (detachDebugger guards a
    // destroyed webContents).
    runCleanupStep('browserPaneRegistry.detachAll', () => browserPaneRegistry.detachAll());

    // Destroy every offscreen browser lane. Synchronous, same rule: a lane is a
    // real BrowserWindow main owns, so nothing else tears it down on the way out.
    runCleanupStep('destroyAllLanes', () => destroyAllLanes());

    // Destroy every open pop-out window synchronously. Idempotent -- the main
    // window's 'close' handler (index.ts) already calls this in the normal quit
    // path, so this is a no-op there; it matters for SIGINT/SIGTERM and other
    // shutdown entry points that reach performShutdown() without a 'close' event.
    runCleanupStep('popOutWindowManager.destroyAll', () => popOutWindowManager.destroyAll());

    // Close active project's file watchers before killing sessions
    runCleanupStep('boardConfigManager.detach', () => dependencies.getBoardConfigManager().detach());

    // Close the recursive worktree fs.watch handles. These are libuv
    // FSWatcher handles (one per subscribed worktree, many after a
    // multi-project recovery session) that keep the event loop alive past
    // a clean quit if never closed - the failsafe-on-normal-close symptom.
    runCleanupStep('diffWatcher.closeAll', () => dependencies.getDiffWatcher()?.closeAll());

    // The one bare call in the pre-kill region, deliberately. It is not a
    // cleanup step: a throw here leaves no manager to kill PTYs with, so
    // wrapping it would only move the same outcome behind a log line.
    const sessionManager = dependencies.getSessionManager();
    runCleanupStep(
      'terminalSubmitScheduler.cancelAll',
      () => dependencies.getTerminalSubmitScheduler().cancelAll(),
    );

    // Mark running DB records as 'suspended' so sessions can resume on next launch.
    // This must happen BEFORE killAll() because killAll sends best-effort exit
    // signals then force-kills. The atomic compareAndUpdateStatus prevents the
    // onExit handler from overwriting 'suspended' back to 'exited'.
    //
    // Always mark as 'system' - the 'user' marker is reserved for explicit
    // pauses via the Pause button. Suppressing auto-resume-on-restart is
    // handled in resume-suspended.ts by reading the config directly, so
    // shutdown doesn't need to conflate "app is quitting" with "user paused".
    //
    // Clearing task.session_id here is required: SESSION_RESUME's precondition
    // check `if (task.session_id) throw` would otherwise reject the resume
    // click after restart, since the in-memory session IDs don't survive.
    //
    // Wrapped as one step: a throw here (listSessions, or getProjectDb before
    // the per-project catch below is entered) must not skip the PTY kill.
    runCleanupStep('markSessionsSuspended', () => {
      const allSessions = sessionManager.listSessions();
      const sessionsByProject = new Map<string, typeof allSessions>();
      for (const session of allSessions) {
        if (session.status === 'running' || session.status === 'queued') {
          const existing = sessionsByProject.get(session.projectId) || [];
          existing.push(session);
          sessionsByProject.set(session.projectId, existing);
        }
      }

      for (const [projectId, sessions] of sessionsByProject) {
        try {
          const db = getProjectDb(projectId);
          const sessionRepo = new SessionRepository(db);
          const usageHistoryRepo = new UsageHistoryRepository(db);
          const taskRepo = new TaskRepository(db);
          for (const session of sessions) {
            const record = sessionRepo.getLatestForTask(session.taskId);
            if (record && record.status === 'running') {
              // Flush in-flight metrics from usageCache to the DB BEFORE
              // marking suspended. captureSessionMetrics is fully synchronous
              // (in-memory read + better-sqlite3 UPDATE) so it's safe in this
              // sync-only shutdown path. Without this, every clean app close
              // loses cost/token/duration for any active session.
              captureSessionMetrics(
                sessionManager,
                sessionRepo,
                usageHistoryRepo,
                session.id,
                record.id,
                record.started_at,
                record.session_type,
              );
              markRecordSuspended(sessionRepo, record.id, 'system');
              taskRepo.update({ id: session.taskId, session_id: null });
            } else if (record && record.status === 'queued') {
              // Queued sessions never started Claude CLI - mark as exited
              // (not suspended) since there's nothing to resume.
              markRecordExited(sessionRepo, record.id);
              taskRepo.update({ id: session.taskId, session_id: null });
            }
          }
        } catch {
          // DB may already be closing
        }
      }
    });

    // Kill all PTY sessions (with best-effort exit signals). Stays synchronous -
    // no await. Sessions are resumable via --resume <agent_session_id> from the
    // DB record marked 'suspended' above. A young session's kill is parked on a
    // timer the before-quit drain outlasts when `allowGrace` says a drain
    // follows; the call itself never waits either way.
    //
    // NOT wrapped in runCleanupStep: this is the step everything above exists to
    // protect, and its report is the drain's only input. If it throws, the outer
    // catch takes over and the zero-value report leaves the quit undrained,
    // which is the honest outcome.
    ptyKillReport = sessionManager.killAll({ allowGrace: dependencies.allowGrace });
    runCleanupStep('sessionManager.dispose', () => sessionManager.dispose());

    // Ephemeral cleanup: delete project from index so it doesn't show on next launch.
    // The worktree directory cleanup (async) is skipped here - pruneStaleWorktreeProjects()
    // handles it on next launch of the main app.
    //
    // Wrapped for the same reason the pre-kill steps are: this writes to the
    // global index DB, which can be read-only (Sentry DESKTOP-9), and an
    // unwrapped throw here lands in the outer catch and skips closeAll() below.
    // Open SQLite handles keep the libuv loop referenced past a clean quit,
    // which is the leak class that ends in the 6s hard failsafe exiting with 1.
    if (dependencies.isEphemeral) {
      runCleanupStep('deleteEphemeralProject', () => {
        const projectId = dependencies.getCurrentProjectId();
        if (projectId) {
          dependencies.deleteProjectFromIndex(projectId);
        }
      });
    }

    runCleanupStep('closeAll', () => closeAll());
  } catch (error) {
    console.error('[APP] Shutdown error:', error);
  }
  console.log('[SHUTDOWN] cleanup:done');
  // Dev-only diagnostic; a no-op in production (dead-code-eliminated via __KANGENTIC_DEV__).
  logActiveHandlesAtShutdown();
  return ptyKillReport;
}

/**
 * Dev-only diagnostic: log the libuv handles still alive at `cleanup:done`,
 * summarized by resource type (e.g. PipeWrap from a node-pty pipe, StatWatcher
 * from an fs.watch poll, Timeout from an un-unref'd interval, TCP* from a
 * server). If any remain, Electron's normal quit cannot complete and the 6s
 * hard failsafe force-kills the tree (non-clean exit 1). This is the empirical
 * tripwire for that recurring leak class (HTTP keep-alive sockets in 2026-05;
 * worktree watchers / PTY pipes since). Gated by `__KANGENTIC_DEV__` so esbuild
 * dead-code-eliminates it from production builds.
 */
function logActiveHandlesAtShutdown(): void {
  if (!__KANGENTIC_DEV__) return;
  try {
    const activeHandleCounts: Record<string, number> = {};
    for (const handleTypeName of process.getActiveResourcesInfo()) {
      activeHandleCounts[handleTypeName] = (activeHandleCounts[handleTypeName] ?? 0) + 1;
    }
    console.log('[SHUTDOWN] active-handles at cleanup:done:', activeHandleCounts);
  } catch {
    // Diagnostic only - never let it affect the shutdown path.
  }
}

/**
 * Start the hard failsafe timer. If Electron's normal shutdown hangs (e.g.
 * GPU process won't terminate), this guarantees process termination. On Windows,
 * uses taskkill /T to kill the entire process tree including Chromium children.
 *
 * `onFired` runs right before the kill, synchronously, so the caller can leave
 * a record that this run ended by force rather than cleanly (the run-uptime
 * exit record read by the next launch's app_launch). It must not throw and
 * must not do network; a throw is swallowed so the kill always proceeds.
 */
export function startHardShutdownFailsafe(onFired?: () => void): void {
  setTimeout(() => {
    console.error('[SHUTDOWN] hard-failsafe:fired');
    try {
      onFired?.();
    } catch {
      // The record is best-effort; the kill below is the point.
    }
    if (process.platform === 'win32') {
      try {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        require('child_process').execSync(
          `taskkill /PID ${process.pid} /T /F`,
          { windowsHide: true, stdio: 'ignore' },
        );
        console.error('[SHUTDOWN] taskkill:done');
      } catch {
        // taskkill may fail if process is already dying
      }
    } else {
      // macOS/Linux: SIGKILL the process group to ensure child processes are cleaned up.
      // Negative PID targets the entire process group, not just the main process.
      try {
        process.kill(-process.pid, 'SIGKILL');
      } catch {
        // Process may already be dying
      }
    }
    process.exit(1);
  }, HARD_SHUTDOWN_DEADLINE_MS);
}
