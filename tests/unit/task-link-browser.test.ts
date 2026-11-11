/**
 * How a task's link reaches its Kangentic browser (src/renderer/utils/task-link-browser.ts).
 *
 * What a user loses if this goes: a click on a board card's artifact or PR pill
 * that opens nothing because the task window was closed, a link that opens the
 * window and then never loads, or a second click that loads the first link.
 * The default-browser fallback is the net under all three, so its timing is
 * pinned: not before PENDING_TASK_LINK_MS, once after.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const stores = vi.hoisted(() => ({
  config: { browser: { enabled: true as boolean | undefined } },
  sessionByTaskId: new Map<string, { status: string }>(),
  currentProject: { id: 'project-1' } as { id: string } | null,
  openInstanceKeys: {} as Record<string, boolean>,
  setDetailTaskId: vi.fn(),
}));

vi.mock('../../src/renderer/stores/config-store', () => ({
  useConfigStore: { getState: () => ({ config: stores.config }), subscribe: () => () => undefined },
}));
vi.mock('../../src/renderer/stores/pop-out-store', () => ({
  usePopOutStore: { getState: () => ({ openInstanceKeys: stores.openInstanceKeys }), subscribe: () => () => undefined },
}));
vi.mock('../../src/renderer/stores/project-store', () => ({
  useProjectStore: { getState: () => ({ currentProject: stores.currentProject }) },
}));
vi.mock('../../src/renderer/stores/session-store', () => ({
  useSessionStore: {
    getState: () => ({ _sessionByTaskId: stores.sessionByTaskId, setDetailTaskId: stores.setDetailTaskId }),
    subscribe: () => () => undefined,
  },
}));

import { popOutInstanceKey } from '../../src/shared/pop-out';
import {
  PENDING_TASK_LINK_MS,
  openInTaskBrowser,
  registerTaskLinkBrowser,
  taskLinkBrowser,
} from '../../src/renderer/utils/task-link-browser';

const TASK = 'task-1';
const FIRST_LINK = 'https://www.figma.com/design/AbC123xyz/First';
const SECOND_LINK = 'https://miro.com/app/board/uXjVabc123=/';

function fakeBrowser() {
  return { open: vi.fn() };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal('window', { electronAPI: {} });
  stores.config.browser = { enabled: true };
  stores.sessionByTaskId.clear();
  stores.currentProject = { id: 'project-1' };
  stores.openInstanceKeys = {};
  stores.setDetailTaskId.mockClear();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('openInTaskBrowser', () => {
  it('opens at once in the browser the task window registered', () => {
    const browser = fakeBrowser();
    const unregister = registerTaskLinkBrowser(TASK, browser);
    const openExternal = vi.fn();
    expect(openInTaskBrowser(TASK, FIRST_LINK, openExternal)).toBe(true);
    expect(browser.open).toHaveBeenCalledExactlyOnceWith(FIRST_LINK);
    expect(stores.setDetailTaskId).not.toHaveBeenCalled();
    unregister();
    expect(taskLinkBrowser(TASK)).toBeNull();
  });

  it('returns false, and opens nothing, for a task with no session', () => {
    const openExternal = vi.fn();
    expect(openInTaskBrowser(TASK, FIRST_LINK, openExternal)).toBe(false);
    expect(stores.setDetailTaskId).not.toHaveBeenCalled();
    vi.advanceTimersByTime(PENDING_TASK_LINK_MS * 2);
    expect(openExternal).not.toHaveBeenCalled();
  });

  it('returns false when the Browser pane is off for the project', () => {
    stores.sessionByTaskId.set(TASK, { status: 'running' });
    stores.config.browser = { enabled: false };
    expect(openInTaskBrowser(TASK, FIRST_LINK, vi.fn())).toBe(false);
  });

  it('returns false when the task browser is popped out into its own window', () => {
    stores.sessionByTaskId.set(TASK, { status: 'running' });
    stores.openInstanceKeys = { [popOutInstanceKey('browser', { projectId: 'project-1', taskId: TASK })]: true };
    expect(openInTaskBrowser(TASK, FIRST_LINK, vi.fn())).toBe(false);
  });

  it('opens the task window for a running session and hands the link to the next registered browser', () => {
    stores.sessionByTaskId.set(TASK, { status: 'running' });
    const openExternal = vi.fn();
    expect(openInTaskBrowser(TASK, FIRST_LINK, openExternal)).toBe(true);
    expect(stores.setDetailTaskId).toHaveBeenCalledExactlyOnceWith(TASK);

    const browser = fakeBrowser();
    const unregister = registerTaskLinkBrowser(TASK, browser);
    expect(browser.open).toHaveBeenCalledExactlyOnceWith(FIRST_LINK);

    // The link was taken, so the fallback never fires.
    vi.advanceTimersByTime(PENDING_TASK_LINK_MS * 2);
    expect(openExternal).not.toHaveBeenCalled();
    unregister();
  });

  it('falls back to the default browser once, and only after the wait, when no window registers', () => {
    stores.sessionByTaskId.set(TASK, { status: 'running' });
    const openExternal = vi.fn();
    expect(openInTaskBrowser(TASK, FIRST_LINK, openExternal)).toBe(true);

    vi.advanceTimersByTime(PENDING_TASK_LINK_MS - 1);
    expect(openExternal).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(openExternal).toHaveBeenCalledExactlyOnceWith(FIRST_LINK);

    vi.advanceTimersByTime(PENDING_TASK_LINK_MS * 2);
    expect(openExternal).toHaveBeenCalledTimes(1);
  });

  it('lets a second click replace the first pending link', () => {
    stores.sessionByTaskId.set(TASK, { status: 'running' });
    const openExternal = vi.fn();
    openInTaskBrowser(TASK, FIRST_LINK, openExternal);
    openInTaskBrowser(TASK, SECOND_LINK, openExternal);

    // The first one's timer is gone: only the second can fall back.
    vi.advanceTimersByTime(PENDING_TASK_LINK_MS);
    expect(openExternal).toHaveBeenCalledExactlyOnceWith(SECOND_LINK);
  });

  it('does not open the link a second time in a browser that registers after the fallback fired', () => {
    stores.sessionByTaskId.set(TASK, { status: 'running' });
    const openExternal = vi.fn();
    openInTaskBrowser(TASK, FIRST_LINK, openExternal);
    vi.advanceTimersByTime(PENDING_TASK_LINK_MS);
    expect(openExternal).toHaveBeenCalledExactlyOnceWith(FIRST_LINK);

    const lateBrowser = fakeBrowser();
    const unregister = registerTaskLinkBrowser(TASK, lateBrowser);
    expect(lateBrowser.open).not.toHaveBeenCalled();
    expect(openExternal).toHaveBeenCalledTimes(1);
    unregister();
  });

  it('keeps a newer registration when an older browser unregisters', () => {
    const olderBrowser = fakeBrowser();
    const newerBrowser = fakeBrowser();
    const unregisterOlder = registerTaskLinkBrowser(TASK, olderBrowser);
    const unregisterNewer = registerTaskLinkBrowser(TASK, newerBrowser);
    unregisterOlder();
    expect(taskLinkBrowser(TASK)).toBe(newerBrowser);
    unregisterNewer();
    expect(taskLinkBrowser(TASK)).toBeNull();
  });

  it('hands a replaced link to the browser as the second one, never the first', () => {
    stores.sessionByTaskId.set(TASK, { status: 'running' });
    openInTaskBrowser(TASK, FIRST_LINK, vi.fn());
    openInTaskBrowser(TASK, SECOND_LINK, vi.fn());
    const browser = fakeBrowser();
    const unregister = registerTaskLinkBrowser(TASK, browser);
    expect(browser.open).toHaveBeenCalledExactlyOnceWith(SECOND_LINK);
    unregister();
  });
});
