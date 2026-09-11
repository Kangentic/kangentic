import { startLogMirror } from './log-mirror';
import { startCrashCapture } from './crash-capture';
import { configureDebugDumpResolver } from './debug-dump-resolver';
import { installIpcRecorder } from './ipc-recorder';

/**
 * Single entry point for the product diagnostics subsystem. Called once from
 * `src/main/index.ts` near the top of process startup, BEFORE
 * `registerAllIpc()` runs (so the IPC recorder can patch `ipcMain.handle`
 * before any handler registers).
 *
 * Always installs:
 *   - IPC traffic recorder (patches `ipcMain.handle`; runtime gated)
 *   - log mirror (console.* → .kangentic/logs/<date>.log)
 *   - crash capture (uncaughtException, render-process-gone, the GPU
 *     child-process-gone, preload-error, renderer window.onerror via IPC)
 *   - debug-dump path resolver (for SessionTelemetry's ActivitySnapshotWriter)
 *
 * Verbosity / activation gates are read live via the callbacks so toggle
 * changes take effect without restart.
 */

export interface DiagnosticsContext {
  /** Returns the active project root path, or null when no project is open. */
  getProjectRoot: () => string | null;
  /** Returns the current value of `developer.activityDebugOverlay`. */
  getActivityDebugOverlayEnabled: () => boolean;
  /** Returns the current value of `developer.persistConsoleLogs`. */
  getPersistConsoleLogs: () => boolean;
  /** Returns the current value of `developer.recordIpcTraffic`. */
  getRecordIpcTraffic: () => boolean;
}

let installed = false;

export function installDiagnostics(context: DiagnosticsContext): void {
  if (installed) return;
  installed = true;

  // Patch ipcMain.handle FIRST so subsequent ipcMain.handle calls inside
  // log-mirror / crash-capture (and every later registerXyzHandlers) flow
  // through the recorder. `enabled` is read live so the patched handlers
  // are no-ops until the user toggles `developer.recordIpcTraffic` on.
  installIpcRecorder({
    getProjectRoot: context.getProjectRoot,
    enabled: context.getRecordIpcTraffic,
  });

  startLogMirror({
    getProjectRoot: context.getProjectRoot,
    getPersistInfoDebug: context.getPersistConsoleLogs,
  });

  startCrashCapture({
    getProjectRoot: context.getProjectRoot,
  });

  configureDebugDumpResolver({
    getProjectRoot: context.getProjectRoot,
    getActivityDebugOverlayEnabled: context.getActivityDebugOverlayEnabled,
  });
}
