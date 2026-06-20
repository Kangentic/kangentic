/**
 * Unit tests for startStartupTimer (src/main/transition-engine/session-startup/timing.ts).
 *
 * Verifies the two log gates:
 *   - work gate: a pass that did real work (workCount > 0) always logs.
 *   - threshold gate: a zero-work pass logs only if it ran past
 *     STARTUP_TIMING_LOG_THRESHOLD_MS (a slow no-op is a perf signal).
 * ...and that packaged builds are a full no-op.
 *
 * `Date.now` is driven by a mutable `currentTime` so elapsed durations are
 * deterministic; `app.isPackaged` is a mutable hoisted mock toggled per test.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { appMock } = vi.hoisted(() => ({ appMock: { isPackaged: false } }));

vi.mock('electron', () => ({ app: appMock }));

import { startStartupTimer, STARTUP_TIMING_LOG_THRESHOLD_MS } from '../../src/main/transition-engine/session-startup/timing';

const PROJECT_ID = '1a2b3c4d-5678-90ab-cdef-1234567890ab';

let currentTime = 0;
let consoleLogSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  appMock.isPackaged = false;
  currentTime = 1000;
  vi.spyOn(Date, 'now').mockImplementation(() => currentTime);
  consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('startStartupTimer', () => {
  it('logs when the pass did real work, even when fast', () => {
    const done = startStartupTimer('autoSpawnTasks', PROJECT_ID, 'spawned');
    currentTime += 5; // 5ms - well under the threshold
    done(2);

    expect(consoleLogSpy).toHaveBeenCalledTimes(1);
    const line = consoleLogSpy.mock.calls[0][0] as string;
    expect(line).toContain('[startup] autoSpawnTasks');
    expect(line).toContain('1a2b3c4d'); // first 8 chars of the project id only
    expect(line).not.toContain('5678'); // not the full id
    expect(line).toContain('spawned=2');
    expect(line).toContain('(5ms)');
  });

  it('stays silent for a fast no-op (the common per-open case)', () => {
    const done = startStartupTimer('autoSpawnTasks', PROJECT_ID, 'spawned');
    currentTime += STARTUP_TIMING_LOG_THRESHOLD_MS - 1; // just under the threshold
    done(0);

    expect(consoleLogSpy).not.toHaveBeenCalled();
  });

  it('logs a slow no-op as a perf signal (threshold gate, inclusive)', () => {
    const done = startStartupTimer('resumeSuspendedSessions', PROJECT_ID, 'resumed');
    currentTime += STARTUP_TIMING_LOG_THRESHOLD_MS; // exactly at the threshold -> logs
    done(0);

    expect(consoleLogSpy).toHaveBeenCalledTimes(1);
    const line = consoleLogSpy.mock.calls[0][0] as string;
    expect(line).toContain('[startup] resumeSuspendedSessions');
    expect(line).toContain('resumed=0');
    expect(line).toContain(`(${STARTUP_TIMING_LOG_THRESHOLD_MS}ms)`);
  });

  it('is a full no-op in packaged builds, even with work and a slow pass', () => {
    appMock.isPackaged = true;
    const done = startStartupTimer('autoSpawnTasks', PROJECT_ID, 'spawned');
    currentTime += 999;
    done(5);

    expect(consoleLogSpy).not.toHaveBeenCalled();
  });
});
