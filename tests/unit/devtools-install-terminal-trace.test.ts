/**
 * The terminal trace wiring in `installDevtools` (src/devtools/install.ts).
 *
 * `terminal-trace-persist.test.ts` and `composed-width-sampler.test.ts` pin the
 * two recorders on their own. Neither can notice `installDevtools` forgetting
 * to subscribe one, pointing the persisted file somewhere else, or leaving the
 * sampler's pending timers alive at quit. These pin that wiring: both listeners
 * are subscribed to the trace, an entry reaches the file under the config dir,
 * a resize produces a composed-width sample, and the quit hook cancels a
 * sample that has not fired yet.
 *
 * `__KANGENTIC_DEV__` is false under vitest, so the real `recordTerminalTrace`
 * keeps nothing and calls no listener. The listeners `installDevtools`
 * subscribes are read off the wrapped `addTerminalTraceListener` and driven
 * directly, which is what `recordTerminalTrace` does for each kept entry.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { App } from 'electron';
import type { DevtoolsContext } from '../../src/devtools/install';
import type { TerminalTraceEvent } from '../../src/main/pty/terminal-trace';
import type { SessionManager } from '../../src/main/pty/session-manager';

const hoisted = await vi.hoisted(async () => {
  const fsModule = await import('node:fs');
  const osModule = await import('node:os');
  const pathModule = await import('node:path');
  return {
    configDir: fsModule.mkdtempSync(pathModule.join(osModule.tmpdir(), 'kangentic-devtools-install-')),
    appOn: vi.fn<(eventName: string, handler: () => void) => void>(),
    stopStallProfiler: vi.fn(),
    stopInspectionServer: vi.fn(),
  };
});

vi.mock('electron', () => ({ app: { on: hoisted.appOn } }));

vi.mock('../../src/devtools/main/lockfile', () => ({
  writeLockfile: vi.fn(),
  removeLockfile: vi.fn(),
}));

vi.mock('../../src/devtools/main/inspection-server', () => ({
  startInspectionServer: vi.fn(async () => null),
  stopInspectionServer: hoisted.stopInspectionServer,
}));

vi.mock('../../src/devtools/main/cdp', () => ({
  attachDebugger: vi.fn(),
  detachDebugger: vi.fn(),
}));

vi.mock('../../src/devtools/main/spawn-tracer', () => ({
  installSpawnTracer: vi.fn(),
}));

vi.mock('../../src/devtools/main/stall-profiler', () => ({
  isStallProfilerRunning: vi.fn(() => false),
  stallProfileDirectory: vi.fn(() => hoisted.configDir),
  startStallProfiler: vi.fn(async () => undefined),
  stopStallProfiler: hoisted.stopStallProfiler,
}));

vi.mock('../../src/main/config/paths', () => ({
  PATHS: { configDir: hoisted.configDir },
}));

// Wrap, not replace: the real functions still run (both are no-ops under
// `__KANGENTIC_DEV__ = false` or plain set inserts), and the calls stay
// observable.
vi.mock('../../src/main/pty/terminal-trace', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/main/pty/terminal-trace')>();
  return {
    ...actual,
    addTerminalTraceListener: vi.fn(actual.addTerminalTraceListener),
    recordTerminalTrace: vi.fn(actual.recordTerminalTrace),
  };
});

const SESSION_ID = 'session-window';
const TRACE_FILE_PATH = path.join(hoisted.configDir, 'logs', 'terminal-trace.jsonl');

/** An agent composing 210-column rows inside a 210-column grid. */
const ALT_SCREEN_FRAME = '\x1b[?1049h' + ('─'.repeat(210) + '\r\n').repeat(6);

function createFakeSessionManager() {
  return {
    getTerminalDimensions: vi.fn(async () => [{
      sessionId: SESSION_ID,
      ptyCols: 210,
      ptyRows: 48,
      lastCols: 210,
      lastRows: 48,
      inAltScreen: true,
    }]),
    getRawScrollback: vi.fn(async () => ALT_SCREEN_FRAME),
  };
}

function createContext(sessionManager: ReturnType<typeof createFakeSessionManager>): DevtoolsContext {
  return {
    app: { getPath: () => hoisted.configDir } as unknown as App,
    getMainWindow: () => null,
    getProjectRoot: () => null,
    getProjectId: () => null,
    getWorktreePath: () => null,
    getSessionManager: () => sessionManager as unknown as SessionManager,
    getIpcContext: () => null,
    getInspectionServerEnabled: () => false,
    getEvalEnabled: () => false,
    getStallProfilerEnabled: () => false,
  };
}

function traceEntry(overrides: Partial<TerminalTraceEvent>): TerminalTraceEvent {
  return {
    ts: Date.UTC(2026, 9, 14, 14, 25, 4, 120),
    source: 'main',
    process: 'main',
    sessionId: SESSION_ID,
    event: 'resize-applied',
    detail: { origin: 'desktop', cols: 210, rows: 48 },
    ...overrides,
  };
}

/** `installDevtools` keeps its context in module state and installs once, so
 *  every test loads a fresh copy of it and of the modules it talks to. */
async function loadFreshInstall() {
  vi.resetModules();
  const { installDevtools } = await import('../../src/devtools/install');
  const traceModule = await import('../../src/main/pty/terminal-trace');
  const queueModule = await import('../../src/main/diagnostics/async-file-queue');
  return {
    installDevtools,
    addTerminalTraceListener: vi.mocked(traceModule.addTerminalTraceListener),
    recordTerminalTrace: vi.mocked(traceModule.recordTerminalTrace),
    flushAllForTest: queueModule.flushAllForTest,
  };
}

type LoadedInstall = Awaited<ReturnType<typeof loadFreshInstall>>;

function readTraceLines(): Record<string, unknown>[] {
  return fs.readFileSync(TRACE_FILE_PATH, 'utf-8')
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

function beforeQuitHandler(): () => void {
  const registration = hoisted.appOn.mock.calls.find(([eventName]) => eventName === 'before-quit');
  if (!registration) throw new Error('installDevtools did not register a before-quit handler');
  return registration[1];
}

describe('installDevtools terminal trace wiring', () => {
  let loaded: LoadedInstall;
  let sessionManager: ReturnType<typeof createFakeSessionManager>;

  /** What `recordTerminalTrace` does with each entry it keeps. */
  function emitTrace(entry: TerminalTraceEvent): void {
    for (const [listener] of loaded.addTerminalTraceListener.mock.calls) {
      listener(entry);
    }
  }

  beforeEach(async () => {
    vi.clearAllMocks();
    fs.rmSync(path.join(hoisted.configDir, 'logs'), { recursive: true, force: true });
    sessionManager = createFakeSessionManager();
    loaded = await loadFreshInstall();
    loaded.installDevtools(createContext(sessionManager));
  });

  afterEach(async () => {
    // A sample test emits a resize, which the persist listener also writes.
    await loaded.flushAllForTest();
  });

  afterAll(() => {
    fs.rmSync(hoisted.configDir, { recursive: true, force: true });
  });

  it('subscribes exactly two listeners to the terminal trace', () => {
    expect(loaded.addTerminalTraceListener).toHaveBeenCalledTimes(2);
  });

  it('persists a trace entry as one JSON line under the config dir logs folder', async () => {
    emitTrace(traceEntry({}));
    await loaded.flushAllForTest();

    expect(readTraceLines()).toEqual([{
      ts: '2026-10-14T14:25:04.120Z',
      process: 'main',
      sessionId: SESSION_ID,
      event: 'resize-applied',
      detail: { origin: 'desktop', cols: 210, rows: 48 },
    }]);
  });

  describe('composed-width sample', () => {
    beforeEach(() => {
      // Only the sampler's debounce timer is faked. The file queue flushes on a
      // real setImmediate, which afterEach awaits.
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('records a composed-sample trace entry after a pty resize', async () => {
      emitTrace(traceEntry({
        process: 'pty-host',
        event: 'pty-resize',
        detail: { fromCols: 306, toCols: 210, fromRows: 19, toRows: 48 },
      }));
      expect(loaded.recordTerminalTrace).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(1000);

      expect(loaded.recordTerminalTrace).toHaveBeenCalledTimes(1);
      expect(loaded.recordTerminalTrace).toHaveBeenCalledWith(
        SESSION_ID,
        'composed-sample',
        expect.objectContaining({
          composedCols: 210,
          ptyCols: 210,
          hostCols: 210,
          matchesPty: true,
        }),
        expect.any(Number),
      );
    });

    it('cancels a pending sample when the app quits', async () => {
      emitTrace(traceEntry({
        process: 'pty-host',
        event: 'pty-resize',
        detail: { fromCols: 306, toCols: 210, fromRows: 19, toRows: 48 },
      }));
      // Well inside the debounce, so the sample is still pending.
      await vi.advanceTimersByTimeAsync(500);

      beforeQuitHandler()();
      await vi.advanceTimersByTimeAsync(5000);

      expect(sessionManager.getTerminalDimensions).not.toHaveBeenCalled();
      expect(loaded.recordTerminalTrace).not.toHaveBeenCalled();
    });
  });
});
