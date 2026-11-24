/**
 * The startup timer's timeline sink (`setStartupTimelineSink`).
 *
 * A dev build's lag journal keeps each launch's timeline, so the console is
 * not the only place the marks live. What it must hand over: every mark with
 * a whole-number elapsed time, taken before the marks are cleared, never after
 * the sink is removed, and never from a packaged app.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const hoisted = vi.hoisted(() => ({ electronApp: { isPackaged: false } }));

vi.mock('electron', () => ({ app: hoisted.electronApp }));

type StartupTimer = typeof import('../../src/main/startup-timer');

describe('startup timeline sink', () => {
  let timer: StartupTimer;

  /** Make the next `performance.now()` reads return `readings`, in order. */
  function readClock(...readings: number[]): void {
    const spy = vi.spyOn(performance, 'now');
    for (const reading of readings) spy.mockReturnValueOnce(reading);
  }

  beforeEach(async () => {
    vi.resetModules();
    hoisted.electronApp.isPackaged = false;
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    timer = await import('../../src/main/startup-timer');
    timer.initStartupTimer(1_000);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('hands each mark over as a label and a rounded whole-number elapsed time, then hands nothing over a second time', () => {
    const sink = vi.fn();
    timer.setStartupTimelineSink(sink);
    readClock(1_000.4, 1_234.6);
    timer.mark('process_start');
    timer.mark('window_ready');

    timer.finishStartupTimer();

    expect(sink).toHaveBeenCalledTimes(1);
    expect(sink).toHaveBeenCalledWith([
      { label: 'process_start', elapsedMs: 0 },
      { label: 'window_ready', elapsedMs: 235 },
    ]);

    // The marks were cleared by the first finish: a second window's timeline
    // starts empty and has nothing to hand over.
    timer.finishStartupTimer();
    expect(sink).toHaveBeenCalledTimes(1);
  });

  it('stops handing marks over once the sink is set to null', () => {
    const sink = vi.fn();
    timer.setStartupTimelineSink(sink);
    timer.setStartupTimelineSink(null);
    timer.mark('window_ready');

    expect(() => timer.finishStartupTimer()).not.toThrow();

    expect(sink).not.toHaveBeenCalled();
  });

  it('never calls the sink in a packaged app, whether or not a mark was kept', () => {
    const sink = vi.fn();
    timer.setStartupTimelineSink(sink);
    timer.mark('kept_before_packaging');
    hoisted.electronApp.isPackaged = true;
    timer.mark('window_ready');

    timer.finishStartupTimer();

    expect(sink).not.toHaveBeenCalled();
  });
});
