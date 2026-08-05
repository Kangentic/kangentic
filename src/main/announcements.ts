import { app, BrowserWindow, ipcMain } from 'electron';
import { IPC } from '../shared/ipc-channels';
import {
  ANNOUNCEMENTS_URL,
  parseAnnouncementsFeed,
  selectActiveAnnouncements,
  type Announcement,
} from '../shared/announcements';

const CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000; // 4 hours, matching the updater cadence
const INITIAL_DELAY_MS = 10_000; // after the updater's 5s first check
const FETCH_TIMEOUT_MS = 10_000;

let checkTimeout: ReturnType<typeof setTimeout> | null = null;
let checkInterval: ReturnType<typeof setInterval> | null = null;
let announcementsWindow: BrowserWindow | null = null;
let cachedActive: Announcement[] = [];

/**
 * Fetch the announcements feed, filter it for this client, and push the
 * active list to the renderer when it changed. Never throws: every failure
 * mode (offline, DNS, timeout, non-200, malformed JSON, unusable feed) is a
 * silent skip that keeps the last-known list, following the attempt/catch/
 * degrade convention (see the relay probe in ipc/handlers/mobile-bridge.ts).
 *
 * Deliberately NO trackEvent here, not even for structural failures: unlike
 * an updater download, a failed feed fetch has no user-visible consequence,
 * and most failures are offline machines. The updater's
 * isTransientUpdaterError classifier exists to separate blips from real bugs
 * in app_error telemetry; with nothing worth alerting on, the simpler
 * equivalent is to emit nothing at all.
 *
 * @internal Exported for testing.
 */
export async function checkAnnouncements(): Promise<void> {
  const url = process.env.KANGENTIC_ANNOUNCEMENTS_URL ?? ANNOUNCEMENTS_URL;
  let feed: Announcement[] | null = null;
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    if (!response.ok) {
      console.log(`[ANNOUNCEMENTS] fetch skipped: HTTP ${response.status}`);
      return;
    }
    feed = parseAnnouncementsFeed(await response.json());
  } catch (error) {
    console.log('[ANNOUNCEMENTS] fetch skipped:',
      error instanceof Error ? error.message : String(error));
    return;
  }
  if (feed === null) {
    console.log('[ANNOUNCEMENTS] fetch skipped: unusable feed');
    return;
  }

  const active = selectActiveAnnouncements(feed, {
    appVersion: app.getVersion(),
    platform: process.platform,
    now: new Date(),
  });
  // selectActiveAnnouncements sorts deterministically, so serialized equality
  // is a sound change check.
  if (JSON.stringify(active) === JSON.stringify(cachedActive)) return;
  cachedActive = active;
  if (announcementsWindow && !announcementsWindow.isDestroyed()) {
    announcementsWindow.webContents.send(IPC.ANNOUNCEMENTS_CHANGED, active);
  }
}

/**
 * Register the announcements IPC handler and start the polling timers.
 *
 * The GET handler is registered before any bail-out so the renderer's invoke
 * never rejects with `No handler registered` (same reasoning as the updater's
 * no-op handlers). Unlike the updater there is no `app.isPackaged` gate: dev
 * builds poll too, so the team dogfoods the announcements surface from
 * `npm start`. Tests are the exception: under NODE_ENV=test (set by the E2E
 * helpers) nothing is scheduled, so no test run ever touches the network.
 */
export function initAnnouncements(mainWindow: BrowserWindow): void {
  ipcMain.handle(IPC.ANNOUNCEMENTS_GET, () => cachedActive);

  if (process.env.NODE_ENV === 'test') return;

  announcementsWindow = mainWindow;

  // .unref() both timers so a 4-hour interval never keeps the event loop
  // alive past a clean quit (the pr-refresh-scheduler timer-leak rules).
  checkTimeout = setTimeout(() => {
    void checkAnnouncements();
    checkInterval = setInterval(() => {
      void checkAnnouncements();
    }, CHECK_INTERVAL_MS);
    checkInterval.unref();
  }, INITIAL_DELAY_MS);
  checkTimeout.unref();
}

/**
 * Update the window reference used for the changed-push. Called when macOS
 * recreates the window after all windows were closed (dock icon click).
 */
export function updateAnnouncementsWindow(mainWindow: BrowserWindow): void {
  announcementsWindow = mainWindow;
}

/**
 * Synchronously clear announcement timers. Called from syncShutdownCleanup().
 */
export function stopAnnouncementTimers(): void {
  if (checkTimeout) {
    clearTimeout(checkTimeout);
    checkTimeout = null;
  }
  if (checkInterval) {
    clearInterval(checkInterval);
    checkInterval = null;
  }
}
