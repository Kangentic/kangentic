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
 *       5. structural error - trackEvent('app_error', ...) AND reportHandledError(error, { source: 'updater' })
 *          called, gated identically (reportHandledError sits after the same three early
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
}));

vi.mock('electron', () => ({
  app: { isPackaged: true },
  BrowserWindow: class {
    isDestroyed() { return false; }
    webContents = { send: vi.fn() };
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
import { checkWithRetry, downloadWithRetry, initUpdater } from '../../src/main/updater';
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
    // Wire up listeners fresh for each test.
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
