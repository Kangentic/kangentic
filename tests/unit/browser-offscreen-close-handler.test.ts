/**
 * Unit tests for the BROWSER_OFFSCREEN_CLOSE IPC handler in
 * src/main/ipc/handlers/browser.ts.
 *
 * This is the user's Close control for a task whose browser surface is
 * currently offscreen (a lane). Two properties are the load-bearing behavior
 * and are easy to silently regress:
 *   - it is explicitly project-scoped (.claude/rules/project-scoped-ipc.md):
 *     resolveProjectContext resolves the caller's projectId, and an
 *     unresolvable project returns false rather than throwing or falling
 *     back to the ambient currentProjectId;
 *   - it destroys only entries with kind 'lane' for the resolved
 *     (taskId, projectId) pair - a same-taskId 'pane' entry, or a lane
 *     belonging to a DIFFERENT project, must never be destroyed.
 *
 * Strategy mirrors browser-jar-ensure-handler.test.ts: capture ipcMain.handle
 * registrations via a mocked electron module, then invoke the captured
 * handler directly without a running Electron process.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const { capturedHandlers, fakeGetByTaskId, fakeDestroyLane } = vi.hoisted(() => {
  const capturedHandlers = new Map<string, (...args: unknown[]) => unknown>();
  const fakeGetByTaskId = vi.fn();
  const fakeDestroyLane = vi.fn();
  return { capturedHandlers, fakeGetByTaskId, fakeDestroyLane };
});

vi.mock('electron', () => ({
  app: {
    getVersion: vi.fn(() => '0.0.0'),
    getPath: vi.fn(() => '/mock/userData'),
  },
  ipcMain: {
    handle: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => {
      capturedHandlers.set(channel, handler);
    }),
    on: vi.fn(),
  },
  session: {
    fromPartition: vi.fn(),
  },
  Notification: { isSupported: vi.fn(() => false) },
  dialog: { showOpenDialog: vi.fn() },
  shell: { openPath: vi.fn(), openExternal: vi.fn() },
}));

vi.mock('../../src/main/browser/browser-url-store', () => ({
  browserUrlStore: {
    get: vi.fn(() => null),
    set: vi.fn(),
    clear: vi.fn(),
  },
}));

vi.mock('../../src/main/browser/browser-pane-registry', () => ({
  browserPaneRegistry: {
    register: vi.fn(),
    unregister: vi.fn(),
    unregisterByWebContentsId: vi.fn(),
    setVisibility: vi.fn(),
    getByTaskId: fakeGetByTaskId,
    // registerBrowserHandlers installs the lane hand-off, which subscribes to
    // both registry callbacks. Omitting them makes every test in this file
    // throw at registration time, before it reaches its own subject.
    setPaneClosedHandler: vi.fn(),
    setPaneRegisteredHandler: vi.fn(),
  },
}));

// destroyLane is the only lane-manager export this handler calls. laneTaskIds
// and setLaneChangeListener are stubbed only so registration (which calls
// setLaneChangeListener unconditionally) does not throw.
vi.mock('../../src/main/browser/browser-lane-manager', () => ({
  destroyLane: fakeDestroyLane,
  laneTaskIds: vi.fn(() => []),
  setLaneChangeListener: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Import under test (must come after all vi.mock() calls)
// ---------------------------------------------------------------------------

import { registerBrowserHandlers } from '../../src/main/ipc/handlers/browser';

// ---------------------------------------------------------------------------
// Fixtures and helpers
// ---------------------------------------------------------------------------

const TASK_ID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const CURRENT_PROJECT_ID = 'proj-close-current';
const CURRENT_PROJECT_PATH = '/mock/browser-close-current';
const OTHER_PROJECT_ID = 'proj-close-other';
const OTHER_PROJECT_PATH = '/mock/browser-close-other';

function makeContext(opts: {
  currentProjectId?: string | null;
  currentProjectPath?: string | null;
  getByIdResult?: { path: string } | undefined;
} = {}) {
  const getById = vi.fn(() => opts.getByIdResult);
  return {
    // 'currentProjectId' in opts, not `?? CURRENT_PROJECT_ID`: an explicit
    // null in opts (the "no project open" case) must not be coalesced back
    // to the default project.
    currentProjectId: 'currentProjectId' in opts ? opts.currentProjectId : CURRENT_PROJECT_ID,
    currentProjectPath: 'currentProjectPath' in opts ? opts.currentProjectPath : CURRENT_PROJECT_PATH,
    configManager: { loadProjectOverrides: vi.fn(() => null) },
    projectRepo: { getById },
    sessionManager: {
      getSessionProjectId: vi.fn(() => undefined),
      hasLiveSessionForTask: vi.fn(() => false),
    },
  };
}

async function invokeOffscreenClose(taskId: string, projectId?: string | null): Promise<unknown> {
  const handler = capturedHandlers.get('browser:offscreenClose');
  if (!handler) throw new Error('browser:offscreenClose handler not registered');
  return handler(undefined, taskId, projectId);
}

function laneEntry(overrides: Partial<{ sessionId: string; kind: string; projectId: string | null }> = {}) {
  return {
    sessionId: 'lane_aaaaaaaa',
    ownerSessionId: null,
    taskId: TASK_ID,
    projectId: CURRENT_PROJECT_ID,
    webContentsId: 1,
    url: 'http://localhost:3000',
    registeredAt: Date.now(),
    kind: 'lane',
    widgetSize: null,
    visibility: 'offscreen',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('BROWSER_OFFSCREEN_CLOSE IPC handler', () => {
  beforeEach(() => {
    capturedHandlers.clear();
    fakeGetByTaskId.mockReset();
    fakeDestroyLane.mockReset();
    fakeGetByTaskId.mockReturnValue([]);
    fakeDestroyLane.mockReturnValue(true);
  });

  it('returns false without querying the registry when the project does not resolve', async () => {
    const context = makeContext({ currentProjectId: null, currentProjectPath: null });
    registerBrowserHandlers(context as unknown as Parameters<typeof registerBrowserHandlers>[0]);

    const result = await invokeOffscreenClose(TASK_ID);

    expect(result).toBe(false);
    expect(fakeGetByTaskId).not.toHaveBeenCalled();
    expect(fakeDestroyLane).not.toHaveBeenCalled();
  });

  it('queries the registry scoped to the resolved project, not merely by taskId', async () => {
    const context = makeContext();
    registerBrowserHandlers(context as unknown as Parameters<typeof registerBrowserHandlers>[0]);

    await invokeOffscreenClose(TASK_ID, CURRENT_PROJECT_ID);

    expect(fakeGetByTaskId).toHaveBeenCalledWith(TASK_ID, CURRENT_PROJECT_ID);
  });

  it('an explicit projectId for a DIFFERENT project scopes the query to that project, not the ambient one', async () => {
    const context = makeContext({ getByIdResult: { path: OTHER_PROJECT_PATH } });
    registerBrowserHandlers(context as unknown as Parameters<typeof registerBrowserHandlers>[0]);

    await invokeOffscreenClose(TASK_ID, OTHER_PROJECT_ID);

    expect(fakeGetByTaskId).toHaveBeenCalledWith(TASK_ID, OTHER_PROJECT_ID);
    expect(fakeGetByTaskId).not.toHaveBeenCalledWith(TASK_ID, CURRENT_PROJECT_ID);
  });

  it('destroys a lane entry and returns true', async () => {
    const context = makeContext();
    registerBrowserHandlers(context as unknown as Parameters<typeof registerBrowserHandlers>[0]);
    fakeGetByTaskId.mockReturnValue([laneEntry()]);

    const result = await invokeOffscreenClose(TASK_ID, CURRENT_PROJECT_ID);

    expect(fakeDestroyLane).toHaveBeenCalledWith('lane_aaaaaaaa');
    expect(result).toBe(true);
  });

  it('never destroys a pane entry for the same task', async () => {
    const context = makeContext();
    registerBrowserHandlers(context as unknown as Parameters<typeof registerBrowserHandlers>[0]);
    fakeGetByTaskId.mockReturnValue([
      laneEntry({ sessionId: 'pane_bbbbbbbb', kind: 'pane' }),
    ]);

    const result = await invokeOffscreenClose(TASK_ID, CURRENT_PROJECT_ID);

    expect(fakeDestroyLane).not.toHaveBeenCalled();
    expect(result).toBe(false);
  });

  it('destroys every lane entry the registry returns for the task, ignoring pane entries mixed in', async () => {
    const context = makeContext();
    registerBrowserHandlers(context as unknown as Parameters<typeof registerBrowserHandlers>[0]);
    fakeGetByTaskId.mockReturnValue([
      laneEntry({ sessionId: 'lane_first' }),
      laneEntry({ sessionId: 'pane_ignored', kind: 'pane' }),
      laneEntry({ sessionId: 'lane_second' }),
    ]);

    const result = await invokeOffscreenClose(TASK_ID, CURRENT_PROJECT_ID);

    expect(fakeDestroyLane).toHaveBeenCalledTimes(2);
    expect(fakeDestroyLane).toHaveBeenCalledWith('lane_first');
    expect(fakeDestroyLane).toHaveBeenCalledWith('lane_second');
    expect(fakeDestroyLane).not.toHaveBeenCalledWith('pane_ignored');
    expect(result).toBe(true);
  });

  it('returns false when a lane entry exists but destroyLane reports nothing was closed', async () => {
    const context = makeContext();
    registerBrowserHandlers(context as unknown as Parameters<typeof registerBrowserHandlers>[0]);
    fakeGetByTaskId.mockReturnValue([laneEntry()]);
    fakeDestroyLane.mockReturnValue(false);

    const result = await invokeOffscreenClose(TASK_ID, CURRENT_PROJECT_ID);

    expect(result).toBe(false);
  });
});
