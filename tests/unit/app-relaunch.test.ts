import { describe, it, expect, vi, beforeEach, afterEach, beforeAll } from 'vitest';
import {
  relaunchApp,
  devRestartFileFrom,
  isRestartRequested,
  resetRestartRequestedForTests,
  DEV_RESTART_FILE_FLAG,
  type RelaunchDependencies,
} from '../../src/main/app-relaunch';

/**
 * Mocks for the quitAndInstallIfUpdatePending describe block further below,
 * which exercises src/main/updater.ts (the real implementation behind
 * relaunchApp's `update-install` route). Declared here, at module scope, so
 * `vi.mock` can hoist them above every import in this file, including the
 * `app-relaunch` import above.
 *
 * This is safe next to the relaunchApp tests above: app-relaunch.ts carries
 * no imports of its own (see its own file), so mocking `electron` and
 * `electron-updater` here has nothing in that module to reach. Every one of
 * relaunchApp's calls into "Electron" arrives through the RelaunchDependencies
 * object a test constructs by hand, never through these mocked modules.
 */
const updaterModuleMocks = vi.hoisted(() => ({
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

vi.mock('electron', () => updaterModuleMocks.electronMock);
vi.mock('electron-updater', () => ({ autoUpdater: updaterModuleMocks.autoUpdaterMock }));
vi.mock('../../src/main/analytics/analytics', () => ({
  trackEvent: updaterModuleMocks.trackEventMock,
  sanitizeErrorMessage: (input: string) => input,
}));
vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return { ...actual, existsSync: updaterModuleMocks.existsSyncMock };
});

/**
 * app-relaunch.ts - how the Graphics acceleration toggle restarts the app.
 *
 * Every route has to end in `quit`, never an exit that skips `before-quit`:
 * that is what records a `clean` run, and an `abrupt` one is half of what the
 * next launch's GPU check treats as a GPU death. Under `npm start` the route
 * must NOT be Electron's own relaunch, because scripts/dev.js closes Vite when
 * its Electron exits.
 */

function recordingDependencies(overrides: Partial<RelaunchDependencies> = {}) {
  const calls: string[] = [];
  const dependencies: RelaunchDependencies = {
    isTest: false,
    devRestartFile: null,
    installPendingUpdateAndRelaunch: () => false,
    relaunch: () => calls.push('relaunch'),
    quit: () => calls.push('quit'),
    writeFile: (filePath, contents) => calls.push(`write ${filePath} ${contents.length > 0 ? 'with contents' : 'empty'}`),
    ...overrides,
  };
  return { calls, dependencies };
}

describe('relaunchApp', () => {
  it('relaunches and then quits through the normal quit path in a packaged build', () => {
    const { calls, dependencies } = recordingDependencies();
    expect(relaunchApp(dependencies)).toBe('relaunch');
    expect(calls).toEqual(['relaunch', 'quit']);
  });

  it('installs a downloaded update and relaunches into it instead, so the installer does not close the relaunched app', () => {
    const { calls, dependencies } = recordingDependencies({
      installPendingUpdateAndRelaunch: () => {
        calls.push('install update and relaunch');
        return true;
      },
    });
    expect(relaunchApp(dependencies)).toBe('update-install');
    expect(calls).toEqual(['install update and relaunch']);
  });

  it('asks dev.js for the restart instead of relaunching, and writes the request before quitting', () => {
    const { calls, dependencies } = recordingDependencies({ devRestartFile: '/mock/worktree/.kangentic/dev-5173.restart' });
    expect(relaunchApp(dependencies)).toBe('dev-restart');
    // The file must be on disk before Electron exits: dev.js checks for it
    // in its 'close' handler, and without it tears Vite down.
    expect(calls).toEqual(['write /mock/worktree/.kangentic/dev-5173.restart with contents', 'quit']);
  });

  it('does nothing but log under NODE_ENV=test, since a relaunch would orphan an Electron the harness does not own', () => {
    const { calls, dependencies } = recordingDependencies({ isTest: true, devRestartFile: '/mock/restart' });
    expect(relaunchApp(dependencies)).toBe('skipped-in-test');
    expect(calls).toEqual([]);
  });

  it('does not quit when the dev restart request cannot be written, so the caller can report it', () => {
    const { calls, dependencies } = recordingDependencies({
      devRestartFile: '/mock/restart',
      writeFile: () => {
        throw new Error('EACCES');
      },
    });
    expect(() => relaunchApp(dependencies)).toThrow('EACCES');
    expect(calls).toEqual([]);
  });
});

describe('isRestartRequested', () => {
  // The quit a restart starts must be able to tell itself from one that ends
  // the app: an ephemeral preview deletes its open project on the latter only.
  beforeEach(() => {
    resetRestartRequestedForTests();
  });

  it('is false until a restart is asked for', () => {
    expect(isRestartRequested()).toBe(false);
  });

  it('is true once the dev restart request is written, before the quit runs', () => {
    let requestedWhenQuitRan: boolean | null = null;
    const { dependencies } = recordingDependencies({
      devRestartFile: '/mock/restart',
      quit: () => { requestedWhenQuitRan = isRestartRequested(); },
    });
    relaunchApp(dependencies);
    expect(requestedWhenQuitRan).toBe(true);
  });

  it('is true for a packaged relaunch too', () => {
    relaunchApp(recordingDependencies().dependencies);
    expect(isRestartRequested()).toBe(true);
  });

  it('is already true when the packaged quit runs, since before-quit fires inside the quit call', () => {
    let requestedWhenQuitRan: boolean | null = null;
    const { dependencies } = recordingDependencies({
      quit: () => { requestedWhenQuitRan = isRestartRequested(); },
    });

    relaunchApp(dependencies);

    expect(requestedWhenQuitRan).toBe(true);
  });

  it('is already true when control passes to the update installer, which is the call that quits the app', () => {
    let requestedWhenInstallRan: boolean | null = null;
    const { dependencies } = recordingDependencies({
      installPendingUpdateAndRelaunch: () => {
        requestedWhenInstallRan = isRestartRequested();
        return true;
      },
    });

    expect(relaunchApp(dependencies)).toBe('update-install');

    expect(requestedWhenInstallRan).toBe(true);
    expect(isRestartRequested()).toBe(true);
  });

  it('stays false when the restart is skipped in a test run or its request cannot be written', () => {
    relaunchApp(recordingDependencies({ isTest: true, devRestartFile: '/mock/restart' }).dependencies);
    expect(isRestartRequested()).toBe(false);

    expect(() => relaunchApp(recordingDependencies({
      devRestartFile: '/mock/restart',
      writeFile: () => { throw new Error('EACCES'); },
    }).dependencies)).toThrow('EACCES');
    expect(isRestartRequested()).toBe(false);
  });
});

describe('devRestartFileFrom', () => {
  it('reads the path dev.js passes', () => {
    expect(devRestartFileFrom(['electron', '/mock/project', `${DEV_RESTART_FILE_FLAG}/mock/project/.kangentic/dev-5173.restart`]))
      .toBe('/mock/project/.kangentic/dev-5173.restart');
  });

  it('returns null outside npm start, or for an empty value', () => {
    expect(devRestartFileFrom(['electron', '/mock/project', '--ephemeral'])).toBeNull();
    expect(devRestartFileFrom([DEV_RESTART_FILE_FLAG])).toBeNull();
  });
});

/**
 * quitAndInstallIfUpdatePending (src/main/updater.ts) is the real
 * implementation behind relaunchApp's `update-install` route: with an update
 * already downloaded and `autoInstallOnAppQuit` on, a plain quit would run
 * the installer silently without relaunching, closing the instance
 * `app.relaunch()` just started.
 *
 * `updateDownloaded` is module-scoped state with no reset hook, so every case
 * below reimports the module fresh with `vi.resetModules()` instead of
 * sharing one import across tests.
 */
type UpdaterModule = typeof import('../../src/main/updater');

describe('quitAndInstallIfUpdatePending', () => {
  const originalResourcesPath = process.resourcesPath;
  const originalPlatform = process.platform;

  const fakeMainWindowSend = vi.fn();
  const fakeMainWindow = {
    isDestroyed: () => false,
    webContents: { send: fakeMainWindowSend },
  } as unknown as Electron.BrowserWindow;

  beforeAll(async () => {
    // Warm the module graph once: the first import pulls in
    // @sentry/electron/main through updater.ts's error-reporting dependency,
    // and doing that cold inside a test body risks the default 5s test
    // timeout. vi.resetModules() clears vitest's own module registry, not
    // Node's underlying resolution of already-loaded externals, so later
    // fresh imports in the tests below stay fast.
    vi.resetModules();
    await import('../../src/main/updater');
  });

  beforeEach(() => {
    Object.defineProperty(process, 'resourcesPath', {
      value: '/mock/resources',
      configurable: true,
    });
    Object.defineProperty(process, 'platform', {
      value: 'win32',
      configurable: true,
    });
    updaterModuleMocks.electronMock.app.isPackaged = true;
    updaterModuleMocks.electronMock.ipcMain.handle.mockReset();
    updaterModuleMocks.autoUpdaterMock.on.mockReset();
    updaterModuleMocks.autoUpdaterMock.checkForUpdates.mockReset();
    updaterModuleMocks.autoUpdaterMock.quitAndInstall.mockReset();
    updaterModuleMocks.autoUpdaterMock.autoDownload = true;
    updaterModuleMocks.autoUpdaterMock.autoInstallOnAppQuit = false;
    updaterModuleMocks.autoUpdaterMock.disableDifferentialDownload = false;
    updaterModuleMocks.trackEventMock.mockReset();
    updaterModuleMocks.existsSyncMock.mockReset();
    updaterModuleMocks.existsSyncMock.mockReturnValue(true);
    fakeMainWindowSend.mockReset();
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

  /** A fresh module instance, so this case's `updateDownloaded` starts at its
   *  real default (false) instead of whatever an earlier case left behind. */
  async function freshUpdaterModule(): Promise<UpdaterModule> {
    vi.resetModules();
    return import('../../src/main/updater');
  }

  /** Drives initUpdater's real packaged-with-manifest wiring path (see the
   *  beforeEach above for what makes that path run) and returns the
   *  `update-downloaded` listener it registers on `autoUpdater.on`, the same
   *  listener electron-updater would call once a real download finishes. */
  function registerUpdateDownloadedListener(
    updaterModule: UpdaterModule,
  ): (info: { version: string; releaseNotes: unknown }) => void {
    updaterModule.initUpdater(fakeMainWindow);
    const registeredCall = updaterModuleMocks.autoUpdaterMock.on.mock.calls.find(
      (call) => call[0] === 'update-downloaded',
    );
    if (!registeredCall) throw new Error('update-downloaded handler was not registered');
    return registeredCall[1] as (info: { version: string; releaseNotes: unknown }) => void;
  }

  it('installs and relaunches when an update is downloaded and autoInstallOnAppQuit is on', async () => {
    const updaterModule = await freshUpdaterModule();
    try {
      const updateDownloadedListener = registerUpdateDownloadedListener(updaterModule);
      // Reach updateDownloaded = true through the real path: fire the
      // listener initUpdater actually registered, exactly as
      // electron-updater's own 'update-downloaded' event would.
      updateDownloadedListener({ version: '9.9.9', releaseNotes: null });
      // win32 is not the Linux branch, so initUpdater already left this true;
      // asserting it keeps the case honest about which guard it exercises.
      expect(updaterModuleMocks.autoUpdaterMock.autoInstallOnAppQuit).toBe(true);

      expect(updaterModule.quitAndInstallIfUpdatePending()).toBe(true);
      expect(updaterModuleMocks.autoUpdaterMock.quitAndInstall).toHaveBeenCalledTimes(1);
      expect(updaterModuleMocks.autoUpdaterMock.quitAndInstall).toHaveBeenCalledWith(true, true);
    } finally {
      updaterModule.stopUpdaterTimers();
    }
  });

  it('returns false and never installs when no update has finished downloading', async () => {
    const updaterModule = await freshUpdaterModule();
    try {
      // Register the listener but never fire it, so updateDownloaded stays
      // at its real default of false.
      registerUpdateDownloadedListener(updaterModule);
      // autoInstallOnAppQuit is true here (win32, not Linux), so the
      // updateDownloaded guard is the only thing that can produce false.
      expect(updaterModuleMocks.autoUpdaterMock.autoInstallOnAppQuit).toBe(true);

      expect(updaterModule.quitAndInstallIfUpdatePending()).toBe(false);
      expect(updaterModuleMocks.autoUpdaterMock.quitAndInstall).not.toHaveBeenCalled();
    } finally {
      updaterModule.stopUpdaterTimers();
    }
  });

  it('returns false and never installs on Linux, where autoInstallOnAppQuit stays off even with an update downloaded', async () => {
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
    const updaterModule = await freshUpdaterModule();
    try {
      const updateDownloadedListener = registerUpdateDownloadedListener(updaterModule);
      updateDownloadedListener({ version: '9.9.9', releaseNotes: null });
      // Proves the listener actually ran (updateDownloaded flipped to true)
      // before the guard is exercised, so this case isolates the
      // autoInstallOnAppQuit guard rather than accidentally passing through
      // the updateDownloaded one.
      expect(fakeMainWindowSend).toHaveBeenCalledTimes(1);
      expect(updaterModuleMocks.autoUpdaterMock.autoInstallOnAppQuit).toBe(false);

      expect(updaterModule.quitAndInstallIfUpdatePending()).toBe(false);
      expect(updaterModuleMocks.autoUpdaterMock.quitAndInstall).not.toHaveBeenCalled();
    } finally {
      updaterModule.stopUpdaterTimers();
    }
  });
});
