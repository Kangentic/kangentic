import type { PtyExitDrainResult } from './exit-callback-drain';

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
  /** Idempotent: does the real work on the first call, nothing afterwards. */
  performShutdown: () => void;
  /** Child pids the cleanup killed; empty means no drain and no preventDefault. */
  getKilledPtyPids: () => number[];
  drainPtyExitCallbacks: (pids: number[]) => Promise<PtyExitDrainResult>;
  /** Best-effort: the app should look quit while the drain runs. */
  hideAllWindows: () => void;
  /** Always app.quit(), never process.exit(): Electron must run its own teardown. */
  requestQuit: () => void;
}

type DrainState = 'idle' | 'draining' | 'complete';

export function createBeforeQuitHandler(
  dependencies: BeforeQuitHandlerDependencies,
): (event: BeforeQuitEvent) => void {
  let drainState: DrainState = 'idle';

  return (event: BeforeQuitEvent): void => {
    dependencies.performShutdown();

    // Second pass after the drain: let Electron proceed.
    if (drainState === 'complete') return;

    // A repeated quit request while the drain is running keeps waiting; the
    // drain's own deadline bounds how long.
    if (drainState === 'draining') {
      event.preventDefault();
      return;
    }

    const killedPtyPids = dependencies.getKilledPtyPids();
    if (killedPtyPids.length === 0) {
      // Nothing to drain: byte-for-byte the plain synchronous quit.
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
      drain = dependencies.drainPtyExitCallbacks(killedPtyPids);
    } catch {
      completeAndQuit();
      return;
    }
    drain.then(completeAndQuit, completeAndQuit);
  };
}
