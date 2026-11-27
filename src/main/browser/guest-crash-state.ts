import type { WebContents } from 'electron';

/**
 * The last `render-process-gone` reason of each browser guest, so a drive
 * refused with `page-crashed` can say WHY the page stopped (task #1226).
 *
 * Electron's own `webContents.isCrashed()` stays the liveness source:
 * `withGuest` asks it, and this map only supplies the words. That split keeps a
 * missed event harmless, since a crash this module never heard of still refuses
 * the drive, just with "crashed" rather than "ran out of memory".
 *
 * Tracked from construction for both kinds of surface: the `<webview>` branch
 * of `web-contents-created` in `src/main/index.ts`, and the lane manager's
 * offscreen guest. An entry clears on the guest's next `dom-ready` (a reload or
 * a navigation revived it) and goes with the guest on `destroyed`.
 */
const lastCrashReason = new Map<number, string>();

export function trackGuestCrash(webContents: WebContents): void {
  const webContentsId = webContents.id;
  webContents.on('render-process-gone', (_event, details) => {
    lastCrashReason.set(webContentsId, details.reason);
  });
  webContents.on('dom-ready', () => {
    lastCrashReason.delete(webContentsId);
  });
  webContents.once('destroyed', () => {
    lastCrashReason.delete(webContentsId);
  });
}

export function guestCrashReason(webContentsId: number): string | null {
  return lastCrashReason.get(webContentsId) ?? null;
}

/**
 * Whether the guest's page process is gone. Electron's own answer, or a crash
 * this module heard and no `dom-ready` has cleared yet.
 *
 * `isCrashed` is always present on a real WebContents. The `typeof` check is for
 * the hand-built guest doubles across the browser unit suites, which predate
 * this check and stand for live guests: one without the method reads as alive.
 */
export function isGuestCrashed(webContents: WebContents): boolean {
  if (lastCrashReason.has(webContents.id)) return true;
  return typeof webContents.isCrashed === 'function' && webContents.isCrashed();
}
