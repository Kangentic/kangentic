/**
 * Unit tests for the BROWSER_POP_OUT_NAVIGATE IPC handler in
 * src/main/ipc/handlers/browser.ts.
 *
 * This is the main-process end of a link click for a Browser pane that lives in
 * a window of its own. The relay's own logic is pinned in
 * pop-out-link-relay.test.ts; what only this file can lose is the WIRING: the
 * channel is registered, and the three untrusted renderer arguments reach the
 * relay in the order (projectId, ownerKey, url) and against the real pop-out
 * window manager. A dropped registration makes every popped-out link fall back
 * to the default browser (the renderer sees a rejected invoke), and a swapped
 * argument order looks up a window that never exists, with the same symptom.
 *
 * Strategy mirrors browser-offscreen-close-handler.test.ts: capture
 * ipcMain.handle registrations through a mocked electron module and invoke the
 * captured handler directly. The relay is the REAL one, over a fake window.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const { capturedHandlers, fakeWindowFor, fakeFocus } = vi.hoisted(() => ({
  capturedHandlers: new Map<string, (...args: unknown[]) => unknown>(),
  fakeWindowFor: vi.fn(),
  fakeFocus: vi.fn(),
}));

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
  session: { fromPartition: vi.fn() },
  Notification: { isSupported: vi.fn(() => false) },
  dialog: { showOpenDialog: vi.fn() },
  shell: { openPath: vi.fn(), openExternal: vi.fn() },
}));

vi.mock('../../src/main/browser/browser-url-store', () => ({
  browserUrlStore: { get: vi.fn(() => null), set: vi.fn(), clear: vi.fn() },
}));

vi.mock('../../src/main/browser/browser-pane-registry', () => ({
  browserPaneRegistry: {
    register: vi.fn(),
    unregister: vi.fn(),
    unregisterByWebContentsId: vi.fn(),
    setVisibility: vi.fn(),
    getByTaskId: vi.fn(() => []),
    // registerBrowserHandlers installs the lane hand-off, which subscribes to both callbacks.
    setPaneClosedHandler: vi.fn(),
    setPaneRegisteredHandler: vi.fn(),
  },
}));

vi.mock('../../src/main/browser/browser-lane-manager', () => ({
  destroyLane: vi.fn(),
  laneTaskIds: vi.fn(() => []),
  setLaneChangeListener: vi.fn(),
}));

vi.mock('../../src/main/pop-out/pop-out-window-manager', () => ({
  popOutWindowManager: { windowFor: fakeWindowFor, focus: fakeFocus },
}));

import { registerBrowserHandlers } from '../../src/main/ipc/handlers/browser';
import { IPC } from '../../src/shared/ipc-channels';

const PROJECT_ID = 'project-pop-out-handler';
const OWNER_KEY = 'task-pop-out-handler';
const URL_TEXT = 'http://localhost:5173/signup';

function makeContext() {
  return {
    currentProjectId: PROJECT_ID,
    currentProjectPath: '/mock/pop-out-handler',
    configManager: { loadProjectOverrides: vi.fn(() => null) },
    projectRepo: { getById: vi.fn(() => undefined) },
    sessionManager: {
      getSessionProjectId: vi.fn(() => undefined),
      hasLiveSessionForTask: vi.fn(() => false),
      on: vi.fn(),
    },
  };
}

function loadedWindow() {
  const contents = {
    isDestroyed: vi.fn(() => false),
    isLoadingMainFrame: vi.fn(() => false),
    once: vi.fn(),
    send: vi.fn(),
  };
  return { isDestroyed: vi.fn(() => false), webContents: contents };
}

function invokePopOutNavigate(...args: unknown[]): unknown {
  const handler = capturedHandlers.get(IPC.BROWSER_POP_OUT_NAVIGATE);
  if (!handler) throw new Error(`${IPC.BROWSER_POP_OUT_NAVIGATE} handler not registered`);
  return handler(undefined, ...args);
}

describe('BROWSER_POP_OUT_NAVIGATE IPC handler', () => {
  beforeEach(() => {
    capturedHandlers.clear();
    fakeWindowFor.mockReset();
    fakeFocus.mockReset();
    registerBrowserHandlers(makeContext() as unknown as Parameters<typeof registerBrowserHandlers>[0]);
  });

  it('is registered on the channel the preload invokes', () => {
    expect(IPC.BROWSER_POP_OUT_NAVIGATE).toBe('browser:popOutNavigate');
    expect(capturedHandlers.has('browser:popOutNavigate')).toBe(true);
  });

  it('looks the window up by (projectId, ownerKey) in that order, sends it the link, raises it and returns true', () => {
    const popOutWindow = loadedWindow();
    fakeWindowFor.mockReturnValue(popOutWindow);

    const result = invokePopOutNavigate(PROJECT_ID, OWNER_KEY, URL_TEXT);

    expect(result).toBe(true);
    expect(fakeWindowFor).toHaveBeenCalledExactlyOnceWith('browser', { projectId: PROJECT_ID, taskId: OWNER_KEY });
    expect(popOutWindow.webContents.send).toHaveBeenCalledExactlyOnceWith(IPC.BROWSER_NAVIGATE_REQUEST, OWNER_KEY, URL_TEXT);
    expect(fakeFocus).toHaveBeenCalledExactlyOnceWith('browser', { projectId: PROJECT_ID, taskId: OWNER_KEY });
  });

  it('returns false and sends nothing when no such window is open, so the renderer opens the default browser', () => {
    fakeWindowFor.mockReturnValue(null);

    expect(invokePopOutNavigate(PROJECT_ID, OWNER_KEY, URL_TEXT)).toBe(false);
    expect(fakeFocus).not.toHaveBeenCalled();
  });

  it('refuses malformed renderer arguments without touching the window manager', () => {
    expect(invokePopOutNavigate(undefined, OWNER_KEY, URL_TEXT)).toBe(false);
    expect(invokePopOutNavigate(PROJECT_ID, 42, URL_TEXT)).toBe(false);
    expect(invokePopOutNavigate(PROJECT_ID, OWNER_KEY, { href: URL_TEXT })).toBe(false);
    expect(invokePopOutNavigate()).toBe(false);
    expect(fakeWindowFor).not.toHaveBeenCalled();
  });

  it('refuses a non-http URL even for an open window', () => {
    fakeWindowFor.mockReturnValue(loadedWindow());

    expect(invokePopOutNavigate(PROJECT_ID, OWNER_KEY, 'file:///etc/hosts')).toBe(false);
    expect(fakeFocus).not.toHaveBeenCalled();
  });
});
