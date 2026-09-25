/**
 * Tests for updater.ts retry logic and error-handler decision tree.
 *
 * isTransientUpdaterError classifier tests live in updater-error-classifier.test.ts.
 * This file covers:
 *   - checkWithRetry(): flag transitions, retry call count, error logging
 *   - downloadWithRetry(): flag transitions, retry call count, error logging
 *   - autoUpdater.on('error') handler branches:
 *       1. checkRetrying || downloadRetrying in-flight - no trackEvent, no reportHandledError
 *       2. isTransientUpdaterError - no trackEvent, no reportHandledError, console.log suppression message
 *       3. hasTransientNetworkCause - trackEvent YES, reportHandledError NO. The only branch
 *          where the two split. A rewrapped feed failure (DESKTOP-F: GitHub 504 arriving as
 *          ERR_UPDATER_INVALID_RELEASE_FEED) is un-actionable as an issue but still worth
 *          counting, so its gate sits BETWEEN the two reporters. Moving that gate above
 *          trackEvent would delete the volume signal; moving it below reportHandledError
 *          would do nothing at all. Both regressions are pinned here.
 *       4. isElevationDeniedError - trackEvent YES, reportHandledError NO. The same split as
 *          branch 3, for the Linux install path: the user dismissed the polkit prompt
 *          (DESKTOP-R), which is their own choice rather than a defect, so it is counted but
 *          never filed. Its gate sits directly below branch 3's, between the two reporters,
 *          and the same two position regressions are pinned here.
 *       5. isReadOnlyVolumeError - trackEvent YES, reportHandledError NO, PLUS one
 *          updater:blocked push. The same split again for the macOS install path
 *          (DESKTOP-1A), and the only branch in the whole handler that says anything
 *          to the user: an app running from a read-only volume never updates again,
 *          silently, until someone moves it. The push is latched for the app run, so
 *          a condition every 4-hour check rediscovers still toasts once.
 *       6. isResourceUnavailableError - trackEvent YES, reportHandledError NO. EAGAIN
 *          (DESKTOP-1B) reaching us through macOS's NSError rendering rather than
 *          through Node, which is the only reason branch 2's errno list misses it.
 *       7. isPrereleaseWithNoMatchingRelease - trackEvent YES, reportHandledError NO,
 *          and ONLY on a prerelease build. A prerelease asking for a channel we do not
 *          publish (DESKTOP-17) is its normal state; the identical error on a STABLE
 *          build means our releases feed is empty and still reports. Both pinned here.
 *       8. structural error - trackEvent('app_error', ...) AND reportHandledError(error, { source: 'updater' })
 *          called, gated identically (reportHandledError sits after the same six early
 *          returns, so a regression that moves it above any guard would page Sentry
 *          for a transient, declined, or in-flight-retry error)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// vi.hoisted() values are initialized before vi.mock() factories run,
// which lets the factories close over mutable references without the
// "Cannot access before initialization" TDZ error that afflicts top-level
// const declarations referenced inside vi.mock() factories.
const mocks = vi.hoisted(() => ({
  checkForUpdates: vi.fn(),
  downloadUpdate: vi.fn(),
  autoUpdaterOn: vi.fn(),
  trackEvent: vi.fn(),
  sanitizeErrorMessage: vi.fn((message: string) => message),
  reportHandledError: vi.fn(),
  // initUpdater() now guards on the presence of app-update.yml; force the
  // guard to pass so the full wiring path (including the `error` listener
  // these tests target) is executed.
  existsSync: vi.fn(() => true),
  getVersion: vi.fn(() => '0.42.0'),
  // Shared across every BrowserWindow the tests construct, so a push can be
  // asserted without reaching back into the instance initUpdater captured.
  webContentsSend: vi.fn(),
}));

vi.mock('electron', () => ({
  // getVersion feeds the DESKTOP-17 gate, whose whole point is that a stable
  // version and a prerelease version take different branches. Default to a
  // stable one so every OTHER test in this file exercises the reporting path,
  // and let the prerelease tests override it.
  app: { isPackaged: true, getVersion: mocks.getVersion },
  BrowserWindow: class {
    isDestroyed() { return false; }
    webContents = { send: mocks.webContentsSend };
  },
  ipcMain: { handle: vi.fn() },
}));

vi.mock('electron-updater', () => ({
  autoUpdater: {
    on: mocks.autoUpdaterOn,
    checkForUpdates: mocks.checkForUpdates,
    downloadUpdate: mocks.downloadUpdate,
    quitAndInstall: vi.fn(),
    autoDownload: false,
    autoInstallOnAppQuit: false,
    disableDifferentialDownload: false,
  },
}));

vi.mock('../../src/main/analytics/analytics', () => ({
  trackEvent: mocks.trackEvent,
  sanitizeErrorMessage: mocks.sanitizeErrorMessage,
}));

vi.mock('../../src/main/analytics/error-reporting', () => ({
  reportHandledError: mocks.reportHandledError,
}));

vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return { ...actual, existsSync: mocks.existsSync };
});

// initUpdater() no longer short-circuits on Linux, but it still picks
// per-platform branches (autoInstallOnAppQuit on Linux, disableDifferentialDownload
// on macOS). Pin the platform so these tests exercise one deterministic wiring
// path whether they run on a Windows dev host or Ubuntu CI. The Linux-specific
// branch has its own coverage in updater-init-guard.test.ts.
Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });

// initUpdater() reads process.resourcesPath via manifestPath(). It is
// undefined under vitest, which would throw `path` argument errors before
// the existsSync stub above is consulted.
Object.defineProperty(process, 'resourcesPath', {
  value: '/fake/resources',
  configurable: true,
});

// Import after mocks are registered.
import { checkWithRetry, downloadWithRetry, initUpdater, updateUpdaterWindow } from '../../src/main/updater';
import { BrowserWindow } from 'electron';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeError(message: string, code?: string): Error {
  const error = new Error(message);
  if (code !== undefined) {
    (error as NodeJS.ErrnoException).code = code;
  }
  return error;
}

/**
 * After initUpdater() has been called, extract the callback registered for
 * a specific autoUpdater event name from mocks.autoUpdaterOn.mock.calls.
 */
function getRegisteredListener(eventName: string): ((...args: unknown[]) => void) {
  const callEntry = mocks.autoUpdaterOn.mock.calls.find(
    (callArgs) => callArgs[0] === eventName,
  );
  if (!callEntry) throw new Error(`No autoUpdater.on('${eventName}') call found`);
  return callEntry[1] as (...args: unknown[]) => void;
}

// ---------------------------------------------------------------------------
// checkWithRetry
// ---------------------------------------------------------------------------

describe('checkWithRetry', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('resolves immediately when the first check succeeds', async () => {
    mocks.checkForUpdates.mockResolvedValueOnce(undefined);

    const promise = checkWithRetry();
    await vi.runAllTimersAsync();
    await promise;

    expect(mocks.checkForUpdates).toHaveBeenCalledTimes(1);
  });

  it('retries after RETRY_DELAY_MS when the first check fails', async () => {
    mocks.checkForUpdates
      .mockRejectedValueOnce(makeError('DNS failure'))
      .mockResolvedValueOnce(undefined);

    const promise = checkWithRetry();
    // First attempt fails in the microtask queue; advance past the 30-second
    // retry delay to trigger the second attempt.
    await vi.advanceTimersByTimeAsync(30_000);
    await promise;

    expect(mocks.checkForUpdates).toHaveBeenCalledTimes(2);
  });

  it('logs a retry message and a console.error when both attempts fail', async () => {
    const consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    mocks.checkForUpdates
      .mockRejectedValueOnce(makeError('first failure'))
      .mockRejectedValueOnce(makeError('second failure'));

    const promise = checkWithRetry();
    await vi.advanceTimersByTimeAsync(30_000);
    await promise; // must not throw

    expect(mocks.checkForUpdates).toHaveBeenCalledTimes(2);
    expect(consoleLogSpy).toHaveBeenCalledWith(
      expect.stringContaining('[UPDATER] Check failed, retrying in 30s...'),
    );
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      expect.stringContaining('[UPDATER] Check failed after retry:'),
      expect.any(Error),
    );

    consoleLogSpy.mockRestore();
    consoleErrorSpy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// downloadWithRetry
// ---------------------------------------------------------------------------

describe('downloadWithRetry', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('resolves immediately when the first download succeeds', async () => {
    mocks.downloadUpdate.mockResolvedValueOnce(undefined);

    const promise = downloadWithRetry();
    await vi.runAllTimersAsync();
    await promise;

    expect(mocks.downloadUpdate).toHaveBeenCalledTimes(1);
  });

  it('retries after RETRY_DELAY_MS when the first download fails', async () => {
    mocks.downloadUpdate
      .mockRejectedValueOnce(makeError('ECONNRESET', 'ECONNRESET'))
      .mockResolvedValueOnce(undefined);

    const promise = downloadWithRetry();
    await vi.advanceTimersByTimeAsync(30_000);
    await promise;

    expect(mocks.downloadUpdate).toHaveBeenCalledTimes(2);
  });

  it('logs a retry message and a console.error when both attempts fail', async () => {
    const consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    mocks.downloadUpdate
      .mockRejectedValueOnce(makeError('first download failure'))
      .mockRejectedValueOnce(makeError('second download failure'));

    const promise = downloadWithRetry();
    await vi.advanceTimersByTimeAsync(30_000);
    await promise; // must not throw

    expect(mocks.downloadUpdate).toHaveBeenCalledTimes(2);
    expect(consoleLogSpy).toHaveBeenCalledWith(
      expect.stringContaining('[UPDATER] Download failed, retrying in 30s:'),
      expect.any(Error),
    );
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      expect.stringContaining('[UPDATER] Download failed after retry:'),
      expect.any(Error),
    );

    consoleLogSpy.mockRestore();
    consoleErrorSpy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// autoUpdater.on('error') listener decision tree
//
// initUpdater() wires the listener. app.isPackaged is mocked as true above
// so initUpdater() does not return early.
//
// Module-level checkRetrying and downloadRetrying flags start as false.
// We set them to true by starting a retry cycle (first call rejects, fake
// timer not yet advanced) and assert before advancing the clock.
// ---------------------------------------------------------------------------

describe("autoUpdater.on('error') listener", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    // clearAllMocks clears calls, not implementations, so a mockReturnValue
    // set by one test would leak into the next. Re-assert the stable default
    // here: every test that is not about DESKTOP-17 must take the reporting
    // branch, and that depends on the version NOT being a prerelease.
    mocks.getVersion.mockReturnValue('0.42.0');
    // Wire up listeners fresh for each test. This also re-arms the
    // read-only-volume notice latch, which initUpdater owns.
    const window = new BrowserWindow();
    initUpdater(window as unknown as import('electron').BrowserWindow);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('calls trackEvent for a structural (non-transient) error when not retrying', () => {
    mocks.sanitizeErrorMessage.mockReturnValue('sanitized message');

    const errorListener = getRegisteredListener('error');
    const structuralError = makeError('ERR_UPDATER_INVALID_SIGNATURE', 'ERR_UPDATER_INVALID_SIGNATURE');
    errorListener(structuralError);

    expect(mocks.trackEvent).toHaveBeenCalledTimes(1);
    expect(mocks.trackEvent).toHaveBeenCalledWith('app_error', {
      source: 'updater',
      message: 'sanitized message',
    });
    expect(mocks.sanitizeErrorMessage).toHaveBeenCalledWith(structuralError.message);
    // reportHandledError forwards the REAL error (not the sanitized message
    // trackEvent gets), so a structural updater failure is diagnosable in
    // Sentry beyond a bare count.
    expect(mocks.reportHandledError).toHaveBeenCalledTimes(1);
    expect(mocks.reportHandledError).toHaveBeenCalledWith(structuralError, { source: 'updater' });
  });

  it('does NOT call trackEvent for a transient error when not retrying', () => {
    const consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    const errorListener = getRegisteredListener('error');
    const transientError = makeError('network reset', 'ECONNRESET');
    errorListener(transientError);

    expect(mocks.trackEvent).not.toHaveBeenCalled();
    expect(consoleLogSpy).toHaveBeenCalledWith(
      expect.stringContaining('[UPDATER] Suppressing transient error telemetry:'),
      expect.any(String),
    );
    // A transient error must never reach Sentry either - it shares the same
    // early return as the trackEvent suppression above.
    expect(mocks.reportHandledError).not.toHaveBeenCalled();

    consoleLogSpy.mockRestore();
  });

  it('counts a rewrapped transient feed failure but does NOT report it to Sentry', () => {
    const consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    mocks.sanitizeErrorMessage.mockReturnValue('sanitized feed failure');

    const errorListener = getRegisteredListener('error');
    // DESKTOP-F's shape: a GitHub 504 that electron-updater's double rewrap has
    // relabelled as a structural feed error, so isTransientUpdaterError misses it.
    const wrapped = makeError(
      'Cannot parse releases feed: Error: Unable to find latest version on GitHub'
        + ' (https://github.com/Kangentic/kangentic/releases/latest),'
        + ' please ensure a production release exists: HttpError: 504',
      'ERR_UPDATER_INVALID_RELEASE_FEED',
    );
    errorListener(wrapped);

    // The volume view survives: this is still "an update check failed".
    expect(mocks.trackEvent).toHaveBeenCalledTimes(1);
    expect(mocks.trackEvent).toHaveBeenCalledWith('app_error', {
      source: 'updater',
      message: 'sanitized feed failure',
    });
    // But it never becomes an issue - there is nothing to ship a fix for.
    expect(mocks.reportHandledError).not.toHaveBeenCalled();
    expect(consoleLogSpy).toHaveBeenCalledWith(
      expect.stringContaining('[UPDATER] Counting but not reporting a transient feed failure:'),
      expect.any(String),
    );

    consoleLogSpy.mockRestore();
  });

  it('counts a denied elevation prompt but does NOT report it to Sentry', () => {
    const consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    mocks.sanitizeErrorMessage.mockReturnValue('sanitized elevation failure');

    const errorListener = getRegisteredListener('error');
    // DESKTOP-R's shape, verbatim from the Sentry event. BaseUpdater.spawnSyncLog
    // throws a BARE Error here, so no code argument: the predicate has nothing
    // but the message to work with.
    const declined = makeError('Command pkexec exited with code 126');
    errorListener(declined);

    // The volume view survives: "how often is a Linux update declined".
    expect(mocks.trackEvent).toHaveBeenCalledTimes(1);
    expect(mocks.trackEvent).toHaveBeenCalledWith('app_error', {
      source: 'updater',
      message: 'sanitized elevation failure',
    });
    // But it never becomes an issue - the user dismissed the polkit prompt.
    expect(mocks.reportHandledError).not.toHaveBeenCalled();
    expect(consoleLogSpy).toHaveBeenCalledWith(
      expect.stringContaining('[UPDATER] Counting but not reporting a denied elevation prompt:'),
      expect.any(String),
    );

    consoleLogSpy.mockRestore();
  });

  it('counts a read-only volume but does NOT report it, and tells the user once', () => {
    const consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    mocks.sanitizeErrorMessage.mockReturnValue('sanitized read-only volume');

    const errorListener = getRegisteredListener('error');
    // DESKTOP-1A's shape, verbatim from the Sentry event. Squirrel.Mac raises
    // it and MacUpdater only forwards it, so there is no code and no stack.
    const readOnly = makeError(
      'Cannot update while running on a read-only volume.'
        + ' The application is on a read-only volume.'
        + ' Please move the application and try again.'
        + " If you're on macOS Sierra or later, you'll need to move the application"
        + ' out of the Downloads directory.'
        + ' See https://github.com/Squirrel/Squirrel.Mac/issues/182 for more information.',
    );
    errorListener(readOnly);

    // The volume view survives: "how many installs cannot update at all".
    expect(mocks.trackEvent).toHaveBeenCalledTimes(1);
    expect(mocks.trackEvent).toHaveBeenCalledWith('app_error', {
      source: 'updater',
      message: 'sanitized read-only volume',
    });
    // But it never becomes an issue - no build of ours would behave differently.
    expect(mocks.reportHandledError).not.toHaveBeenCalled();
    expect(consoleLogSpy).toHaveBeenCalledWith(
      expect.stringContaining('[UPDATER] Counting but not reporting a read-only volume:'),
      expect.any(String),
    );

    // Unlike every other suppressed branch, this one is also told to the user,
    // because the install silently never updates again until someone acts.
    expect(mocks.webContentsSend).toHaveBeenCalledTimes(1);
    const [channel, message] = mocks.webContentsSend.mock.calls[0];
    expect(channel).toBe('updater:blocked');
    expect(message).toContain('read-only volume');
    expect(message).toContain('Applications');

    consoleLogSpy.mockRestore();
  });

  it('tells the user about a read-only volume only once per app run', () => {
    const consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    const errorListener = getRegisteredListener('error');
    const readOnly = makeError('Cannot update while running on a read-only volume.');
    // A 4-hour check interval rediscovers a permanent condition forever;
    // DESKTOP-1A produced 11 events from one install. Without the latch that
    // is 11 toasts.
    errorListener(readOnly);
    errorListener(readOnly);
    errorListener(readOnly);

    // Counted every time - the volume signal is the honest one.
    expect(mocks.trackEvent).toHaveBeenCalledTimes(3);
    // Told once.
    expect(mocks.webContentsSend).toHaveBeenCalledTimes(1);
    expect(mocks.reportHandledError).not.toHaveBeenCalled();

    consoleLogSpy.mockRestore();
  });

  it('does not burn the read-only notice when there is no window to receive it', () => {
    const consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    // On macOS every window can be closed while the app keeps running, and a
    // scheduled check can land in that gap. Latching on reaching the notifier
    // rather than on the send would spend this run's one notice on nobody.
    const destroyed = { isDestroyed: () => true, webContents: { send: mocks.webContentsSend } };
    initUpdater(destroyed as unknown as import('electron').BrowserWindow);

    const errorListener = getRegisteredListener('error');
    const readOnly = makeError('Cannot update while running on a read-only volume.');
    errorListener(readOnly);
    expect(mocks.webContentsSend).not.toHaveBeenCalled();

    // The dock icon brings a window back; the next check must still tell them.
    initUpdater(new BrowserWindow() as unknown as import('electron').BrowserWindow);
    getRegisteredListener('error')(readOnly);
    expect(mocks.webContentsSend).toHaveBeenCalledTimes(1);

    consoleLogSpy.mockRestore();
  });

  it('keeps the once-per-app-run latch armed across a window rebuild via updateUpdaterWindow', () => {
    // rebuildMainWindow() (src/main/index.ts) - macOS dock-icon reactivation
    // with no live window, and a second-instance arrival that finds the same -
    // re-points the updater at the new window through updateUpdaterWindow, NOT
    // initUpdater. The process never restarted, so this is not the "later
    // launch" the latch comment on notifyReadOnlyVolume reserves a fresh
    // notice for: the user already saw this run's one notice, and a rebuilt
    // window must not repeat it. A refactor that folds updateUpdaterWindow and
    // initUpdater's window assignment into one shared setter, and carries the
    // latch reset along with it, would turn every dock-icon click during a
    // read-only-volume failure back into a fresh toast - the exact spam
    // DESKTOP-1A's 11 events were.
    const consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const errorListener = getRegisteredListener('error');
    const readOnly = makeError('Cannot update while running on a read-only volume.');

    // App run 1's window (from beforeEach) gets the notice.
    errorListener(readOnly);
    expect(mocks.webContentsSend).toHaveBeenCalledTimes(1);

    // All windows close and macOS rebuilds one, in the SAME app run.
    const rebuiltWindowSend = vi.fn();
    const rebuiltWindow = {
      isDestroyed: () => false,
      webContents: { send: rebuiltWindowSend },
    } as unknown as import('electron').BrowserWindow;
    updateUpdaterWindow(rebuiltWindow);

    errorListener(readOnly);
    // Latch held across the rebuild: no second toast on the new window.
    expect(rebuiltWindowSend).not.toHaveBeenCalled();

    // Positive control: the rebuilt window IS the live target, so the silence
    // above is the latch holding, not a dead reference the error can't reach.
    // Only a genuine new app run (initUpdater) re-arms the latch.
    initUpdater(rebuiltWindow);
    getRegisteredListener('error')(readOnly);
    expect(rebuiltWindowSend).toHaveBeenCalledTimes(1);

    consoleLogSpy.mockRestore();
  });

  it('counts an EAGAIN install failure but does NOT report it to Sentry', () => {
    const consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    mocks.sanitizeErrorMessage.mockReturnValue('sanitized eagain');

    const errorListener = getRegisteredListener('error');
    // DESKTOP-1B's shape, verbatim. macOS renders EAGAIN through NSError, so
    // the errno never reaches us as a `code` and the six errno branches in
    // isTransientUpdaterError all miss it. U+2019 apostrophe is the real one.
    const eagain = makeError(
      'The operation couldn’t be completed. Resource temporarily unavailable',
    );
    errorListener(eagain);

    expect(mocks.trackEvent).toHaveBeenCalledTimes(1);
    expect(mocks.trackEvent).toHaveBeenCalledWith('app_error', {
      source: 'updater',
      message: 'sanitized eagain',
    });
    expect(mocks.reportHandledError).not.toHaveBeenCalled();
    expect(consoleLogSpy).toHaveBeenCalledWith(
      expect.stringContaining('[UPDATER] Counting but not reporting a transient EAGAIN:'),
      expect.any(String),
    );
    // Transient, not permanent: nothing for the user to do, so nothing is said.
    expect(mocks.webContentsSend).not.toHaveBeenCalled();

    consoleLogSpy.mockRestore();
  });

  it('counts a prerelease with no matching release but does NOT report it', () => {
    const consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    mocks.sanitizeErrorMessage.mockReturnValue('sanitized no published versions');
    // The release DESKTOP-17 arrived from.
    mocks.getVersion.mockReturnValue('0.41.0-dev.1');

    const errorListener = getRegisteredListener('error');
    const noVersions = makeError(
      'No published versions on GitHub',
      'ERR_UPDATER_NO_PUBLISHED_VERSIONS',
    );
    errorListener(noVersions);

    expect(mocks.trackEvent).toHaveBeenCalledTimes(1);
    expect(mocks.trackEvent).toHaveBeenCalledWith('app_error', {
      source: 'updater',
      message: 'sanitized no published versions',
    });
    expect(mocks.reportHandledError).not.toHaveBeenCalled();
    expect(consoleLogSpy).toHaveBeenCalledWith(
      expect.stringContaining(
        '[UPDATER] Counting but not reporting a prerelease with no matching release:',
      ),
      expect.any(String),
    );
    // A prerelease build asking for a channel we do not publish is that
    // build's normal state; there is nothing to tell its user.
    expect(mocks.webContentsSend).not.toHaveBeenCalled();

    consoleLogSpy.mockRestore();
  });

  it('STILL reports no-published-versions on a stable build (an empty feed)', () => {
    // The case the DESKTOP-17 gate must not swallow, and the reason the
    // predicate takes the version at all. GitHubProvider throws this same
    // sentence when the Atom feed has no entries, which on a stable build
    // means our releases feed is broken. getVersion is the stable default.
    const errorListener = getRegisteredListener('error');
    const noVersions = makeError(
      'No published versions on GitHub',
      'ERR_UPDATER_NO_PUBLISHED_VERSIONS',
    );
    errorListener(noVersions);

    expect(mocks.trackEvent).toHaveBeenCalledTimes(1);
    expect(mocks.reportHandledError).toHaveBeenCalledTimes(1);
    expect(mocks.reportHandledError).toHaveBeenCalledWith(noVersions, { source: 'updater' });
  });

  it('still reports a genuine install failure on a prerelease build', () => {
    // The version conjunct gates ONE message, not the whole handler. A
    // prerelease build must stay as diagnosable as a stable one for
    // everything else.
    mocks.getVersion.mockReturnValue('0.41.0-dev.1');

    const errorListener = getRegisteredListener('error');
    const signatureFailure = makeError(
      'ERR_UPDATER_INVALID_SIGNATURE',
      'ERR_UPDATER_INVALID_SIGNATURE',
    );
    errorListener(signatureFailure);

    expect(mocks.trackEvent).toHaveBeenCalledTimes(1);
    expect(mocks.reportHandledError).toHaveBeenCalledTimes(1);
    expect(mocks.reportHandledError).toHaveBeenCalledWith(signatureFailure, { source: 'updater' });
  });

  it('still reports an install failure that came back through the same front-end', () => {
    const errorListener = getRegisteredListener('error');
    // Same front-end name, different exit code: pkexec authorized fine and the
    // package manager underneath it failed, so pkexec handed back that
    // program's own code. The exit-code restriction is what has to do the work
    // here, since the name alone matches. This is the case the gate must NOT
    // swallow.
    const installFailure = makeError('Command pkexec exited with code 1');
    errorListener(installFailure);

    expect(mocks.trackEvent).toHaveBeenCalledTimes(1);
    expect(mocks.reportHandledError).toHaveBeenCalledTimes(1);
    expect(mocks.reportHandledError).toHaveBeenCalledWith(installFailure, { source: 'updater' });
  });

  it('still reports a feed error with no transient cause (a real broken feed)', () => {
    const errorListener = getRegisteredListener('error');
    // Same wrapper code, but the nested text is a parse failure rather than a
    // network blip. This is the case the new gate must NOT swallow.
    const malformed = makeError(
      'Cannot parse releases feed: Error: Unexpected token < in JSON at position 0',
      'ERR_UPDATER_INVALID_RELEASE_FEED',
    );
    errorListener(malformed);

    expect(mocks.trackEvent).toHaveBeenCalledTimes(1);
    expect(mocks.reportHandledError).toHaveBeenCalledTimes(1);
    expect(mocks.reportHandledError).toHaveBeenCalledWith(malformed, { source: 'updater' });
  });

  it('classifies the FIRST download failure, before downloadRetrying is set', async () => {
    // Load-bearing for DESKTOP-1A reaching the user at all. On macOS the
    // read-only error arrives on the download/install path, and gate 1
    // swallows anything that lands while a retry is in flight. It only
    // escapes because MacUpdater's CONSTRUCTOR-registered forward emits
    // synchronously inside the rejecting call, while downloadRetrying is not
    // set until downloadWithRetry's catch runs a microtask later.
    //
    // Emit-then-reject is hand-written here, so what this proves is that OUR
    // handler classifies and notifies given that order, not that upstream
    // produces it. The other half - that the constructor's forward really is
    // registered before doDownloadUpdate's once("error", reject) - is read off
    // the installed MacUpdater.js in updater-error-classifier.test.ts.
    const consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const errorListener = getRegisteredListener('error');
    const readOnly = makeError('Cannot update while running on a read-only volume.');

    mocks.downloadUpdate.mockImplementationOnce(() => {
      // What electron-updater does: emit, then reject with the same error.
      errorListener(readOnly);
      return Promise.reject(readOnly);
    });
    mocks.downloadUpdate.mockResolvedValueOnce(undefined);

    const downloadPromise = downloadWithRetry();
    await vi.advanceTimersByTimeAsync(31_000);
    await downloadPromise;

    // The emit beat the flag, so the error was classified rather than dropped.
    expect(mocks.trackEvent).toHaveBeenCalledTimes(1);
    expect(mocks.webContentsSend).toHaveBeenCalledTimes(1);
    expect(mocks.webContentsSend.mock.calls[0][0]).toBe('updater:blocked');

    consoleLogSpy.mockRestore();
    consoleErrorSpy.mockRestore();
  });

  it('does NOT call trackEvent while checkRetrying is true (in-flight guard)', async () => {
    // Start a check retry cycle. First call rejects, setting checkRetrying=true
    // while the 30-second setTimeout is pending. We assert before advancing.
    mocks.checkForUpdates.mockRejectedValueOnce(makeError('DNS failure'));

    const retryPromise = checkWithRetry();
    // Flush microtasks so the rejection is processed and checkRetrying is set
    // to true before the retry timer starts waiting.
    await vi.advanceTimersByTimeAsync(0);

    const errorListener = getRegisteredListener('error');
    const structuralError = makeError('ERR_UPDATER_INVALID_SIGNATURE', 'ERR_UPDATER_INVALID_SIGNATURE');
    errorListener(structuralError);

    // The in-flight guard returned early - no trackEvent should have fired.
    expect(mocks.trackEvent).not.toHaveBeenCalled();
    expect(mocks.reportHandledError).not.toHaveBeenCalled();

    // Clean up: advance past the retry delay and resolve the pending promise.
    mocks.checkForUpdates.mockResolvedValueOnce(undefined);
    await vi.advanceTimersByTimeAsync(30_000);
    await retryPromise;
  });

  it('does NOT call trackEvent while downloadRetrying is true (in-flight guard)', async () => {
    mocks.downloadUpdate.mockRejectedValueOnce(makeError('ECONNRESET', 'ECONNRESET'));

    const retryPromise = downloadWithRetry();
    await vi.advanceTimersByTimeAsync(0);

    const errorListener = getRegisteredListener('error');
    const structuralError = makeError('ERR_UPDATER_INVALID_SIGNATURE', 'ERR_UPDATER_INVALID_SIGNATURE');
    errorListener(structuralError);

    expect(mocks.trackEvent).not.toHaveBeenCalled();
    expect(mocks.reportHandledError).not.toHaveBeenCalled();

    mocks.downloadUpdate.mockResolvedValueOnce(undefined);
    await vi.advanceTimersByTimeAsync(30_000);
    await retryPromise;
  });
});
