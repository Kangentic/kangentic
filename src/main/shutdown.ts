import { closeAll, getProjectDb } from './db/database';
import { SessionRepository } from './db/repositories/session-repository';
import { markRecordSuspended, markRecordExited } from './engine/session-lifecycle';
import type { SessionManager } from './pty/session-manager';
import type { BoardConfigManager } from './config/board-config-manager';
import type { CommandInjector } from './engine/command-injector';

interface ShutdownDependencies {
  getSessionManager: () => SessionManager;
  getBoardConfigManager: () => BoardConfigManager;
  getCommandInjector: () => CommandInjector;
  getCurrentProjectId: () => string | null;
  deleteProjectFromIndex: (projectId: string) => void;
  stopUpdaterTimers: () => void;
  clearPendingTimers: () => void;
  isEphemeral: boolean;
}

const HARD_SHUTDOWN_DEADLINE_MS = 6000;

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
 */
export function syncShutdownCleanup(dependencies: ShutdownDependencies): void {
  // Clear pending timers that could fire during shutdown
  dependencies.clearPendingTimers();
  dependencies.stopUpdaterTimers();

  try {
    // Close active project's file watchers before killing sessions
    dependencies.getBoardConfigManager().detach();

    const sessionManager = dependencies.getSessionManager();
    dependencies.getCommandInjector().cancelAll();

    // Mark running DB records as 'suspended' so sessions can resume on next launch.
    // This must happen BEFORE killAll() because killAll sends best-effort exit
    // signals then force-kills. The atomic compareAndUpdateStatus prevents the
    // onExit handler from overwriting 'suspended' back to 'exited'.
    //
    // Tag with suspended_by='user' so recoverSessions/reconcileSessions leave
    // them paused on next launch. Nothing auto-resumes or auto-spawns until
    // the user explicitly clicks resume. This gives the user a clean slate
    // on every restart instead of a stampede of recovered/reconciled agents.
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
        for (const session of sessions) {
          const record = sessionRepo.getLatestForTask(session.taskId);
          if (record && record.status === 'running') {
            markRecordSuspended(sessionRepo, record.id, 'user');
          } else if (record && record.status === 'queued') {
            // Queued sessions never started Claude CLI - mark as exited
            // (not suspended) since there's nothing to resume.
            markRecordExited(sessionRepo, record.id);
          }
        }
      } catch {
        // DB may already be closing
      }
    }

    // Kill all PTY sessions immediately (with best-effort exit signals).
    // Stays synchronous - no await. Sessions are resumable via --resume
    // <agent_session_id> from the DB record marked 'suspended' above.
    sessionManager.killAll();
    sessionManager.dispose();

    // Ephemeral cleanup: delete project from index so it doesn't show on next launch.
    // The worktree directory cleanup (async) is skipped here - pruneStaleWorktreeProjects()
    // handles it on next launch of the main app.
    if (dependencies.isEphemeral) {
      const projectId = dependencies.getCurrentProjectId();
      if (projectId) {
        dependencies.deleteProjectFromIndex(projectId);
      }
    }

    closeAll();
  } catch (error) {
    console.error('[APP] Shutdown error:', error);
  }
}

/**
 * Start the hard failsafe timer. If Electron's normal shutdown hangs (e.g.
 * GPU process won't terminate), this guarantees process termination. On Windows,
 * uses taskkill /T to kill the entire process tree including Chromium children.
 */
export function startHardShutdownFailsafe(): void {
  setTimeout(() => {
    console.error('[APP] Hard shutdown deadline reached - forcing exit');
    if (process.platform === 'win32') {
      try {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        require('child_process').execSync(
          `taskkill /PID ${process.pid} /T /F`,
          { windowsHide: true, stdio: 'ignore' },
        );
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
