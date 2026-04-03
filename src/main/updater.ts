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
let retrying = false;

/**
 * Check for updates with a single retry on failure. Transient network errors
 * (DNS timeout, GitHub API blip) resolve on retry without waiting 4 hours.
 */
async function checkWithRetry(): Promise<void> {
  try {
    await autoUpdater.checkForUpdates();
  } catch {
    console.log('[UPDATER] Check failed, retrying in 30s...');
    retrying = true;
    await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS));
    try {
      await autoUpdater.checkForUpdates();
    } catch (retryError) {
      console.error('[UPDATER] Check failed after retry:', retryError);
    } finally {
      retrying = false;
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

  // IPC handlers for renderer
  ipcMain.handle(IPC.UPDATE_CHECK, () => checkWithRetry());

  ipcMain.handle(IPC.UPDATE_INSTALL, () => {
    autoUpdater.quitAndInstall(true, true);
  });

  // When an update is available, start downloading immediately
  autoUpdater.on('update-available', () => {
    console.log('[UPDATER] Update available, downloading...');
    autoUpdater.downloadUpdate().catch((error) => {
      console.error('[UPDATER] Download failed:', error);
    });
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
  autoUpdater.on('error', (error) => {
    console.error('[UPDATER] Error:', error);
    if (!retrying) {
      trackEvent('app_error', {
        source: 'updater',
        message: sanitizeErrorMessage(error.message),
      });
    }
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
