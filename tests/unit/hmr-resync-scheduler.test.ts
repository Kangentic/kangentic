/**
 * The dev-only scheduler that runs the Pattern B re-sync once per burst of Vite
 * updates (src/renderer/utils/hmr-resync-scheduler.ts).
 *
 * What a developer loses if it breaks: a fast-forward of the main checkout
 * re-fetches every store on each of its hundreds of updates again (8,935 IPC
 * calls in 12.7 s, with main stalling for seconds), or the re-sync stops
 * running at all and a replaced store keeps its defaults until a reload.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createHmrResyncScheduler,
  HMR_RESYNC_IN_FLIGHT_CEILING_MS,
  HMR_RESYNC_QUIET_MS,
} from '../../src/renderer/utils/hmr-resync-scheduler';

describe('createHmrResyncScheduler', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('runs a burst of asks once, the quiet period after the last one', () => {
    const scheduler = createHmrResyncScheduler({ quietMs: 500 });
    const run = vi.fn();

    // 300 updates 40 ms apart: 12 s of burst, never 500 ms of quiet.
    for (let update = 0; update < 300; update += 1) {
      scheduler.schedule(run);
      vi.advanceTimersByTime(40);
    }
    expect(run).not.toHaveBeenCalled();

    // 40 ms have passed since the last ask, so 459 more is still inside the quiet period.
    vi.advanceTimersByTime(459);
    expect(run).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(run).toHaveBeenCalledTimes(1);

    // Nothing is left armed.
    vi.advanceTimersByTime(60_000);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('waits out an update that takes longer to apply than the quiet period', () => {
    // The measured shape of a real burst: each update starts as the last one ends, and
    // some take longer to apply (750 ms and 1.4 s were measured) than the quiet period.
    const scheduler = createHmrResyncScheduler({ quietMs: 500 });
    const run = vi.fn();

    for (let update = 0; update < 20; update += 1) {
      scheduler.holdWhileUpdating();
      vi.advanceTimersByTime(800);
      scheduler.schedule(run);
    }
    expect(run).not.toHaveBeenCalled();

    vi.advanceTimersByTime(499);
    expect(run).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('runs a held ask at the ceiling when its update never finishes', () => {
    // Vite fires no afterUpdate for an update whose accept callback throws.
    const scheduler = createHmrResyncScheduler({ quietMs: 500, inFlightCeilingMs: 10_000 });
    const run = vi.fn();

    scheduler.schedule(run);
    vi.advanceTimersByTime(100);
    scheduler.holdWhileUpdating();

    vi.advanceTimersByTime(9_999);
    expect(run).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('arms nothing when an update starts with no ask pending', () => {
    const scheduler = createHmrResyncScheduler({ quietMs: 500, inFlightCeilingMs: 10_000 });
    const run = vi.fn();

    // The first update of a burst: nothing has asked yet.
    scheduler.holdWhileUpdating();
    vi.advanceTimersByTime(60_000);
    expect(run).not.toHaveBeenCalled();

    scheduler.schedule(run);
    vi.advanceTimersByTime(500);
    expect(run).toHaveBeenCalledTimes(1);

    // An update after the run finds nothing pending either.
    scheduler.holdWhileUpdating();
    vi.advanceTimersByTime(60_000);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('runs the newest ask, not the first', () => {
    const scheduler = createHmrResyncScheduler({ quietMs: 500 });
    const first = vi.fn();
    const newest = vi.fn();

    scheduler.schedule(first);
    vi.advanceTimersByTime(100);
    scheduler.holdWhileUpdating();
    vi.advanceTimersByTime(100);
    scheduler.schedule(newest);
    vi.advanceTimersByTime(500);

    expect(first).not.toHaveBeenCalled();
    expect(newest).toHaveBeenCalledTimes(1);
  });

  it('runs once for each burst when a quiet period separates them', () => {
    const scheduler = createHmrResyncScheduler({ quietMs: 500 });
    const run = vi.fn();

    scheduler.schedule(run);
    scheduler.schedule(run);
    vi.advanceTimersByTime(500);
    expect(run).toHaveBeenCalledTimes(1);

    scheduler.schedule(run);
    vi.advanceTimersByTime(500);
    expect(run).toHaveBeenCalledTimes(2);
  });

  it('stays usable after a run that throws', () => {
    const scheduler = createHmrResyncScheduler({ quietMs: 500 });
    const failing = vi.fn(() => {
      throw new Error('a store load threw synchronously');
    });
    const run = vi.fn();

    scheduler.schedule(failing);
    expect(() => vi.advanceTimersByTime(500)).toThrow('a store load threw synchronously');

    // The failed ask is gone: an update that starts now holds nothing.
    scheduler.holdWhileUpdating();
    vi.advanceTimersByTime(60_000);
    expect(failing).toHaveBeenCalledTimes(1);

    scheduler.schedule(run);
    vi.advanceTimersByTime(500);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('keeps two schedulers apart, as the main window and a pop-out each hold their own', () => {
    const mainWindow = createHmrResyncScheduler({ quietMs: 500 });
    const popOut = createHmrResyncScheduler({ quietMs: 500 });
    const mainRun = vi.fn();
    const popOutRun = vi.fn();

    mainWindow.schedule(mainRun);
    popOut.schedule(popOutRun);
    vi.advanceTimersByTime(500);

    expect(mainRun).toHaveBeenCalledTimes(1);
    expect(popOutRun).toHaveBeenCalledTimes(1);
  });

  it('defaults to the measured quiet period and ceiling', () => {
    const scheduler = createHmrResyncScheduler();
    const run = vi.fn();

    scheduler.schedule(run);
    vi.advanceTimersByTime(HMR_RESYNC_QUIET_MS - 1);
    expect(run).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(run).toHaveBeenCalledTimes(1);

    scheduler.schedule(run);
    scheduler.holdWhileUpdating();
    vi.advanceTimersByTime(HMR_RESYNC_IN_FLIGHT_CEILING_MS - 1);
    expect(run).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1);
    expect(run).toHaveBeenCalledTimes(2);
  });
});
