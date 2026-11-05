import type { PtyExitDrainResult } from './exit-callback-drain';
import type { PtyKillReport } from './session-shutdown';

/**
 * The signal routes' end of the quit: the synchronous cleanup, the bounded wait
 * for the PTY exit-callback drain, then `process.exit`. Pure so it is
 * unit-testable; src/main/index.ts supplies the process pieces.
 *
 * Main exiting with the pty host alive closes the host's service pipe, and an
 * exit callback still in flight there dispatches after Node has stopped, which
 * aborts the host (Sentry DESKTOP-2A). So a POSIX signal waits for the same
 * drain as a user's quit. The wait is timer-only and deadline-bounded, and the
 * hard failsafe is armed before it starts. See
 * .claude/rules/synchronous-shutdown.md.
 *
 * Windows exits at once. A packaged Windows build has no console, so no signal
 * reaches it, and these routes run there only under `npm start`.
 */

export interface SignalExitDependencies {
  /** Idempotent: true only for the call that ran the cleanup. */
  performShutdown: () => boolean;
  getPtyKillReport: () => PtyKillReport;
  drainPtyExitCallbacks: (report: PtyKillReport) => Promise<PtyExitDrainResult>;
  /** Best-effort: the app should look quit while the drain runs. */
  hideAllWindows: () => void;
  /** Log lines are queued for a loop turn `exit` never reaches. */
  writeQueuedLogs: () => void;
  exit: () => void;
  platform?: NodeJS.Platform;
  /** Defaults to console.log. Every path that skips the drain logs one, as the
   *  before-quit handler's do, so a crash report says why no drain ran. */
  log?: (line: string) => void;
}

export function createSignalExitHandler(dependencies: SignalExitDependencies): () => void {
  const platform = dependencies.platform ?? process.platform;
  const log = dependencies.log ?? ((line: string) => console.log(line));

  const writeLogsAndExit = (): void => {
    dependencies.writeQueuedLogs();
    dependencies.exit();
  };

  return (): void => {
    // A second signal lands here during the wait, which ends at its own deadline.
    if (!dependencies.performShutdown()) return;

    if (platform === 'win32') {
      log('[SHUTDOWN] pty-drain:skip reason=windows-signal');
      writeLogsAndExit();
      return;
    }

    const report = dependencies.getPtyKillReport();
    if (report.killedCount === 0 && report.pids.length === 0) {
      log('[SHUTDOWN] pty-drain:skip reason=no-pty-killed');
      writeLogsAndExit();
      return;
    }

    try {
      dependencies.hideAllWindows();
    } catch {
      // Cosmetic only; a window that refuses to hide must not block the exit.
    }
    dependencies.writeQueuedLogs();

    let drain: Promise<PtyExitDrainResult>;
    try {
      drain = dependencies.drainPtyExitCallbacks(report);
    } catch {
      writeLogsAndExit();
      return;
    }
    drain.then(writeLogsAndExit, writeLogsAndExit);
  };
}
