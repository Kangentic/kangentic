/**
 * The Browser pane's reason (src/main/browser/browser-pane-reason.ts) ends with
 * the surface it described. Two IPC handlers in src/main/ipc/handlers/browser.ts
 * are the user's ways to close one:
 *
 * - BROWSER_PANE_USER_CLOSE (Close browser on a pane) clears the reason of the
 *   guest's OWNER, before the registry forgets the guest. After it the owner
 *   key can no longer be found, so a reason left behind would sit unreachable
 *   and reappear on the next pane the agent drives.
 * - BROWSER_OFFSCREEN_CLOSE (the task menu's Close of an offscreen surface)
 *   clears it only when a lane was actually destroyed.
 *
 * Harness mirrors browser-offscreen-close-handler.test.ts: capture the
 * ipcMain.handle registrations and call them directly. The reason store is the
 * real module.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const hoisted = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  ownerKeyForWebContents: vi.fn(),
  unregisterByWebContentsId: vi.fn(),
  getByTaskId: vi.fn(),
  destroyLane: vi.fn(),
}));

vi.mock('electron', () => ({
  app: { getVersion: vi.fn(() => '0.0.0'), getPath: vi.fn(() => '/mock/userData') },
  ipcMain: {
    handle: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => {
      hoisted.handlers.set(channel, handler);
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
    // The crashed-surfaces push re-reads the map on every membership change.
    onMembershipChange: vi.fn(),
    register: vi.fn(),
    unregister: vi.fn(),
    unregisterByWebContentsId: hoisted.unregisterByWebContentsId,
    ownerKeyForWebContents: hoisted.ownerKeyForWebContents,
    setVisibility: vi.fn(),
    getByTaskId: hoisted.getByTaskId,
    setPaneClosedHandler: vi.fn(),
    setPaneRegisteredHandler: vi.fn(),
  },
}));

vi.mock('../../src/main/browser/browser-lane-manager', () => ({
  destroyLane: hoisted.destroyLane,
  laneTaskIds: vi.fn(() => []),
  setLaneChangeListener: vi.fn(),
}));

import { registerBrowserHandlers } from '../../src/main/ipc/handlers/browser';
import { IPC } from '../../src/shared/ipc-channels';
import {
  setBrowserPaneReason,
  getBrowserPaneReason,
  clearAllBrowserPaneReasons,
} from '../../src/main/browser/browser-pane-reason';

const PROJECT_ID = 'proj-reason';
const OWNER = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const OTHER_OWNER = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';

function invoke(channel: string, ...args: unknown[]): unknown {
  const handler = hoisted.handlers.get(channel);
  if (!handler) throw new Error(`No handler registered for ${channel}`);
  return handler({}, ...args);
}

function giveReason(ownerKey: string): void {
  setBrowserPaneReason(ownerKey, { purpose: 'for-user', reason: 'showing the app', sessionId: 'sess-a' });
}

describe('closing a Browser surface forgets the agent\'s reason', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    hoisted.handlers.clear();
    clearAllBrowserPaneReasons();
    hoisted.getByTaskId.mockReturnValue([]);
    hoisted.destroyLane.mockReturnValue(true);
    registerBrowserHandlers({
      currentProjectId: PROJECT_ID,
      currentProjectPath: '/mock/browser-reason',
      configManager: { loadProjectOverrides: vi.fn(() => null) },
      projectRepo: { getById: vi.fn(() => undefined) },
      mainWindow: { isDestroyed: () => false },
      sessionManager: {
        getSessionProjectId: vi.fn(() => undefined),
        hasLiveSessionForTask: vi.fn(() => false),
        on: vi.fn(),
      },
    } as never);
  });

  describe('BROWSER_PANE_USER_CLOSE', () => {
    it("clears the reason of the closed guest's owner, and only that owner's, before the guest is unregistered", () => {
      giveReason(OWNER);
      giveReason(OTHER_OWNER);
      hoisted.ownerKeyForWebContents.mockReturnValue(OWNER);
      let reasonWhenUnregistered: unknown = 'not called';
      hoisted.unregisterByWebContentsId.mockImplementation(() => {
        reasonWhenUnregistered = getBrowserPaneReason(OWNER);
      });

      invoke(IPC.BROWSER_PANE_USER_CLOSE, 42);

      expect(hoisted.ownerKeyForWebContents).toHaveBeenCalledWith(42);
      expect(getBrowserPaneReason(OWNER)).toBeNull();
      expect(getBrowserPaneReason(OTHER_OWNER)).not.toBeNull();
      expect(reasonWhenUnregistered).toBeNull();
      expect(hoisted.unregisterByWebContentsId).toHaveBeenCalledWith(42, 'user-closed');
    });

    it('clears nothing for a guest no surface registered', () => {
      giveReason(OWNER);
      hoisted.ownerKeyForWebContents.mockReturnValue(null);

      invoke(IPC.BROWSER_PANE_USER_CLOSE, 42);

      expect(getBrowserPaneReason(OWNER)).not.toBeNull();
    });

    it.each([
      ['a non-integer', 1.5],
      ['zero', 0],
      ['a negative id', -3],
      ['a string', '42'],
      ['undefined', undefined],
    ])('refuses %s without looking the owner up or clearing anything', (_name, invalidId) => {
      giveReason(OWNER);
      hoisted.ownerKeyForWebContents.mockReturnValue(OWNER);

      invoke(IPC.BROWSER_PANE_USER_CLOSE, invalidId);

      expect(hoisted.ownerKeyForWebContents).not.toHaveBeenCalled();
      expect(hoisted.unregisterByWebContentsId).not.toHaveBeenCalled();
      expect(getBrowserPaneReason(OWNER)).not.toBeNull();
    });
  });

  describe('BROWSER_OFFSCREEN_CLOSE', () => {
    function lane(): Record<string, unknown> {
      return { sessionId: 'lane_aaaaaaaa', taskId: OWNER, projectId: PROJECT_ID, kind: 'lane' };
    }

    it('clears the task\'s reason when a lane was closed', async () => {
      giveReason(OWNER);
      hoisted.getByTaskId.mockReturnValue([lane()]);

      const result = await invoke(IPC.BROWSER_OFFSCREEN_CLOSE, OWNER, PROJECT_ID);

      expect(result).toBe(true);
      expect(getBrowserPaneReason(OWNER)).toBeNull();
    });

    it('keeps the reason when nothing was closed (no lane for the task)', async () => {
      giveReason(OWNER);
      hoisted.getByTaskId.mockReturnValue([{ ...lane(), sessionId: 'pane_bbbbbbbb', kind: 'pane' }]);

      const result = await invoke(IPC.BROWSER_OFFSCREEN_CLOSE, OWNER, PROJECT_ID);

      expect(result).toBe(false);
      expect(hoisted.destroyLane).not.toHaveBeenCalled();
      expect(getBrowserPaneReason(OWNER)).not.toBeNull();
    });

    it('keeps the reason when the lane reports it was not destroyed', async () => {
      giveReason(OWNER);
      hoisted.getByTaskId.mockReturnValue([lane()]);
      hoisted.destroyLane.mockReturnValue(false);

      const result = await invoke(IPC.BROWSER_OFFSCREEN_CLOSE, OWNER, PROJECT_ID);

      expect(result).toBe(false);
      expect(getBrowserPaneReason(OWNER)).not.toBeNull();
    });
  });
});
