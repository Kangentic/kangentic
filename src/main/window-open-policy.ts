import {
  EMBEDDED_BROWSER_SCHEMES,
  EXTERNAL_OPEN_SCHEMES,
  isAllowedExternalUrl,
} from '../shared/external-url';
import { detectEmbeddedSignInRefusal, type EmbeddedSignInRefusal } from './browser/embedded-signin-refusal';

/**
 * Builds the `setWindowOpenHandler` callback for non-webview WebContents (the
 * main window, and any pop-out window - both fire `web-contents-created`).
 * Those contents get no window-open policy by default, so a renderer
 * `window.open()` falls through to Electron's default: spawning a bare,
 * chrome-less BrowserWindow. This handler denies that always, routing an
 * allowed URL out to the OS default browser instead.
 *
 * This is defense in depth, not the primary path for any one feature. xterm
 * OSC 8 links are claimed by `createTerminalLinkHandler` before they can reach
 * here (and gated more tightly, on TERMINAL_LINK_SCHEMES, since terminal bytes
 * are agent-controlled). What DOES still land here is any other
 * renderer-originated window.open - the realistic one being a middle-click or
 * Ctrl+click on an agent-authored markdown link, which Chromium turns into a
 * new-window request rather than the `onClick` that MarkdownRenderer
 * intercepts. That is why the allowlist here matches the shell:openExternal
 * IPC channel's (EXTERNAL_OPEN_SCHEMES, mailto: included): it is the same link,
 * and a middle-click should not resolve differently from a left-click.
 *
 * `openExternal` is injected so this stays unit-testable without importing
 * Electron's `shell` module.
 */
export function createExternalWindowOpenHandler(
  openExternal: (url: string) => Promise<void>,
): (details: { url: string }) => { action: 'deny' } {
  return ({ url }) => {
    if (!isAllowedExternalUrl(url, EXTERNAL_OPEN_SCHEMES)) {
      console.warn(`[WINDOW_OPEN] Denied window.open for disallowed URL: ${url}`);
      return { action: 'deny' };
    }
    // Deferred to the next tick so this callback stays synchronous and
    // returns its deny verdict before ShellExecute runs - Electron reads the
    // return value inline, and openExternal is not required to be cheap.
    // .catch, not a bare `void`: openExternal REJECTS when the OS has no
    // registered handler (a stock Windows box with no mail client, for
    // mailto:), and an unhandled rejection here would be picked up by the
    // process-level handler above and reported as an `app_error` telemetry
    // event - turning an expected, non-actionable outcome into crash signal.
    setImmediate(() => {
      openExternal(url).catch((openError) => {
        console.warn(`[WINDOW_OPEN] shell.openExternal failed for ${url}`, openError);
      });
    });
    return { action: 'deny' };
  };
}

// ---------------------------------------------------------------------------
// Embedded Browser pane popups (OAuth and other window.open sign-in flows)
// ---------------------------------------------------------------------------

/**
 * The pane used to deny every `window.open`, which made any site whose sign-in
 * is a popup present as a dead button with nothing in the UI to explain it. The
 * handler below allows http(s) popups instead, on terms that keep the surface
 * the old deny handler was protecting closed:
 *
 *  - The popup is CHROMED and its title is OURS, forced to the live origin. An
 *    OS title bar is the only origin indicator the window has, and a page free
 *    to name itself is exactly the phishing affordance to avoid.
 *  - Its `webPreferences` restate the guest's hardening in full. A child window
 *    inherits NONE of its opener's preferences on Electron 30 and later, so
 *    anything omitted here silently reverts to the framework default.
 *  - It shares the guest's `Session` OBJECT, not a partition string. That keeps
 *    the OAuth cookie in the same per-worktree jar, and - less obviously - keeps
 *    the popup in the opener's browsing context group, without which
 *    `window.opener`, `postMessage`, and the `popup.closed` poll that nearly
 *    every OAuth flow relies on are all severed.
 *
 * See `docs/embedded-browser.md` decisions 10 to 12.
 */

/** Live popups one pane may hold. A runaway-guard, NOT a security boundary: a
 *  page can open four at depth one as easily as four in a chain. */
export const MAX_LIVE_POPUPS_PER_PANE = 4;

/** Default OAuth-popup size, used when `window.open` names no features. */
const DEFAULT_POPUP_WIDTH = 520;
const DEFAULT_POPUP_HEIGHT = 680;
const MIN_POPUP_WIDTH = 360;
const MAX_POPUP_WIDTH = 1400;
const MIN_POPUP_HEIGHT = 400;
const MAX_POPUP_HEIGHT = 1000;

export interface WindowBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface WebviewPopupPolicy {
  /** The guest's own Session, assigned to the popup verbatim (see above). */
  guestSession: Electron.Session;
  /** The OS window hosting the guest. Resolved lazily: a pane can be popped out
   *  into its own window after this policy is built. */
  resolveParentWindow: () => Electron.BrowserWindow | null;
  /** False once this pane has been granted `MAX_LIVE_POPUPS_PER_PANE` popups. */
  hasPopupBudget: () => boolean;
  /** Called synchronously the moment a popup is ALLOWED, before Chromium has
   *  created anything. Counting here rather than at creation is what makes the
   *  cap hold against a page that calls `window.open` several times in a row:
   *  `did-create-window` fires after this handler has already answered, so a
   *  count kept there is still zero for every call in the burst. */
  onPopupGranted: () => void;
  /** Called once per popup hardened, nested ones included. The caller owns the
   *  count and wires its own `closed` release. */
  onPopupOpened: (popupWindow: Electron.BrowserWindow) => void;
  /** Injected so this module never imports Electron's `dialog`. */
  showSignInRefusalPrompt: (
    popupWindow: Electron.BrowserWindow,
    refusal: EmbeddedSignInRefusal,
  ) => void;
}

/**
 * The window title the popup carries, which is the ONLY thing telling the user
 * whose sign-in form they are looking at.
 *
 * `URL.host` rather than `hostname`, so a non-default port is visible; an http
 * origin is labelled as not secure, because a sign-in form served over http is
 * exactly the case a bare hostname would flatter.
 */
export function popupWindowTitleForUrl(rawUrl: string): string {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return 'Unknown site';
  }
  if (parsed.protocol === 'https:') return parsed.host;
  if (parsed.protocol === 'http:') return `Not secure - ${parsed.host}`;
  return 'Unknown site';
}

/**
 * Size and position for the popup, from the `window.open` features string.
 *
 * The page's requested SIZE is honored within sane bounds, because an OAuth
 * provider sizing its own consent screen is normal and useful. Its requested
 * POSITION (`left` / `top`) is deliberately ignored: a page placing its own
 * window on the screen is a phishing affordance, and centring on the host window
 * is what a user expects of a dialog their own click produced.
 */
export function popupBoundsFromFeatures(
  features: string,
  parentBounds: WindowBounds | null,
): { width: number; height: number; x?: number; y?: number } {
  const readFeature = (name: string): number | null => {
    const match = new RegExp(`(?:^|,)\\s*${name}\\s*=\\s*(\\d+)`, 'i').exec(features ?? '');
    if (!match) return null;
    const value = Number.parseInt(match[1], 10);
    return Number.isFinite(value) ? value : null;
  };
  const clamp = (value: number, low: number, high: number) => Math.max(low, Math.min(high, value));

  const width = clamp(readFeature('width') ?? DEFAULT_POPUP_WIDTH, MIN_POPUP_WIDTH, MAX_POPUP_WIDTH);
  const height = clamp(readFeature('height') ?? DEFAULT_POPUP_HEIGHT, MIN_POPUP_HEIGHT, MAX_POPUP_HEIGHT);
  if (!parentBounds) return { width, height };

  // Centred, but never above or left of the host: a popup larger than its parent
  // would otherwise be placed partly offscreen, where its title bar (the origin
  // indicator) can be the part that is clipped.
  return {
    width,
    height,
    x: Math.round(Math.max(parentBounds.x, parentBounds.x + (parentBounds.width - width) / 2)),
    y: Math.round(Math.max(parentBounds.y, parentBounds.y + (parentBounds.height - height) / 2)),
  };
}

/**
 * The `setWindowOpenHandler` for a Browser pane's `<webview>` guest, and for the
 * popups it opens (they get the same policy, so a chained identity-provider hop
 * stays in one cookie jar instead of being ejected to the system browser).
 */
export function createWebviewWindowOpenHandler(
  policy: WebviewPopupPolicy,
): (details: Electron.HandlerDetails) => Electron.WindowOpenHandlerResponse {
  return (details) => {
    // No `mailto:` here, unlike the app window's handler. Guest pages are
    // agent-navigable and `shell.openExternal` is ShellExecute on Windows; the
    // guest's own `will-navigate` already refuses non-http(s), so this is parity
    // with the pane rather than a new restriction.
    if (!isAllowedExternalUrl(details.url, EMBEDDED_BROWSER_SCHEMES)) {
      console.warn(`[WINDOW_OPEN] Denied webview popup for disallowed URL: ${details.url}`);
      return { action: 'deny' };
    }
    if (!policy.hasPopupBudget()) {
      console.warn(`[WINDOW_OPEN] Denied webview popup, pane is at its live popup limit: ${details.url}`);
      return { action: 'deny' };
    }

    const parentWindow = policy.resolveParentWindow();
    const parentBounds = parentWindow && !parentWindow.isDestroyed() ? parentWindow.getBounds() : null;

    // Consume the budget HERE, synchronously with the allow, not when the window
    // later materializes. See `onPopupGranted`.
    policy.onPopupGranted();

    return {
      action: 'allow',
      // Stated rather than inherited: the popup dies with the pane that opened
      // it, so closing a task window never strands a sign-in window behind it.
      outlivesOpener: false,
      overrideBrowserWindowOptions: {
        ...(parentWindow && !parentWindow.isDestroyed() ? { parent: parentWindow } : {}),
        modal: false,
        ...popupBoundsFromFeatures(details.features, parentBounds),
        minWidth: MIN_POPUP_WIDTH,
        minHeight: MIN_POPUP_HEIGHT,
        // Chromed, unlike every other window this app creates, because the OS
        // title bar IS the origin indicator. Seeded from the requested URL so the
        // window is labelled before its first byte loads.
        frame: true,
        autoHideMenuBar: true,
        title: popupWindowTitleForUrl(details.url),
        backgroundColor: '#ffffff',
        webPreferences: {
          // The guest's hardening, restated in full. NOT inherited on Electron
          // 30+, so an omission here is a silent revert to the default.
          // `preload` is absent rather than undefined, deliberately.
          nodeIntegration: false,
          contextIsolation: true,
          sandbox: true,
          webSecurity: true,
          webviewTag: false,
          session: policy.guestSession,
        },
      },
    };
  };
}

/**
 * Apply the pane's policy to a popup window Chromium has just created.
 *
 * Called from the EMBEDDER's `did-create-window`, which fires after
 * `web-contents-created` has already given the popup the app-window policy. This
 * runs later and `setWindowOpenHandler` is a setter, so the webview policy wins.
 * That ordering is load-bearing; see the call site in `src/main/index.ts`.
 *
 * `openedUrl` comes from `DidCreateWindowDetails.url` rather than being tracked
 * on the policy: two `window.open` calls can be in flight at once, and a shared
 * mutable field would let one popup be labelled with the other's origin, which is
 * the single thing this window's security story rests on.
 */
export function hardenWebviewPopupWindow(
  popupWindow: Electron.BrowserWindow,
  openedUrl: string,
  policy: WebviewPopupPolicy,
): void {
  if (popupWindow.isDestroyed()) return;
  policy.onPopupOpened(popupWindow);
  const popupContents = popupWindow.webContents;

  // The page must never control the title: it is the origin display.
  //
  // Note there is no synchronous call here. `getURL()` is still '' at this point,
  // so re-asserting now would replace the good constructor title with
  // 'Unknown site' until the first navigation commits.
  const applyOriginTitle = () => {
    if (popupWindow.isDestroyed()) return;
    popupWindow.setTitle(popupWindowTitleForUrl(popupContents.getURL()));
  };
  popupWindow.on('page-title-updated', (titleEvent) => {
    titleEvent.preventDefault();
    applyOriginTitle();
  });
  popupContents.on('did-navigate', applyOriginTitle);
  popupContents.on('did-navigate-in-page', applyOriginTitle);

  // Same navigation policy as the guest that opened it.
  popupContents.on('will-navigate', (navigationEvent, urlString) => {
    if (isAllowedExternalUrl(urlString, EMBEDDED_BROWSER_SCHEMES)) return;
    navigationEvent.preventDefault();
    console.warn(`[WINDOW_OPEN] Blocked popup navigation to disallowed URL: ${urlString}`);
  });

  // A popup may open one more popup under the identical policy, budget-capped.
  // Without this it would fall to the app-window handler and eject a chained IdP
  // hop to the system browser, where the cookies are different - silently
  // breaking the flow rather than completing it.
  popupContents.setWindowOpenHandler(createWebviewWindowOpenHandler(policy));
  popupContents.on('did-create-window', (childWindow, childDetails) => {
    hardenWebviewPopupWindow(childWindow, childDetails.url, policy);
  });

  // Surface a provider that refuses embedded browsers, once per window.
  let hasPromptedRefusal = false;
  popupContents.on('did-navigate', () => {
    if (hasPromptedRefusal || popupWindow.isDestroyed()) return;
    const refusal = detectEmbeddedSignInRefusal(popupContents.getURL(), openedUrl);
    if (!refusal) return;
    hasPromptedRefusal = true;
    policy.showSignInRefusalPrompt(popupWindow, refusal);
  });
}
