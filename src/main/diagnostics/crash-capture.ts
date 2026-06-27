import * as fs from 'node:fs';
import * as path from 'node:path';
import { app, ipcMain } from 'electron';
import { IPC } from '../../shared/ipc-channels';
import type { CrashRecord } from '../../shared/types';
import { resolveCrashRecord } from './source-map-resolver';
import { isBenignStreamWriteError } from './benign-stream-error';

/**
 * Captures fatal-error events from main, preload, and renderer and persists
 * one JSON file per crash to `<projectRoot>/.kangentic/logs/crashes/<ts>.json`.
 * Always on; no user-facing toggle. The whole point is to never lose a crash.
 *
 * Sources:
 *   - `process.on('uncaughtException')` in main
 *   - `process.on('unhandledRejection')` in main
 *   - `webContents.on('render-process-gone')` per-window (renderer crashed)
 *   - `webContents.on('preload-error')` per-window (preload threw at load)
 *   - IPC.CRASH_REPORT from the preload error capture (window.onerror,
 *     unhandledrejection)
 *
 * Coexists with the existing `process.on('uncaughtException')` handler in
 * `src/main/index.ts` (analytics tracking + console.error). Node fires all
 * registered listeners in order; both run.
 */

interface CrashCaptureOptions {
  getProjectRoot: () => string | null;
}

let installed = false;

export function startCrashCapture(options: CrashCaptureOptions): void {
  if (installed) return;
  installed = true;

  process.on('uncaughtException', (error) => {
    // A recurring stdio `write EAGAIN`/EPIPE (the Windows npm-start TTY
    // artifact) is transient and survivable; do not persist a crash record
    // for it. See `benign-stream-error.ts`.
    if (isBenignStreamWriteError(error)) return;
    writeRecord(options.getProjectRoot(), {
      ts: new Date().toISOString(),
      kind: 'main-uncaught-exception',
      source: 'main',
      message: error.message,
      stack: error.stack ?? null,
      origin: null,
      context: null,
      versions: getVersions(),
    });
  });

  process.on('unhandledRejection', (reason) => {
    if (isBenignStreamWriteError(reason)) return;
    const error = reason instanceof Error ? reason : new Error(String(reason));
    writeRecord(options.getProjectRoot(), {
      ts: new Date().toISOString(),
      kind: 'main-unhandled-rejection',
      source: 'main',
      message: error.message,
      stack: error.stack ?? null,
      origin: null,
      context: null,
      versions: getVersions(),
    });
  });

  // Per-window crash listeners. `web-contents-created` fires for every
  // BrowserWindow + <webview> (the embedded browser pane has its own
  // webContents). We attach to all of them.
  app.on('web-contents-created', (_event, webContents) => {
    webContents.on('render-process-gone', (_evt, details) => {
      writeRecord(options.getProjectRoot(), {
        ts: new Date().toISOString(),
        kind: 'render-process-gone',
        source: 'renderer',
        message: `Render process gone: ${details.reason}`,
        stack: null,
        origin: safeGetUrl(webContents),
        context: { reason: details.reason, exitCode: details.exitCode },
        versions: getVersions(),
      });
    });
    webContents.on('preload-error', (_evt, preloadPath, error) => {
      writeRecord(options.getProjectRoot(), {
        ts: new Date().toISOString(),
        kind: 'preload-error',
        source: 'preload',
        message: error.message,
        stack: error.stack ?? null,
        origin: preloadPath,
        context: null,
        versions: getVersions(),
      });
    });
  });

  // Renderer-side error capture forwards through the preload script.
  ipcMain.handle(IPC.CRASH_REPORT, (_event, record: CrashRecord) => {
    writeRecord(options.getProjectRoot(), record);
  });
}

function writeRecord(projectRoot: string | null, record: CrashRecord): void {
  if (!projectRoot) return;
  // Resolve bundled-chunk URLs in the stack back to original source
  // file:line:col (V1 is a passthrough; replacing the resolver body adds
  // real source-map lookup with no caller changes).
  const resolved = resolveCrashRecord(record);
  const directory = path.join(projectRoot, '.kangentic', 'logs', 'crashes');
  try {
    fs.mkdirSync(directory, { recursive: true });
  } catch {
    return;
  }
  // Replace `:` and `.` so the filename is portable to Windows.
  const safeStamp = resolved.ts.replace(/[:.]/g, '-');
  const file = path.join(directory, `${safeStamp}.json`);
  try {
    fs.writeFileSync(file, JSON.stringify(resolved, null, 2), 'utf-8');
  } catch {
    // Best-effort.
  }
}

function safeGetUrl(webContents: Electron.WebContents): string | null {
  try {
    return webContents.getURL() || null;
  } catch {
    return null;
  }
}

function getVersions(): CrashRecord['versions'] {
  return {
    kangentic: app.getVersion(),
    electron: process.versions.electron,
    node: process.versions.node,
    chrome: process.versions.chrome,
  };
}
