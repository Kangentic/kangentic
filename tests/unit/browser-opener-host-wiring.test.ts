/**
 * The detached-window half of the pane opener host that `registerBrowserHandlers`
 * installs in src/main/ipc/handlers/browser.ts.
 *
 * `closePanes` (and through it `kangentic_browser_close_pane`) reaches a task's
 * detached Browser window only through two host callbacks, and
 * browser-pane-opener.test.ts stubs both, so nothing else proves the real ones
 * ask the right window manager question. Three properties matter:
 *   - both address the BROWSER pop-out of the explicit (projectId, taskId) they
 *     are handed, never another surface kind and never the ambient project;
 *   - `closeDetachedWindow` reports false, without closing, when no window is
 *     open, so `closePanes` does not list a window it never closed;
 *   - it reports true only after it actually asked for the close.
 *
 * Strategy mirrors browser-offscreen-close-handler.test.ts: mock electron and the
 * collaborators, register the handlers against a fake context, and read the host
 * back out through the opener's `setBrowserPaneOpenerHost` seam.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { BrowserPaneOpenerHost } from '../../src/main/browser/browser-pane-opener';

const { openerHost, popOutHas, popOutClose } = vi.hoisted(() => ({
  openerHost: { read: null as (() => BrowserPaneOpenerHost | null) | null },
  popOutHas: vi.fn(),
  popOutClose: vi.fn(),
}));

vi.mock('electron', () => ({
  app: {
    getVersion: vi.fn(() => '0.0.0'),
    getPath: vi.fn(() => '/mock/userData'),
  },
  ipcMain: { handle: vi.fn(), on: vi.fn() },
  session: { fromPartition: vi.fn() },
  webContents: { fromId: vi.fn() },
  Notification: { isSupported: vi.fn(() => false) },
  dialog: { showOpenDialog: vi.fn() },
  shell: { openPath: vi.fn(), openExternal: vi.fn() },
}));

// The opener is the seam: capture the reader the handlers install instead of
// running the opener, which has its own suite.
vi.mock('../../src/main/browser/browser-pane-opener', () => ({
  setBrowserPaneOpenerHost: (reader: () => BrowserPaneOpenerHost | null) => {
    openerHost.read = reader;
  },
  offscreenSurfaceUrl: vi.fn(() => null),
}));

vi.mock('../../src/main/pop-out/pop-out-window-manager', () => ({
  popOutWindowManager: {
    has: (...args: unknown[]) => popOutHas(...args),
    close: (...args: unknown[]) => popOutClose(...args),
  },
}));

vi.mock('../../src/main/pop-out/window-broadcast', () => ({ broadcast: vi.fn() }));
vi.mock('../../src/main/browser/browser-url-store', () => ({
  browserUrlStore: { get: vi.fn(() => null), set: vi.fn(), clear: vi.fn() },
}));
vi.mock('../../src/main/browser/browser-pane-registry', () => ({
  browserPaneRegistry: {
    register: vi.fn(),
    unregisterByWebContentsId: vi.fn(),
    setVisibility: vi.fn(),
    getByTaskId: vi.fn(() => []),
  },
}));
vi.mock('../../src/main/browser/browser-lane-handoff', () => ({ installLaneHandoff: vi.fn() }));
vi.mock('../../src/main/browser/browser-lane-manager', () => ({
  destroyLane: vi.fn(),
  laneTaskIds: vi.fn(() => []),
  setLaneChangeListener: vi.fn(),
}));

import { registerBrowserHandlers } from '../../src/main/ipc/handlers/browser';

/** An open project that is deliberately NOT the one the host is asked about. */
const AMBIENT_PROJECT_ID = 'proj-ambient';
const PROJECT_ID = 'proj-other';
const TASK_ID = 'task-9';

function installedHost(): BrowserPaneOpenerHost {
  const context = {
    currentProjectId: AMBIENT_PROJECT_ID,
    currentProjectPath: '/mock/browser-host-wiring',
    configManager: { loadProjectOverrides: vi.fn(() => null) },
    sessionManager: { hasLiveSessionForTask: vi.fn(() => false) },
    mainWindow: { isDestroyed: () => false, webContents: { send: vi.fn() } },
  };
  registerBrowserHandlers(context as unknown as Parameters<typeof registerBrowserHandlers>[0]);
  const host = openerHost.read?.();
  if (!host) throw new Error('registerBrowserHandlers did not install an opener host');
  return host;
}

describe('opener host detached-window wiring', () => {
  beforeEach(() => {
    openerHost.read = null;
    popOutHas.mockReset();
    popOutClose.mockReset();
  });

  describe('hasDetachedWindow', () => {
    it("asks the window manager about the task's browser window and relays the answer", () => {
      const host = installedHost();

      popOutHas.mockReturnValue(true);
      expect(host.hasDetachedWindow(PROJECT_ID, TASK_ID)).toBe(true);
      popOutHas.mockReturnValue(false);
      expect(host.hasDetachedWindow(PROJECT_ID, TASK_ID)).toBe(false);

      // The explicit ids, not the ambient project, and the browser surface kind.
      expect(popOutHas).toHaveBeenCalledWith('browser', { projectId: PROJECT_ID, taskId: TASK_ID });
      expect(popOutHas).not.toHaveBeenCalledWith('browser', { projectId: AMBIENT_PROJECT_ID, taskId: TASK_ID });
      expect(popOutClose).not.toHaveBeenCalled();
    });
  });

  describe('closeDetachedWindow', () => {
    it('closes the task browser window and reports true when one is open', () => {
      popOutHas.mockReturnValue(true);
      const host = installedHost();

      expect(host.closeDetachedWindow(PROJECT_ID, TASK_ID)).toBe(true);

      expect(popOutHas).toHaveBeenCalledWith('browser', { projectId: PROJECT_ID, taskId: TASK_ID });
      expect(popOutClose).toHaveBeenCalledTimes(1);
      expect(popOutClose).toHaveBeenCalledWith('browser', { projectId: PROJECT_ID, taskId: TASK_ID });
    });

    it('reports false and closes nothing when no window is open', () => {
      // closePanes lists a window as closed only when this returns true, so a
      // blind close here would report a window the call never touched.
      popOutHas.mockReturnValue(false);
      const host = installedHost();

      expect(host.closeDetachedWindow(PROJECT_ID, TASK_ID)).toBe(false);

      expect(popOutHas).toHaveBeenCalledWith('browser', { projectId: PROJECT_ID, taskId: TASK_ID });
      expect(popOutClose).not.toHaveBeenCalled();
    });
  });
});
