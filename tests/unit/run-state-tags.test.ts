/**
 * The five run-state tags every Sentry event carries (`run-state-tags.ts`): how
 * long ago the machine woke, the CPU speed limit, this run's uptime, the main
 * window's state and whether the app is focused. They exist so a timeout, a
 * stall or a missing frame says what the machine was doing on its first event
 * (Sentry DESKTOP-46 needed three releases to collect three of them). A wrong
 * value here misleads every investigation that reads it, and a throw would cost
 * the event, since they are read inside `beforeSend`.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runStateTags, setRunStateSource, type WindowStateReadable } from '../../src/main/analytics/run-state-tags';
import { initRunUptimeTracking, resetRunUptimeForTests } from '../../src/main/analytics/run-uptime';
import { noteCpuSpeedLimit, resetCpuSpeedLimitForTests } from '../../src/main/browser/cpu-speed-limit';
import { noteWake, resetWakeClockForTests } from '../../src/main/browser/wake-clock';

const NOW = Date.UTC(2026, 10, 25, 12, 0, 0);

function windowIn(state: 'visible' | 'minimized' | 'hidden' | 'destroyed'): WindowStateReadable {
  return {
    isDestroyed: () => state === 'destroyed',
    isMinimized: () => state === 'minimized',
    isVisible: () => state === 'visible' || state === 'minimized',
  };
}

let temporaryDirectory: string;

beforeEach(() => {
  temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'run-state-tags-'));
  resetWakeClockForTests();
  resetCpuSpeedLimitForTests();
  resetRunUptimeForTests();
  setRunStateSource(null);
});

afterEach(() => {
  resetRunUptimeForTests();
  setRunStateSource(null);
  fs.rmSync(temporaryDirectory, { recursive: true, force: true });
});

describe('runStateTags', () => {
  it('reads unknown, never a guess, before anything was recorded or registered', () => {
    expect(runStateTags(NOW)).toEqual({
      since_wake: 'none',
      cpu_speed_limit: 'unknown',
      run_uptime: 'unknown',
      main_window: 'unknown',
      app_focused: 'unknown',
    });
  });

  it('buckets the wake, the limit and the uptime, and reads the window and the focus', () => {
    noteWake(NOW - 10_000);
    noteCpuSpeedLimit(60);
    initRunUptimeTracking(path.join(temporaryDirectory, 'run.json'), NOW - 10 * 60_000);
    setRunStateSource({ mainWindow: () => windowIn('minimized'), appFocused: () => true });

    expect(runStateTags(NOW)).toEqual({
      since_wake: 'under_30s',
      cpu_speed_limit: '50-74',
      run_uptime: '5-30m',
      main_window: 'minimized',
      app_focused: 'yes',
    });
  });

  it.each([
    ['visible', 'visible'],
    ['hidden', 'hidden'],
    ['minimized', 'minimized'],
    ['destroyed', 'none'],
  ] as const)('reads a %s main window as %s', (state, expected) => {
    setRunStateSource({ mainWindow: () => windowIn(state), appFocused: () => false });
    expect(runStateTags(NOW)).toMatchObject({ main_window: expected, app_focused: 'no' });
  });

  it('reads no window as none, which is not the same as unknown', () => {
    setRunStateSource({ mainWindow: () => null, appFocused: () => false });
    expect(runStateTags(NOW).main_window).toBe('none');
  });

  // The tags are read inside beforeSend, where a throw makes the SDK drop the event.
  it('never throws when a window read does, and says unknown for it', () => {
    setRunStateSource({
      mainWindow: () => { throw new Error('Object has been destroyed'); },
      appFocused: () => { throw new Error('Object has been destroyed'); },
    });
    expect(runStateTags(NOW)).toMatchObject({ main_window: 'unknown', app_focused: 'unknown' });
  });

  it('holds only fixed words, so nothing a user wrote can ride a tag', () => {
    noteWake(NOW - 5 * 60_000);
    noteCpuSpeedLimit(100);
    initRunUptimeTracking(path.join(temporaryDirectory, 'run.json'), NOW - 3 * 3_600_000);
    setRunStateSource({ mainWindow: () => windowIn('visible'), appFocused: () => true });
    for (const value of Object.values(runStateTags(NOW))) {
      expect(value).toMatch(/^[a-z0-9_<+-]{1,12}$/);
    }
  });
});
