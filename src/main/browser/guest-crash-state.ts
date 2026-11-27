import type { WebContents } from 'electron';

/**
 * The last `render-process-gone` reason of each browser guest (task #1226).
 *
 * Two readers. A drive refused with `page-crashed` says WHY the page stopped,
 * and the crashed-surface push (`ipc/handlers/browser.ts`) tells every window
 * which owners' pages are stopped, so the Browser pill's badge and the card
 * globes turn red wherever the page runs: a pane in this window or another, or
 * an offscreen lane no renderer can see.
 *
 * Electron's own `webContents.isCrashed()` stays the liveness answer for a drive:
 * `withGuest` asks `isGuestCrashed`, which reads both, so a crash this module
 * never heard of still refuses the drive, just with "crashed" for its words.
 *
 * Tracked from construction for both kinds of surface: the `<webview>` branch
 * of `web-contents-created` in `src/main/index.ts`, and the lane manager's
 * offscreen guest. An entry clears on the guest's next `dom-ready` (a reload or
 * a navigation revived it) and goes with the guest on `destroyed`. Every change
 * calls the listener, so the push is sent on the change itself.
 */
const lastCrashReason = new Map<number, string>();

/**
 * Called after any change to which guests are crashed. Injected rather than
 * imported, the lane manager's `setLaneChangeListener` shape: this module is
 * loaded in unit tests with no window plumbing, and a null listener is inert.
 */
let crashChangeListener: (() => void) | null = null;

export function setGuestCrashChangeListener(listener: (() => void) | null): void {
  crashChangeListener = listener;
}

function announceCrashChange(): void {
  try {
    crashChangeListener?.();
  } catch (error) {
    // report-ok: the listener is the push's broadcast, which reports its own failures; a throw
    // here must not stop the crash being recorded for the drive refusal.
    console.warn('[browser-crash] crash-change listener failed:', error);
  }
}

export function trackGuestCrash(webContents: WebContents): void {
  const webContentsId = webContents.id;
  webContents.on('render-process-gone', (_event, details) => {
    lastCrashReason.set(webContentsId, details.reason);
    announceCrashChange();
  });
  webContents.on('dom-ready', () => {
    if (lastCrashReason.delete(webContentsId)) announceCrashChange();
  });
  webContents.once('destroyed', () => {
    if (lastCrashReason.delete(webContentsId)) announceCrashChange();
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
