import { ipcRenderer } from 'electron';
import { IPC } from '../../shared/ipc-channels';
import type { CrashRecord } from '../../shared/types';

/**
 * Renderer-side error capture. Registers `error` / `unhandledrejection`
 * listeners on `window` and forwards each as a crash record over
 * `IPC.CRASH_REPORT` to the main-process diagnostics subsystem
 * (`src/main/diagnostics/`).
 *
 * Lives in preload (not the renderer bundle) so it runs before any
 * application code and survives even if the renderer's `index.tsx` throws
 * during boot.
 *
 * This module used to patch `console.*` as well and forward every call for
 * the log file. Under context isolation that patch sat in the preload's own
 * world, where the app's console calls never passed, so it kept nothing the
 * renderer printed. Main now takes a window's console output from its
 * `console-message` event (`mirrorRendererConsole` in
 * `src/main/diagnostics/log-mirror.ts`).
 */

let installed = false;

export function installRendererCrashCapture(): void {
  if (installed) return;
  installed = true;

  window.addEventListener('error', (event) => {
    reportCrash({
      ts: new Date().toISOString(),
      kind: 'renderer-window-error',
      source: 'renderer',
      message: event.message ?? String(event.error ?? 'window error'),
      stack: extractStack(event.error),
      origin: event.filename || window.location?.href || null,
      context: {
        line: event.lineno,
        col: event.colno,
      },
      versions: getVersions(),
    });
  });

  window.addEventListener('unhandledrejection', (event) => {
    const reason = event.reason;
    const message =
      reason instanceof Error ? reason.message : String(reason ?? 'unhandled rejection');
    reportCrash({
      ts: new Date().toISOString(),
      kind: 'renderer-unhandled-rejection',
      source: 'renderer',
      message,
      stack: extractStack(reason),
      origin: window.location?.href || null,
      context: null,
      versions: getVersions(),
    });
  });
}

/**
 * A renderer callback the preload called on a push threw (push-callback-guard.ts).
 * The local record keeps the message, as every crash record does; main sends
 * Sentry only the error's type and frames, tagged with `method`.
 */
export function reportPushCallbackFailure(method: string, error: unknown): void {
  const errorName = error instanceof Error && typeof error.name === 'string' ? error.name : 'Error';
  console.error(`[preload] a ${method} callback threw:`, error);
  reportCrash({
    ts: new Date().toISOString(),
    kind: 'renderer-window-error',
    source: 'preload',
    message: error instanceof Error ? error.message : String(error),
    stack: extractStack(error),
    origin: window.location?.href || null,
    context: { pushCallback: method, errorName },
    versions: getVersions(),
  });
}

function reportCrash(record: CrashRecord): void {
  try {
    ipcRenderer.invoke(IPC.CRASH_REPORT, record).catch(() => {
      // Best-effort.
    });
  } catch {
    // Best-effort.
  }
}

function extractStack(value: unknown): string | null {
  if (value instanceof Error && typeof value.stack === 'string') return value.stack;
  if (typeof value === 'object' && value !== null && 'stack' in value) {
    const stack = (value as { stack?: unknown }).stack;
    if (typeof stack === 'string') return stack;
  }
  return null;
}

function getVersions(): CrashRecord['versions'] {
  // Preload runs in a renderer process so `app.getVersion()` is unavailable.
  // The main side fills `kangentic` from `app.getVersion()` when it writes
  // its own crash records; here we record what `process.versions` exposes
  // and let the main side override `kangentic` if it wants to.
  return {
    kangentic: 'unknown',
    electron: process.versions.electron ?? 'unknown',
    node: process.versions.node ?? 'unknown',
    chrome: process.versions.chrome ?? 'unknown',
  };
}
