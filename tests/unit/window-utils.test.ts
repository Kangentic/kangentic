/**
 * Unit tests for resolvePopOutBounds / savePopOutBounds / resolveIconPath in
 * src/main/window-utils.ts.
 *
 * resolvePopOutBounds / savePopOutBounds are the pop-out window engine's bounds-persistence
 * pair (mirrors resolveWindowBounds / the main window's saveBounds, but keyed per PopOutKind
 * and read-merge-write so a save for one kind never clobbers a sibling kind's saved bounds).
 * These lock the behavior the pop-out engine introduced: reverting either function to a stub,
 * or dropping the read-merge-write sibling preservation in savePopOutBounds, must fail these
 * tests.
 *
 * resolveIconPath locks the @kangentic/branding desktop-icon migration's dev (unpackaged)
 * path.join segment order: reverting it to the old local resources/ layout, or scrambling the
 * segment order/count, must fail the dedicated test below.
 *
 * fs.readFileSync, PATHS.configFile, and electron's screen/app APIs are all mocked so the
 * suite is pure Node -- no real file writes, no real Electron, no OS-specific paths.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import path from 'node:path';
import type { AppConfig } from '../../src/shared/types';
import type { ConfigManager } from '../../src/main/config/config-manager';
import type { BrowserWindow } from 'electron';

vi.mock('node:fs', () => ({
  default: { readFileSync: vi.fn() },
}));
vi.mock('../../src/main/config/paths', () => ({
  PATHS: { configFile: '/mock/kangentic/config.json' },
}));
vi.mock('electron', () => ({
  app: { isPackaged: false, getAppPath: vi.fn(() => '/mock/app') },
  screen: {
    getAllDisplays: vi.fn(),
    getDisplayMatching: vi.fn(),
  },
}));

import fs from 'node:fs';
import { screen } from 'electron';
import { resolveIconPath, resolvePopOutBounds, savePopOutBounds } from '../../src/main/window-utils';

interface FakeDisplay {
  id: number;
  bounds: { x: number; y: number; width: number; height: number };
}

const PRIMARY_DISPLAY: FakeDisplay = { id: 1, bounds: { x: 0, y: 0, width: 1920, height: 1080 } };

function mockConfigFile(config: Partial<AppConfig>): void {
  vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(config) as unknown as ReturnType<typeof fs.readFileSync>);
}

function mockDisplays(...displays: FakeDisplay[]): void {
  vi.mocked(screen.getAllDisplays).mockReturnValue(displays as unknown as ReturnType<typeof screen.getAllDisplays>);
}

describe('resolvePopOutBounds', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDisplays(PRIMARY_DISPLAY);
  });

  it('returns null when restoreWindowPosition is false', () => {
    mockConfigFile({
      restoreWindowPosition: false,
      popOutBounds: {
        changes: { bounds: { x: 100, y: 100, width: 1000, height: 750 }, displayId: 1, maximized: false },
      },
    });
    expect(resolvePopOutBounds('changes')).toBeNull();
  });

  it('returns null when there is no saved entry for this kind', () => {
    mockConfigFile({ restoreWindowPosition: true, popOutBounds: {} });
    expect(resolvePopOutBounds('changes')).toBeNull();
  });

  it('returns null when the saved width is below the 320px floor', () => {
    mockConfigFile({
      restoreWindowPosition: true,
      popOutBounds: {
        changes: { bounds: { x: 100, y: 100, width: 300, height: 750 }, displayId: 1, maximized: false },
      },
    });
    expect(resolvePopOutBounds('changes')).toBeNull();
  });

  it('returns null when the saved height is below the 240px floor', () => {
    mockConfigFile({
      restoreWindowPosition: true,
      popOutBounds: {
        changes: { bounds: { x: 100, y: 100, width: 1000, height: 200 }, displayId: 1, maximized: false },
      },
    });
    expect(resolvePopOutBounds('changes')).toBeNull();
  });

  it('returns null when the saved position overlaps no connected display', () => {
    mockConfigFile({
      restoreWindowPosition: true,
      // PRIMARY_DISPLAY only covers 0,0 - 1920,1080; this saved position is off-screen
      // (e.g. an external monitor that was disconnected since the last save).
      popOutBounds: {
        changes: { bounds: { x: 5000, y: 5000, width: 1000, height: 750 }, displayId: 1, maximized: false },
      },
    });
    expect(resolvePopOutBounds('changes')).toBeNull();
  });

  it('returns the saved bounds when the position overlaps a connected display', () => {
    mockConfigFile({
      restoreWindowPosition: true,
      popOutBounds: {
        changes: { bounds: { x: 100, y: 100, width: 1000, height: 750 }, displayId: 1, maximized: true },
      },
    });
    expect(resolvePopOutBounds('changes')).toEqual({ x: 100, y: 100, width: 1000, height: 750, maximized: true });
  });
});

interface FakeBrowserWindow {
  isDestroyed(): boolean;
  isMinimized(): boolean;
  isMaximized(): boolean;
  getBounds(): { x: number; y: number; width: number; height: number };
}

function fakeWin(overrides: Partial<FakeBrowserWindow> = {}): FakeBrowserWindow {
  return {
    isDestroyed: () => false,
    isMinimized: () => false,
    isMaximized: () => false,
    getBounds: () => ({ x: 200, y: 300, width: 1000, height: 750 }),
    ...overrides,
  };
}

function fakeConfigManager(popOutBounds: AppConfig['popOutBounds']): {
  load: () => Partial<AppConfig>;
  save: ReturnType<typeof vi.fn<(partial: Partial<AppConfig>) => void>>;
} {
  return {
    load: () => ({ popOutBounds }),
    save: vi.fn<(partial: Partial<AppConfig>) => void>(),
  };
}

describe('savePopOutBounds', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(screen.getDisplayMatching).mockReturnValue(
      { id: 7, bounds: { x: 0, y: 0, width: 1920, height: 1080 } } as unknown as ReturnType<typeof screen.getDisplayMatching>,
    );
  });

  it('does not save when the window is destroyed', () => {
    const win = fakeWin({ isDestroyed: () => true });
    const configManager = fakeConfigManager({});
    savePopOutBounds('changes', win as unknown as BrowserWindow, configManager as unknown as ConfigManager);
    expect(configManager.save).not.toHaveBeenCalled();
  });

  it('does not save when the window is minimized', () => {
    const win = fakeWin({ isMinimized: () => true });
    const configManager = fakeConfigManager({});
    savePopOutBounds('changes', win as unknown as BrowserWindow, configManager as unknown as ConfigManager);
    expect(configManager.save).not.toHaveBeenCalled();
  });

  it('maximized save is a no-op when there is no prior bounds entry for this kind', () => {
    const win = fakeWin({ isMaximized: () => true });
    const configManager = fakeConfigManager({}); // no 'changes' entry to flip yet
    savePopOutBounds('changes', win as unknown as BrowserWindow, configManager as unknown as ConfigManager);
    expect(configManager.save).not.toHaveBeenCalled();
  });

  it('maximized save flips only maximized, keeping the prior bounds/displayId, and preserves a sibling kind', () => {
    const previousChanges = { bounds: { x: 5, y: 5, width: 1000, height: 750 }, displayId: 1, maximized: false };
    const previousStats = { bounds: { x: 50, y: 50, width: 1100, height: 800 }, displayId: 2, maximized: false };
    const win = fakeWin({ isMaximized: () => true });
    const configManager = fakeConfigManager({ changes: previousChanges, stats: previousStats });

    savePopOutBounds('changes', win as unknown as BrowserWindow, configManager as unknown as ConfigManager);

    expect(configManager.save).toHaveBeenCalledTimes(1);
    const savedConfig = configManager.save.mock.calls[0][0];
    expect(savedConfig.popOutBounds?.changes).toEqual({ ...previousChanges, maximized: true });
    expect(savedConfig.popOutBounds?.stats).toEqual(previousStats); // sibling untouched
  });

  it('non-maximized save writes fresh bounds/displayId from the window and preserves a sibling kind (read-merge-write)', () => {
    const previousStats = { bounds: { x: 50, y: 50, width: 1100, height: 800 }, displayId: 2, maximized: false };
    const win = fakeWin({ getBounds: () => ({ x: 200, y: 300, width: 1000, height: 750 }) });
    const configManager = fakeConfigManager({ stats: previousStats }); // 'changes' has no prior entry

    savePopOutBounds('changes', win as unknown as BrowserWindow, configManager as unknown as ConfigManager);

    expect(configManager.save).toHaveBeenCalledTimes(1);
    const savedConfig = configManager.save.mock.calls[0][0];
    expect(savedConfig.popOutBounds?.changes).toEqual({
      bounds: { x: 200, y: 300, width: 1000, height: 750 },
      displayId: 7,
      maximized: false,
    });
    // Highest-value assertion: a save for 'changes' must not drop the sibling 'stats'
    // entry (read-merge-write), regardless of AppConfig's dictionary merge semantics.
    expect(savedConfig.popOutBounds?.stats).toEqual(previousStats);
  });
});

describe('resolveIconPath', () => {
  // Derived from process.platform (not hardcoded) so this passes on both local Windows and
  // CI's headless Linux runner, per cross-platform-parity.
  const expectedIconFilename = process.platform === 'win32' ? 'icon.ico' : 'icon.png';

  it('dev (unpackaged) resolves to the @kangentic/branding desktop icon for this platform', () => {
    // The mocked electron.app has isPackaged: false and getAppPath() -> '/mock/app'.
    const expectedPath = path.join(
      '/mock/app',
      'node_modules',
      '@kangentic',
      'branding',
      'resources',
      'desktop',
      expectedIconFilename,
    );
    expect(resolveIconPath()).toBe(expectedPath);
  });
});
