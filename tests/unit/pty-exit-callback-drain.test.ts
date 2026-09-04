/**
 * Unit tests for the bounded PTY exit-callback drain
 * (src/main/pty/shutdown/exit-callback-drain.ts).
 *
 * The drain is what stands between the synchronous shutdown cleanup and
 * Electron tearing Node down. Sentry DESKTOP-C: node-pty's exit callback is a
 * native ThreadSafeFunction; dispatched after node::Stop(), node-addon-api
 * throws a C++ exception from inside its own catch block and the process
 * dies. The drain keeps the loop alive, timer-only, until each killed child is
 * gone plus a few loop turns, so the callback lands while JS is callable.
 *
 * Everything here runs on fake timers with an injected pid probe. Tier: Unit.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  drainPtyExitCallbacks,
  PTY_EXIT_DRAIN_DEADLINE_MS,
  PTY_EXIT_DRAIN_POLL_MS,
  PTY_EXIT_DRAIN_SETTLE_TICKS,
} from '../../src/main/pty/shutdown/exit-callback-drain';
import type { PtyExitDrainResult } from '../../src/main/pty/shutdown/exit-callback-drain';

/** Start a drain and expose whether / how it settled without awaiting it. */
function startDrain(options: Parameters<typeof drainPtyExitCallbacks>[0]) {
  const state: { result: PtyExitDrainResult | null } = { result: null };
  void drainPtyExitCallbacks(options).then((result) => {
    state.result = result;
  });
  return state;
}

describe('drainPtyExitCallbacks', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('resolves at once, without polling or logging, when there is nothing to drain', async () => {
    const isProcessAlive = vi.fn(() => true);
    const log = vi.fn();

    const result = await drainPtyExitCallbacks({ pids: [], isProcessAlive, log });

    expect(result).toEqual({ timedOut: false, elapsedMs: 0, lingeringPids: [] });
    expect(isProcessAlive).not.toHaveBeenCalled();
    expect(log).not.toHaveBeenCalled();
  });

  it('treats non-positive and non-integer pids as nothing to drain', async () => {
    const isProcessAlive = vi.fn(() => true);

    const result = await drainPtyExitCallbacks({ pids: [0, -7, Number.NaN, 12.5], isProcessAlive });

    expect(result.timedOut).toBe(false);
    expect(isProcessAlive).not.toHaveBeenCalled();
  });

  it('resolves only after the settle ticks that follow the last pid disappearing', async () => {
    const log = vi.fn();
    const state = startDrain({
      pids: [11, 22],
      isProcessAlive: () => false,
      pollIntervalMs: 10,
      settleTicks: 2,
      deadlineMs: 1000,
      log,
    });

    // Tick 1 (10ms) sees both pids gone and arms the settle; ticks 2 and 3
    // are the settle. Resolving at tick 1 would quit before libuv has run
    // the loop turn that dispatches the queued exit callback.
    await vi.advanceTimersByTimeAsync(20);
    expect(state.result).toBeNull();

    await vi.advanceTimersByTimeAsync(10);
    expect(state.result).toEqual({ timedOut: false, elapsedMs: 30, lingeringPids: [] });
    expect(log.mock.calls.map((call) => call[0])).toEqual([
      '[SHUTDOWN] pty-drain:start n=2',
      '[SHUTDOWN] pty-drain:done 30ms',
    ]);
  });

  it('keeps polling a lingering pid and stops re-polling the ones already gone', async () => {
    let pollsOfLingering = 0;
    const isProcessAlive = vi.fn((pid: number) => {
      if (pid !== 22) return false;
      pollsOfLingering += 1;
      // Alive for the first three polls, gone from the fourth.
      return pollsOfLingering <= 3;
    });
    const state = startDrain({
      pids: [11, 22],
      isProcessAlive,
      pollIntervalMs: 10,
      settleTicks: 2,
      deadlineMs: 1000,
    });

    // Polls at 10/20/30 see pid 22 alive, 40 sees it gone, 50 and 60 settle.
    await vi.advanceTimersByTimeAsync(50);
    expect(state.result).toBeNull();
    await vi.advanceTimersByTimeAsync(10);
    expect(state.result).toEqual({ timedOut: false, elapsedMs: 60, lingeringPids: [] });

    // Pid 11 was gone on the first poll and never probed again.
    const probesOfDeadPid = isProcessAlive.mock.calls.filter((call) => call[0] === 11);
    expect(probesOfDeadPid).toHaveLength(1);
  });

  it('gives up at the deadline, reports the lingering pids, and stops polling', async () => {
    const isProcessAlive = vi.fn(() => true);
    const log = vi.fn();
    const state = startDrain({
      pids: [11],
      isProcessAlive,
      pollIntervalMs: 10,
      settleTicks: 2,
      deadlineMs: 100,
      log,
    });

    await vi.advanceTimersByTimeAsync(100);
    expect(state.result).toEqual({ timedOut: true, elapsedMs: 100, lingeringPids: [11] });
    expect(log).toHaveBeenLastCalledWith('[SHUTDOWN] pty-drain:timeout 100ms lingering=11');

    // The poll timer was cleared with the deadline: no probes after it.
    const probesAtDeadline = isProcessAlive.mock.calls.length;
    await vi.advanceTimersByTimeAsync(200);
    expect(isProcessAlive.mock.calls.length).toBe(probesAtDeadline);
  });

  it('treats a probe that throws as a dead process, so a broken probe can never hold the quit', async () => {
    const state = startDrain({
      pids: [11],
      isProcessAlive: () => {
        throw new Error('probe exploded');
      },
      pollIntervalMs: 10,
      settleTicks: 1,
      deadlineMs: 1000,
    });

    await vi.advanceTimersByTimeAsync(20);
    expect(state.result).toEqual({ timedOut: false, elapsedMs: 20, lingeringPids: [] });
  });

  it('ships defaults that finish a clean drain well inside the 6s hard-shutdown failsafe', () => {
    // A clean drain costs settle ticks x poll interval after the last pid is
    // gone; the deadline bounds a child that ignores the kill. Both must leave
    // Electron's own teardown room under startHardShutdownFailsafe's 6000ms.
    expect(PTY_EXIT_DRAIN_POLL_MS * PTY_EXIT_DRAIN_SETTLE_TICKS).toBeLessThanOrEqual(200);
    expect(PTY_EXIT_DRAIN_DEADLINE_MS).toBeLessThanOrEqual(2000);
  });
});
