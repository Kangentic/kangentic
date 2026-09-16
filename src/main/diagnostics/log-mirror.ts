import * as path from 'node:path';
import { ipcMain } from 'electron';
import { IPC } from '../../shared/ipc-channels';
import type { LogEntry } from '../../shared/types';
import { resolveLogEntry } from './source-map-resolver';
import { queueAppend } from './async-file-queue';
import { getCurrentProjectLogName } from './project-log-context';

/**
 * Persistent console-output mirror. Patches `console.log/warn/error/info/debug`
 * in the main process and listens on IPC.LOG_APPEND for renderer-side output
 * forwarded by the preload script. Lines are appended as NDJSON to
 * `<projectRoot>/.kangentic/logs/<YYYY-MM-DD>.log`.
 *
 * Verbosity gating:
 *   - `error` and `warn` are ALWAYS persisted.
 *   - `info`, `debug`, `log` are persisted only when `developer.persistConsoleLogs`
 *     is `true`.
 *
 * Resilience: when `getProjectRoot()` returns null (no project open yet) or
 * when the file system rejects the write, the call is silently dropped. We
 * never want a diagnostic feature to crash the app. The same guarantee
 * covers the terminal echo below: the echo itself can throw, which is what
 * a packaged Windows GUI build with no console attached did, and that throw
 * must not propagate into whatever main-process code called `console.*` in
 * the first place. The catch names which paths actually reach it.
 */

interface LogMirrorOptions {
  /** Returns the active project root, or null when no project is open. */
  getProjectRoot: () => string | null;
  /** Returns the current value of `developer.persistConsoleLogs`. */
  getPersistInfoDebug: () => boolean;
}

let installed = false;

export function startLogMirror(options: LogMirrorOptions): void {
  if (installed) return;
  installed = true;

  const originalLog = console.log;
  const originalWarn = console.warn;
  const originalError = console.error;
  const originalInfo = console.info;
  const originalDebug = console.debug;

  const wrap =
    (level: LogEntry['level'], original: (...args: unknown[]) => void) =>
    (...args: unknown[]): void => {
      const now = new Date();
      // Always call the original first so the dev console still shows output
      // and any other listeners (analytics, devtools) see the call. Even if
      // the persistence path throws below, the original was invoked first so
      // visible behavior is unchanged. A compact local-time prefix is prepended
      // to the terminal echo only (the persisted record below keeps its own
      // un-prefixed `args` plus a full ISO `ts`) so it's clear when each line
      // happened while watching the dev terminal. When the line was emitted
      // inside a per-project async region (see project-log-context.ts), a
      // `[projectName]` tag follows the timestamp so interleaved multi-project
      // output (the startup-recovery flurry, etc.) can be tied back to its
      // project; global lines (updater, shutdown, bootstrap) have no ambient
      // project and stay untagged.
      const projectName = getCurrentProjectLogName();
      const prefix = projectName
        ? `[${formatLogTimestamp(now)}] [${projectName}]`
        : `[${formatLogTimestamp(now)}]`;
      // Built outside the guard below on purpose: that guard is for a dead
      // stdout, and a defect in prefixConsoleArgs must still surface.
      const echoArgs = prefixConsoleArgs(args, prefix);
      try {
        original.apply(console, echoArgs);
      } catch {
        // A dead stdout must not reach the caller. Left unguarded, a throw
        // out of the echo aborted the CALLER mid-function (Sentry
        // DESKTOP-10/11/12, from a packaged Windows GUI build, which has
        // no console attached: agent detection threw away a CLI it had
        // just found).
        //
        // Measured on Node 24, because what can reach this catch is
        // narrower than it looks: console swallows write failures itself,
        // both a synchronous throw and an error handed to the write
        // callback, so neither of those gets here. Two things do escape,
        // because console does them BEFORE entering that guard. It
        // resolves `process.stdout`, so a throw from constructing the
        // stream comes straight out. And it formats the args, so a
        // hostile one does too (a throwing custom inspect, or a throwing
        // Symbol.toPrimitive under %s; plain getters are safe, inspect
        // does not call them).
        //
        // So the catch stays untyped on purpose: neither path reliably
        // produces an EPIPE, and narrowing this to a code would reopen the
        // crash. Persistence below must still run, because in exactly this
        // environment the log file is the only record. Never log from
        // here, the echo is what just failed.
      }
      if (!shouldPersist(level, options.getPersistInfoDebug())) return;
      appendLog(options.getProjectRoot(), {
        ts: now.toISOString(),
        level,
        source: 'main',
        args: args.map(stringifyArg),
      });
    };

  console.log = wrap('log', originalLog);
  console.warn = wrap('warn', originalWarn);
  console.error = wrap('error', originalError);
  console.info = wrap('info', originalInfo);
  console.debug = wrap('debug', originalDebug);

  // Renderer + preload forward via IPC.LOG_APPEND. The preload patch
  // (src/preload/diagnostics/console-capture.ts) is the producer.
  ipcMain.handle(IPC.LOG_APPEND, (_event, entry: LogEntry) => {
    if (!shouldPersist(entry.level, options.getPersistInfoDebug())) return;
    appendLog(options.getProjectRoot(), entry);
  });
}

function shouldPersist(level: LogEntry['level'], persistInfoDebug: boolean): boolean {
  if (level === 'error' || level === 'warn') return true;
  return persistInfoDebug;
}

/**
 * Compact local-time stamp `HH:MM:SS.mmm` for the terminal echo. Local (not
 * UTC) because it's read by a developer watching their own clock; the persisted
 * NDJSON keeps the unambiguous full ISO `ts` separately.
 */
export function formatLogTimestamp(date: Date): string {
  const hours = String(date.getHours()).padStart(2, '0');
  const minutes = String(date.getMinutes()).padStart(2, '0');
  const seconds = String(date.getSeconds()).padStart(2, '0');
  const milliseconds = String(date.getMilliseconds()).padStart(3, '0');
  return `${hours}:${minutes}:${seconds}.${milliseconds}`;
}

/**
 * Prepend `prefix` to a console arg list in a printf-format-safe way. When the
 * first argument is a string it is concatenated into the format-string slot so
 * any specifiers (`%s`, `%d`, ...) keep binding to the trailing args; a
 * separate leading arg would shift them out of alignment. Otherwise (object
 * first arg, or no args at all) the prefix is passed as its own leading arg so
 * the object still renders structured in the terminal.
 */
export function prefixConsoleArgs(args: unknown[], prefix: string): unknown[] {
  if (typeof args[0] === 'string') {
    return [`${prefix} ${args[0]}`, ...args.slice(1)];
  }
  return [prefix, ...args];
}

function appendLog(projectRoot: string | null, entry: LogEntry): void {
  if (!projectRoot) return;
  // Pass entries through the source-map resolver so any embedded stacks
  // in stringified Error args resolve to original source coordinates
  // (V1 is a passthrough; replacing the resolver body adds real
  // source-map lookup with no caller changes).
  const resolved = resolveLogEntry(entry);
  // YYYY-MM-DD slice of an ISO 8601 timestamp.
  const date = resolved.ts.slice(0, 10);
  const file = path.join(projectRoot, '.kangentic', 'logs', `${date}.log`);
  // Async-buffered: queueAppend returns immediately; the disk write
  // happens on the next setImmediate turn. Eliminates the per-call
  // appendFileSync + mkdirSync that blocked the main event loop on
  // every console.* and IPC.LOG_APPEND.
  queueAppend(file, JSON.stringify(resolved) + '\n');
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
