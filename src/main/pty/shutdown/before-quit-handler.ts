import type { PtyExitDrainResult } from './exit-callback-drain';
import type { PtyKillReport } from './session-shutdown';

/**
 * The `before-quit` handler: the synchronous shutdown cleanup, then the one
 * sanctioned `event.preventDefault()` in the quit path, held only for the
 * bounded PTY exit-callback drain (see exit-callback-drain.ts for why), then
 * `app.quit()` again so Electron's normal teardown runs. Pure so the state
 * machine is unit-testable; src/main/index.ts supplies the Electron pieces.
 * See .claude/rules/synchronous-shutdown.md.
 */

export interface BeforeQuitEvent {
  preventDefault: () => void;
}

export interface BeforeQuitHandlerDependencies {
  /** Idempotent: does the real work on the first call, nothing afterwards.
   *  Returns true when THIS call ran the cleanup, false when another entry
   *  point had already run it. */
  performShutdown: () => boolean;
  /** True after an OS shutdown the app cannot ask to be delayed (Windows
   *  session-end). Its own signal rather than an empty kill report, so the skip
   *  can name its reason in a breadcrumb instead of being indistinguishable
   *  from "nothing was killed". */
  isOsInitiatedShutdown: () => boolean;
  /** What the cleanup killed. A zero report means no drain, no preventDefault. */
  getPtyKillReport: () => PtyKillReport;
  drainPtyExitCallbacks: (report: PtyKillReport) => Promise<PtyExitDrainResult>;
  /** Best-effort: the app should look quit while the drain runs. */
  hideAllWindows: () => void;
  /** Always app.quit(), never process.exit(): Electron must run its own teardown. */
  requestQuit: () => void;
  /** Defaults to console.log; the lines become Sentry console breadcrumbs.
   *  Every path that SKIPS the drain logs one, so a native crash report
   *  arriving with no pty-drain:start can be told apart from one where the
   *  drain ran and was not enough. */
  log?: (line: string) => void;
}

type DrainState = 'idle' | 'draining' | 'complete';

export function createBeforeQuitHandler(
  dependencies: BeforeQuitHandlerDependencies,
): (event: BeforeQuitEvent) => void {
  let drainState: DrainState = 'idle';
  const log = dependencies.log ?? ((line: string) => console.log(line));

  return (event: BeforeQuitEvent): void => {
    const cleanupRanInThisPass = dependencies.performShutdown();

    // Second pass after the drain: let Electron proceed.
    if (drainState === 'complete') return;

    // A repeated quit request while the drain is running keeps waiting; the
    // drain's own deadline bounds how long.
    if (drainState === 'draining') {
      event.preventDefault();
      return;
    }

    // A note, not a skip. Skipping here would silently disarm the crash
    // protection whenever the cleanup ran under another entry point, which is
    // the exact bug class this drain exists to prevent, so drain anyway on a
    // report some other pass produced.
    //
    // Its routine producer is the macOS/Linux powerMonitor 'shutdown' path,
    // which runs performShutdown() and then app.quit(), so the before-quit pass
    // that follows always sees false. There, this line followed by
    // pty-drain:start is the signature of an OS shutdown draining correctly.
    // Anywhere else it means a new shutdown entry point was added.
    if (!cleanupRanInThisPass) log('[SHUTDOWN] pty-drain:note cleanup-ran-earlier');

    if (dependencies.isOsInitiatedShutdown()) {
      log('[SHUTDOWN] pty-drain:skip reason=os-initiated-shutdown');
      drainState = 'complete';
      return;
    }

    const ptyKillReport = dependencies.getPtyKillReport();
    // killedCount is the load-bearing half: a kill whose child pid was
    // unreadable contributes no pid but still has an exit callback in flight.
    // The pids check is belt and braces against an inconsistent report.
    if (ptyKillReport.killedCount === 0 && ptyKillReport.pids.length === 0) {
      // Nothing to drain: byte-for-byte the plain synchronous quit.
      log('[SHUTDOWN] pty-drain:skip reason=no-pty-killed');
      drainState = 'complete';
      return;
    }

    drainState = 'draining';
    event.preventDefault();
    try {
      dependencies.hideAllWindows();
    } catch {
      // Cosmetic only; a window that refuses to hide must not block the quit.
    }

    const completeAndQuit = (): void => {
      drainState = 'complete';
      dependencies.requestQuit();
    };

    let drain: Promise<PtyExitDrainResult>;
    try {
      drain = dependencies.drainPtyExitCallbacks(ptyKillReport);
    } catch {
      completeAndQuit();
      return;
    }
    drain.then(completeAndQuit, completeAndQuit);
  };
}
