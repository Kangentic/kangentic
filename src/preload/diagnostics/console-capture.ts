import { ipcRenderer } from 'electron';
import { IPC } from '../../shared/ipc-channels';
import type { CrashRecord, LogEntry } from '../../shared/types';

/**
 * Renderer-side console + error capture. Patches `window.console.*` and
 * registers `error` / `unhandledrejection` listeners on `window`. Forwards
 * via `IPC.LOG_APPEND` and `IPC.CRASH_REPORT` to the main-process diagnostics
 * subsystem (`src/main/diagnostics/`), which decides whether to persist
 * based on the active toggles.
 *
 * Lives in preload (not the renderer bundle) so it runs before any
 * application code and survives even if the renderer's `index.tsx` throws
 * during boot.
 */

let installed = false;

export function installConsoleCapture(): void {
  if (installed) return;
  installed = true;

  const originalLog = console.log.bind(console);
  const originalWarn = console.warn.bind(console);
  const originalError = console.error.bind(console);
  const originalInfo = console.info.bind(console);
  const originalDebug = console.debug.bind(console);

  const wrap =
    (level: LogEntry['level'], original: (...args: unknown[]) => void) =>
    (...args: unknown[]): void => {
      original(...args);
      // Cheap-stringify info/debug/log levels: they're either silently
      // dropped on the main side (when `developer.persistConsoleLogs` is
      // off) or persisted to disk (when on). The expensive recursive
      // JSON.stringify with circular-safe replacer is reserved for
      // errors and warnings, where structured output of object/Error
      // args is genuinely useful for bug reports. For chatty renderers
      // (React warnings, HMR) this keeps the per-call cost dominated by
      // the IPC round-trip rather than serialization.
      const stringifier = level === 'error' || level === 'warn'
        ? stringifyArg
        : cheapStringify;
      try {
        const entry: LogEntry = {
          ts: new Date().toISOString(),
          level,
          source: 'renderer',
          args: args.map(stringifier),
        };
        ipcRenderer.invoke(IPC.LOG_APPEND, entry).catch(() => {
          // Best-effort. The main-side handler may not be installed yet
          // during very early boot; silently dropping is correct.
        });
      } catch {
        // Stringification failure must not crash the page.
      }
    };

  console.log = wrap('log', originalLog);
  console.warn = wrap('warn', originalWarn);
  console.error = wrap('error', originalError);
  console.info = wrap('info', originalInfo);
  console.debug = wrap('debug', originalDebug);

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

function stringifyArg(argument: unknown): string {
  if (argument instanceof Error) {
    return JSON.stringify({
      name: argument.name,
      message: argument.message,
      stack: argument.stack ?? null,
    });
  }
  if (typeof argument === 'object' && argument !== null) {
    try {
      return JSON.stringify(argument, circularSafeReplacer());
    } catch {
      return String(argument);
    }
  }
  return String(argument);
}

/**
 * Cheap stringification for info/debug/log levels. Skips the recursive
 * JSON.stringify + circular-safe replacer used for error/warn. Object
 * args become `[object Object]`, which is acceptable at these levels
 * because they're high-volume and low-diagnostic-value in persisted form.
 */
function cheapStringify(argument: unknown): string {
  if (argument === null) return 'null';
  if (argument === undefined) return 'undefined';
  return String(argument);
}

function circularSafeReplacer(): (key: string, value: unknown) => unknown {
  const seen = new WeakSet<object>();
  return (_key, value) => {
    if (typeof value === 'object' && value !== null) {
      if (seen.has(value as object)) return '[Circular]';
      seen.add(value as object);
    }
    return value;
  };
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
