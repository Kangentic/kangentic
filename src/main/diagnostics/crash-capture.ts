import * as fs from 'node:fs';
import * as path from 'node:path';
import { app, ipcMain } from 'electron';
import { IPC } from '../../shared/ipc-channels';
import type { CrashRecord } from '../../shared/types';
import { resolveCrashRecord } from './source-map-resolver';
import { isBenignStreamWriteError } from './benign-stream-error';
import { recordGpuModeObservation, recordGpuProcessGone } from './gpu-health';
import { createLinuxGpuZygoteProbe } from './linux-gpu-zygote';
import { getLastHostMemorySample } from './host-memory';
import { PATHS } from '../config/paths';

/**
 * Captures fatal-error events from main, preload, and renderer and persists
 * one JSON file per crash to `<projectRoot>/.kangentic/logs/crashes/<ts>.json`.
 * Always on; no user-facing toggle. The whole point is to never lose a crash.
 *
 * Sources:
 *   - `process.on('uncaughtException')` in main
 *   - `process.on('unhandledRejection')` in main
 *   - `webContents.on('render-process-gone')` per-window (renderer crashed)
 *   - `app.on('child-process-gone')` for the GPU process (crashed or killed;
 *     a clean exit is not recorded). Sentry sees these only as native
 *     minidumps when error reporting is on; locally nothing else records that
 *     the GPU process died, and a GPU death is what puts every terminal on
 *     the slow DOM renderer for the next two minutes (see
 *     `src/renderer/utils/terminal-webgl.ts`).
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
  /** `<configDir>/gpu-health.json`, computed once from PATHS by the caller
   *  (this module stays decoupled from PATHS, matching run-uptime.ts). Where
   *  a repeated GPU death's escalation record is written for the NEXT launch
   *  to report - see gpu-health.ts for why not live. */
  gpuHealthFilePath: string;
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
      // DESKTOP-16: read synchronously, never re-sample - crash time is not
      // the moment to call an OS API that may itself need to allocate.
      writeRecord(options.getProjectRoot(), {
        ts: new Date().toISOString(),
        kind: 'render-process-gone',
        source: 'renderer',
        message: `Render process gone: ${details.reason}`,
        stack: null,
        origin: safeGetUrl(webContents),
        context: { reason: details.reason, exitCode: details.exitCode, hostMemory: getLastHostMemorySample() },
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

  // The GPU process is not a webContents, so it has no per-window event; the
  // app-level `child-process-gone` is where a crash or kill of it is visible.
  // Chromium relaunches it on its own, so this is a record, not a recovery.
  // Not every GPU failure arrives here: see `gpu-info-update` below.
  app.on('child-process-gone', (_event, details) => {
    if (details.type !== 'GPU' || details.reason === 'clean-exit') return;
    // breadcrumb-ok: Electron's child-process-gone reason is a fixed enum, not error text
    console.warn(`[gpu] GPU process gone: ${details.reason} (exit code ${details.exitCode})`);
    writeRecord(options.getProjectRoot(), {
      ts: new Date().toISOString(),
      kind: 'gpu-process-gone',
      source: 'gpu',
      message: `GPU process gone: ${details.reason}`,
      stack: null,
      origin: null,
      context: { reason: details.reason, exitCode: details.exitCode },
      versions: getVersions(),
    });
    // Counts repeated deaths across the whole run (not gated on a project
    // being open, unlike the local record above) and rewrites the durable
    // escalation record on every death - see gpu-health.ts.
    recordGpuProcessGone(options.gpuHealthFilePath, details.reason, details.exitCode, app.getVersion(), {
      // gpu-health.ts stays Electron-free (matches run-uptime.ts), so it
      // takes a plain record rather than Electron's GPUFeatureStatus type.
      getFeatureStatus: () => ({ ...app.getGPUFeatureStatus() }),
    });
  });

  // A GPU process that fails to LAUNCH never reaches `child-process-gone`
  // (Electron does not forward Chromium's launch-failed notification), and
  // on Linux neither does one whose zygote died with it. What Chromium does
  // announce is the fallback to its last rung, as a `gpu-info-update`, before
  // the fatal that follows it (DESKTOP-W). gpu-health.ts writes only when
  // compositing leaves the GPU, so the update that fires on every normal GPU
  // restart costs one status read and no write.
  //
  // On Linux the fallback also records whether the GPU's zygote was alive
  // (linux-gpu-zygote.ts). The zygote is found on the first update, which
  // arrives while the GPU is still initializing and healthy, because once the
  // zygote is dead there is nothing left to find. After that, discover()
  // returns at once.
  const linuxZygoteProbe = process.platform === 'linux' ? createLinuxGpuZygoteProbe(process.pid) : null;
  app.on('gpu-info-update', () => {
    linuxZygoteProbe?.discover();
    recordGpuModeObservation(options.gpuHealthFilePath, app.getVersion(), {
      getFeatureStatus: () => ({ ...app.getGPUFeatureStatus() }),
      readLinuxProcessSnapshot: linuxZygoteProbe ? () => linuxZygoteProbe.snapshot() : undefined,
    });
  });

  // Renderer-side error capture forwards through the preload script.
  ipcMain.handle(IPC.CRASH_REPORT, (_event, record: CrashRecord) => {
    writeRecord(options.getProjectRoot(), record);
  });
}

function writeRecord(projectRoot: string | null, record: CrashRecord): void {
  // Resolve bundled-chunk URLs in the stack back to original source
  // file:line:col (V1 is a passthrough; replacing the resolver body adds
  // real source-map lookup with no caller changes).
  const resolved = resolveCrashRecord(record);
  // No project open (or none yet at startup): fall back to the app's own
  // config dir rather than dropping the record. A crash is exactly the kind
  // of event that must not silently go missing because nothing was open.
  const directory = projectRoot
    ? path.join(projectRoot, '.kangentic', 'logs', 'crashes')
    : path.join(PATHS.configDir, 'logs', 'crashes');
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
