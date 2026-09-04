/**
 * Shared startup-gate state module.
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
