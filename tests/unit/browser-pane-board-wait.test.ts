/**
 * `hostPaneWhenBoardHasTask`: an agent's open_pane can arrive before the board has
 * the task it names (a new task took 1.3 s to arrive in a live run). Nothing would
 * ask again, so the bridge waits for the board to catch up, for as long as main
 * waits on the pane, then mounts the parked window that hosts the pane. If the task
 * never lands, it gives up and clears the pane flag main has already stopped
 * waiting on.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { hostPaneWhenBoardHasTask } from '../../src/renderer/window-manager/bridge/useBrowserPaneRequestBridge';
import { useWindowStore, monitorWindowManager } from '../../src/renderer/window-manager/store/window-store';
import { useBoardStore } from '../../src/renderer/stores/board-store';
import { useProjectStore } from '../../src/renderer/stores/project-store';
import { useSessionStore } from '../../src/renderer/stores/session-store';
import { BROWSER_PANE_OPEN_TIMEOUT_MS } from '../../src/shared/types';
import type { Project, Task } from '../../src/shared/types';

const PROJECT = 'project-a';
const TASK = 'task-a';

const boardTask = { id: TASK, title: 'Task A', swimlane_id: 'lane-a', archived_at: null } as Task;

function windowsHostingTask(): Array<{ kind: string; anchor: string; parked?: boolean }> {
  return Object.values(useWindowStore.getState().windows).map((managedWindow) => ({
    kind: managedWindow.kind,
    anchor: managedWindow.anchor,
    parked: managedWindow.parked,
  }));
}

let cancelWait: (() => void) | null = null;

beforeEach(() => {
  vi.useFakeTimers();
  useWindowStore.setState({ windows: {}, order: [], focusedWindowId: null });
  monitorWindowManager.store.setState({ windows: {}, order: [], focusedWindowId: null });
  useProjectStore.setState({ currentProject: { id: PROJECT } as Project });
  useBoardStore.setState({ tasks: [], archivedTasks: [], swimlanes: [] });
  useSessionStore.setState({
    detailTaskId: null,
    browserOpenTasks: new Set([TASK]),
    browserHeldTasks: new Set(),
    browserGuestTasks: new Set(),
  });
});

afterEach(() => {
  cancelWait?.();
  cancelWait = null;
  vi.useRealTimers();
});

describe('hostPaneWhenBoardHasTask', () => {
  it('mounts a parked window once the task lands in tasks, and ends the wait once', () => {
    const onEnded = vi.fn();
    cancelWait = hostPaneWhenBoardHasTask(PROJECT, TASK, onEnded);
    expect(windowsHostingTask()).toEqual([]);

    useBoardStore.setState({ tasks: [boardTask] });

    expect(windowsHostingTask()).toEqual([{ kind: 'task-detail', anchor: TASK, parked: true }]);
    expect(onEnded).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('mounts a parked window once the task lands in archivedTasks', () => {
    const onEnded = vi.fn();
    cancelWait = hostPaneWhenBoardHasTask(PROJECT, TASK, onEnded);

    useBoardStore.setState({ archivedTasks: [{ ...boardTask, archived_at: '2026-01-01T00:00:00.000Z' }] });

    expect(windowsHostingTask()).toEqual([{ kind: 'task-detail', anchor: TASK, parked: true }]);
    expect(onEnded).toHaveBeenCalledTimes(1);
  });

  it('clears a stale detail signal naming the task when it mounts the window', () => {
    // A stale signal would swallow the user's next click on the card as "no
    // change", and that click is what shows this window.
    useSessionStore.setState({ detailTaskId: TASK });
    cancelWait = hostPaneWhenBoardHasTask(PROJECT, TASK, vi.fn());

    useBoardStore.setState({ tasks: [boardTask] });

    expect(useSessionStore.getState().detailTaskId).toBeNull();
  });

  it('leaves a detail signal naming another task alone', () => {
    useSessionStore.setState({ detailTaskId: 'task-other' });
    cancelWait = hostPaneWhenBoardHasTask(PROJECT, TASK, vi.fn());

    useBoardStore.setState({ tasks: [boardTask] });

    expect(useSessionStore.getState().detailTaskId).toBe('task-other');
  });

  it('gives up when the task never lands: no window, flag cleared, a late landing mounts nothing', () => {
    const onEnded = vi.fn();
    cancelWait = hostPaneWhenBoardHasTask(PROJECT, TASK, onEnded);

    vi.advanceTimersByTime(BROWSER_PANE_OPEN_TIMEOUT_MS - 1);
    expect(onEnded).not.toHaveBeenCalled();
    expect(useSessionStore.getState().browserOpenTasks.has(TASK)).toBe(true);

    vi.advanceTimersByTime(1);
    expect(windowsHostingTask()).toEqual([]);
    expect(onEnded).toHaveBeenCalledTimes(1);
    expect(useSessionStore.getState().browserOpenTasks.has(TASK)).toBe(false);

    useBoardStore.setState({ tasks: [boardTask] });
    expect(windowsHostingTask()).toEqual([]);
    expect(onEnded).toHaveBeenCalledTimes(1);
  });

  it('is ended by the returned cancel: a later landing mounts nothing and the open flag stays', () => {
    const onEnded = vi.fn();
    const cancel = hostPaneWhenBoardHasTask(PROJECT, TASK, onEnded);

    cancel();
    expect(onEnded).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);

    useBoardStore.setState({ tasks: [boardTask] });
    vi.advanceTimersByTime(BROWSER_PANE_OPEN_TIMEOUT_MS * 2);

    expect(windowsHostingTask()).toEqual([]);
    expect(useSessionStore.getState().browserOpenTasks.has(TASK)).toBe(true);
    expect(onEnded).toHaveBeenCalledTimes(1);
  });

  it('ignores a board write that changes neither tasks nor archivedTasks', () => {
    // The task is already on the board, so only the early return stands between
    // an unrelated board write and a mounted window.
    useBoardStore.setState({ tasks: [boardTask] });
    const onEnded = vi.fn();
    cancelWait = hostPaneWhenBoardHasTask(PROJECT, TASK, onEnded);

    useBoardStore.setState({ swimlanes: [] });

    expect(windowsHostingTask()).toEqual([]);
    expect(onEnded).not.toHaveBeenCalled();
  });
});
