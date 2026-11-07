import { BrowserWindow, type WebContents } from 'electron';

/**
 * Keep a `<webview>` guest producing frames while its host window is covered or
 * minimized, so an agent's screenshot works with nothing on the user's screen.
 *
 * `Page.captureScreenshot` raises the capturer count with `stay_hidden=true`
 * (`page_handler.cc`), which asks a hidden guest for frames without showing it,
 * so the capture waits on a frame that never comes. Two more counts answer that,
 * and the real app needs both:
 *
 * - The GUEST with `stayHidden: false`, which counts it as visible, so it draws.
 * - The HOST with `stayHidden: true`, which keeps its compositor running without
 *   showing anything, so the guest's frames have somewhere to land.
 *
 * Measured on Electron 45.1.0, Windows, from a live agent on a parked pane, with
 * Kangentic's renderer reporting `visibilityState` hidden. macOS and Linux are
 * unmeasured, and what `hostWindowHidden` reads may differ there:
 *
 *   hold                          result      renderer
 *   guest only                    5 s bound   hidden
 *   guest + host, stayHidden      under 300 ms, stays hidden
 *   guest + host, shown           under 100 ms, flips visible four times
 *
 * So the host's count must keep `stayHidden: true`: `false` shows Kangentic's own
 * page to itself in the middle of the user's work. A bare probe window passed on
 * the guest's count alone, which is how the app shipped a case that failed.
 *
 * It has to OVERLAP the capture. One `capturePage` fired first looked fine on a
 * plain capture and then hung every other shape on a minimized host: it had
 * finished, and dropped its count, before the capture needed frames. So the
 * calls repeat until the capture ends. Each is a 1x1 copy of the last frame,
 * about 6 ms, and the hold lasts only as long as the capture does.
 *
 * Electron exposes nothing longer lived: `incrementCapturerCount` is gone.
 *
 * NOT on a window that was hidden outright (`win.hide()`, which here means the
 * quit path or macOS Cmd+H). There `capturePage` itself never settles, and an
 * unsettled one keeps its count until the window comes back, so the hold would
 * only leak. The capture's own bound answers that case.
 *
 * Only a guest has a `hostWebContents`, so a lane, which composites by itself,
 * and Kangentic's own window under the dev bridge pass straight through.
 */

/** Often enough that one call is still running when the next starts. */
const HOLD_INTERVAL_MS = 16;

/**
 * A bound on calls that have not finished, per surface. Both a settled hold and a
 * fresh one fit under it, and it stops a host hidden mid-capture, where nothing
 * settles, from stacking a call every interval until the capture's own timeout.
 */
const MAX_HOLD_CALLS_IN_FLIGHT = 2;

const HOLD_RECT = { x: 0, y: 0, width: 1, height: 1 };

/** `stayAwake` stays off: a hold that never settled must not keep the machine awake. */
const GUEST_HOLD_OPTIONS = { stayHidden: false, stayAwake: false };
const HOST_HOLD_OPTIONS = { stayHidden: true, stayAwake: false };

function hostWindowHidden(host: WebContents): boolean {
  const hostWindow = BrowserWindow.fromWebContents(host);
  if (!hostWindow) return true;
  return !hostWindow.isVisible() && !hostWindow.isMinimized();
}

function repeatCapture(contents: WebContents, options: typeof GUEST_HOLD_OPTIONS): () => void {
  let inFlight = 0;
  const hold = (): void => {
    if (inFlight >= MAX_HOLD_CALLS_IN_FLIGHT || contents.isDestroyed()) return;
    inFlight += 1;
    const release = (): void => {
      inFlight -= 1;
    };
    // A rejection only means this call took no frame. The capture it is holding
    // for still reports its own result.
    contents.capturePage(HOLD_RECT, options).then(release, release);
  };

  hold();
  const timer = setInterval(hold, HOLD_INTERVAL_MS);
  return () => clearInterval(timer);
}

/** Start holding the guest visible for a capture. Returns the function that ends it. */
export function holdGuestRendering(guest: WebContents): () => void {
  const host = guest.hostWebContents;
  if (!host || hostWindowHidden(host)) return () => undefined;

  const endHostHold = repeatCapture(host, HOST_HOLD_OPTIONS);
  const endGuestHold = repeatCapture(guest, GUEST_HOLD_OPTIONS);
  return () => {
    endHostHold();
    endGuestHold();
  };
}
