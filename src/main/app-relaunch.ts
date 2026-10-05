/**
 * Restart Kangentic, for a setting that only applies at startup (Graphics
 * acceleration: `app.disableHardwareAcceleration()` throws once the app is
 * ready, and `--disable-gpu` cannot be lifted from a running app).
 *
 * Every route ends in `app.quit()`, never `app.exit()`, so `before-quit` runs
 * the synchronous shutdown: sessions are suspended, PTYs are killed, and the
 * run records a `clean` exit. A restart must never read as `abrupt` to the next
 * launch's GPU check (gpu-health.ts's gpuEndedPreviousRun).
 *
 * Under `npm start`, `scripts/dev.js` owns the Electron child and tears Vite
 * down when it exits, so a bare `app.relaunch()` there would start an Electron
 * with no dev server behind it. dev.js passes `--dev-restart-file=<path>`
 * instead: writing that file before quitting asks dev.js to spawn Electron
 * again and keep Vite running. The caller reads the flag only under
 * `__KANGENTIC_DEV__`, so a production build never looks for it.
 *
 * A packaged build with an update already downloaded installs it and
 * relaunches into it instead (updater.ts's quitAndInstallIfUpdatePending):
 * with `autoInstallOnAppQuit` on, a plain quit would run the installer without
 * relaunching, and the installer closes the old instance a relaunch started.
 *
 * Electron-free (the caller passes `app`'s methods in), so the routing is
 * unit-testable.
 */

export const DEV_RESTART_FILE_FLAG = '--dev-restart-file=';

/** The restart-request path dev.js passed, or null when it passed none. */
export function devRestartFileFrom(argv: readonly string[]): string | null {
  for (const argument of argv) {
    if (argument.startsWith(DEV_RESTART_FILE_FLAG)) {
      const filePath = argument.slice(DEV_RESTART_FILE_FLAG.length);
      return filePath.length > 0 ? filePath : null;
    }
  }
  return null;
}

export interface RelaunchDependencies {
  /** E2E and UI runs never relaunch: `app.relaunch()` would orphan an
   *  Electron the test harness does not own (see tests/e2e/electron-janitor.ts). */
  isTest: boolean;
  /** dev.js's restart-request file, or null outside `npm start`. */
  devRestartFile: string | null;
  /** Installs a downloaded update and relaunches into it, returning true, or
   *  returns false when none is waiting (updater.ts's
   *  quitAndInstallIfUpdatePending). A plain quit with an update pending runs
   *  the installer without relaunching, and it closes the instance a relaunch
   *  started. */
  installPendingUpdateAndRelaunch: () => boolean;
  relaunch: () => void;
  quit: () => void;
  writeFile: (filePath: string, contents: string) => void;
}

export type RelaunchRoute = 'skipped-in-test' | 'dev-restart' | 'update-install' | 'relaunch';

/** Set once a restart has been requested, so the quit it starts can tell itself
 *  from a quit that ends the app. */
let restartRequested = false;

/**
 * Whether the quit in progress is a restart this process asked for. The
 * synchronous shutdown reads it: an ephemeral preview deletes its open project
 * from the index on a quit that ends it, but on a restart that would cost the
 * board and every suspended session the relaunch is about to resume.
 */
export function isRestartRequested(): boolean {
  return restartRequested;
}

/** Test-only: forget a requested restart between cases. */
export function resetRestartRequestedForTests(): void {
  restartRequested = false;
}

/** Throws if the dev restart file cannot be written, so the caller can tell the
 *  user the restart did not happen instead of quitting into a dead dev server. */
export function relaunchApp(dependencies: RelaunchDependencies): RelaunchRoute {
  if (dependencies.isTest) {
    console.log('[APP] Restart requested; skipped under NODE_ENV=test.');
    return 'skipped-in-test';
  }
  if (dependencies.devRestartFile) {
    dependencies.writeFile(dependencies.devRestartFile, new Date().toISOString());
    restartRequested = true;
    dependencies.quit();
    return 'dev-restart';
  }
  restartRequested = true;
  if (dependencies.installPendingUpdateAndRelaunch()) return 'update-install';
  dependencies.relaunch();
  dependencies.quit();
  return 'relaunch';
}
