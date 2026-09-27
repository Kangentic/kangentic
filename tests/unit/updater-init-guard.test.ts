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

import { initUpdater, updaterLogger } from '../../src/main/updater';
import { IPC } from '../../src/shared/ipc-channels';
import { filterBreadcrumb } from '../../src/shared/sentry-breadcrumbs';

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
    // The tagged logger, so the Sentry breadcrumb policy keeps the library's
    // own lines (it drops untagged console output).
    expect((mocks.autoUpdaterMock as { logger?: unknown }).logger).toBe(updaterLogger);

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

  it('keeps the update version in the breadcrumb, because it is inside the template string', () => {
    // The Sentry breadcrumb policy (filterBreadcrumb) keeps only the first
    // string argument of a console line and drops every later string
    // argument. A two-argument console.log('[UPDATER] Update downloaded:',
    // info.version) would silently lose the version from the breadcrumb, so
    // the version has to live inside the tagged template string itself.
    mocks.existsSyncMock.mockReturnValue(true);
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    try {
      initUpdater(fakeWindow);

      const updateDownloadedCall = mocks.autoUpdaterMock.on.mock.calls.find(
        (call) => call[0] === 'update-downloaded',
      );
      if (!updateDownloadedCall) throw new Error('update-downloaded handler was not registered');
      const updateDownloadedHandler = updateDownloadedCall[1] as (info: {
        version: string;
        releaseNotes: unknown;
      }) => void;

      updateDownloadedHandler({
        version: '9.9.9',
        releaseNotes: [{ version: '9.9.9', note: 'x' }],
      });

      const updateDownloadedLogCall = logSpy.mock.calls.find(
        (call) => typeof call[0] === 'string' && call[0].startsWith('[UPDATER] Update downloaded'),
      );
      if (!updateDownloadedLogCall) throw new Error('update-downloaded log line was not printed');

      // Rebuild the console breadcrumb the SDK would record from that spied
      // call, exactly as filterBreadcrumb receives it in production.
      const breadcrumb = filterBreadcrumb({
        category: 'console',
        level: 'log',
        message: updateDownloadedLogCall.map(String).join(' '),
        data: { arguments: updateDownloadedLogCall, logger: 'console' },
      });

      expect(breadcrumb?.message).toContain('9.9.9');
    } finally {
      logSpy.mockRestore();
    }
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
 * electron-updater logs through `autoUpdater.logger`, which defaults to the bare
 * console. The Sentry breadcrumb policy (src/shared/sentry-breadcrumbs.ts)
 * keeps `[electron-updater]` lines and always drops debug, so the tag and the
 * debug routing are what decide whether a line reaches the breadcrumb trail.
 */
describe('updaterLogger', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('tags every level and sends debug to console.debug', () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const debugSpy = vi.spyOn(console, 'debug').mockImplementation(() => {});

    updaterLogger.info('Checking for update');
    updaterLogger.warn('Cannot find blockmap');
    updaterLogger.error(new Error('Squirrel failed'));
    updaterLogger.debug?.('File has 12 changed blocks');

    expect(logSpy).toHaveBeenCalledWith('[electron-updater] Checking for update');
    expect(warnSpy).toHaveBeenCalledWith('[electron-updater] Cannot find blockmap');
    expect(errorSpy).toHaveBeenCalledWith('[electron-updater] Error: Squirrel failed');
    expect(debugSpy).toHaveBeenCalledWith('[electron-updater] File has 12 changed blocks');
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

/**
 * quitAndInstallIfUpdatePending(): the restart route a Graphics acceleration
 * toggle takes when a downloaded update is already waiting. A plain
 * app.relaunch() with autoInstallOnAppQuit on would let the installer run
 * silently on quit WITHOUT relaunching, and it then closes the instance the
 * relaunch just started, leaving the user with no app at all. This installs
 * and force-relaunches in one step instead - the same call the release-notes
 * modal's "Restart to update" button makes.
 *
 * `updateDownloaded` is module-scope state, set only inside the real
 * update-downloaded handler initUpdater wires up. The describe blocks above
 * already fire that handler against the file's one static `initUpdater`
 * import (to test the payload it sends, not this flag), so a "nothing
 * downloaded yet" case here cannot share that import - it would inherit
 * `true` from an earlier test and pass for the wrong reason. Each test below
 * resets the module registry and re-imports updater.ts fresh; the vi.mock
 * factories registered at the top of this file still intercept the reload.
 */
describe('quitAndInstallIfUpdatePending', () => {
  const originalResourcesPath = process.resourcesPath;
  const originalPlatform = process.platform;

  beforeEach(() => {
    vi.resetModules();
    Object.defineProperty(process, 'resourcesPath', {
      value: '/fake/resources',
      configurable: true,
    });
    mocks.autoUpdaterMock.on.mockReset();
    mocks.autoUpdaterMock.quitAndInstall.mockReset();
    mocks.autoUpdaterMock.autoDownload = true;
    mocks.autoUpdaterMock.autoInstallOnAppQuit = false;
    mocks.autoUpdaterMock.disableDifferentialDownload = false;
    mocks.existsSyncMock.mockReset();
    mocks.existsSyncMock.mockReturnValue(true);
    mocks.trackEventMock.mockReset();
    fakeWindowSend.mockReset();
  });

  afterEach(() => {
    Object.defineProperty(process, 'resourcesPath', {
      value: originalResourcesPath,
      configurable: true,
    });
    Object.defineProperty(process, 'platform', {
      value: originalPlatform,
      configurable: true,
    });
  });

  it('returns false and never calls quitAndInstall when no update has downloaded', async () => {
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
    const updater = await import('../../src/main/updater');
    updater.initUpdater(fakeWindow);
    // Full wiring on win32 turns autoInstallOnAppQuit on by itself (see
    // 'runs full wiring when manifest is present' above); the guard under
    // test must still refuse to fire, because no download has happened.
    expect(mocks.autoUpdaterMock.autoInstallOnAppQuit).toBe(true);

    expect(updater.quitAndInstallIfUpdatePending()).toBe(false);
    expect(mocks.autoUpdaterMock.quitAndInstall).not.toHaveBeenCalled();
  });

  it('returns false when an update is downloaded but autoInstallOnAppQuit is off (Linux)', async () => {
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
    const updater = await import('../../src/main/updater');
    updater.initUpdater(fakeWindow);
    expect(mocks.autoUpdaterMock.autoInstallOnAppQuit).toBe(false);

    const updateDownloadedCall = mocks.autoUpdaterMock.on.mock.calls.find(
      (call) => call[0] === 'update-downloaded',
    );
    if (!updateDownloadedCall) throw new Error('update-downloaded handler was not registered');
    const updateDownloadedHandler = updateDownloadedCall[1] as (info: {
      version: string;
      releaseNotes: unknown;
    }) => void;
    updateDownloadedHandler({ version: '9.9.9', releaseNotes: '' });

    expect(updater.quitAndInstallIfUpdatePending()).toBe(false);
    expect(mocks.autoUpdaterMock.quitAndInstall).not.toHaveBeenCalled();
  });

  it('installs and force-relaunches when an update is downloaded and autoInstallOnAppQuit is on', async () => {
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
    const updater = await import('../../src/main/updater');
    updater.initUpdater(fakeWindow);
    expect(mocks.autoUpdaterMock.autoInstallOnAppQuit).toBe(true);

    const updateDownloadedCall = mocks.autoUpdaterMock.on.mock.calls.find(
      (call) => call[0] === 'update-downloaded',
    );
    if (!updateDownloadedCall) throw new Error('update-downloaded handler was not registered');
    const updateDownloadedHandler = updateDownloadedCall[1] as (info: {
      version: string;
      releaseNotes: unknown;
    }) => void;
    updateDownloadedHandler({ version: '9.9.9', releaseNotes: '' });

    expect(updater.quitAndInstallIfUpdatePending()).toBe(true);
    expect(mocks.autoUpdaterMock.quitAndInstall).toHaveBeenCalledTimes(1);
    // isSilent, isForceRunAfter: the second flag is what brings the app back
    // after the install, matching the release-notes modal's own call.
    expect(mocks.autoUpdaterMock.quitAndInstall).toHaveBeenCalledWith(true, true);
  });
});
