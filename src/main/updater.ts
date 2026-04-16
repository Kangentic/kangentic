import { app, BrowserWindow, ipcMain } from 'electron';
import { autoUpdater } from 'electron-updater';
import { IPC } from '../shared/ipc-channels';
import { trackEvent, sanitizeErrorMessage } from './analytics/analytics';

const CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000; // 4 hours
const INITIAL_DELAY_MS = 5000; // 5 seconds after launch
const RETRY_DELAY_MS = 30_000; // 30 seconds before retry

let checkTimeout: ReturnType<typeof setTimeout> | null = null;
let checkInterval: ReturnType<typeof setInterval> | null = null;
let updaterWindow: BrowserWindow | null = null;
let checkRetrying = false;
let downloadRetrying = false;

/**
 * Returns true if the error is a known-transient download/network failure
 * that should not surface as `app_error` telemetry. Structural failures
 * (signature mismatch, bad manifest, disk full, permission denied, 4xx
 * client errors) still propagate so real bugs stay visible.
 */
export function isTransientUpdaterError(error: Error): boolean {
  const errorCode = (error as NodeJS.ErrnoException).code;
  const errorMessage = error.message ?? '';

  if (errorCode === 'ECONNRESET' || errorCode === 'ETIMEDOUT'
      || errorCode === 'EAI_AGAIN' || errorCode === 'ENOTFOUND'
      || errorCode === 'ENETUNREACH' || errorCode === 'EPIPE') {
    return true;
  }

  if (errorCode && /^HTTP_ERROR_(5\d\d|408|429|618)$/.test(errorCode)) {
    return true;
  }

  if (/net::ERR_/.test(errorMessage)) return true;
  if (/Request has been aborted by the server/i.test(errorMessage)) return true;
  if (/Cannot pipe ".*":/i.test(errorMessage)) return true;

  return false;
}

/** @internal Exported for testing. */
export async function checkWithRetry(): Promise<void> {
  try {
    await autoUpdater.checkForUpdates();
  } catch {
    console.log('[UPDATER] Check failed, retrying in 30s...');
    checkRetrying = true;
    await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS));
    try {
      await autoUpdater.checkForUpdates();
    } catch (retryError) {
      console.error('[UPDATER] Check failed after retry:', retryError);
    } finally {
      checkRetrying = false;
    }
  }
}

/** @internal Exported for testing. */
export async function downloadWithRetry(): Promise<void> {
  try {
    await autoUpdater.downloadUpdate();
  } catch (firstError) {
    console.log('[UPDATER] Download failed, retrying in 30s:', firstError);
    downloadRetrying = true;
    try {
      await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS));
      await autoUpdater.downloadUpdate();
    } catch (retryError) {
      console.error('[UPDATER] Download failed after retry:', retryError);
    } finally {
      downloadRetrying = false;
    }
  }
}

/**
 * Initialize the auto-updater for packaged builds (Windows and macOS only).
 * Linux users update via the launcher package (`npx kangentic`).
 */
export function initUpdater(mainWindow: BrowserWindow): void {
  if (!app.isPackaged || process.platform === 'linux') return;

  updaterWindow = mainWindow;

  // We control the download -- don't auto-download on check
  autoUpdater.autoDownload = false;
  // Install pending updates silently when the user quits normally
  autoUpdater.autoInstallOnAppQuit = true;

  // macOS differential download reads a cached update.zip from
  // ~/Library/Caches/<appId>-updater/pending/, which macOS evicts under
  // disk pressure. That race produces a bare `ENOENT: no such file or
  // directory, open '<path>'` error, historically our dominant updater
  // failure. Full redownload is an acceptable tradeoff for eliminating
  // the flakiness. See MacUpdater.js:88-103 for the cached-zip read
  // path we are bypassing.
  if (process.platform === 'darwin') {
    autoUpdater.disableDifferentialDownload = true;
  }

  // IPC handlers for renderer
  ipcMain.handle(IPC.UPDATE_CHECK, () => checkWithRetry());

  ipcMain.handle(IPC.UPDATE_INSTALL, () => {
    autoUpdater.quitAndInstall(true, true);
  });

  // When an update is available, start downloading immediately (with retry).
  autoUpdater.on('update-available', () => {
    console.log('[UPDATER] Update available, downloading...');
    void downloadWithRetry();
  });

  // When download completes, notify the renderer
  autoUpdater.on('update-downloaded', (info) => {
    console.log('[UPDATER] Update downloaded:', info.version);
    if (updaterWindow && !updaterWindow.isDestroyed()) {
      updaterWindow.webContents.send(IPC.UPDATE_DOWNLOADED, { version: info.version });
    }
  });

  // Log errors but never surface to user. Skip analytics during retry to
  // avoid double-counting transient failures that resolve on second attempt.
  // Also filter known-transient failure classes so network blips and presigned
  // URL expiries do not pollute the app_error signal.
  autoUpdater.on('error', (error) => {
    console.error('[UPDATER] Error:', error);
    if (checkRetrying || downloadRetrying) return;
    if (isTransientUpdaterError(error)) {
      const errorCode = (error as NodeJS.ErrnoException).code;
      console.log('[UPDATER] Suppressing transient error telemetry:',
        errorCode ?? error.message.slice(0, 80));
      return;
    }
    trackEvent('app_error', {
      source: 'updater',
      message: sanitizeErrorMessage(error.message),
    });
  });

  // Schedule checks
  checkTimeout = setTimeout(() => {
    console.log('[UPDATER] Checking for updates...');
    checkWithRetry();

    checkInterval = setInterval(() => {
      console.log('[UPDATER] Checking for updates...');
      checkWithRetry();
    }, CHECK_INTERVAL_MS);
  }, INITIAL_DELAY_MS);
}

/**
 * Update the window reference used by the auto-updater. Called when macOS
 * recreates the window after all windows were closed (dock icon click).
 */
export function updateUpdaterWindow(mainWindow: BrowserWindow): void {
  updaterWindow = mainWindow;
}

/**
 * Synchronously clear updater timers. Called from syncShutdownCleanup().
 */
export function stopUpdaterTimers(): void {
  if (checkTimeout) {
    clearTimeout(checkTimeout);
    checkTimeout = null;
  }
  if (checkInterval) {
    clearInterval(checkInterval);
    checkInterval = null;
  }
}
