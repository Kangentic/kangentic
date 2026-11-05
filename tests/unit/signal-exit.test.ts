/**
 * The signal routes' end of the quit (src/main/pty/shutdown/signal-exit.ts). On
 * POSIX, SIGTERM, SIGINT and SIGHUP must not end main while the pty host still
 * has an exit callback to land: the host's service pipe closes and node-pty
 * aborts it in Node's teardown (Sentry DESKTOP-2A).
 *
 * Tier: Unit.
 */

import { describe, it, expect, vi } from 'vitest';

import { createSignalExitHandler } from '../../src/main/pty/shutdown/signal-exit';
import type { PtyExitDrainResult } from '../../src/main/pty/shutdown/exit-callback-drain';
import type { PtyKillReport } from '../../src/main/pty/shutdown/session-shutdown';

const HOST_REPORT: PtyKillReport = { pids: [9999], killedCount: 1, deferredCount: 0 };
const CLEAN_DRAIN: PtyExitDrainResult = { timedOut: false, elapsedMs: 125, lingeringPids: [], unprobedKillCount: 0 };

function makeHarness(platform: NodeJS.Platform) {
  let resolveDrain: (result: PtyExitDrainResult) => void = () => undefined;
  let rejectDrain: (error: Error) => void = () => undefined;
  const drain = new Promise<PtyExitDrainResult>((resolve, reject) => {
    resolveDrain = resolve;
    rejectDrain = reject;
  });
  const calls: string[] = [];
  let shutdownRan = false;
  const dependencies = {
    performShutdown: vi.fn(() => {
      if (shutdownRan) return false;
      shutdownRan = true;
      calls.push('shutdown');
      return true;
    }),
    getPtyKillReport: vi.fn(() => HOST_REPORT),
    drainPtyExitCallbacks: vi.fn((_report: PtyKillReport): Promise<PtyExitDrainResult> => {
      calls.push('drain');
      return drain;
    }),
    hideAllWindows: vi.fn(() => { calls.push('hide'); }),
    writeQueuedLogs: vi.fn(() => { calls.push('logs'); }),
    exit: vi.fn(() => { calls.push('exit'); }),
    log: vi.fn((line: string) => { calls.push(`log:${line}`); }),
    platform,
  };
  return { handler: createSignalExitHandler(dependencies), dependencies, calls, resolveDrain, rejectDrain };
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe.each(['darwin', 'linux'] as const)('a signal on %s', (platform) => {
  it('keeps main alive until the drain ends, so the pty host leaves first', async () => {
    const { handler, dependencies, calls, resolveDrain } = makeHarness(platform);

    handler();

    expect(dependencies.drainPtyExitCallbacks).toHaveBeenCalledWith(HOST_REPORT);
    expect(dependencies.exit).not.toHaveBeenCalled();

    resolveDrain(CLEAN_DRAIN);
    await flushMicrotasks();

    // The shutdown's lines land before the wait, the drain's own after it.
    expect(calls).toEqual(['shutdown', 'hide', 'logs', 'drain', 'logs', 'exit']);
  });

  it('logs the skip, exits once, and neither drains nor hides when no PTY was killed', () => {
    const { handler, dependencies, calls } = makeHarness(platform);
    dependencies.getPtyKillReport.mockReturnValue({ pids: [], killedCount: 0, deferredCount: 0 });

    handler();

    expect(calls).toEqual(['shutdown', 'log:[SHUTDOWN] pty-drain:skip reason=no-pty-killed', 'logs', 'exit']);
    expect(dependencies.exit).toHaveBeenCalledTimes(1);
    expect(dependencies.drainPtyExitCallbacks).not.toHaveBeenCalled();
    expect(dependencies.hideAllWindows).not.toHaveBeenCalled();
  });

  it('still drains when the count says a PTY was killed but no pid could be named', () => {
    const { handler, dependencies } = makeHarness(platform);
    const report: PtyKillReport = { pids: [], killedCount: 1, deferredCount: 0 };
    dependencies.getPtyKillReport.mockReturnValue(report);

    handler();

    expect(dependencies.drainPtyExitCallbacks).toHaveBeenCalledWith(report);
    expect(dependencies.log).not.toHaveBeenCalled();
  });

  it('drains and exits even when hiding the windows throws', async () => {
    const { handler, dependencies, resolveDrain } = makeHarness(platform);
    dependencies.hideAllWindows.mockImplementation(() => { throw new Error('window is gone'); });

    expect(() => handler()).not.toThrow();
    expect(dependencies.drainPtyExitCallbacks).toHaveBeenCalledTimes(1);

    resolveDrain(CLEAN_DRAIN);
    await flushMicrotasks();
    expect(dependencies.exit).toHaveBeenCalledTimes(1);
  });

  it('exits once when the drain rejects', async () => {
    const { handler, dependencies, rejectDrain } = makeHarness(platform);

    handler();
    rejectDrain(new Error('drain failed'));
    await flushMicrotasks();

    expect(dependencies.exit).toHaveBeenCalledTimes(1);
  });

  it('exits once when the drain throws synchronously', () => {
    const { handler, dependencies } = makeHarness(platform);
    dependencies.drainPtyExitCallbacks.mockImplementation(() => {
      throw new Error('drain constructor exploded');
    });

    expect(() => handler()).not.toThrow();
    expect(dependencies.exit).toHaveBeenCalledTimes(1);
  });

  it('ignores a second signal during the wait, whose deadline already bounds it', async () => {
    const { handler, dependencies, resolveDrain } = makeHarness(platform);

    handler();
    handler();

    expect(dependencies.drainPtyExitCallbacks).toHaveBeenCalledTimes(1);
    expect(dependencies.exit).not.toHaveBeenCalled();

    resolveDrain(CLEAN_DRAIN);
    await flushMicrotasks();
    expect(dependencies.exit).toHaveBeenCalledTimes(1);
  });
});

describe('a signal on Windows', () => {
  it('exits at once with the queued logs written and no drain', () => {
    const { handler, dependencies, calls } = makeHarness('win32');

    handler();

    // The skip line is logged before the queued logs are written, so it lands in them.
    expect(calls).toEqual(['shutdown', 'log:[SHUTDOWN] pty-drain:skip reason=windows-signal', 'logs', 'exit']);
    expect(dependencies.drainPtyExitCallbacks).not.toHaveBeenCalled();
    expect(dependencies.getPtyKillReport).not.toHaveBeenCalled();
    expect(dependencies.hideAllWindows).not.toHaveBeenCalled();
  });
});
