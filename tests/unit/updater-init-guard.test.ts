import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  electronMock: {
    app: { isPackaged: true },
    BrowserWindow: class {},
    ipcMain: { handle: vi.fn() },
  },
  autoUpdaterMock: {
    on: vi.fn(),
    checkForUpdates: vi.fn(),
    downloadUpdate: vi.fn(),
    quitAndInstall: vi.fn(),
    autoDownload: true,
    autoInstallOnAppQuit: false,
    disableDifferentialDownload: false,
  },
  trackEventMock: vi.fn(),
  existsSyncMock: vi.fn(),
}));

vi.mock('electron', () => mocks.electronMock);
vi.mock('electron-updater', () => ({ autoUpdater: mocks.autoUpdaterMock }));
vi.mock('../../src/main/analytics/analytics', () => ({
  trackEvent: mocks.trackEventMock,
  sanitizeErrorMessage: (input: string) => input,
}));
vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return { ...actual, existsSync: mocks.existsSyncMock };
});

import { initUpdater } from '../../src/main/updater';
import { IPC } from '../../src/shared/ipc-channels';

// Only populated on the full-wiring path (packaged + manifest present), where
// initUpdater assigns this window as `updaterWindow` and later sends the
// normalized update-downloaded payload through it.
const fakeWindowSend = vi.fn();
const fakeWindow = {
  isDestroyed: () => false,
  webContents: { send: fakeWindowSend },
} as unknown as Electron.BrowserWindow;

describe('initUpdater manifest guard', () => {
  const originalResourcesPath = process.resourcesPath;
  const originalPlatform = process.platform;

  beforeEach(() => {
    vi.useFakeTimers();
    Object.defineProperty(process, 'resourcesPath', {
      value: '/fake/resources',
      configurable: true,
    });
    // Pin the platform so CI (ubuntu) and a Windows dev host exercise the
    // same wiring path. Linux is no longer short-circuited (see the Linux
    // describe block below), but it does take a different autoInstallOnAppQuit
    // branch, so the shared cases must not depend on the host OS.
    Object.defineProperty(process, 'platform', {
      value: 'win32',
      configurable: true,
    });
    mocks.electronMock.app.isPackaged = true;
    mocks.electronMock.ipcMain.handle.mockReset();
    mocks.autoUpdaterMock.on.mockReset();
    mocks.autoUpdaterMock.checkForUpdates.mockReset();
    mocks.autoUpdaterMock.autoDownload = true;
    mocks.autoUpdaterMock.autoInstallOnAppQuit = false;
    mocks.autoUpdaterMock.disableDifferentialDownload = false;
    mocks.trackEventMock.mockReset();
    mocks.existsSyncMock.mockReset();
    fakeWindowSend.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
    Object.defineProperty(process, 'resourcesPath', {
      value: originalResourcesPath,
      configurable: true,
    });
    Object.defineProperty(process, 'platform', {
      value: originalPlatform,
      configurable: true,
    });
  });

  it('registers no-op IPC handlers and skips wiring when manifest is missing', () => {
    mocks.existsSyncMock.mockReturnValue(false);

    initUpdater(fakeWindow);

    const handlerCalls = mocks.electronMock.ipcMain.handle.mock.calls;
    const channels = handlerCalls.map((call) => call[0]);
    expect(channels).toEqual([IPC.UPDATE_CHECK, IPC.UPDATE_INSTALL]);
    for (const [, fn] of handlerCalls) {
      expect((fn as () => unknown)()).toBeUndefined();
    }

    expect(mocks.autoUpdaterMock.on).not.toHaveBeenCalled();
    expect(mocks.autoUpdaterMock.autoDownload).toBe(true);

    vi.advanceTimersByTime(60_000);
    expect(mocks.autoUpdaterMock.checkForUpdates).not.toHaveBeenCalled();

    expect(mocks.trackEventMock).toHaveBeenCalledTimes(1);
    expect(mocks.trackEventMock).toHaveBeenCalledWith('app_error', {
      source: 'updater',
      message: 'missing_manifest',
    });
  });

  it('runs full wiring when manifest is present', () => {
    mocks.existsSyncMock.mockReturnValue(true);

    initUpdater(fakeWindow);

    const onEvents = mocks.autoUpdaterMock.on.mock.calls.map((call) => call[0]).sort();
    expect(onEvents).toEqual(['error', 'update-available', 'update-downloaded']);

    expect(mocks.autoUpdaterMock.autoDownload).toBe(false);
    expect(mocks.autoUpdaterMock.autoInstallOnAppQuit).toBe(true);

    expect(mocks.trackEventMock).not.toHaveBeenCalled();
  });

  it('normalizes array-form release notes before sending update-downloaded to the renderer', () => {
    mocks.existsSyncMock.mockReturnValue(true);

    initUpdater(fakeWindow);

    const updateDownloadedCall = mocks.autoUpdaterMock.on.mock.calls.find(
      (call) => call[0] === 'update-downloaded',
    );
    if (!updateDownloadedCall) throw new Error('update-downloaded handler was not registered');
    const updateDownloadedHandler = updateDownloadedCall[1] as (info: {
      version: string;
      releaseNotes: unknown;
    }) => void;

    // Array form (builder-util-runtime's ReleaseNoteInfo[]) proves
    // normalizeReleaseNotes actually runs rather than a raw passthrough -
    // a passthrough would forward the array itself, not the joined string.
    updateDownloadedHandler({
      version: '9.9.9',
      releaseNotes: [{ version: '9.9.9', note: 'x' }],
    });

    expect(fakeWindowSend).toHaveBeenCalledWith(IPC.UPDATE_DOWNLOADED, {
      version: '9.9.9',
      releaseNotes: 'x',
    });
  });

  it('registers no-op IPC handlers and skips wiring on unpackaged builds', () => {
    mocks.electronMock.app.isPackaged = false;

    initUpdater(fakeWindow);

    const handlerCalls = mocks.electronMock.ipcMain.handle.mock.calls;
    const channels = handlerCalls.map((call) => call[0]);
    expect(channels).toEqual([IPC.UPDATE_CHECK, IPC.UPDATE_INSTALL]);
    for (const [, fn] of handlerCalls) {
      expect((fn as () => unknown)()).toBeUndefined();
    }

    expect(mocks.existsSyncMock).not.toHaveBeenCalled();
    expect(mocks.autoUpdaterMock.on).not.toHaveBeenCalled();
    expect(mocks.trackEventMock).not.toHaveBeenCalled();
  });
});

/**
 * Linux used to be short-circuited alongside dev builds, on the belief that
 * deb/rpm had no in-place update path. It does: electron-updater ships
 * DebUpdater/RpmUpdater, its `autoUpdater` export selects one via the
 * `package-type` marker, and electron-builder writes that marker plus an
 * app-update.yml for every fpm target in its supportsAutoUpdate list
 * (["deb", "rpm", "pacman"]). These tests pin that Linux now wires up like
 * any other platform, and the one deliberate difference.
 */
describe('initUpdater on Linux', () => {
  const originalResourcesPath = process.resourcesPath;
  const originalPlatform = process.platform;

  beforeEach(() => {
    vi.useFakeTimers();
    Object.defineProperty(process, 'resourcesPath', {
      value: '/fake/resources',
      configurable: true,
    });
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
    mocks.electronMock.app.isPackaged = true;
    mocks.electronMock.ipcMain.handle.mockReset();
    mocks.autoUpdaterMock.on.mockReset();
    mocks.autoUpdaterMock.checkForUpdates.mockReset();
    mocks.autoUpdaterMock.autoDownload = true;
    mocks.autoUpdaterMock.autoInstallOnAppQuit = false;
    mocks.autoUpdaterMock.disableDifferentialDownload = false;
    mocks.trackEventMock.mockReset();
    mocks.existsSyncMock.mockReset();
    fakeWindowSend.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
    Object.defineProperty(process, 'resourcesPath', {
      value: originalResourcesPath,
      configurable: true,
    });
    Object.defineProperty(process, 'platform', {
      value: originalPlatform,
      configurable: true,
    });
  });

  it('runs full wiring on a packaged Linux build', () => {
    mocks.existsSyncMock.mockReturnValue(true);

    initUpdater(fakeWindow);

    const onEvents = mocks.autoUpdaterMock.on.mock.calls.map((call) => call[0]).sort();
    expect(onEvents).toEqual(['error', 'update-available', 'update-downloaded']);
    expect(mocks.autoUpdaterMock.autoDownload).toBe(false);
    expect(mocks.trackEventMock).not.toHaveBeenCalled();
  });

  it('schedules the periodic check on Linux', () => {
    mocks.existsSyncMock.mockReturnValue(true);

    initUpdater(fakeWindow);
    vi.advanceTimersByTime(5_000);

    expect(mocks.autoUpdaterMock.checkForUpdates).toHaveBeenCalledTimes(1);
  });

  it('does NOT install on quit, unlike the other platforms', () => {
    // DebUpdater/RpmUpdater shell out to the package manager, which always
    // elevates. On the quit path that means a password prompt as the window
    // disappears, racing session teardown. The update stays staged for the
    // modal's explicit "Restart to update" instead.
    mocks.existsSyncMock.mockReturnValue(true);

    initUpdater(fakeWindow);

    expect(mocks.autoUpdaterMock.autoInstallOnAppQuit).toBe(false);
  });

  it('still honors the missing-manifest guard on Linux', () => {
    mocks.existsSyncMock.mockReturnValue(false);

    initUpdater(fakeWindow);

    expect(mocks.electronMock.ipcMain.handle.mock.calls.map((call) => call[0]))
      .toEqual([IPC.UPDATE_CHECK, IPC.UPDATE_INSTALL]);
    expect(mocks.autoUpdaterMock.on).not.toHaveBeenCalled();
    expect(mocks.trackEventMock).toHaveBeenCalledWith('app_error', {
      source: 'updater',
      message: 'missing_manifest',
    });
  });
});
