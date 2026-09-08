/**
 * Shared startup-gate state, and the window-lifecycle decisions that read it.
 *
 * Two predicates live here: `shouldCreateWindowOnActivate` (macOS dock click)
 * and `decideSecondInstanceAction` (a second launch hitting the single-instance
 * lock). They are together because they answer the same question from two
 * events and share the same inputs - the startup flag below and the shutdown
 * flag from shutdown-state.ts - so a change to one is almost always a change to
 * both. Neither can live in src/main/index.ts: that file makes top-level
 * `electron` calls and cannot be imported by a unit test.
 *
 * The startup gate itself:
 *
 * macOS fires `app.on('activate')` during launch, before the `app.whenReady()`
 * body has finished. The module-scope activate handler in index.ts creates the
 * main window whenever the window count is zero, so it used to win that race
 * and build the window while whenReady was still parked on
 * `await startMcpHttpServer(...)`. The renderer then loaded and invoked
 * `announcements:get` / `announcements:getHistory` before
 * `initAnnouncements(mainWindow)` had called `ipcMain.handle`, and the invoke
 * rejected with "No handler registered" (Sentry DESKTOP-3 / DESKTOP-4). The
 * same race also left `registerAllIpc` holding an unsettled `mcpServerHandle`,
 * and produced a SECOND BrowserWindow once whenReady reached its own
 * `createWindow()` call.
 *
 * The gate closes all three: the activate handler is a no-op until the startup
 * sequence has created the window and registered its handlers.
 *
 * Mirrors shutdown-state.ts - one module-level flag, read through a function so
 * every caller observes the same value.
 */

let startupComplete = false;

export function isStartupComplete(): boolean {
  return startupComplete;
}

export function markStartupComplete(): void {
  startupComplete = true;
}

/** The inputs `shouldCreateWindowOnActivate` decides on. */
export interface ActivateWindowState {
  shuttingDown: boolean;
  startupComplete: boolean;
  openWindowCount: number;
}

/**
 * Whether an `activate` event should build the main window.
 *
 * Pure, and deliberately not inlined into the handler: src/main/index.ts makes
 * top-level `electron` calls and so cannot be imported by a unit test (see the
 * headers of tests/unit/developer-flag-defaults.test.ts and
 * tests/unit/config-manager.test.ts). Keeping the decision here is what makes
 * the launch-time ordering testable at all.
 */
export function shouldCreateWindowOnActivate(state: ActivateWindowState): boolean {
  if (state.shuttingDown) return false;
  // The launch-time activate. The whenReady body creates the window
  // unconditionally, so dropping this event loses nothing - acting on it is
  // what raced ahead of IPC registration.
  if (!state.startupComplete) return false;
  return state.openWindowCount === 0;
}

/** What a `second-instance` event should do with the running process. */
export type SecondInstanceAction = 'focus' | 'rebuild' | 'ignore';

/** The inputs `decideSecondInstanceAction` decides on. */
export interface SecondInstanceState {
  /** A main window exists AND is not destroyed. Truthiness alone is not enough:
   *  index.ts never nulled `mainWindow` on close, which is how a destroyed
   *  window reached isMinimized() (Sentry DESKTOP-J). */
  hasLiveWindow: boolean;
  shuttingDown: boolean;
  startupComplete: boolean;
}

/**
 * What a second launch should do to the process already holding the
 * single-instance lock.
 *
 * Pure, and lives here rather than inline in the handler for the same reason
 * `shouldCreateWindowOnActivate` does: src/main/index.ts makes top-level
 * `electron` calls and cannot be imported by a unit test.
 *
 * Sentry DESKTOP-J: the old handler was `if (mainWindow) { ...isMinimized() }`,
 * a bare truthiness check. Nothing ever assigned `mainWindow = null`, so once
 * the window closed the variable held a DESTROYED BrowserWindow, `isMinimized()`
 * threw `TypeError: Object has been destroyed`, and the throw escaped a raw
 * Electron event handler with no JS frame below it to catch.
 *
 * The order of the three checks is load-bearing:
 *
 * 1. `shuttingDown` first. The before-quit drain HIDES windows rather than
 *    destroying them (index.ts hideAllWindows), so during a quit the window is
 *    live-but-hidden. Checked any later, that state reads as `focus` and a
 *    second launch would un-hide an app that is mid-teardown.
 * 2. `hasLiveWindow` next: the ordinary case, and the only one that existed
 *    before this fix.
 * 3. `startupComplete` gates ONLY `rebuild`. The whenReady body creates the
 *    window unconditionally, so building one before the gate opens races IPC
 *    registration exactly as the launch-time activate did (DESKTOP-3/4). It
 *    must NOT gate `focus`: a window that already exists is safe to raise
 *    whether or not startup finished.
 *
 * `rebuild` means the app outlived its window - a browser lane survived the
 * 'closed' sweep, so getAllWindows() stayed above zero, window-all-closed never
 * fired, and on Windows app.quit() never ran. The process is an invisible
 * zombie still holding the lock. Rebuilding is what stops a second launch from
 * being silently swallowed by it.
 */
export function decideSecondInstanceAction(state: SecondInstanceState): SecondInstanceAction {
  if (state.shuttingDown) return 'ignore';
  if (state.hasLiveWindow) return 'focus';
  if (!state.startupComplete) return 'ignore';
  return 'rebuild';
}
