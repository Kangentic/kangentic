/**
 * The crashed-surfaces map and its push (task #1226), in
 * src/main/ipc/handlers/browser.ts.
 *
 * What a user loses if it goes: the Browser pill's badge and the card globes stop turning
 * red for a page that stopped in an offscreen lane or a pop-out, or turn red under the
 * wrong owner, or the push floods every window on each pane register.
 *
 * Real `guest-crash-state` runs here. On main's side only the registry (its entries and its
 * membership subscription) and `broadcast` are doubles, so a crash is driven the way Electron
 * drives it: a `render-process-gone` event on a tracked guest. The last describe also loads the
 * real preload over a faked `contextBridge` and `ipcRenderer`, wired to main's handlers and
 * broadcast by channel name.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';

type RendererListener = (event: unknown, payload: unknown) => void;

const { registryEntries, membershipListeners, broadcastMock, rendererListeners, exposeInMainWorldMock, rendererInvokeMock } = vi.hoisted(() => ({
  registryEntries: [] as Array<{ taskId: string; webContentsId: number }>,
  membershipListeners: [] as Array<() => void>,
  broadcastMock: vi.fn(),
  // The preload's side of the bridge, for the round trip at the end of this file.
  rendererListeners: new Map<string, Set<(event: unknown, payload: unknown) => void>>(),
  exposeInMainWorldMock: vi.fn(),
  rendererInvokeMock: vi.fn(),
}));

vi.mock('electron', () => ({
  app: {
    getVersion: vi.fn(() => '0.0.0'),
    getPath: vi.fn(() => '/mock/userData'),
  },
  ipcMain: {
    handle: vi.fn(),
    on: vi.fn(),
  },
  session: { fromPartition: vi.fn() },
  Notification: { isSupported: vi.fn(() => false) },
  dialog: { showOpenDialog: vi.fn() },
  shell: { openPath: vi.fn(), openExternal: vi.fn() },
  contextBridge: { exposeInMainWorld: exposeInMainWorldMock },
  ipcRenderer: {
    send: vi.fn(),
    invoke: rendererInvokeMock,
    on: (channel: string, listener: RendererListener) => {
      const listeners = rendererListeners.get(channel) ?? new Set<RendererListener>();
      listeners.add(listener);
      rendererListeners.set(channel, listeners);
    },
    removeListener: (channel: string, listener: RendererListener) => {
      rendererListeners.get(channel)?.delete(listener);
    },
  },
  webUtils: { getPathForFile: vi.fn() },
}));

// The preload registers window listeners at module scope.
vi.mock('../../src/preload/diagnostics/renderer-crash-capture', () => ({
  installRendererCrashCapture: vi.fn(),
  reportPushCallbackFailure: vi.fn(),
}));

vi.mock('../../src/main/browser/browser-url-store', () => ({
  browserUrlStore: { get: vi.fn(() => null), set: vi.fn(), clear: vi.fn() },
}));

vi.mock('../../src/main/browser/browser-pane-registry', () => ({
  browserPaneRegistry: {
    list: () => [...registryEntries],
    onMembershipChange: vi.fn((listener: () => void) => {
      membershipListeners.push(listener);
      return () => {};
    }),
    register: vi.fn(),
    unregister: vi.fn(),
    setPaneClosedHandler: vi.fn(),
    setPaneRegisteredHandler: vi.fn(),
  },
}));

vi.mock('../../src/main/browser/jar-seeder', () => ({
  syncJarFromIdentity: vi.fn(),
}));

vi.mock('../../src/main/pop-out/window-broadcast', () => ({
  broadcast: broadcastMock,
}));

import { crashedSurfaces, registerBrowserHandlers } from '../../src/main/ipc/handlers/browser';
import { setGuestCrashChangeListener, trackGuestCrash } from '../../src/main/browser/guest-crash-state';
import { IPC } from '../../src/shared/ipc-channels';
import { ipcMain } from 'electron';
import type { ElectronAPI } from '../../src/shared/types';

const TASK_ID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const OWNER_KEY = 'command-terminal::proj-1::slot-1';
const LIVE_TASK_ID = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';

/** A tracked guest double with real event wiring, as the guest-crash-state tests build one. */
function trackedGuest(id: number) {
  const events = new EventEmitter();
  const guest = {
    id,
    on: (name: string, listener: (...args: unknown[]) => void) => { events.on(name, listener); return guest; },
    once: (name: string, listener: (...args: unknown[]) => void) => { events.once(name, listener); return guest; },
    crash: (reason: string) => events.emit('render-process-gone', {}, { reason, exitCode: 1 }),
    revive: () => events.emit('dom-ready'),
    destroy: () => events.emit('destroyed'),
  };
  trackGuestCrash(guest as never);
  return guest;
}

function makeContext() {
  return {
    mainWindow: { isDestroyed: () => false },
    currentProjectPath: '/mock/project',
    currentProjectId: 'proj-1',
    configManager: { loadProjectOverrides: vi.fn(() => null) },
    sessionManager: { getSessionProjectId: vi.fn(() => undefined), on: vi.fn() },
  };
}

/** Every crashed-surfaces broadcast so far, as the map it carried. */
function crashedBroadcasts(): unknown[] {
  return broadcastMock.mock.calls
    .filter((call) => call[1] === IPC.BROWSER_CRASHED_SURFACES)
    .map((call) => call[2]);
}

/** The registry's membership listeners installed by the latest registerBrowserHandlers. */
function fireMembershipChange(): void {
  const latest = membershipListeners[membershipListeners.length - 1];
  if (!latest) throw new Error('registerBrowserHandlers did not subscribe to membership changes');
  latest();
}

describe('crashedSurfaces', () => {
  const guests: Array<ReturnType<typeof trackedGuest>> = [];

  afterEach(() => {
    for (const guest of guests.splice(0)) guest.destroy();
    registryEntries.length = 0;
  });

  it('maps each crashed owner to its kind and leaves a live surface out', () => {
    const taskGuest = trackedGuest(9101);
    const terminalGuest = trackedGuest(9102);
    const liveGuest = trackedGuest(9103);
    guests.push(taskGuest, terminalGuest, liveGuest);
    registryEntries.push(
      { taskId: TASK_ID, webContentsId: 9101 },
      { taskId: OWNER_KEY, webContentsId: 9102 },
      { taskId: LIVE_TASK_ID, webContentsId: 9103 },
    );
    taskGuest.crash('oom');
    terminalGuest.crash('killed');

    expect(crashedSurfaces()).toEqual({ [TASK_ID]: 'out-of-memory', [OWNER_KEY]: 'crashed' });
  });

  it('is empty when nothing crashed', () => {
    const liveGuest = trackedGuest(9104);
    guests.push(liveGuest);
    registryEntries.push({ taskId: TASK_ID, webContentsId: 9104 });
    expect(crashedSurfaces()).toEqual({});
  });
});

describe('the crashed-surfaces push', () => {
  const guests: Array<ReturnType<typeof trackedGuest>> = [];

  beforeEach(() => {
    broadcastMock.mockClear();
    membershipListeners.length = 0;
    registryEntries.length = 0;
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    registerBrowserHandlers(makeContext() as unknown as Parameters<typeof registerBrowserHandlers>[0]);
  });

  afterEach(() => {
    for (const guest of guests.splice(0)) guest.destroy();
    setGuestCrashChangeListener(null);
    registryEntries.length = 0;
    vi.restoreAllMocks();
  });

  it('broadcasts the map on a crash and again, empty, when the page loads again', () => {
    const guest = trackedGuest(9201);
    guests.push(guest);
    registryEntries.push({ taskId: TASK_ID, webContentsId: 9201 });

    guest.crash('oom');
    expect(crashedBroadcasts()).toEqual([{ [TASK_ID]: 'out-of-memory' }]);

    guest.revive();
    expect(crashedBroadcasts()).toEqual([{ [TASK_ID]: 'out-of-memory' }, {}]);
  });

  it('sends nothing for a membership change that leaves the map as it was', () => {
    const guest = trackedGuest(9202);
    guests.push(guest);
    registryEntries.push({ taskId: TASK_ID, webContentsId: 9202 });

    // Nothing crashed: the initial last-sent map is empty, so a register is silent.
    fireMembershipChange();
    expect(crashedBroadcasts()).toEqual([]);

    guest.crash('crashed');
    expect(crashedBroadcasts()).toHaveLength(1);

    // The same crashed map again, as every pane or lane register causes.
    fireMembershipChange();
    fireMembershipChange();
    expect(crashedBroadcasts()).toHaveLength(1);
  });

  it('sends the new map when a guest that crashed before its entry registered then registers', () => {
    const guest = trackedGuest(9203);
    guests.push(guest);

    // No registry entry yet, so the map is still empty and the crash itself sends nothing.
    guest.crash('oom');
    expect(crashedBroadcasts()).toEqual([]);

    registryEntries.push({ taskId: OWNER_KEY, webContentsId: 9203 });
    fireMembershipChange();
    expect(crashedBroadcasts()).toEqual([{ [OWNER_KEY]: 'out-of-memory' }]);
  });

  it('sends the empty map when the crashed surface leaves the registry', () => {
    const guest = trackedGuest(9204);
    guests.push(guest);
    registryEntries.push({ taskId: TASK_ID, webContentsId: 9204 });
    guest.crash('oom');
    expect(crashedBroadcasts()).toHaveLength(1);

    registryEntries.length = 0;
    fireMembershipChange();
    expect(crashedBroadcasts()).toEqual([{ [TASK_ID]: 'out-of-memory' }, {}]);
  });
});

/**
 * The map from main to a window, through the real preload (task #1226).
 *
 * What a user loses if it goes: every renderer test stubs `electronAPI`, so a preload that
 * listened or invoked on another channel, or a main that never answered the read, would leave
 * the marks green in the app with every other test passing. The read matters on its own: after
 * a window reload, an HMR update or a pop-out opening, a page that is still stopped is red only
 * because of it, since the push already went out.
 *
 * The renderer's invoke is routed to main's handler of the same channel, and main's broadcast
 * to the renderer's listeners of the same channel, so a mismatch on either side reads red.
 *
 * Red-green: drop the `BROWSER_CRASHED_SURFACES_GET` handler from browser.ts, or point the
 * preload's `onCrashedSurfaces` at another channel, and this test fails.
 */
describe('the crashed-surfaces map through the preload', () => {
  const guests: Array<ReturnType<typeof trackedGuest>> = [];

  /** The handler main registered last for a channel; registration runs before each test. */
  function mainHandler(channel: string): ((event: unknown, ...args: unknown[]) => unknown) | undefined {
    const registered = vi.mocked(ipcMain.handle).mock.calls.filter((call) => call[0] === channel).at(-1);
    return registered?.[1] as ((event: unknown, ...args: unknown[]) => unknown) | undefined;
  }

  async function exposedApi(): Promise<ElectronAPI> {
    await import('../../src/preload/preload');
    const exposure = exposeInMainWorldMock.mock.calls.find((call) => call[0] === 'electronAPI');
    if (!exposure) throw new Error('the preload never exposed window.electronAPI');
    return exposure[1] as ElectronAPI;
  }

  beforeEach(() => {
    broadcastMock.mockClear();
    membershipListeners.length = 0;
    registryEntries.length = 0;
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    registerBrowserHandlers(makeContext() as unknown as Parameters<typeof registerBrowserHandlers>[0]);
    rendererInvokeMock.mockImplementation(async (channel: string, ...args: unknown[]) => {
      const handler = mainHandler(channel);
      if (!handler) throw new Error(`main registered no handler for ${channel}`);
      return handler({}, ...args);
    });
    broadcastMock.mockImplementation((_window: unknown, channel: string, payload: unknown) => {
      for (const listener of rendererListeners.get(channel) ?? []) listener({}, payload);
    });
  });

  afterEach(() => {
    for (const guest of guests.splice(0)) guest.destroy();
    setGuestCrashChangeListener(null);
    registryEntries.length = 0;
    broadcastMock.mockReset();
    rendererInvokeMock.mockReset();
    vi.restoreAllMocks();
  });

  it('a window reads the map main holds, then hears each change until it unsubscribes', async () => {
    const api = await exposedApi();
    const guest = trackedGuest(9301);
    guests.push(guest);
    registryEntries.push({ taskId: OWNER_KEY, webContentsId: 9301 });
    // Stopped before the window subscribed: only the read can tell it.
    guest.crash('oom');

    await expect(api.browser.getCrashedSurfaces()).resolves.toEqual({ [OWNER_KEY]: 'out-of-memory' });

    const received: Array<Record<string, string>> = [];
    const unsubscribe = api.browser.onCrashedSurfaces((surfaces) => received.push(surfaces));
    guest.revive();
    expect(received).toEqual([{}]);

    unsubscribe();
    guest.crash('killed');
    expect(received).toEqual([{}]);
  });
});
