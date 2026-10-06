import { describe, it, expect, afterEach, vi } from 'vitest';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * The retrieval worker's event-loop watchdog (Sentry DESKTOP-1Q). A worker that
 * hangs is killed after 15 s and its latch report used to say only "exit code
 * unknown". The watchdog thread writes which step held the loop to stderr, which
 * the restart policy already puts in the report.
 *
 * These run a REAL worker thread and hold this thread's loop with a busy wait,
 * because the property that matters is that the line leaves while the loop is
 * held: a thread's console is forwarded through the thread that is hung, so only
 * a direct `fs.writeSync` gets out, and nothing short of a real thread shows it.
 */

import {
  startEventLoopWatchdog,
  LABEL_BYTES,
  WATCHDOG_BUFFER_BYTES,
  WATCHDOG_THREAD_SOURCE,
  type EventLoopWatchdog,
  type EventLoopWatchdogOptions,
} from '../../src/main/retrieval/worker/event-loop-watchdog';
import * as eventLoopLag from '../../src/main/diagnostics/event-loop-lag';
import { setSyncSpanLabelSink, timeSyncWork } from '../../src/main/diagnostics/event-loop-lag';

const CHECK_INTERVAL_MS = 50;
const HELD_CHECKS = 4;
/** Far past HELD_CHECKS * CHECK_INTERVAL_MS (200 ms), so a loaded CI runner still sees the line. */
const HOLD_MS = 1_000;

function holdEventLoop(milliseconds: number): void {
  const until = Date.now() + milliseconds;
  while (Date.now() < until) {
    // Busy wait: nothing else on this thread runs, the heartbeat included.
  }
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

/** The text of `file` from byte `offset` on. */
function readFrom(file: string, offset: number): string {
  return fs.readFileSync(file).subarray(offset).toString('utf8');
}

/** `src/main` TypeScript files whose text matches `pattern`, as sorted forward-slash paths. */
function sourceFilesContaining(pattern: RegExp): string[] {
  const sourceRoot = path.join(__dirname, '..', '..', 'src', 'main');
  const matches: string[] = [];
  const walk = (directoryPath: string): void => {
    for (const entry of fs.readdirSync(directoryPath, { withFileTypes: true })) {
      const fullPath = path.join(directoryPath, entry.name);
      if (entry.isDirectory()) walk(fullPath);
      else if (entry.name.endsWith('.ts') && pattern.test(fs.readFileSync(fullPath, 'utf8'))) {
        matches.push(path.relative(sourceRoot, fullPath).split(path.sep).join('/'));
      }
    }
  };
  walk(sourceRoot);
  return matches.sort();
}

describe('event-loop watchdog', () => {
  let directory: string | null = null;
  let descriptor: number | null = null;
  let watchdog: EventLoopWatchdog | null = null;

  async function start(overrides: EventLoopWatchdogOptions = {}): Promise<string> {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'kangentic-watchdog-'));
    const file = path.join(directory, 'stderr.txt');
    descriptor = fs.openSync(file, 'w');
    watchdog = startEventLoopWatchdog({
      fd: descriptor,
      prefix: '[test-watchdog]',
      heartbeatIntervalMs: 10,
      checkIntervalMs: CHECK_INTERVAL_MS,
      heldChecks: HELD_CHECKS,
      ...overrides,
    });
    await watchdog.online;
    // Let the thread see a few heartbeats, so a hold starts from a re-armed watchdog.
    await delay(CHECK_INTERVAL_MS * 2);
    return file;
  }

  afterEach(async () => {
    await watchdog?.stop();
    watchdog = null;
    if (descriptor !== null) fs.closeSync(descriptor);
    descriptor = null;
    if (directory) fs.rmSync(directory, { recursive: true, force: true });
    directory = null;
  });

  // The hold tests assert only on the bytes written after the hold began: a CI runner that
  // starves this thread for 200 ms before the hold would otherwise leave a stray line.
  it('names the labelled step that held the loop, while it is still held', async () => {
    const file = await start();
    const sizeBeforeHold = fs.statSync(file).size;
    let writtenDuringHold = '';
    timeSyncWork('test:held-step', () => {
      holdEventLoop(HOLD_MS);
      // Read before the span ends and the loop is free: the line has to be out already.
      writtenDuringHold = readFrom(file, sizeBeforeHold);
    });

    expect(writtenDuringHold).toMatch(/\[test-watchdog\] event loop held \d+ s in test:held-step\n/);
  });

  it('says so when the loop is held outside any labelled step', async () => {
    const file = await start();
    const sizeBeforeHold = fs.statSync(file).size;
    holdEventLoop(HOLD_MS);
    expect(readFrom(file, sizeBeforeHold)).toMatch(/event loop held \d+ s outside any labelled step\n/);
  });

  it('names the enclosing step once an inner one has finished', async () => {
    const file = await start();
    const sizeBeforeHold = fs.statSync(file).size;
    timeSyncWork('test:outer', () => {
      timeSyncWork('test:inner', () => undefined);
      holdEventLoop(HOLD_MS);
    });
    expect(readFrom(file, sizeBeforeHold)).toContain('in test:outer\n');
  });

  it('truncates a label longer than the label buffer instead of overflowing it', async () => {
    const file = await start();
    const sizeBeforeHold = fs.statSync(file).size;
    // The buffer holds LABEL_BYTES UTF-8 bytes; this label is ASCII, so one byte per character.
    const longLabel = 'test:' + 'x'.repeat(LABEL_BYTES * 2);
    let writtenDuringHold = '';
    timeSyncWork(longLabel, () => {
      holdEventLoop(HOLD_MS);
      writtenDuringHold = readFrom(file, sizeBeforeHold);
    });

    expect(writtenDuringHold).toContain('in ' + longLabel.slice(0, LABEL_BYTES) + '\n');
  });

  it('reports only a short label that follows a long one, not the long one\'s leftover bytes', async () => {
    const file = await start();
    const longLabel = 'test:' + 'y'.repeat(75);
    timeSyncWork(longLabel, () => undefined);
    const sizeBeforeHold = fs.statSync(file).size;
    let writtenDuringHold = '';
    timeSyncWork('test:short', () => {
      holdEventLoop(HOLD_MS);
      writtenDuringHold = readFrom(file, sizeBeforeHold);
    });

    expect(writtenDuringHold.endsWith('in test:short\n')).toBe(true);
    expect(writtenDuringHold).not.toContain('yyy');
  });

  it('writes once per hold, and writes nothing while the loop is free', { timeout: 15_000 }, async () => {
    // A one second threshold, so a CI stall of a few hundred ms cannot write a line in the free wait.
    const thresholdMs = 1_000;
    const file = await start({ checkIntervalMs: CHECK_INTERVAL_MS, heldChecks: thresholdMs / CHECK_INTERVAL_MS });
    // Free for twice the threshold: the heartbeat keeps moving.
    await delay(thresholdMs * 2);
    expect(fs.readFileSync(file, 'utf8')).toBe('');

    holdEventLoop(thresholdMs * 2);
    const lines = fs.readFileSync(file, 'utf8').split('\n').filter((line) => line.length > 0);
    expect(lines).toHaveLength(1);
  });

  it('writes again for a second hold once the heartbeat has resumed', { timeout: 15_000 }, async () => {
    const file = await start();
    holdEventLoop(HOLD_MS);
    expect(fs.statSync(file).size).toBeGreaterThan(0);

    // Free long enough for the thread to see a beat and re-arm, with room for a CI
    // runner that starves the watchdog thread for a while: nothing signals the re-arm.
    await delay(HOLD_MS);
    const sizeBeforeSecondHold = fs.statSync(file).size;
    holdEventLoop(HOLD_MS);
    // Grew, not "exactly two lines": a stall in the gap could add one.
    expect(fs.statSync(file).size).toBeGreaterThan(sizeBeforeSecondHold);
  });

  it('requires only node built-ins in the thread, since a native module is unsafe in a worker thread', () => {
    const requires = [...WATCHDOG_THREAD_SOURCE.matchAll(/require\('([^']+)'\)/g)].map((match) => match[1]);
    expect(requires.length).toBeGreaterThan(0);
    for (const moduleName of requires) expect(moduleName.startsWith('node:')).toBe(true);
  });

  it('is the only worker thread in src/main', () => {
    expect(
      sourceFilesContaining(/['"](node:)?worker_threads['"]/),
      'A second worker thread in src/main: see .claude/rules/retrieval-out-of-process.md before adding one, and update this list if it is deliberate.',
    ).toEqual(['retrieval/worker/event-loop-watchdog.ts']);
  });

  it('writes its line to stderr when stderr is a pipe, as the utility process forks it', { timeout: 15_000 }, async () => {
    // The tests above pass a file descriptor. The worker's real stderr is fd 2 on a pipe
    // (UTILITY_PROCESS_STDIO), so this runs the thread source in a child whose stderr is one.
    // The heartbeat never beats here, so the line comes after the held checks.
    const childScript = [
      `const { Worker } = require('node:worker_threads');`,
      `const buffer = new SharedArrayBuffer(${WATCHDOG_BUFFER_BYTES});`,
      `const watchdog = new Worker(${JSON.stringify(WATCHDOG_THREAD_SOURCE)}, {`,
      `  eval: true,`,
      `  workerData: { buffer, fd: 2, checkIntervalMs: ${CHECK_INTERVAL_MS}, heldChecks: ${HELD_CHECKS}, prefix: '[pipe-watchdog]' },`,
      `});`,
      `watchdog.once('online', () => {`,
      `  const until = Date.now() + ${HOLD_MS};`,
      `  while (Date.now() < until) {}`,
      `  process.exit(0);`,
      `});`,
    ].join('\n');
    const child = spawn(process.execPath, ['-e', childScript], { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderrText = '';
    child.stderr.on('data', (chunk: Buffer) => {
      stderrText += chunk.toString('utf8');
    });
    const exitCode = await new Promise<number | null>((resolve) => child.on('close', resolve));

    expect(exitCode).toBe(0);
    expect(stderrText).toMatch(/\[pipe-watchdog\] event loop held \d+ s outside any labelled step\n/);
  });

  it('is started first in the worker\'s initialize(), before the database is configured', () => {
    const workerSource = fs.readFileSync(
      path.join(__dirname, '..', '..', 'src', 'main', 'retrieval', 'worker', 'retrieval-worker.ts'),
      'utf8',
    );
    const layoutChanged =
      'retrieval-worker.ts no longer has a top-level initialize() calling both functions; update this scan to the new layout.';
    const functionStart = workerSource.indexOf('function initialize(');
    expect(functionStart, layoutChanged).toBeGreaterThanOrEqual(0);
    // A top-level function ends at the first closing brace in column 0.
    const functionEnd = workerSource.indexOf('\n}\n', functionStart);
    expect(functionEnd, layoutChanged).toBeGreaterThan(functionStart);
    const initializeBody = workerSource.slice(functionStart, functionEnd);

    const watchdogCall = initializeBody.indexOf('startEventLoopWatchdog(');
    const databaseCall = initializeBody.indexOf('configureProjectDbAccess(');
    expect(watchdogCall, layoutChanged).toBeGreaterThanOrEqual(0);
    expect(databaseCall, layoutChanged).toBeGreaterThanOrEqual(0);
    expect(watchdogCall, 'startEventLoopWatchdog() must run before the database is configured.').toBeLessThan(databaseCall);
  });
});

describe('event-loop watchdog stop()', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    setSyncSpanLabelSink(null);
  });

  it('clears the span-label sink it installed, so spans stop writing into a buffer nobody reads', async () => {
    // Forwarding spy: the real sink still gets installed, so the spans below behave as in the worker.
    const sinkSpy = vi.spyOn(eventLoopLag, 'setSyncSpanLabelSink');
    const watchdog = startEventLoopWatchdog({ fd: 2, heartbeatIntervalMs: 10, checkIntervalMs: 1_000, heldChecks: 1_000 });
    await watchdog.online;
    expect(sinkSpy).toHaveBeenCalledTimes(1);
    expect(sinkSpy.mock.calls[0][0]).toEqual(expect.any(Function));

    await watchdog.stop();

    expect(sinkSpy).toHaveBeenCalledTimes(2);
    expect(sinkSpy.mock.calls[1][0]).toBeNull();
  });
});

describe('event-loop watchdog when the thread cannot start', () => {
  afterEach(() => {
    vi.doUnmock('node:worker_threads');
    vi.resetModules();
  });

  it('costs only the diagnostics: no throw, a warning, and spans still run their work', async () => {
    vi.resetModules();
    vi.doMock('node:worker_threads', () => ({
      Worker: class {
        constructor() {
          throw new Error('no threads');
        }
      },
    }));
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const freshWatchdog = await import('../../src/main/retrieval/worker/event-loop-watchdog');
      const freshLag = await import('../../src/main/diagnostics/event-loop-lag');

      let started: EventLoopWatchdog | undefined;
      let thrown: unknown;
      try {
        started = freshWatchdog.startEventLoopWatchdog();
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeUndefined();
      expect(started).toBeDefined();
      await expect(started?.online).resolves.toBeUndefined();
      await expect(started?.stop()).resolves.toBeUndefined();

      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('did not start'), expect.any(Error));
      expect(freshLag.timeSyncWork('test:no-thread', () => 'work result')).toBe('work result');
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('logs an error event from the thread instead of throwing, since an unhandled one would take down the worker', async () => {
    // An EventEmitter with no 'error' listener throws on emit. Red-green: remove the
    // `watchdog.on('error', ...)` line and the emit below throws.
    const { EventEmitter } = await import('node:events');
    const constructed: { instance: EventEmitter | null } = { instance: null };
    vi.resetModules();
    vi.doMock('node:worker_threads', () => ({
      Worker: class extends EventEmitter {
        constructor() {
          super();
          constructed.instance = this;
        }
        unref(): void {}
        terminate(): Promise<number> {
          return Promise.resolve(0);
        }
      },
    }));
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const freshLag = await import('../../src/main/diagnostics/event-loop-lag');
    let started: EventLoopWatchdog | undefined;
    try {
      const freshWatchdog = await import('../../src/main/retrieval/worker/event-loop-watchdog');
      started = freshWatchdog.startEventLoopWatchdog();
      expect(constructed.instance).not.toBeNull();

      const threadError = new Error('thread crashed');
      expect(() => constructed.instance?.emit('error', threadError)).not.toThrow();

      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('stopped'), threadError);
    } finally {
      await started?.stop();
      freshLag.setSyncSpanLabelSink(null);
      warnSpy.mockRestore();
    }
  });
});

describe('setSyncSpanLabelSink', () => {
  afterEach(() => {
    setSyncSpanLabelSink(null);
  });

  it('reports each span as it starts and restores the enclosing label as it ends, even when the work throws', () => {
    const seen: Array<string | null> = [];
    setSyncSpanLabelSink((label) => seen.push(label));

    timeSyncWork('outer', () => {
      timeSyncWork('inner', () => undefined);
      expect(() => timeSyncWork('failing', () => {
        throw new Error('boom');
      })).toThrow('boom');
    });

    expect(seen).toEqual(['outer', 'inner', 'outer', 'failing', 'outer', null]);
  });

  it('is set only by the retrieval worker\'s watchdog, so main\'s spans keep their one null check', () => {
    expect(
      sourceFilesContaining(/setSyncSpanLabelSink\(/),
      'A new file mentions setSyncSpanLabelSink( (a caller, or prose in a comment). Main must not set a sink; update this list only if the new file is not one.',
    ).toEqual([
      'diagnostics/event-loop-lag.ts',
      'retrieval/worker/event-loop-watchdog.ts',
    ]);
  });
});
