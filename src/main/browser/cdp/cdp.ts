import type { WebContents } from 'electron';
import type { QueryAllResult } from './types';

/**
 * Wraps `webContents.debugger.attach('1.3')` and exposes typed helpers
 * for the Chrome DevTools Protocol calls. Content-agnostic: it drives any
 * `WebContents` the caller hands it. Two consumers share it - the shipped
 * browser-pane driver (an embedded `<webview>` guest) and the dev-only
 * inspection bridge (the app's own main window). All CDP `sendCommand`
 * calls in the codebase route through this single module.
 *
 * Single attach per webContents. Subsequent `attach()` calls are no-ops.
 * `detach()` is wired into each consumer's synchronous shutdown path so
 * the debugger is released cleanly on app quit.
 *
 * Console.messageAdded events feed an internal ring buffer so the
 * `/console` endpoint can return the last N messages without keeping
 * a live websocket open. Buffer size is fixed at 500 entries.
 */

const CDP_VERSION = '1.3';
const CONSOLE_RING_SIZE = 500;
/** Smaller than the console ring: a page makes far fewer dialogs than logs,
 *  and a dialog is only interesting for the call or two after it fired. */
const DIALOG_RING_SIZE = 20;
/** Network is chattier than console on a dev server (every chunk, font and
 *  source map), but the interesting entries are the recent ones. */
const NETWORK_RING_SIZE = 300;

interface AttachedState {
  webContents: WebContents;
  consoleRing: ConsoleEntry[];
  /** Dialogs this session intercepted, newest last. See `dialogResponse`. */
  dialogRing: DialogEntry[];
  /**
   * How the NEXT `javascriptDialogOpening` is answered.
   *
   * There is always an answer, and that is the point. Enabling the `Page`
   * domain moves dialogs off Chromium's native UI and onto the debugger, so
   * once we listen we OWN every dialog: failing to respond leaves the page
   * blocked forever with nothing on screen to dismiss. Dismiss is the default
   * because it is the safe direction for all four types - cancel a `confirm`,
   * decline a `prompt`, and stay on the page for a `beforeunload`.
   *
   * Pre-ARMED rather than answered reactively, which is forced rather than
   * chosen: a pending dialog blocks the renderer, so the tool call that would
   * answer it could never run. The agent arms the response, then takes the
   * action that triggers it.
   */
  dialogResponse: DialogResponse;
  networkRing: NetworkEntry[];
  /**
   * In-flight requests by CDP requestId, promoted into `networkRing` when the
   * response or failure lands.
   *
   * The start timestamp is held BESIDE the entry rather than on it, so nothing
   * internal can reach the agent-facing payload: `getNetworkEntries` returns
   * pending entries too, and a `startedAt` stashed on the entry itself shipped
   * an undocumented field in the tool response. CDP timestamps are a monotonic
   * clock with an arbitrary origin, so only the DIFFERENCE between two of them
   * means anything, which is why the raw value is never reported.
   */
  networkPending: Map<string, { entry: NetworkEntry; startedAt: number | null }>;
  /**
   * Settles once `Page.enable` has been acknowledged, which is when dialog
   * interception actually starts working.
   *
   * Load-bearing, and it took a live agent to find it. The domain enables are
   * fire-and-forget and `attachDebugger` is synchronous, so `withGuest` used to
   * attach and run the tool body in the same tick. On the FIRST drive against
   * a guest that left `Page.enable` in flight - and if that first drive was a
   * click that opened a `confirm()`, the dialog raced ahead of the interceptor,
   * Chromium showed its own native modal, and the pane wedged with no agent
   * path to recovery. Every later drive was fine, which is exactly what made it
   * look like it worked: a sweep that calls a dozen tools before clicking never
   * reproduces it.
   *
   * Never rejects: a guest that refuses the command still resolves, because a
   * failed enable is not a reason to fail every drive. It only means dialogs
   * fall back to Chromium's own UI, which is where they were before.
   */
  interceptionReady: Promise<void>;
  messageListener: (event: Electron.Event, method: string, params: unknown) => void;
  detachListener: (event: Electron.Event, reason: string) => void;
  /** `Emulation.setFocusEmulationEnabled` has been sent for THIS CDP session.
   *  Lives on the attached state, not in a module Set, so it resets with the
   *  session for free: the detach listener drops this whole entry. */
  focusEmulated: boolean;
  /** The device-metrics override currently applied to THIS CDP session, or
   *  null. Not a boolean like `focusEmulated` above, because metrics are
   *  re-settable: holding the values makes a re-set idempotent, lets
   *  `clearDeviceMetrics` no-op when nothing is set, and lets a caller read
   *  back what it asked for. Rides the same WeakMap entry, so a detach
   *  re-arms it for free. */
  deviceMetrics: DeviceMetrics | null;
}

export interface DeviceMetrics {
  width: number;
  height: number;
  /** 0 means "keep the system default", which is what a Retina user's pane
   *  should stay at unless the caller explicitly asks otherwise. */
  deviceScaleFactor: number;
}

export interface ConsoleEntry {
  ts: string;
  level: 'log' | 'warn' | 'error' | 'info' | 'debug' | 'verbose';
  text: string;
  url: string | null;
  lineNumber: number | null;
}

/** A JavaScript dialog the page raised, and what we answered it with. */
export interface DialogEntry {
  ts: string;
  type: 'alert' | 'confirm' | 'prompt' | 'beforeunload';
  message: string;
  /** The `prompt()` default, when the page supplied one. */
  defaultPrompt: string | null;
  url: string | null;
  /** True when we accepted (OK), false when we dismissed (Cancel). */
  accepted: boolean;
  /** Text sent for a `prompt()`, or null. */
  promptText: string | null;
}

export interface DialogResponse {
  accept: boolean;
  promptText?: string;
  /** True for a one-shot arm, consumed by the next dialog. A persistent arm
   *  survives until the session detaches or it is armed again. */
  once: boolean;
}

/** The safe default: cancel a confirm, decline a prompt, stay on the page. */
const DEFAULT_DIALOG_RESPONSE: DialogResponse = { accept: false, once: false };

export interface NetworkEntry {
  ts: string;
  method: string;
  url: string;
  /** The CDP resource type (Document, XHR, Fetch, Script, ...), when known. */
  resourceType: string | null;
  /** Null while the request is still in flight or if it failed before a
   *  response. */
  status: number | null;
  /** Set when the request failed rather than returning a status. */
  errorText: string | null;
  /** Milliseconds from request to response or failure; null while pending. */
  durationMs: number | null;
}

const attached = new WeakMap<WebContents, AttachedState>();

export function attachDebugger(webContents: WebContents): boolean {
  if (attached.has(webContents)) return true;
  try {
    webContents.debugger.attach(CDP_VERSION);
  } catch {
    return false;
  }
  const state: AttachedState = {
    webContents,
    focusEmulated: false,
    deviceMetrics: null,
    consoleRing: [],
    dialogRing: [],
    dialogResponse: { ...DEFAULT_DIALOG_RESPONSE },
    networkRing: [],
    networkPending: new Map(),
    // Replaced below with the real `Page.enable` promise. Seeded resolved so
    // the field is never undefined for a reader that races construction.
    interceptionReady: Promise.resolve(),
    messageListener: (_event, method, params) => {
      if (method === 'Console.messageAdded') {
        const message = (params as { message: ConsoleMessage }).message;
        state.consoleRing.push({
          ts: new Date().toISOString(),
          level: normalizeLevel(message.level),
          text: message.text ?? '',
          url: message.url ?? null,
          lineNumber: typeof message.line === 'number' ? message.line : null,
        });
        while (state.consoleRing.length > CONSOLE_RING_SIZE) {
          state.consoleRing.shift();
        }
        return;
      }
      // ANSWER EVERY DIALOG. With `Page` enabled, Chromium routes dialogs here
      // instead of showing its own, so a dialog we do not answer blocks the
      // renderer with nothing on screen for the user to dismiss - every later
      // CDP command then queues behind it until the drive lock times out, and
      // the pane is wedged for good. This handler is the whole reason enabling
      // `Page` is safe.
      if (method === 'Page.javascriptDialogOpening') {
        const opening = params as {
          type?: string;
          message?: string;
          defaultPrompt?: string;
          url?: string;
        };
        const response = state.dialogResponse;
        if (response.once) state.dialogResponse = { ...DEFAULT_DIALOG_RESPONSE };
        const promptText = response.accept ? response.promptText ?? '' : undefined;
        state.dialogRing.push({
          ts: new Date().toISOString(),
          type: normalizeDialogType(opening.type),
          message: opening.message ?? '',
          defaultPrompt: opening.defaultPrompt ?? null,
          url: opening.url ?? null,
          accepted: response.accept,
          promptText: promptText ?? null,
        });
        while (state.dialogRing.length > DIALOG_RING_SIZE) state.dialogRing.shift();
        void webContents.debugger
          .sendCommand('Page.handleJavaScriptDialog', {
            accept: response.accept,
            ...(promptText === undefined ? {} : { promptText }),
          })
          .catch(() => {
            // Nothing left to try. The dialog stays up and the pane is wedged,
            // which is why this is logged rather than swallowed silently.
            console.warn('[browser-cdp] could not answer a JavaScript dialog; the pane may be blocked');
          });
        return;
      }
      if (method === 'Network.requestWillBeSent') {
        const sent = params as {
          requestId?: string;
          request?: { url?: string; method?: string };
          type?: string;
          timestamp?: number;
        };
        if (!sent.requestId) return;
        state.networkPending.set(sent.requestId, {
          entry: {
            ts: new Date().toISOString(),
            method: sent.request?.method ?? 'GET',
            url: sent.request?.url ?? '',
            resourceType: sent.type ?? null,
            status: null,
            errorText: null,
            durationMs: null,
          },
          startedAt: typeof sent.timestamp === 'number' ? sent.timestamp : null,
        });
        // BOUND the pending map. The ring is capped, but a request that never
        // settles is never deleted from here - an aborted fetch, a long poll,
        // or anything still in flight when the page navigates away. Over a
        // long session against a dev server that is a slow leak, so the oldest
        // unsettled request is dropped once there are more of them than the
        // ring itself would hold. Insertion order makes the first key the
        // oldest.
        while (state.networkPending.size > NETWORK_RING_SIZE) {
          const oldest = state.networkPending.keys().next();
          if (oldest.done) break;
          state.networkPending.delete(oldest.value);
        }
        return;
      }
      if (method === 'Network.responseReceived' || method === 'Network.loadingFailed') {
        const settled = params as {
          requestId?: string;
          response?: { status?: number };
          errorText?: string;
          timestamp?: number;
        };
        if (!settled.requestId) return;
        const pending = state.networkPending.get(settled.requestId);
        if (!pending) return;
        state.networkPending.delete(settled.requestId);
        const entry = pending.entry;
        entry.status = settled.response?.status ?? null;
        entry.errorText = settled.errorText ?? null;
        if (pending.startedAt !== null && typeof settled.timestamp === 'number') {
          entry.durationMs = Math.round((settled.timestamp - pending.startedAt) * 1000);
        }
        state.networkRing.push(entry);
        while (state.networkRing.length > NETWORK_RING_SIZE) state.networkRing.shift();
      }
    },
    detachListener: (_event, _reason) => {
      // Fires when the debugger is detached for any reason: explicit
      // `webContents.debugger.detach()` from us, the user opening
      // DevTools (which steals the connection), or the webContents being
      // destroyed. Drop the WeakMap entry so subsequent calls see "not
      // attached" instead of stale state - they'll either return null /
      // 5xx through the inspection-server, or the bridge can re-attach
      // explicitly via attachDebugger() when appropriate. We deliberately
      // do NOT auto-reattach: the typical cause is the user opening
      // DevTools, and stealing it back would be hostile.
      attached.delete(state.webContents);
    },
  };
  webContents.debugger.on('message', state.messageListener);
  webContents.debugger.on('detach', state.detachListener);
  // Enable the domains we use. Each `sendCommand` is fire-and-forget;
  // failures during enable are non-fatal and the corresponding endpoint
  // returns 5xx if its capability is missing. Console.* is technically
  // deprecated in modern CDP in favor of Runtime.consoleAPICalled, but
  // it still works on Chromium 120+ which is what current Electron ships.
  void webContents.debugger.sendCommand('Console.enable').catch(() => {});
  void webContents.debugger.sendCommand('DOM.enable').catch(() => {});
  void webContents.debugger.sendCommand('Runtime.enable').catch(() => {});
  void webContents.debugger.sendCommand('CSS.enable').catch(() => {});
  // `Network` is always on rather than enabled by the first `network` call,
  // and the cost is accepted deliberately. A dev server is chatty, so this is
  // two events per request crossing into main for the life of the pane - but
  // the ring and the in-flight map are both bounded, and the alternative was
  // measured to be worse in practice: enabling on demand makes the FIRST call
  // return an empty list for a page that has already loaded, which reads as
  // "no requests were made" rather than "I started watching just now". That
  // exact confusion happened during this tool's own bring-up.
  void webContents.debugger.sendCommand('Network.enable').catch(() => {});
  // `Page` is what moves JavaScript dialogs onto the debugger, and the
  // listener above is what keeps that safe - see `dialogResponse`. Enabling it
  // without answering every dialog would be strictly worse than not enabling
  // it at all.
  //
  // This one is AWAITED by callers (see `interceptionReady`) rather than being
  // fire-and-forget like its neighbours, because until it is acknowledged a
  // dialog still goes to Chromium's own modal and wedges the pane.
  state.interceptionReady = webContents.debugger
    .sendCommand('Page.enable')
    .then(() => undefined)
    .catch(() => undefined);
  attached.set(webContents, state);
  return true;
}

/**
 * Wait until this guest's dialog interception is actually live.
 *
 * Called by `withGuest` before it runs a tool body, so no drive can outrun
 * `Page.enable`. Resolves immediately for a guest that is already attached,
 * which is every call after the first.
 */
export async function waitForDialogInterception(webContents: WebContents): Promise<void> {
  await attached.get(webContents)?.interceptionReady;
}

export function detachDebugger(webContents: WebContents): void {
  // `before-quit` may fire after the webContents is destroyed; bail rather
  // than throw "Object has been destroyed" when touching the debugger.
  if (webContents.isDestroyed()) return;
  const state = attached.get(webContents);
  if (!state) return;
  try {
    webContents.debugger.removeListener('message', state.messageListener);
    webContents.debugger.removeListener('detach', state.detachListener);
    webContents.debugger.detach();
  } catch {
    // best-effort
  }
  attached.delete(webContents);
}

/**
 * Returns true when CDP is currently attached to the given webContents.
 * Callers can use this to fail-fast with a clear error instead of waiting
 * for the underlying sendCommand to reject.
 */
export function isDebuggerAttached(webContents: WebContents): boolean {
  return attached.has(webContents);
}

/**
 * Make a guest render and behave as a FOCUSED page, without the browser ever
 * giving it real keyboard focus.
 *
 * What it buys, stated carefully because a stronger claim here was wrong once:
 * the page BEHAVES as focused. A page that hides UI, pauses a render loop, or
 * drops a selection highlight on blur keeps working while an agent drives it,
 * and the guest's own focused element survives the renderer handing the user's
 * focus back (`src/renderer/utils/agent-input-focus-guard.ts`).
 *
 * What it does NOT do is affect input ROUTING. Measured inside a guest during a
 * drive whose keystrokes were being dropped: `document.hasFocus()` was already
 * `true` while nothing landed. Chromium routes keyboard input to the widget that
 * genuinely holds focus, and emulation does not change which widget that is - so
 * do not reach for this when a `type` call is not landing. See
 * `.claude/rules/agent-driven-focus.md` for what actually governs that.
 *
 * Idempotent per CDP session, and deliberately NOT called from
 * `attachDebugger`: the dev inspection bridge attaches through that same
 * function against Kangentic's OWN window (`src/devtools/install.ts`), where a
 * permanently-focused page would change `document.hasFocus()` under the app
 * itself. Only the browser-pane driver arms it.
 *
 * Fire-and-forget like the domain enables above: a guest that refuses the
 * command is not a reason to fail the tool call.
 *
 * See `.claude/rules/agent-driven-focus.md`.
 */
export function ensureFocusEmulation(webContents: WebContents): void {
  const state = attached.get(webContents);
  if (!state || state.focusEmulated) return;
  state.focusEmulated = true;
  void webContents.debugger
    .sendCommand('Emulation.setFocusEmulationEnabled', { enabled: true })
    .catch(() => {});
}

/**
 * Override the viewport the page lays out against, leaving the real widget
 * alone.
 *
 * This is the ONLY way to change a docked `<webview>` pane's viewport without
 * destroying it. The pane is sized by CSS flex inside the task-detail split row
 * and has no programmatic bounds API, and the tree above it cannot change shape
 * without remounting the element - which kills the guest, its `sessionStorage`,
 * and the agent's surface handle (`.claude/rules/retained-pane-never-remounts.md`).
 * An override costs none of that: no reload, no new handle, same document.
 *
 * Deliberately does NOT send the `scale` parameter. `Input.dispatchMouseEvent`
 * takes coordinates a real mouse would produce, and the whole click path
 * (`resolveClickPoint` -> `contentCentroid` -> `dispatchMouseEvent`) carries no
 * scale term. At the default scale of 1 blink's widget genuinely IS `width`
 * wide, so a box-model centroid hit-tests correctly and that question never
 * arises; at scale < 1 it would, silently, for every interact tool. Callers
 * that want the whole emulated layout visible in a smaller widget set the zoom
 * factor instead, which Chromium has always accounted for in hit-testing.
 *
 * `mobile` is mandatory in the CDP call and stays false: this is a desktop
 * viewport override, not device emulation with a mobile viewport meta and touch
 * event emulation.
 *
 * The override is CDP-session scoped, not document scoped, so it survives a
 * navigation. Clearing is the caller's job; see `viewport-override.ts` for who
 * owns that and when.
 *
 * Unlike the fire-and-forget calls above this one REPORTS failure, because a
 * caller that thinks it set a 1920px viewport and did not will report a
 * measurement taken at the wrong width.
 */
export async function setDeviceMetrics(
  webContents: WebContents,
  metrics: DeviceMetrics,
): Promise<boolean> {
  const state = attached.get(webContents);
  if (!state) return false;
  try {
    await webContents.debugger.sendCommand('Emulation.setDeviceMetricsOverride', {
      width: metrics.width,
      height: metrics.height,
      deviceScaleFactor: metrics.deviceScaleFactor,
      mobile: false,
    });
  } catch {
    return false;
  }
  state.deviceMetrics = { ...metrics };
  return true;
}

/** The override currently applied to this CDP session, or null. */
export function getDeviceMetrics(webContents: WebContents): DeviceMetrics | null {
  const state = attached.get(webContents);
  return state?.deviceMetrics ? { ...state.deviceMetrics } : null;
}

/**
 * Drop the override and let the page lay out against its real widget again.
 * A no-op when nothing is set, so a blanket clear on teardown costs one map
 * lookup rather than a CDP roundtrip.
 */
export async function clearDeviceMetrics(webContents: WebContents): Promise<boolean> {
  const state = attached.get(webContents);
  if (!state || !state.deviceMetrics) return false;
  try {
    await webContents.debugger.sendCommand('Emulation.clearDeviceMetricsOverride');
  } catch {
    return false;
  }
  state.deviceMetrics = null;
  return true;
}

interface ConsoleMessage {
  level?: string;
  text?: string;
  url?: string;
  line?: number;
}

function normalizeLevel(level: string | undefined): ConsoleEntry['level'] {
  switch (level) {
    case 'log':
    case 'warn':
    case 'error':
    case 'info':
    case 'debug':
    case 'verbose':
      return level;
    default:
      return 'log';
  }
}

export function getConsoleEntries(webContents: WebContents): ConsoleEntry[] {
  const state = attached.get(webContents);
  return state ? [...state.consoleRing] : [];
}

function normalizeDialogType(value: string | undefined): DialogEntry['type'] {
  return value === 'confirm' || value === 'prompt' || value === 'beforeunload' ? value : 'alert';
}

/** Dialogs this session intercepted and answered, oldest first. */
export function getDialogEntries(webContents: WebContents): DialogEntry[] {
  const state = attached.get(webContents);
  return state ? [...state.dialogRing] : [];
}

/**
 * Arm how the next dialog (or every later one) is answered.
 *
 * Armed AHEAD of the action rather than answered after it, because a pending
 * dialog blocks the renderer: the tool call that would answer it could not
 * run. So an agent that wants to get through a `confirm()` arms accept, then
 * clicks.
 */
export function setDialogResponse(webContents: WebContents, response: DialogResponse): boolean {
  const state = attached.get(webContents);
  if (!state) return false;
  state.dialogResponse = response;
  return true;
}

export function getDialogResponse(webContents: WebContents): DialogResponse | null {
  return attached.get(webContents)?.dialogResponse ?? null;
}

/**
 * Network activity this session saw, oldest first, settled requests followed
 * by anything still in flight.
 *
 * Pending requests are reported rather than hidden: a request that never
 * settles is usually the answer an agent is looking for (a dev server that
 * accepted the connection and went quiet), and omitting it would make the
 * list say the page finished loading when it did not.
 */
export function getNetworkEntries(webContents: WebContents): NetworkEntry[] {
  const state = attached.get(webContents);
  if (!state) return [];
  return [...state.networkRing, ...[...state.networkPending.values()].map((p) => p.entry)];
}

// ---------------------------------------------------------------------------
// Page / Screenshot
// ---------------------------------------------------------------------------

export interface ScreenshotOptions {
  format?: 'png' | 'jpeg';
  quality?: number;
  clip?: { x: number; y: number; width: number; height: number; scale?: number };
  fullPage?: boolean;
}

/**
 * `Page.captureScreenshot` waits for a composited frame, so it NEVER RESOLVES
 * when the guest is not being composited: a minimized or fully occluded host
 * window, a `visibility: hidden` or offscreen subtree. Worse than the missing
 * image, the un-settled command wedges that guest's CDP queue and every later
 * command stacks behind it, so one screenshot at the wrong moment bricks the
 * pane for the rest of the session.
 *
 * Measured on Electron 41: minimized and occluded hosts both hang indefinitely,
 * while an `opacity: 0` subtree in a visible window still composites and
 * captures normally. Occlusion is not observable from the main process, so a
 * precondition check cannot cover every case and this bound is the real
 * guarantee: the call fails cleanly and the agent gets an actionable error
 * rather than a tool call that never returns.
 */
export const SCREENSHOT_TIMEOUT_MS = 5000;

export class ScreenshotNotComposited extends Error {
  constructor() {
    // The bound is interpolated, never restated: the agent-facing message, the
    // race below, and the test all have to move together when it changes.
    super(
      `The Browser pane produced no frame within ${SCREENSHOT_TIMEOUT_MS / 1000}s, which means its window is not being composited (minimized, or fully covered by another window). Ask the user to bring the Kangentic window to the front, then retry. Other tools that do not need pixels, such as query_dom and click, still work.`,
    );
    this.name = 'ScreenshotNotComposited';
  }
}

export async function captureScreenshot(
  webContents: WebContents,
  options: ScreenshotOptions = {},
): Promise<string | null> {
  let timer: NodeJS.Timeout | undefined;
  const capture = webContents.debugger.sendCommand('Page.captureScreenshot', {
    format: options.format ?? 'png',
    quality: options.quality,
    clip: options.clip
      ? { ...options.clip, scale: options.clip.scale ?? 1 }
      : undefined,
    captureBeyondViewport: options.fullPage ?? false,
  }) as Promise<{ data: string }>;
  const bounded = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new ScreenshotNotComposited()), SCREENSHOT_TIMEOUT_MS);
  });
  try {
    const result = await Promise.race([capture, bounded]);
    return result.data ?? null;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export interface LayoutMetrics {
  /** Layout viewport in CSS pixels (matches `window.innerWidth/Height`). */
  viewportWidth: number;
  viewportHeight: number;
  /** Device pixel ratio applied by `Page.captureScreenshot` to produce raster output. */
  deviceScaleFactor: number;
  /** Full document size in CSS pixels (used by `fullPage: true` capture). */
  contentWidth: number;
  contentHeight: number;
}

/**
 * Returns the layout viewport, device scale factor, and full content size.
 * Used by the screenshot response to surface scale metadata so the agent
 * can map image-space coordinates back to viewport-space without guessing.
 */
export async function getLayoutMetrics(webContents: WebContents): Promise<LayoutMetrics | null> {
  try {
    const result = (await webContents.debugger.sendCommand('Page.getLayoutMetrics')) as {
      cssLayoutViewport?: { clientWidth: number; clientHeight: number };
      layoutViewport?: { clientWidth: number; clientHeight: number };
      cssVisualViewport?: { scale?: number };
      visualViewport?: { scale?: number };
      cssContentSize?: { width: number; height: number };
      contentSize?: { width: number; height: number };
    };
    const viewport = result.cssLayoutViewport ?? result.layoutViewport;
    const content = result.cssContentSize ?? result.contentSize;
    if (!viewport) return null;
    const deviceScaleFactorResult = (await webContents.debugger.sendCommand('Runtime.evaluate', {
      expression: 'window.devicePixelRatio',
      returnByValue: true,
    })) as { result: { value?: number } };
    const deviceScaleFactor =
      typeof deviceScaleFactorResult.result.value === 'number'
        ? deviceScaleFactorResult.result.value
        : 1;
    return {
      viewportWidth: viewport.clientWidth,
      viewportHeight: viewport.clientHeight,
      deviceScaleFactor,
      contentWidth: content?.width ?? viewport.clientWidth,
      contentHeight: content?.height ?? viewport.clientHeight,
    };
  } catch {
    return null;
  }
}

/**
 * Parse PNG/JPEG header bytes to recover the rasterized image dimensions.
 * Avoids paying for a separate CDP roundtrip just to learn what we
 * already produced. PNG dimensions live at offset 16/20; JPEG SOF
 * markers carry them in the marker payload.
 */
export function decodeImageDimensions(
  format: 'png' | 'jpeg',
  buffer: Buffer,
): { width: number; height: number } | null {
  if (format === 'png') {
    if (buffer.length < 24) return null;
    if (buffer.readUInt32BE(0) !== 0x89504e47) return null;
    return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
  }
  if (buffer.length < 4 || buffer[0] !== 0xff || buffer[1] !== 0xd8) return null;
  let offset = 2;
  while (offset < buffer.length - 9) {
    if (buffer[offset] !== 0xff) break;
    const marker = buffer[offset + 1];
    const segmentLength = buffer.readUInt16BE(offset + 2);
    const isStartOfFrame =
      marker >= 0xc0 &&
      marker <= 0xcf &&
      marker !== 0xc4 &&
      marker !== 0xc8 &&
      marker !== 0xcc;
    if (isStartOfFrame) {
      return {
        height: buffer.readUInt16BE(offset + 5),
        width: buffer.readUInt16BE(offset + 7),
      };
    }
    offset += 2 + segmentLength;
  }
  return null;
}

// ---------------------------------------------------------------------------
// DOM
// ---------------------------------------------------------------------------

interface DocumentRoot {
  root: { nodeId: number; backendNodeId: number };
}

interface QueriedNode {
  nodeId: number;
}

interface OuterHtml {
  outerHTML: string;
}

interface BoxModel {
  model: {
    width: number;
    height: number;
    border: number[];
    content: number[];
    margin: number[];
    padding: number[];
  };
}

/**
 * Selector spec parsed out of the user-supplied string. Supports the
 * standard CSS form plus three convenience prefixes that match
 * Playwright vocabulary:
 *
 *   - `text="Cancel"` (or `text=Cancel`)         -> exact visible-text match
 *   - `text*="Cancel"` (or `text*=Cancel`)       -> substring visible-text match
 *   - `aria="Cancel"` (or `aria=Cancel`)         -> accessible name match
 *   - `:has-text("Cancel")`                       -> alias for text*=
 *
 * Anything that doesn't match those prefixes falls through to plain
 * CSS, so existing callers continue to work without changes.
 */
interface SelectorSpec {
  kind: 'css' | 'text' | 'text-contains' | 'aria';
  value: string;
}

const TEXT_RE = /^text=(?:"([^"]*)"|'([^']*)'|(.+))$/;
const TEXT_CONTAINS_RE = /^text\*=(?:"([^"]*)"|'([^']*)'|(.+))$/;
const ARIA_RE = /^aria=(?:"([^"]*)"|'([^']*)'|(.+))$/;
const HAS_TEXT_RE = /:has-text\((?:"([^"]*)"|'([^']*)')\)/;

export function parseSelectorSpec(selector: string): SelectorSpec {
  const trimmed = selector.trim();
  let match = trimmed.match(TEXT_RE);
  if (match) return { kind: 'text', value: match[1] ?? match[2] ?? match[3] ?? '' };
  match = trimmed.match(TEXT_CONTAINS_RE);
  if (match) return { kind: 'text-contains', value: match[1] ?? match[2] ?? match[3] ?? '' };
  match = trimmed.match(ARIA_RE);
  if (match) return { kind: 'aria', value: match[1] ?? match[2] ?? match[3] ?? '' };
  match = trimmed.match(HAS_TEXT_RE);
  if (match) return { kind: 'text-contains', value: match[1] ?? match[2] ?? '' };
  return { kind: 'css', value: trimmed };
}

interface EvaluateNodeResult {
  result: { objectId?: string; subtype?: string };
  exceptionDetails?: unknown;
}

async function resolveSelector(webContents: WebContents, selector: string): Promise<number | null> {
  const spec = parseSelectorSpec(selector);
  if (spec.kind === 'css') {
    const root = (await webContents.debugger.sendCommand('DOM.getDocument', {
      depth: 0,
    })) as DocumentRoot;
    const queried = (await webContents.debugger.sendCommand('DOM.querySelector', {
      nodeId: root.root.nodeId,
      selector: spec.value,
    })) as QueriedNode;
    return queried.nodeId || null;
  }
  const expression = buildSelectorExpression(spec);
  const evalResult = (await webContents.debugger.sendCommand('Runtime.evaluate', {
    expression,
    returnByValue: false,
  })) as EvaluateNodeResult;
  if (evalResult.exceptionDetails) return null;
  const objectId = evalResult.result?.objectId;
  if (!objectId || evalResult.result.subtype === 'null') return null;
  try {
    const nodeResult = (await webContents.debugger.sendCommand('DOM.requestNode', {
      objectId,
    })) as { nodeId: number };
    return nodeResult.nodeId || null;
  } finally {
    try {
      await webContents.debugger.sendCommand('Runtime.releaseObject', { objectId });
    } catch {
      // best-effort
    }
  }
}

/**
 * Candidate pool for `text=` / `text*=` matching, shared by
 * `buildSelectorExpression` (first match) and `buildSelectorAllExpression`
 * (all matches) so the two paths cannot drift. Favors interactive / labeled
 * elements so a parent wrapper does not over-match; missing a candidate is
 * better than a benign over-match because the agent gets a clear "not found".
 */
const CANDIDATE_POOL_SELECTOR =
  'button, a, input, textarea, select, label, summary, [role], [aria-label], [aria-labelledby], [contenteditable="true"]';

/**
 * Content-named element pool for `aria=` matching: elements whose accessible
 * name derives from their text content per WAI-ARIA (button, link, heading,
 * etc.). Shared by both selector builders so the single-match and all-match
 * aria paths cannot drift.
 */
const ARIA_CONTENT_NAME_SELECTOR =
  'button, a, [role="button"], [role="link"], [role="menuitem"], [role="tab"], h1, h2, h3, h4, h5, h6';

export function buildSelectorExpression(spec: SelectorSpec): string {
  const targetLiteral = JSON.stringify(spec.value);
  const candidatesJs = `document.querySelectorAll(${JSON.stringify(CANDIDATE_POOL_SELECTOR)})`;
  if (spec.kind === 'text') {
    return `(() => {
      const target = ${targetLiteral};
      for (const element of ${candidatesJs}) {
        const ariaLabel = element.getAttribute('aria-label');
        const visibleText = (ariaLabel ?? element.innerText ?? element.textContent ?? '').trim();
        if (visibleText === target) return element;
      }
      return null;
    })()`;
  }
  if (spec.kind === 'text-contains') {
    return `(() => {
      const target = ${targetLiteral};
      for (const element of ${candidatesJs}) {
        const ariaLabel = element.getAttribute('aria-label');
        const visibleText = (ariaLabel ?? element.innerText ?? element.textContent ?? '').trim();
        if (visibleText.includes(target)) return element;
      }
      return null;
    })()`;
  }
  // aria=: prefer aria-label, fall back to text content for unlabeled
  // elements whose name derives from their content per the WAI-ARIA spec
  // (button, link, heading, etc.).
  return `(() => {
    const target = ${targetLiteral};
    for (const element of document.querySelectorAll('[aria-label]')) {
      if ((element.getAttribute('aria-label') ?? '').trim() === target) return element;
    }
    for (const element of document.querySelectorAll(${JSON.stringify(ARIA_CONTENT_NAME_SELECTOR)})) {
      const visibleText = (element.innerText ?? element.textContent ?? '').trim();
      if (visibleText === target) return element;
    }
    return null;
  })()`;
}

/**
 * Build a single self-contained expression that measures EVERY element
 * matching `spec` (unlike `buildSelectorExpression`, which returns the
 * first match). Evaluated once via `Runtime.evaluate` so N elements cost
 * one CDP round-trip. `attributes` / `outerHTML` are included only when
 * requested to keep multi-element payloads lean. Pure + exported so the
 * collection logic is unit-testable without a live window.
 */
export function buildSelectorAllExpression(
  spec: SelectorSpec,
  opts: { includeHtml: boolean; includeAttributes: boolean; limit: number; htmlMaxChars: number },
): string {
  let collectExpr: string;
  if (spec.kind === 'css') {
    collectExpr = 'Array.from(document.querySelectorAll(target))';
  } else if (spec.kind === 'text' || spec.kind === 'text-contains') {
    const comparison = spec.kind === 'text' ? 'visibleText === target' : 'visibleText.includes(target)';
    collectExpr = `Array.from(document.querySelectorAll(${JSON.stringify(CANDIDATE_POOL_SELECTOR)})).filter((element) => {
        const ariaLabel = element.getAttribute('aria-label');
        const visibleText = (ariaLabel ?? element.innerText ?? element.textContent ?? '').trim();
        return ${comparison};
      })`;
  } else {
    // aria=: aria-label matches first, then content-derived names, deduped.
    collectExpr = `(() => {
        const matched = new Set();
        for (const element of document.querySelectorAll('[aria-label]')) {
          if ((element.getAttribute('aria-label') ?? '').trim() === target) matched.add(element);
        }
        for (const element of document.querySelectorAll(${JSON.stringify(ARIA_CONTENT_NAME_SELECTOR)})) {
          const visibleText = (element.innerText ?? element.textContent ?? '').trim();
          if (visibleText === target) matched.add(element);
        }
        return Array.from(matched);
      })()`;
  }
  return `(() => {
    const target = ${JSON.stringify(spec.value)};
    const LIMIT = ${opts.limit};
    const HTML_MAX = ${opts.htmlMaxChars};
    const INCLUDE_HTML = ${opts.includeHtml ? 'true' : 'false'};
    const INCLUDE_ATTRS = ${opts.includeAttributes ? 'true' : 'false'};
    const all = ${collectExpr};
    const total = all.length;
    const elements = all.slice(0, LIMIT).map((element, index) => {
      const rect = element.getBoundingClientRect();
      const entry = {
        index,
        tag: element.tagName.toLowerCase(),
        box: {
          x: rect.x, y: rect.y, width: rect.width, height: rect.height,
          top: rect.top, right: rect.right, bottom: rect.bottom, left: rect.left,
        },
      };
      if (INCLUDE_ATTRS) {
        const attributes = {};
        for (const attribute of element.attributes) attributes[attribute.name] = attribute.value;
        entry.attributes = attributes;
      }
      if (INCLUDE_HTML) {
        const html = element.outerHTML ?? '';
        entry.outerHTML = html.length > HTML_MAX ? html.slice(0, HTML_MAX) : html;
        if (html.length > HTML_MAX) entry.outerHTMLTruncated = true;
      }
      return entry;
    });
    return {
      selector: target,
      kind: ${JSON.stringify(spec.kind)},
      total,
      returned: elements.length,
      truncated: total > elements.length,
      elements,
    };
  })()`;
}

/**
 * Measure every element matching `selector` in one round-trip. Returns
 * the raw `runtimeEvaluate` envelope so callers can distinguish an
 * evaluation error (invalid selector) from an empty match set.
 */
export async function queryAllElements(
  webContents: WebContents,
  selector: string,
  opts: { includeHtml: boolean; includeAttributes: boolean; limit: number; htmlMaxChars: number },
): Promise<{ value: QueryAllResult | null; error: string | null }> {
  const spec = parseSelectorSpec(selector);
  const expression = buildSelectorAllExpression(spec, opts);
  return runtimeEvaluate<QueryAllResult>(webContents, expression);
}

export async function getOuterHtml(
  webContents: WebContents,
  selector: string,
): Promise<string | null> {
  const nodeId = await resolveSelector(webContents, selector);
  if (!nodeId) return null;
  return getOuterHtmlByNodeId(webContents, nodeId);
}

export async function getOuterHtmlByNodeId(
  webContents: WebContents,
  nodeId: number,
): Promise<string | null> {
  const result = (await webContents.debugger.sendCommand('DOM.getOuterHTML', {
    nodeId,
  })) as OuterHtml;
  return result.outerHTML ?? null;
}

export async function getBoundingBox(
  webContents: WebContents,
  selector: string,
): Promise<BoxModel['model'] | null> {
  const nodeId = await resolveSelector(webContents, selector);
  if (!nodeId) return null;
  return getBoundingBoxByNodeId(webContents, nodeId);
}

export async function getBoundingBoxByNodeId(
  webContents: WebContents,
  nodeId: number,
): Promise<BoxModel['model'] | null> {
  try {
    const result = (await webContents.debugger.sendCommand('DOM.getBoxModel', {
      nodeId,
    })) as BoxModel;
    return result.model;
  } catch {
    return null;
  }
}

/**
 * Public selector resolver. Useful when callers want to do multiple CDP
 * operations against the same element without re-running DOM.querySelector
 * each time. Returns null when the selector doesn't match.
 */
export async function resolveSelectorPublic(
  webContents: WebContents,
  selector: string,
): Promise<number | null> {
  return resolveSelector(webContents, selector);
}

export async function getComputedStyle(
  webContents: WebContents,
  selector: string,
): Promise<Record<string, string> | null> {
  const nodeId = await resolveSelector(webContents, selector);
  if (!nodeId) return null;
  try {
    const result = (await webContents.debugger.sendCommand(
      'CSS.getComputedStyleForNode',
      { nodeId },
    )) as { computedStyle: { name: string; value: string }[] };
    const out: Record<string, string> = {};
    for (const entry of result.computedStyle) out[entry.name] = entry.value;
    return out;
  } catch {
    return null;
  }
}

export async function getAccessibilityTree(
  webContents: WebContents,
): Promise<unknown> {
  try {
    return await webContents.debugger.sendCommand('Accessibility.getFullAXTree');
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Input (mouse + keyboard)
// ---------------------------------------------------------------------------

export type MouseEventType = 'mousePressed' | 'mouseReleased' | 'mouseMoved' | 'mouseWheel';
export type MouseButton = 'none' | 'left' | 'middle' | 'right';

export interface MouseEventOptions {
  type: MouseEventType;
  x: number;
  y: number;
  button?: MouseButton;
  clickCount?: number;
  /** `mouseWheel` only: the scroll delta in CSS pixels. Ignored otherwise. */
  deltaX?: number;
  deltaY?: number;
}

export async function dispatchMouseEvent(
  webContents: WebContents,
  options: MouseEventOptions,
): Promise<void> {
  // A wheel event is a POINTER event with no button, like a move: Chromium
  // rejects `Input.dispatchMouseEvent` outright if `mouseWheel` arrives
  // carrying `button: 'left'`, and the deltas are required rather than
  // optional for it.
  const pressless = options.type === 'mouseMoved' || options.type === 'mouseWheel';
  await webContents.debugger.sendCommand('Input.dispatchMouseEvent', {
    type: options.type,
    x: options.x,
    y: options.y,
    button: options.button ?? (pressless ? 'none' : 'left'),
    clickCount: options.clickCount ?? (pressless ? 0 : 1),
    ...(options.type === 'mouseWheel'
      ? { deltaX: options.deltaX ?? 0, deltaY: options.deltaY ?? 0 }
      : {}),
  });
}

/**
 * How long a mouse move waits for its acknowledgement before the sequence
 * carries on. Chromium queues a mouse move until the next animation frame, so
 * a visible window acknowledges it within one frame (16ms at 60Hz) and this
 * bound never fires there: the move still precedes the press by a frame and a
 * hover-gated element still renders open before the press lands, exactly as
 * before. A hidden window (minimized, or fully occluded, which is where a
 * preview an agent is driving usually sits) produces no frames, and the
 * acknowledgement then waits on a fallback timer instead. Measured on
 * Electron 41 with the window minimized: 5.0s per selector click, every one
 * reported as a timeout at the MCP layer even though each landed, while a
 * coordinate click (no move) took 1-3ms; a drag paid the same 5s per
 * intermediate step. The move stays queued after the bound and is dispatched
 * in order when the press or release flushes the queue, so nothing is lost.
 *
 * A bounded wait rather than no wait at all: un-awaited moves sent back to
 * back arrive inside one frame, where Chromium coalesces consecutive moves
 * into one, which would change what a drag-and-drop library sees in a VISIBLE
 * window. The bound leaves the visible case byte-identical.
 */
const MOUSE_MOVE_ACK_TIMEOUT_MS = 100;

async function dispatchMouseMoveBounded(webContents: WebContents, x: number, y: number): Promise<void> {
  // The catch is required: a move whose acknowledgement outlives the bound
  // can still reject later (the window closing mid-sequence), and by then
  // nothing awaits it, so it would surface as an unhandled rejection in main.
  const acknowledged = dispatchMouseEvent(webContents, { type: 'mouseMoved', x, y }).catch(() => {});
  let timer: ReturnType<typeof setTimeout> | undefined;
  const bounded = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, MOUSE_MOVE_ACK_TIMEOUT_MS);
  });
  try {
    await Promise.race([acknowledged, bounded]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Bring an element into the viewport before it is measured or clicked.
 *
 * REQUIRED, not an optimization. `Input.dispatchMouseEvent` takes coordinates
 * relative to the VIEWPORT, while `DOM.getBoxModel` measures in page space - so
 * for anything below the fold the click was dispatched at a y far outside the
 * viewport and simply never landed. Measured on a real page: an element 11,122px
 * down reported that exact y, the click reported success, and the page did not
 * react at all. That is the worst shape a bug can take here, because the tool
 * told the agent it had clicked.
 *
 * Best-effort: a node that cannot be scrolled (detached, `display: none`) just
 * leaves the caller measuring what it would have measured anyway, and the caller
 * still reports honestly from the box it gets back.
 */
async function scrollNodeIntoView(webContents: WebContents, nodeId: number): Promise<void> {
  try {
    await webContents.debugger.sendCommand('DOM.scrollIntoViewIfNeeded', { nodeId });
  } catch {
    // best-effort
  }
}

/** Centroid of a box-model content quad: x0,y0, x1,y1, x2,y2, x3,y3
 *  (top-left, top-right, bottom-right, bottom-left). */
function contentCentroid(box: BoxModel['model']): { x: number; y: number } | null {
  if (!box || !Array.isArray(box.content) || box.content.length < 8) return null;
  return {
    x: (box.content[0] + box.content[4]) / 2,
    y: (box.content[1] + box.content[5]) / 2,
  };
}

/**
 * Scroll an element into view and return the viewport centroid to click.
 * Returns null when the selector does not resolve or cannot be measured.
 */
async function resolveClickPoint(
  webContents: WebContents,
  selector: string,
): Promise<{ x: number; y: number } | null> {
  const nodeId = await resolveSelector(webContents, selector);
  if (!nodeId) return null;
  await scrollNodeIntoView(webContents, nodeId);
  // Measured AFTER the scroll: the box is only meaningful once the element is
  // actually in the viewport the click coordinates address.
  const box = await getBoundingBoxByNodeId(webContents, nodeId);
  if (!box) return null;
  return contentCentroid(box);
}

export async function clickAtCenterOfSelector(
  webContents: WebContents,
  selector: string,
): Promise<boolean> {
  const point = await resolveClickPoint(webContents, selector);
  if (!point) return false;
  // A `mouseMoved` before the press, which a real pointer always produces.
  // Without it a page never sees `mouseover` / `mouseenter`, so hover-gated UI
  // (dropdown menus, hover-revealed action buttons, tooltips) is not open when
  // the press arrives and the click hits whatever is underneath instead.
  await dispatchMouseMoveBounded(webContents, point.x, point.y);
  await dispatchMouseEvent(webContents, { type: 'mousePressed', x: point.x, y: point.y });
  await dispatchMouseEvent(webContents, { type: 'mouseReleased', x: point.x, y: point.y });
  return true;
}

/**
 * Move the pointer over an element without pressing.
 *
 * `click` already sends a `mouseMoved` before its press, for the same reason
 * this exists standalone: hover-gated UI (a dropdown, a tooltip, a
 * hover-revealed button) is not open until the pointer arrives. Verifying that
 * UI is a separate act from clicking it, and there was no way to do it.
 */
export async function hoverSelector(webContents: WebContents, selector: string): Promise<boolean> {
  const point = await resolveClickPoint(webContents, selector);
  if (!point) return false;
  await dispatchMouseMoveBounded(webContents, point.x, point.y);
  return true;
}

/**
 * Scroll the page, or an element, by a wheel delta.
 *
 * The family had no scroll at all until a live agent run hit it: `eval`
 * (`window.scrollBy`) is gated off by default, and the only key that moved the
 * page was ArrowDown at about 40px a press, so "scroll down 600px" was fifteen
 * calls. `mouseWheel` is the primitive a real wheel produces, and it was
 * already MEASURED working against a guest during the lane spike (see
 * `browser-lane-manager.ts`) - it simply had no caller.
 *
 * Dispatched at an element's centroid when a selector is given, so a scrollable
 * panel scrolls rather than the page behind it. With no selector it goes to the
 * viewport centre, which is where a user's pointer effectively is for a page
 * scroll.
 */
export async function scrollBy(
  webContents: WebContents,
  options: { selector?: string; deltaX?: number; deltaY?: number },
): Promise<boolean> {
  let point: { x: number; y: number };
  if (options.selector) {
    const resolved = await resolveClickPoint(webContents, options.selector);
    if (!resolved) return false;
    point = resolved;
  } else {
    const metrics = await getLayoutMetrics(webContents);
    // Falls back to a modest fixed point rather than refusing: a guest that
    // cannot report metrics can still be scrolled, and the centre of a small
    // viewport is inside every larger one.
    point = metrics
      ? { x: Math.round(metrics.viewportWidth / 2), y: Math.round(metrics.viewportHeight / 2) }
      : { x: 200, y: 200 };
  }
  await dispatchMouseEvent(webContents, {
    type: 'mouseWheel',
    x: point.x,
    y: point.y,
    deltaX: options.deltaX ?? 0,
    deltaY: options.deltaY ?? 0,
  });
  return true;
}

/**
 * Choose an option in a native `<select>`.
 *
 * Click cannot do this, which is why it needs its own primitive: the dropdown
 * a `<select>` opens is OS chrome drawn outside the page, so a synthesized
 * mouse press reaches the control and then has nothing to aim at. Any form
 * with a dropdown was untestable.
 *
 * Sets the value and fires `input` + `change`, which is what a real choice
 * produces and what every framework listens for. `Runtime.callFunctionOn`
 * against the resolved node rather than a page-wide evaluate, so this stays a
 * scoped DOM operation on one element and does NOT need the `eval` capability
 * - the same reasoning that lets `type` write text without it.
 */
export async function selectOptionOnSelector(
  webContents: WebContents,
  selector: string,
  choice: { value?: string; label?: string; index?: number },
): Promise<{ ok: true; value: string } | { ok: false; reason: 'not-found' | 'not-a-select' | 'no-match' }> {
  const nodeId = await resolveSelector(webContents, selector);
  if (!nodeId) return { ok: false, reason: 'not-found' };
  let objectId: string | undefined;
  try {
    const resolved = (await webContents.debugger.sendCommand('DOM.resolveNode', { nodeId })) as {
      object?: { objectId?: string };
    };
    objectId = resolved.object?.objectId;
  } catch {
    return { ok: false, reason: 'not-found' };
  }
  if (!objectId) return { ok: false, reason: 'not-found' };

  const declaration = `function (value, label, index) {
    if (this.tagName !== 'SELECT') return { ok: false, reason: 'not-a-select' };
    var options = Array.prototype.slice.call(this.options);
    var match = null;
    if (typeof index === 'number') match = options[index] || null;
    else if (typeof value === 'string') match = options.filter(function (o) { return o.value === value; })[0] || null;
    else if (typeof label === 'string') match = options.filter(function (o) { return o.text.trim() === label.trim(); })[0] || null;
    if (!match) return { ok: false, reason: 'no-match' };
    this.value = match.value;
    this.dispatchEvent(new Event('input', { bubbles: true }));
    this.dispatchEvent(new Event('change', { bubbles: true }));
    return { ok: true, value: match.value };
  }`;
  try {
    const result = (await webContents.debugger.sendCommand('Runtime.callFunctionOn', {
      objectId,
      functionDeclaration: declaration,
      arguments: [{ value: choice.value }, { value: choice.label }, { value: choice.index }],
      returnByValue: true,
    })) as { result?: { value?: { ok: boolean; reason?: string; value?: string } } };
    const value = result.result?.value;
    if (!value || !value.ok) {
      return { ok: false, reason: value?.reason === 'not-a-select' ? 'not-a-select' : 'no-match' };
    }
    return { ok: true, value: value.value ?? '' };
  } catch {
    return { ok: false, reason: 'not-found' };
  }
}

export async function dragFromTo(
  webContents: WebContents,
  fromSelector: string,
  toSelector: string,
  options: { steps?: number } = {},
): Promise<boolean> {
  // Same viewport-coordinate requirement as a click: measure only after both
  // ends are scrolled into view, or a drag involving anything below the fold
  // silently does nothing. Source first, then target, because scrolling to the
  // target can move the source - so the source is re-measured last, once the
  // page has settled where the drag will actually run.
  //
  // A node id is only valid until the next `DOM.getDocument`, which re-issues
  // every id, and a CSS resolve calls it each time. So the source id is
  // resolved twice: once to scroll it, and again after the target has been
  // resolved and scrolled, right before it is measured. Holding the first id
  // across the target's resolve made every two-selector drag fail with
  // "selector did not match" (the stale id's box read as null), which the
  // caller could not tell apart from a real miss.
  const scrolledFromNodeId = await resolveSelector(webContents, fromSelector);
  if (!scrolledFromNodeId) return false;
  await scrollNodeIntoView(webContents, scrolledFromNodeId);
  const toNodeId = await resolveSelector(webContents, toSelector);
  if (!toNodeId) return false;
  await scrollNodeIntoView(webContents, toNodeId);
  const toBox = await getBoundingBoxByNodeId(webContents, toNodeId);
  const fromNodeId = await resolveSelector(webContents, fromSelector);
  if (!fromNodeId) return false;
  const fromBox = await getBoundingBoxByNodeId(webContents, fromNodeId);
  const source = fromBox ? contentCentroid(fromBox) : null;
  const target = toBox ? contentCentroid(toBox) : null;
  if (!source || !target) return false;
  const sourceX = source.x;
  const sourceY = source.y;
  const targetX = target.x;
  const targetY = target.y;
  const steps = Math.max(2, options.steps ?? 10);

  await dispatchMouseEvent(webContents, { type: 'mousePressed', x: sourceX, y: sourceY });
  for (let stepIndex = 1; stepIndex <= steps; stepIndex++) {
    const fraction = stepIndex / steps;
    // Bounded per step (see MOUSE_MOVE_ACK_TIMEOUT_MS): a ten-step drag in a
    // hidden window took 50s with each step awaiting its frame.
    await dispatchMouseMoveBounded(
      webContents,
      sourceX + (targetX - sourceX) * fraction,
      sourceY + (targetY - sourceY) * fraction,
    );
  }
  await dispatchMouseEvent(webContents, { type: 'mouseReleased', x: targetX, y: targetY });
  return true;
}

/**
 * Drop OS files on an element, the way a drag out of the file manager lands.
 *
 * `Input.dispatchDragEvent` carries a `DragData` whose `files` are absolute
 * paths; Chromium turns them into the real `File` objects a page's `drop`
 * handler reads from `dataTransfer.files`, each backed by its path, which is
 * what Electron's `webUtils.getPathForFile` resolves. That is the one hop no
 * in-page simulation can reach: a `new File()` dispatched from script has no
 * path, and the bridge object is frozen, so it could never be faked.
 *
 * The three events mirror a real drag. `dragEnter` is what lets a page arm a
 * drop target at all (Kangentic's terminal overlay switches its
 * `pointer-events` on the document's `dragenter`), `dragOver` is what sets
 * the drop effect, and `drop` delivers the files. Each is dispatched at the
 * element's viewport centroid, after the scroll-into-view every other input
 * helper here performs, for the same below-the-fold reason.
 */
export async function dropFilesOnSelector(
  webContents: WebContents,
  selector: string,
  filePaths: readonly string[],
): Promise<boolean> {
  const point = await resolveClickPoint(webContents, selector);
  if (!point) return false;
  // dragOperationsMask 1 = copy, the operation a file-manager drag offers.
  const data = { items: [], files: [...filePaths], dragOperationsMask: 1 };
  for (const type of ['dragEnter', 'dragOver', 'drop'] as const) {
    await webContents.debugger.sendCommand('Input.dispatchDragEvent', {
      type,
      x: point.x,
      y: point.y,
      data,
    });
  }
  return true;
}

export interface KeyEventOptions {
  type: 'keyDown' | 'keyUp' | 'char' | 'rawKeyDown';
  text?: string;
  key?: string;
  code?: string;
  windowsVirtualKeyCode?: number;
  modifiers?: number;
}

export async function dispatchKeyEvent(
  webContents: WebContents,
  options: KeyEventOptions,
): Promise<void> {
  await webContents.debugger.sendCommand('Input.dispatchKeyEvent', options);
}

/**
 * Type a string, one character at a time, as a real keyboard would.
 *
 * Each character sends `keyDown` / `char` / `keyUp` rather than a bare `char`.
 * The bare `char` alone delivers the text and nothing else, so a page that does
 * ANY of its work in a `keydown` handler never reacts: React inputs that filter
 * or transform keys, search-as-you-type boxes, form libraries that validate per
 * keystroke, and editors with hotkeys. Those pages took the text into the DOM
 * and then behaved as though nothing had been typed, which reads as "the agent
 * typed but the app ignored it".
 *
 * ONLY THE `char` CARRIES `text`, deliberately. In CDP a `keyDown` with a
 * non-empty `text` performs the insertion by itself (it is how Puppeteer types),
 * so carrying `text` on both would insert every character TWICE. Splitting the
 * roles - `keyDown` to fire handlers, `char` to insert - keeps the insertion
 * path exactly the one that has always worked here and adds the missing events
 * around it, so this cannot regress typing that works today.
 *
 * Special keys (Enter, Tab, arrows) still go through `dispatchKeypress`, which
 * owns the virtual-key-code mapping.
 */
export async function typeText(webContents: WebContents, text: string): Promise<void> {
  for (const character of text) {
    const keyIdentity = printableKeyIdentity(character);
    await dispatchKeyEvent(webContents, { type: 'keyDown', ...keyIdentity });
    await dispatchKeyEvent(webContents, { type: 'char', text: character });
    await dispatchKeyEvent(webContents, { type: 'keyUp', ...keyIdentity });
  }
}

/**
 * `key` / `code` / `windowsVirtualKeyCode` for a printable character, so a
 * page's `keydown` handler sees a plausible event rather than an empty one.
 *
 * Only letters, digits, and Enter get a real `code`; everything else (symbols,
 * punctuation, non-Latin text) carries `key` and the uppercased char code, which
 * is what matters to handlers keying off `event.key`. A full physical-layout map
 * would be a lie for any non-US keyboard, so it is deliberately not attempted.
 */
function printableKeyIdentity(character: string): {
  key: string;
  code?: string;
  windowsVirtualKeyCode?: number;
} {
  if (character === '\n' || character === '\r') {
    return { key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 };
  }
  const upper = character.toUpperCase();
  if (character >= 'a' && character <= 'z') {
    return { key: character, code: `Key${upper}`, windowsVirtualKeyCode: upper.charCodeAt(0) };
  }
  if (character >= 'A' && character <= 'Z') {
    return { key: character, code: `Key${character}`, windowsVirtualKeyCode: character.charCodeAt(0) };
  }
  if (character >= '0' && character <= '9') {
    return { key: character, code: `Digit${character}`, windowsVirtualKeyCode: character.charCodeAt(0) };
  }
  return { key: character, windowsVirtualKeyCode: upper.charCodeAt(0) };
}

const SPECIAL_KEY_MAP: Record<string, { code: string; key: string; vk: number }> = {
  Enter: { code: 'Enter', key: 'Enter', vk: 13 },
  Escape: { code: 'Escape', key: 'Escape', vk: 27 },
  Tab: { code: 'Tab', key: 'Tab', vk: 9 },
  Backspace: { code: 'Backspace', key: 'Backspace', vk: 8 },
  ArrowUp: { code: 'ArrowUp', key: 'ArrowUp', vk: 38 },
  ArrowDown: { code: 'ArrowDown', key: 'ArrowDown', vk: 40 },
  ArrowLeft: { code: 'ArrowLeft', key: 'ArrowLeft', vk: 37 },
  ArrowRight: { code: 'ArrowRight', key: 'ArrowRight', vk: 39 },
  Space: { code: 'Space', key: ' ', vk: 32 },
  // The page-navigation keys, added after a live agent run hit `unknown-key`
  // on all of them. They DELIVER the key to the page; they do not perform the
  // browser's default action. Measured against a live guest: two PageDowns on
  // a focused document left `scrollY` at 0, and only `scrollBy`'s wheel event
  // moved it. So these serve a page that handles the keys ITSELF - a grid, a
  // slide deck, a listbox - and `scrollBy` is what scrolls. Delete rides along
  // because a form test needs it and its absence was the same oversight.
  PageUp: { code: 'PageUp', key: 'PageUp', vk: 33 },
  PageDown: { code: 'PageDown', key: 'PageDown', vk: 34 },
  End: { code: 'End', key: 'End', vk: 35 },
  Home: { code: 'Home', key: 'Home', vk: 36 },
  Delete: { code: 'Delete', key: 'Delete', vk: 46 },
};

const MODIFIER_FLAGS: Record<string, number> = {
  Alt: 1,
  Ctrl: 2,
  Meta: 4,
  Shift: 8,
  Cmd: 4, // alias for Meta
};

/**
 * Parse a chord like `Ctrl+Shift+P` and dispatch the keyDown / keyUp
 * pair. Single-character segments fall through to `typeText` so
 * `dispatchKeypress('a')` types the letter.
 */
export async function dispatchKeypress(
  webContents: WebContents,
  combo: string,
): Promise<boolean> {
  const parts = combo.split('+').map((part) => part.trim());
  if (parts.length === 0) return false;
  const target = parts[parts.length - 1];
  const modifiers = parts.slice(0, -1);

  let modifierFlags = 0;
  for (const modifier of modifiers) {
    const flag = MODIFIER_FLAGS[modifier];
    if (flag === undefined) return false;
    modifierFlags |= flag;
  }

  const special = SPECIAL_KEY_MAP[target];
  if (special) {
    await dispatchKeyEvent(webContents, {
      type: 'keyDown',
      key: special.key,
      code: special.code,
      windowsVirtualKeyCode: special.vk,
      modifiers: modifierFlags,
    });
    await dispatchKeyEvent(webContents, {
      type: 'keyUp',
      key: special.key,
      code: special.code,
      windowsVirtualKeyCode: special.vk,
      modifiers: modifierFlags,
    });
    return true;
  }

  if (target.length === 1) {
    if (modifierFlags === 0) {
      await typeText(webContents, target);
      return true;
    }
    const upper = target.toUpperCase();
    const vk = upper.charCodeAt(0);
    // Shift alone PRODUCES TEXT; Ctrl / Alt / Meta do not.
    //
    // Without this, `Shift+a` sent a keyDown/keyUp pair carrying no `text` and
    // typed nothing at all - silently, while the tool reported success. That
    // contradicts this function's own contract, where a bare `a` types the
    // letter. A shortcut chord (`Ctrl+a`, `Meta+s`) correctly stays text-free:
    // inserting a character there would be wrong.
    //
    // Scoped to ASCII letters deliberately. `Shift+1` is `!` on a US layout and
    // something else on most others, and this has no keyboard-layout map, so
    // guessing would be a lie. Use `kangentic_browser_type` for symbols.
    const isLetter = /^[a-zA-Z]$/.test(target);
    const isShiftedLetter = modifierFlags === MODIFIER_FLAGS.Shift && isLetter;
    const shiftedText = isShiftedLetter ? upper : null;
    // `key` follows the physical keyboard, not the spelling of the chord: a real
    // Ctrl+V press reports `key: 'v'`, and Ctrl+Shift+V reports `key: 'V'`.
    // Handlers compare on it (xterm's paste chord is `key === 'v'`, its
    // Ctrl+Shift+V form is `shiftKey && key === 'V'`), so `Ctrl+V` spelled with
    // a capital used to arrive as an unknown chord and do nothing, silently.
    const shiftHeld = (modifierFlags & MODIFIER_FLAGS.Shift) !== 0;
    const key = isLetter ? (shiftHeld ? upper : target.toLowerCase()) : target;
    await dispatchKeyEvent(webContents, {
      type: 'keyDown',
      key,
      code: `Key${upper}`,
      windowsVirtualKeyCode: vk,
      modifiers: modifierFlags,
    });
    if (shiftedText) {
      // Same split as `typeText`: the keyDown fires handlers, the char inserts.
      await dispatchKeyEvent(webContents, { type: 'char', text: shiftedText });
    }
    await dispatchKeyEvent(webContents, {
      type: 'keyUp',
      key,
      code: `Key${upper}`,
      windowsVirtualKeyCode: vk,
      modifiers: modifierFlags,
    });
    return true;
  }

  return false;
}

// ---------------------------------------------------------------------------
// Runtime.evaluate
// ---------------------------------------------------------------------------

export async function runtimeEvaluate<T = unknown>(
  webContents: WebContents,
  expression: string,
  options: { awaitPromise?: boolean; returnByValue?: boolean } = {},
): Promise<{ value: T | null; error: string | null }> {
  try {
    const result = (await webContents.debugger.sendCommand('Runtime.evaluate', {
      expression,
      awaitPromise: options.awaitPromise ?? true,
      returnByValue: options.returnByValue ?? true,
    })) as { result: { value?: T }; exceptionDetails?: { text?: string } };
    if (result.exceptionDetails) {
      return { value: null, error: result.exceptionDetails.text ?? 'evaluation error' };
    }
    return { value: (result.result.value as T | undefined) ?? null, error: null };
  } catch (error) {
    return { value: null, error: error instanceof Error ? error.message : String(error) };
  }
}
