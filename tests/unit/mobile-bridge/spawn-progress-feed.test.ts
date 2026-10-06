/**
 * Unit tests for src/main/mobile-bridge/spawn-progress-feed.ts
 *
 * Driven through the real spawn-progress module, so the feed hears exactly
 * the pushes the desktop card does. Contract: the first label emits at once,
 * changes inside the 1000ms window coalesce into one trailing emit, an
 * unchanged re-push emits nothing, the clear always emits, the owning project
 * is resolved at emit time, and no phone listening means no project lookup.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { BrowserWindow } from 'electron';
import { SpawnProgressFeed } from '../../../src/main/mobile-bridge/spawn-progress-feed';
import {
  emitSpawnProgress,
  emitSpawnWaiting,
  clearSpawnProgress,
  createProgressCallback,
  __resetSpawnProgressForTest,
} from '../../../src/main/transition-engine/spawn-progress';

function makeWindow(): BrowserWindow {
  return { isDestroyed: () => false, webContents: { send: vi.fn() } } as unknown as BrowserWindow;
}

describe('SpawnProgressFeed', () => {
  let resolveProjectIdForTask: ReturnType<typeof vi.fn<(taskId: string) => string | null>>;
  let feed: SpawnProgressFeed;
  let emitted: Array<[string, string]>;
  const window = makeWindow();

  beforeEach(() => {
    vi.useFakeTimers();
    __resetSpawnProgressForTest();
    resolveProjectIdForTask = vi.fn((taskId: string) => (taskId === 'task-orphan' ? null : 'proj-1'));
    feed = new SpawnProgressFeed({ resolveProjectIdForTask });
    emitted = [];
    feed.onTaskSpawnProgressChanged((projectId, taskId) => emitted.push([projectId, taskId]));
    feed.start();
  });

  afterEach(() => {
    feed.dispose();
    vi.useRealTimers();
  });

  it('emits the first label at once', () => {
    emitSpawnProgress(window, 'task-1', 'fetching');
    expect(emitted).toEqual([['proj-1', 'task-1']]);
  });

  it('coalesces a burst inside the window into one trailing emit', () => {
    const onProgress = createProgressCallback(window, 'task-1');
    onProgress('fetching');
    // Raw git progress lines pass through createProgressCallback verbatim.
    onProgress('Receiving objects: 10%');
    onProgress('Receiving objects: 55%');
    onProgress('Resolving deltas: 90%');
    expect(emitted).toHaveLength(1);

    vi.advanceTimersByTime(1000);
    expect(emitted).toHaveLength(2);

    // Nothing new arrived in the second window, so it closes quietly.
    vi.advanceTimersByTime(1000);
    expect(emitted).toHaveLength(2);
  });

  it('a label that comes back unchanged emits nothing', () => {
    emitSpawnWaiting(window, 'task-1', 2);
    vi.advanceTimersByTime(1000);
    // The git queue's periodic refresh re-pushes the same text.
    emitSpawnWaiting(window, 'task-1', 2);
    vi.advanceTimersByTime(1000);
    expect(emitted).toHaveLength(1);

    emitSpawnWaiting(window, 'task-1', 1);
    expect(emitted).toHaveLength(2);
  });

  it('always delivers the clear, at the end of an open window', () => {
    emitSpawnProgress(window, 'task-1', 'starting-agent');
    clearSpawnProgress(window, 'task-1');
    expect(emitted).toHaveLength(1);

    vi.advanceTimersByTime(1000);
    expect(emitted).toHaveLength(2);
  });

  it('a clear outside a window emits at once, and the next spawn starts fresh', () => {
    emitSpawnProgress(window, 'task-1', 'starting-agent');
    vi.advanceTimersByTime(1000);
    clearSpawnProgress(window, 'task-1');
    expect(emitted).toHaveLength(2);

    emitSpawnProgress(window, 'task-1', 'starting-agent');
    expect(emitted).toHaveLength(3);
  });

  it('a clear for a task with no label on record emits nothing', () => {
    clearSpawnProgress(window, 'task-never-labelled');
    vi.advanceTimersByTime(1000);
    expect(emitted).toEqual([]);
  });

  it('throttles each task on its own', () => {
    emitSpawnProgress(window, 'task-1', 'fetching');
    emitSpawnProgress(window, 'task-2', 'fetching');
    expect(emitted).toEqual([['proj-1', 'task-1'], ['proj-1', 'task-2']]);
  });

  it('a task no project owns emits nothing', () => {
    emitSpawnProgress(window, 'task-orphan', 'fetching');
    expect(emitted).toEqual([]);
  });

  it('skips the project lookup entirely while nothing listens', () => {
    const quietResolver = vi.fn(() => 'proj-1');
    const quietFeed = new SpawnProgressFeed({ resolveProjectIdForTask: quietResolver });
    quietFeed.start();
    try {
      emitSpawnProgress(window, 'task-1', 'fetching');
      expect(quietResolver).not.toHaveBeenCalled();
    } finally {
      quietFeed.dispose();
    }
  });

  it('a throwing resolver or listener never reaches the spawn path', () => {
    resolveProjectIdForTask.mockImplementation(() => {
      throw new Error('database closed');
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      expect(() => emitSpawnProgress(window, 'task-1', 'fetching')).not.toThrow();
      resolveProjectIdForTask.mockReturnValue('proj-1');
      feed.onTaskSpawnProgressChanged(() => {
        throw new Error('listener failed');
      });
      expect(() => emitSpawnProgress(window, 'task-2', 'fetching')).not.toThrow();
      // The healthy listener still heard it.
      expect(emitted).toEqual([['proj-1', 'task-2']]);
    } finally {
      warn.mockRestore();
    }
  });

  it('prunes an entry a TTL expiry stranded, so a later identical label emits again', () => {
    const nowSpy = vi.spyOn(Date, 'now');
    try {
      nowSpy.mockReturnValue(0);
      emitSpawnProgress(window, 'task-1', 'starting-agent');
      vi.advanceTimersByTime(1000);
      expect(emitted).toHaveLength(1);

      // The desktop's TTL drops the label without a push; the next spawn's
      // first label is the same text and must still be announced.
      __resetSpawnProgressForTest();
      nowSpy.mockReturnValue(10 * 60_000);
      emitSpawnProgress(window, 'task-1', 'starting-agent');
      expect(emitted).toHaveLength(2);
    } finally {
      nowSpy.mockRestore();
    }
  });

  it('dispose stops listening and cancels the open window', () => {
    emitSpawnProgress(window, 'task-1', 'fetching');
    emitSpawnProgress(window, 'task-1', 'creating-worktree');
    feed.dispose();

    vi.advanceTimersByTime(1000);
    emitSpawnProgress(window, 'task-1', 'starting-agent');
    expect(emitted).toHaveLength(1);
  });
});
