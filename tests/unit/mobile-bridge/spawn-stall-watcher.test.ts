/**
 * Unit tests for src/main/mobile-bridge/push/spawn-stall-watcher.ts
 *
 * Mirrors the renderer's own spawn-stall timer contract (App.tsx): arm an
 * 8s timer on first entry into the in-flight map, do not re-arm on a
 * label-only change, and disarm (cancel, no callback) on removal.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { BrowserWindow } from 'electron';
import { SpawnStallWatcher } from '../../../src/main/mobile-bridge/push/spawn-stall-watcher';
import {
  emitSpawnProgress,
  clearSpawnProgress,
  __resetSpawnProgressForTest,
} from '../../../src/main/transition-engine/spawn-progress';

function makeWindow(): BrowserWindow {
  return { isDestroyed: () => false, webContents: { send: vi.fn() } } as unknown as BrowserWindow;
}

describe('SpawnStallWatcher', () => {
  let onStall: ReturnType<typeof vi.fn>;
  let watcher: SpawnStallWatcher;

  beforeEach(() => {
    vi.useFakeTimers();
    __resetSpawnProgressForTest();
    onStall = vi.fn();
    watcher = new SpawnStallWatcher({ onStall });
  });

  afterEach(() => {
    watcher.dispose();
    vi.useRealTimers();
  });

  it('fires onStall 8s after a task enters the in-flight map', () => {
    watcher.start();
    emitSpawnProgress(makeWindow(), 'task-1', 'fetching');
    expect(onStall).not.toHaveBeenCalled();

    vi.advanceTimersByTime(8000);
    expect(onStall).toHaveBeenCalledExactlyOnceWith('task-1');
  });

  it('does not re-arm on a label-only change, so total preparing time is what is measured', () => {
    watcher.start();
    const window = makeWindow();
    emitSpawnProgress(window, 'task-1', 'fetching');
    vi.advanceTimersByTime(6000);
    emitSpawnProgress(window, 'task-1', 'creating-worktree'); // label change, not a re-arm
    vi.advanceTimersByTime(2000); // total 8s since the FIRST entry
    expect(onStall).toHaveBeenCalledExactlyOnceWith('task-1');
  });

  it('disarms when the task leaves the map before the threshold', () => {
    watcher.start();
    const window = makeWindow();
    emitSpawnProgress(window, 'task-1', 'fetching');
    vi.advanceTimersByTime(5000);
    clearSpawnProgress(window, 'task-1'); // spawn finished
    vi.advanceTimersByTime(5000);
    expect(onStall).not.toHaveBeenCalled();
  });

  it('tracks multiple tasks independently', () => {
    watcher.start();
    const window = makeWindow();
    emitSpawnProgress(window, 'task-1', 'fetching');
    vi.advanceTimersByTime(4000);
    emitSpawnProgress(window, 'task-2', 'fetching');
    vi.advanceTimersByTime(4000); // task-1 at 8s, task-2 at 4s
    expect(onStall).toHaveBeenCalledExactlyOnceWith('task-1');

    vi.advanceTimersByTime(4000); // task-2 now at 8s
    expect(onStall).toHaveBeenCalledTimes(2);
    expect(onStall).toHaveBeenCalledWith('task-2');
  });

  it('dispose cancels pending timers and stops listening', () => {
    watcher.start();
    emitSpawnProgress(makeWindow(), 'task-1', 'fetching');
    watcher.dispose();
    vi.advanceTimersByTime(8000);
    expect(onStall).not.toHaveBeenCalled();
  });

  it('start is idempotent and dispose is safe to call twice', () => {
    watcher.start();
    watcher.start();
    emitSpawnProgress(makeWindow(), 'task-1', 'fetching');
    vi.advanceTimersByTime(8000);
    expect(onStall).toHaveBeenCalledTimes(1); // not double-armed by the second start()

    watcher.dispose();
    watcher.dispose();
  });
});
