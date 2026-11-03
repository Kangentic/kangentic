/**
 * BROWSER_COMMAND_TERMINAL_STATE_GET / _SET (src/main/ipc/handlers/browser.ts).
 *
 * The slot is a `slot-N` id main allocates, never any string the renderer
 * sends, and a save lands only for a slot with a live terminal, so a late save
 * after a terminal's end cannot recreate the entry the end cleared.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const hoisted = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  store: { get: vi.fn(), set: vi.fn(), clear: vi.fn() },
}));

vi.mock('electron', () => ({
  app: { getPath: vi.fn(() => '/tmp/app-data'), isPackaged: false },
  session: { fromPartition: vi.fn() },
  webContents: { fromId: vi.fn(), getAllWebContents: vi.fn(() => []) },
  ipcMain: {
    handle: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => {
      hoisted.handlers.set(channel, handler);
    }),
    on: vi.fn(),
  },
}));

vi.mock('../../src/main/browser/command-terminal-browser-store', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../src/main/browser/command-terminal-browser-store')>();
  return { ...original, commandTerminalBrowserStore: hoisted.store };
});

import { registerBrowserHandlers } from '../../src/main/ipc/handlers/browser';
import { IPC } from '../../src/shared/ipc-channels';

const PROJECT_ID = 'proj-1';
const PROJECT_PATH = '/projects/app';

function invoke(channel: string, ...args: unknown[]): unknown {
  const handler = hoisted.handlers.get(channel);
  if (!handler) throw new Error(`No handler registered for ${channel}`);
  return handler({}, ...args);
}

describe('Command Terminal browser state handlers', () => {
  let findLive: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    hoisted.handlers.clear();
    findLive = vi.fn(() => ({ id: 'live-terminal' }));
    const context = {
      currentProjectId: PROJECT_ID,
      currentProjectPath: PROJECT_PATH,
      projectRepo: { getById: vi.fn(() => undefined) },
      configManager: { loadProjectOverrides: vi.fn(() => null) },
      mainWindow: { isDestroyed: () => false },
      sessionManager: {
        on: vi.fn(),
        findLiveCommandTerminalSession: findLive,
        hasLiveSessionForTask: vi.fn(() => false),
      },
    };
    registerBrowserHandlers(context as never);
  });

  describe('SET', () => {
    it('saves the narrowed state for a live terminal in a valid slot', () => {
      invoke(IPC.BROWSER_COMMAND_TERMINAL_STATE_SET, PROJECT_ID, 'slot-2', { open: true, ratio: 0.4, junk: 'x' });

      expect(findLive).toHaveBeenCalledWith(PROJECT_ID, 'slot-2');
      expect(hoisted.store.set).toHaveBeenCalledWith(PROJECT_PATH, 'slot-2', { open: true, ratio: 0.4 });
    });

    it.each([
      ['a prototype key', '__proto__'],
      ['a slot past the cap', 'slot-99'],
      ['a zero-padded slot', 'slot-01'],
      ['slot-0', 'slot-0'],
      ['an empty slot', ''],
      ['a non-string slot', 7],
    ])('refuses %s', (_name, slot) => {
      invoke(IPC.BROWSER_COMMAND_TERMINAL_STATE_SET, PROJECT_ID, slot, { open: true });
      expect(hoisted.store.set).not.toHaveBeenCalled();
    });

    it.each([
      ['null', null],
      ['a string', 'open'],
      ['an object with no boolean open', { open: 'yes' }],
    ])('refuses a malformed state (%s)', (_name, state) => {
      invoke(IPC.BROWSER_COMMAND_TERMINAL_STATE_SET, PROJECT_ID, 'slot-2', state);
      expect(hoisted.store.set).not.toHaveBeenCalled();
    });

    it('refuses an empty or non-string project id', () => {
      invoke(IPC.BROWSER_COMMAND_TERMINAL_STATE_SET, '', 'slot-2', { open: true });
      invoke(IPC.BROWSER_COMMAND_TERMINAL_STATE_SET, undefined, 'slot-2', { open: true });
      expect(hoisted.store.set).not.toHaveBeenCalled();
    });

    it('refuses a slot with no live terminal, so a late save cannot recreate a cleared entry', () => {
      findLive.mockReturnValue(undefined);
      invoke(IPC.BROWSER_COMMAND_TERMINAL_STATE_SET, PROJECT_ID, 'slot-2', { open: false });
      expect(hoisted.store.set).not.toHaveBeenCalled();
    });

    it('refuses when the live lookup throws', () => {
      findLive.mockImplementation(() => {
        throw new Error('registry unavailable');
      });
      invoke(IPC.BROWSER_COMMAND_TERMINAL_STATE_SET, PROJECT_ID, 'slot-2', { open: true });
      expect(hoisted.store.set).not.toHaveBeenCalled();
    });
  });

  describe('GET', () => {
    it('reads the saved state for a valid slot', () => {
      hoisted.store.get.mockReturnValue({ open: true });
      expect(invoke(IPC.BROWSER_COMMAND_TERMINAL_STATE_GET, PROJECT_ID, 'slot-4')).toEqual({ open: true });
      expect(hoisted.store.get).toHaveBeenCalledWith(PROJECT_PATH, 'slot-4');
    });

    it.each([
      ['a prototype key', '__proto__'],
      ['a slot past the cap', 'slot-99'],
      ['a zero-padded slot', 'slot-01'],
    ])('returns null without reading for %s', (_name, slot) => {
      expect(invoke(IPC.BROWSER_COMMAND_TERMINAL_STATE_GET, PROJECT_ID, slot)).toBeNull();
      expect(hoisted.store.get).not.toHaveBeenCalled();
    });
  });
});
