/**
 * Tests for updater.ts retry logic and error-handler decision tree.
 *
 * isTransientUpdaterError classifier tests live in updater-error-classifier.test.ts.
 * This file covers:
 *   - checkWithRetry(): flag transitions, retry call count, error logging
 *   - downloadWithRetry(): flag transitions, retry call count, error logging
 *   - autoUpdater.on('error') handler branches:
 *       1. checkRetrying || downloadRetrying in-flight -- no trackEvent
 *       2. isTransientUpdaterError -- no trackEvent, console.log suppression message
 *       3. structural error -- trackEvent('app_error', ...) called
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

    consoleLogSpy.mockRestore();
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

    mocks.downloadUpdate.mockResolvedValueOnce(undefined);
    await vi.advanceTimersByTimeAsync(30_000);
    await retryPromise;
  });
});
