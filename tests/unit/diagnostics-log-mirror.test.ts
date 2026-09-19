/**
 * Unit tests for `src/main/diagnostics/log-mirror.ts`.
 *
 * Verifies:
 *   - error + warn are persisted to `<projectRoot>/.kangentic/logs/<date>.log`
 *     even when the verbosity toggle is off (errors are never silently lost).
 *   - info / debug / log are persisted only when the toggle is on.
 *   - Each persisted line is valid NDJSON conforming to the LogEntry shape.
 *   - When `getProjectRoot()` returns null (the Welcome Screen, the gap
 *     between projects), the line lands in `<configDir>/logs/<date>.log`
 *     instead of being dropped, the same fallback crash capture uses.
 *   - The IPC.LOG_APPEND handler is registered for the renderer-side relay.
 *
 * The module patches global `console.*` at install time, so the test
 * captures the original handles before importing and restores them after
 * each run to keep output predictable across other tests.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as util from 'node:util';

const ipcHandlers = new Map<string, (...args: unknown[]) => unknown>();

vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => {
      ipcHandlers.set(channel, handler);
    }),
    on: vi.fn(),
  },
}));

// The app's own config dir, which the mirror falls back to with no project
// open. Read through a getter so each test's fresh module (vi.resetModules)
// sees the per-test tmpdir assigned in beforeEach.
const fallbackConfigDir = vi.hoisted(() => ({ current: '' }));
vi.mock('../../src/main/config/paths', () => ({
  PATHS: {
    get configDir() {
      return fallbackConfigDir.current;
    },
  },
}));

let tempDirectory: string;
let originalLog: typeof console.log;
let originalWarn: typeof console.warn;
let originalError: typeof console.error;
let originalInfo: typeof console.info;
let originalDebug: typeof console.debug;

beforeEach(async () => {
  ipcHandlers.clear();
  tempDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'log-mirror-test-'));
  fallbackConfigDir.current = path.join(tempDirectory, 'app-config');
  originalLog = console.log;
  originalWarn = console.warn;
  originalError = console.error;
  originalInfo = console.info;
  originalDebug = console.debug;
  // log-mirror has a module-scoped `installed` flag; vi.resetModules
  // forces a fresh module on each `await import('...log-mirror')` so
  // each test re-installs with its own getProjectRoot closure pointing
  // at the per-test tmpdir. async-file-queue must be re-imported via
  // the same fresh registry so resetForTest() targets the SAME queue
  // instance that log-mirror's queueAppend writes to. A static top-level
  // import would bind to a pre-reset copy and silently flush an empty
  // queue.
  vi.resetModules();
  const { resetForTest } = await import('../../src/main/diagnostics/async-file-queue');
  resetForTest();
});

afterEach(() => {
  console.log = originalLog;
  console.warn = originalWarn;
  console.error = originalError;
  console.info = originalInfo;
  console.debug = originalDebug;
  try {
    fs.rmSync(tempDirectory, { recursive: true, force: true });
  } catch {
    // best-effort
  }
});

async function readLogLines(date: string): Promise<Array<{ ts: string; level: string; source: string; args: string[] }>> {
  // Writes are async-buffered through the file queue; await pending
  // flushes before reading. Dynamic import binds to the same fresh
  // queue instance that log-mirror is using post-resetModules.
  const { flushAllForTest } = await import('../../src/main/diagnostics/async-file-queue');
  await flushAllForTest();
  const file = path.join(tempDirectory, '.kangentic', 'logs', `${date}.log`);
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, 'utf-8')
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line));
}

function todayUtc(): string {
  return new Date().toISOString().slice(0, 10);
}

/**
 * The exact shape packaged Windows sync-pipe stdio produces (`uvException`):
 * `<code>: <uv message>, <syscall>`, with `code` and `syscall` set. This is
 * the error that reached Sentry as DESKTOP-10/11/12.
 */
function epipeWriteError(): NodeJS.ErrnoException {
  const error: NodeJS.ErrnoException = new Error('EPIPE: broken pipe, write');
  error.code = 'EPIPE';
  error.syscall = 'write';
  return error;
}

describe('log-mirror', () => {
  it('persists error and warn even when persistInfoDebug is false', async () => {
    const { startLogMirror } = await import('../../src/main/diagnostics/log-mirror');
    startLogMirror({
      getProjectRoot: () => tempDirectory,
      getPersistInfoDebug: () => false,
    });

    console.error('boom', { code: 42 });
    console.warn('careful');
    console.info('chat');
    console.debug('verbose');
    console.log('plain');

    const lines = await readLogLines(todayUtc());
    const levels = lines.map((entry) => entry.level).sort();
    expect(levels).toEqual(['error', 'warn']);

    const errorLine = lines.find((entry) => entry.level === 'error');
    expect(errorLine?.source).toBe('main');
    expect(errorLine?.args[0]).toBe('boom');
    expect(JSON.parse(errorLine!.args[1])).toEqual({ code: 42 });
    expect(typeof errorLine?.ts).toBe('string');
  });

  it('persists info and debug when persistInfoDebug is true', async () => {
    const { startLogMirror } = await import('../../src/main/diagnostics/log-mirror');
    startLogMirror({
      getProjectRoot: () => tempDirectory,
      getPersistInfoDebug: () => true,
    });

    console.info('chat');
    console.debug('verbose');
    console.log('plain');

    const lines = await readLogLines(todayUtc());
    const levels = lines.map((entry) => entry.level).sort();
    expect(levels).toEqual(['debug', 'info', 'log']);
  });

  it('falls back to the app config dir when project root is null (no project open)', async () => {
    const { startLogMirror, resolveLogDirectory } = await import('../../src/main/diagnostics/log-mirror');
    startLogMirror({
      getProjectRoot: () => null,
      getPersistInfoDebug: () => true,
    });

    expect(() => {
      console.error('no-project');
      console.info('still no-project');
    }).not.toThrow();

    // A global subsystem (the mobile bridge, the updater) logs whether or
    // not a project is open; those lines used to vanish for as long as none
    // was. They land beside crash capture's own fallback instead.
    const { flushAllForTest } = await import('../../src/main/diagnostics/async-file-queue');
    await flushAllForTest();
    expect(resolveLogDirectory(null)).toBe(path.join(fallbackConfigDir.current, 'logs'));
    expect(resolveLogDirectory(tempDirectory)).toBe(path.join(tempDirectory, '.kangentic', 'logs'));
    expect(fs.existsSync(path.join(tempDirectory, '.kangentic', 'logs'))).toBe(false);
    const fallbackFile = path.join(fallbackConfigDir.current, 'logs', `${todayUtc()}.log`);
    const lines = fs
      .readFileSync(fallbackFile, 'utf-8')
      .split(/\r?\n/)
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line) as { level: string; args: string[] });
    expect(lines.map((entry) => entry.level).sort()).toEqual(['error', 'info']);
    expect(lines.find((entry) => entry.level === 'error')?.args[0]).toBe('no-project');
  });

  it('registers an IPC.LOG_APPEND handler for renderer-side relay', async () => {
    const { startLogMirror } = await import('../../src/main/diagnostics/log-mirror');
    const { IPC } = await import('../../src/shared/ipc-channels');
    startLogMirror({
      getProjectRoot: () => tempDirectory,
      getPersistInfoDebug: () => true,
    });

    const handler = ipcHandlers.get(IPC.LOG_APPEND);
    expect(handler).toBeDefined();

    const rendererEntry = {
      ts: new Date().toISOString(),
      level: 'error',
      source: 'renderer',
      args: ['from renderer'],
    };
    handler!({}, rendererEntry);

    const lines = await readLogLines(todayUtc());
    expect(lines.find((entry) => entry.source === 'renderer')).toMatchObject({
      level: 'error',
      args: ['from renderer'],
    });
  });
});

describe('echo failure containment', () => {
  it('survives a throwing echo on every patched level (DESKTOP-10/11/12)', async () => {
    // What the guard has to contain is any synchronous throw out of the
    // echo call, so the spy just throws and the error's own shape is not
    // under test here. Which real paths can throw is recorded on the catch
    // in log-mirror.ts; this pins only that the wrapper survives one.
    // The spy is installed before startLogMirror so it becomes the
    // `original` each wrap calls through.
    const throwingEcho = vi.fn(() => {
      throw epipeWriteError();
    });
    console.log = throwingEcho;
    console.warn = throwingEcho;
    console.error = throwingEcho;
    console.info = throwingEcho;
    console.debug = throwingEcho;

    const { startLogMirror } = await import('../../src/main/diagnostics/log-mirror');
    startLogMirror({
      getProjectRoot: () => tempDirectory,
      getPersistInfoDebug: () => true,
    });

    expect(() => console.log('a')).not.toThrow();
    expect(() => console.warn('b')).not.toThrow();
    expect(() => console.error('c')).not.toThrow();
    expect(() => console.info('d')).not.toThrow();
    expect(() => console.debug('e')).not.toThrow();

    // Each call reached the throwing echo exactly once - the catch block
    // must not itself log (which would recurse into the same failure).
    expect(throwingEcho).toHaveBeenCalledTimes(5);
  });

  it('still persists the line when the echo throws', async () => {
    const throwingEcho = vi.fn(() => {
      throw epipeWriteError();
    });
    console.error = throwingEcho;

    const { startLogMirror } = await import('../../src/main/diagnostics/log-mirror');
    startLogMirror({
      getProjectRoot: () => tempDirectory,
      getPersistInfoDebug: () => false,
    });

    expect(() => console.error('boom despite dead stdout')).not.toThrow();

    const lines = await readLogLines(todayUtc());
    const errorLine = lines.find((entry) => entry.level === 'error');
    expect(errorLine?.args[0]).toBe('boom despite dead stdout');
  });

  // The two tests above prove the catch swallows an arbitrary throw, but
  // they replace `original` with a mock that throws unconditionally - they
  // never exercise what the corrected doc comment on the catch actually
  // names as the reachable paths. Node's console does NOT let a write
  // failure (sync throw or callback error) escape - it swallows both
  // itself - so what escapes is upstream of the write: resolving
  // `process.stdout`, and formatting the args. The two tests below drive
  // the SECOND of those with the REAL, unmocked console implementation (no
  // spy stands in for `original`), the same way a hostile object landing in
  // a real `console.error(...)` call would in production. Split into two
  // `it`s (rather than two assertions in one) so each gets its own
  // independent red-green: vitest aborts a test at its first failed
  // assertion, so a shared test would only ever observe the first hostile
  // arg fail red.
  it('survives a real custom-inspect throw from the REAL console formatter (arg-formatting failure)', async () => {
    // Confirmed empirically (Node 24.15.0) that an un-wrapped
    // `console.log('x', hostileInspect)` throws synchronously out of the
    // real console, which is exactly what this wrap must contain.
    const hostileInspectArgument = {
      [util.inspect.custom]: () => {
        throw new Error('custom inspect boom');
      },
    };

    const { startLogMirror } = await import('../../src/main/diagnostics/log-mirror');
    startLogMirror({
      getProjectRoot: () => tempDirectory,
      getPersistInfoDebug: () => true,
    });

    expect(() => console.error('object arg:', hostileInspectArgument)).not.toThrow();

    // Persistence must still succeed - stringifyArg does not invoke the
    // custom inspect hook (JSON.stringify ignores that symbol), so the
    // record still reaches disk.
    const lines = await readLogLines(todayUtc());
    const errorLine = lines.find((entry) => entry.level === 'error' && entry.args[0] === 'object arg:');
    expect(errorLine).toBeDefined();
  });

  it('survives a real Symbol.toPrimitive throw under %s from the REAL console formatter (arg-formatting failure)', async () => {
    // Confirmed empirically (Node 24.15.0) that this throws synchronously
    // out of the real console even once the timestamp prefix is
    // concatenated into the format-string slot ahead of the `%s`.
    const hostileToPrimitiveArgument = {
      [Symbol.toPrimitive]: () => {
        throw new Error('toPrimitive boom');
      },
    };

    const { startLogMirror } = await import('../../src/main/diagnostics/log-mirror');
    startLogMirror({
      getProjectRoot: () => tempDirectory,
      getPersistInfoDebug: () => true,
    });

    expect(() => console.log('%s', hostileToPrimitiveArgument)).not.toThrow();
  });
});

describe('terminal-echo timestamp prefix', () => {
  it('formats a compact zero-padded local HH:MM:SS.mmm', async () => {
    const { formatLogTimestamp } = await import('../../src/main/diagnostics/log-mirror');
    // Local-component constructor (year, monthIndex, day, h, m, s, ms).
    expect(formatLogTimestamp(new Date(2026, 5, 3, 9, 4, 5, 7))).toBe('09:04:05.007');
    expect(formatLogTimestamp(new Date(2026, 5, 3, 14, 23, 1, 123))).toBe('14:23:01.123');
    expect(formatLogTimestamp(new Date(2026, 5, 3, 0, 0, 0, 0))).toBe('00:00:00.000');
  });

  it('concatenates the prefix into a string first arg (keeps printf specifiers aligned)', async () => {
    const { prefixConsoleArgs } = await import('../../src/main/diagnostics/log-mirror');
    expect(prefixConsoleArgs(['[startup] hi'], '[T]')).toEqual(['[T] [startup] hi']);
    // A `%s` format specifier must stay in the format-string slot so the
    // trailing arg still binds to it.
    expect(prefixConsoleArgs(['x %s', 'y'], '[T]')).toEqual(['[T] x %s', 'y']);
  });

  it('passes the prefix as its own leading arg when the first arg is not a string', async () => {
    const { prefixConsoleArgs } = await import('../../src/main/diagnostics/log-mirror');
    expect(prefixConsoleArgs([{ a: 1 }], '[T]')).toEqual(['[T]', { a: 1 }]);
    // Empty console.log() still echoes just the timestamp.
    expect(prefixConsoleArgs([], '[T]')).toEqual(['[T]']);
  });

  it('does not mutate the original args array (persisted record stays un-prefixed)', async () => {
    const { prefixConsoleArgs } = await import('../../src/main/diagnostics/log-mirror');
    const original = ['[startup] hi', 'extra'];
    prefixConsoleArgs(original, '[T]');
    expect(original).toEqual(['[startup] hi', 'extra']);
  });
});

describe('terminal-echo project tag', () => {
  it('appends [projectName] after the timestamp for logs emitted inside a run', async () => {
    // Capture the echo by making the patched-over original a spy: startLogMirror
    // snapshots console.log at install time, so a spy installed first becomes
    // the `original` the wrap calls through to.
    const echoSpy = vi.fn();
    console.log = echoSpy;
    const { startLogMirror } = await import('../../src/main/diagnostics/log-mirror');
    const { runWithProjectLogContext } = await import('../../src/main/diagnostics/project-log-context');
    startLogMirror({ getProjectRoot: () => tempDirectory, getPersistInfoDebug: () => false });

    runWithProjectLogContext('kangentic', () => {
      console.log('spawned %s', 'claude');
    });

    expect(echoSpy).toHaveBeenCalledTimes(1);
    const [formatString, trailingArg] = echoSpy.mock.calls[0];
    expect(formatString).toMatch(/^\[\d{2}:\d{2}:\d{2}\.\d{3}\] \[kangentic\] spawned %s$/);
    expect(trailingArg).toBe('claude');
  });

  it('leaves global logs (outside any run) untagged', async () => {
    const echoSpy = vi.fn();
    console.log = echoSpy;
    const { startLogMirror } = await import('../../src/main/diagnostics/log-mirror');
    startLogMirror({ getProjectRoot: () => tempDirectory, getPersistInfoDebug: () => false });

    console.log('global line');

    const [formatString] = echoSpy.mock.calls[0];
    expect(formatString).toMatch(/^\[\d{2}:\d{2}:\d{2}\.\d{3}\] global line$/);
    expect(formatString).not.toContain('[kangentic]');
  });
});
