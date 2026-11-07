/**
 * The `detailIsOpen` reader of the pane opener host that `registerBrowserHandlers`
 * installs in src/main/ipc/handlers/browser.ts.
 *
 * The opener decides whether a live offscreen surface is reclaimed into a pane on
 * this answer, and browser-pane-opener.test.ts stubs it. This runs the REAL
 * reader against the REAL `detailOwnerRegistry` (only electron and the unrelated
 * collaborators are mocked), so a reader pointed at the wrong question, or
 * negated, fails here.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { BrowserPaneOpenerHost } from '../../src/main/browser/browser-pane-opener';

const { openerHost } = vi.hoisted(() => ({
  openerHost: { read: null as (() => BrowserPaneOpenerHost | null) | null },
}));

vi.mock('electron', () => ({
  app: {
    getVersion: vi.fn(() => '0.0.0'),
    getPath: vi.fn(() => '/mock/userData'),
  },
  ipcMain: { handle: vi.fn(), on: vi.fn() },
  session: { fromPartition: vi.fn() },
  webContents: { fromId: vi.fn() },
  BrowserWindow: { fromWebContents: vi.fn() },
  Notification: { isSupported: vi.fn(() => false) },
  dialog: { showOpenDialog: vi.fn() },
  shell: { openPath: vi.fn(), openExternal: vi.fn() },
}));

vi.mock('../../src/main/browser/browser-pane-opener', () => ({
  setBrowserPaneOpenerHost: (reader: () => BrowserPaneOpenerHost | null) => {
    openerHost.read = reader;
  },
  offscreenSurfaceUrl: vi.fn(() => null),
}));

vi.mock('../../src/main/pop-out/pop-out-window-manager', () => ({
  popOutWindowManager: { has: vi.fn(() => false), close: vi.fn() },
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
import { detailOwnerRegistry } from '../../src/main/ipc/handlers/task-detail-ownership';

const PROJECT_ID = 'proj-1';
const TASK_ID = 'task-1';
const OWNER_WEB_CONTENTS_ID = 7;

function installedHost(): BrowserPaneOpenerHost {
  const context = {
    currentProjectId: PROJECT_ID,
    currentProjectPath: '/mock/browser-host-detail-open',
    configManager: { loadProjectOverrides: vi.fn(() => null) },
    sessionManager: { hasLiveSessionForTask: vi.fn(() => false), on: vi.fn() },
    mainWindow: { isDestroyed: () => false, webContents: { send: vi.fn() } },
  };
  registerBrowserHandlers(context as unknown as Parameters<typeof registerBrowserHandlers>[0]);
  const host = openerHost.read?.();
  if (!host) throw new Error('registerBrowserHandlers did not install an opener host');
  return host;
}

describe('opener host detailIsOpen', () => {
  beforeEach(() => {
    openerHost.read = null;
  });

  afterEach(() => {
    // The registry is process-global: leave it empty for whatever runs next.
    detailOwnerRegistry.releaseAllFor(OWNER_WEB_CONTENTS_ID);
  });

  it('is false while no host reports the task, and true once one does', () => {
    const host = installedHost();
    expect(host.detailIsOpen(PROJECT_ID, TASK_ID)).toBe(false);

    detailOwnerRegistry.syncOwned(OWNER_WEB_CONTENTS_ID, 'board', [{ projectId: PROJECT_ID, taskId: TASK_ID }]);

    expect(host.detailIsOpen(PROJECT_ID, TASK_ID)).toBe(true);
  });

  it('answers per task and per project, never for another detail', () => {
    const host = installedHost();
    detailOwnerRegistry.syncOwned(OWNER_WEB_CONTENTS_ID, 'board', [{ projectId: PROJECT_ID, taskId: TASK_ID }]);

    expect(host.detailIsOpen(PROJECT_ID, 'task-other')).toBe(false);
    expect(host.detailIsOpen('proj-other', TASK_ID)).toBe(false);
  });

  it('goes false again once the owner reports an empty set', () => {
    const host = installedHost();
    detailOwnerRegistry.syncOwned(OWNER_WEB_CONTENTS_ID, 'board', [{ projectId: PROJECT_ID, taskId: TASK_ID }]);
    detailOwnerRegistry.syncOwned(OWNER_WEB_CONTENTS_ID, 'board', []);

    expect(host.detailIsOpen(PROJECT_ID, TASK_ID)).toBe(false);
  });
});
