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
 * unmeasured, and what `readHostState` reads may differ there:
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
 *
 * Each side records whether any of its calls returned, for the report a capture
 * that timed out sends. DESKTOP-46's 0.60.0 event armed the hold on a visible
 * host, most likely covered for 11 minutes on Windows 10.0.26300 while
 * `speed-limit-change` fired every few seconds, and still got no frame. `none`
 * on the host says its compositor stopped answering, which the hold cannot fix.
 * `settled` on both says the hold was answered and CDP's capture hung anyway.
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

/**
 * What the hold did for one capture, kept for the report a capture that timed out
 * sends (DESKTOP-46). `skipped_hidden` covers a host window hidden outright and a
 * host with no window to read; `hostState` tells those two apart.
 */
export type CaptureHoldOutcome = 'armed' | 'skipped_hidden' | 'no_host';

/** The host window as the hold read it when the capture started. `none`: no window, or no host. */
export type CaptureHostState = 'visible' | 'minimized' | 'hidden' | 'none';

/**
 * Whether any of one side's hold calls returned, fulfilled or rejected: either way
 * that surface's compositor answered. `none` also covers a hold that never armed,
 * and a surface destroyed before any call returned, since a destroyed one is sent
 * no more calls.
 */
export type HoldSettlement = 'settled' | 'none';

export interface HoldSettlements {
  host: HoldSettlement;
  guest: HoldSettlement;
}

export interface GuestCaptureHold {
  outcome: CaptureHoldOutcome;
  hostState: CaptureHostState;
  /** Read when it is needed: at a capture's timeout, not when the hold starts. */
  settlement(): HoldSettlements;
  /** Stop holding. Safe to call when nothing was held. */
  end(): void;
}

function readHostState(host: WebContents): CaptureHostState {
  const hostWindow = BrowserWindow.fromWebContents(host);
  if (!hostWindow) return 'none';
  if (hostWindow.isMinimized()) return 'minimized';
  return hostWindow.isVisible() ? 'visible' : 'hidden';
}

interface RepeatedCapture {
  stop(): void;
  /** This one side's settlement. The pair a hold reports is `GuestCaptureHold.settlement`. */
  state(): HoldSettlement;
}

function repeatCapture(contents: WebContents, options: typeof GUEST_HOLD_OPTIONS): RepeatedCapture {
  let inFlight = 0;
  let settledCalls = 0;
  const hold = (): void => {
    if (inFlight >= MAX_HOLD_CALLS_IN_FLIGHT || contents.isDestroyed()) return;
    inFlight += 1;
    const release = (): void => {
      inFlight -= 1;
      settledCalls += 1;
    };
    // A rejection only means this call took no frame. The capture it is holding
    // for still reports its own result.
    contents.capturePage(HOLD_RECT, options).then(release, release);
  };

  hold();
  const timer = setInterval(hold, HOLD_INTERVAL_MS);
  return {
    stop: () => clearInterval(timer),
    state: () => (settledCalls > 0 ? 'settled' : 'none'),
  };
}

const NOTHING_HELD = (): void => undefined;
const NOTHING_SETTLED = (): HoldSettlements => ({ host: 'none', guest: 'none' });

/** Start holding the guest visible for a capture. Its `end` stops the hold. */
export function holdGuestRendering(guest: WebContents): GuestCaptureHold {
  const host = guest.hostWebContents;
  if (!host) return { outcome: 'no_host', hostState: 'none', settlement: NOTHING_SETTLED, end: NOTHING_HELD };
  const hostState = readHostState(host);
  // A host with no window reads as hidden: nothing says its calls would settle.
  if (hostState === 'hidden' || hostState === 'none') {
    return { outcome: 'skipped_hidden', hostState, settlement: NOTHING_SETTLED, end: NOTHING_HELD };
  }

  const hostHold = repeatCapture(host, HOST_HOLD_OPTIONS);
  const guestHold = repeatCapture(guest, GUEST_HOLD_OPTIONS);
  return {
    outcome: 'armed',
    hostState,
    settlement: () => ({ host: hostHold.state(), guest: guestHold.state() }),
    end: () => {
      hostHold.stop();
      guestHold.stop();
    },
  };
}
