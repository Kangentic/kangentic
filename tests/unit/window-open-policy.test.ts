/**
 * Unit tests for the two window-open policies in
 * src/main/window-open-policy.ts.
 *
 * `createExternalWindowOpenHandler` is installed on non-webview WebContents (the
 * main window, and any pop-out window) in src/main/index.ts's
 * `web-contents-created` handler. It is the widest trust boundary added by
 * the terminal-links-open change: a renderer window.open() must never spawn
 * a bare, chrome-less BrowserWindow, an allowed URL must still reach the OS
 * default browser, and a disallowed URL must never reach openExternal.
 *
 * `createWebviewWindowOpenHandler` + `hardenWebviewPopupWindow` are the opposite
 * decision for the embedded Browser pane: a popup is ALLOWED, because denying it
 * made every popup-based sign-in a dead button. What makes that safe is asserted
 * below - a chromed window whose title is ours and reads the live origin, the
 * guest's hardening restated in full, and the guest's own cookie jar.
 *
 * Tier: Unit (vitest, no browser, no real Electron - openExternal is injected
 * and the window/session objects are structural fakes).
 */
import { describe, it, expect, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {
  createExternalWindowOpenHandler,
  createWebviewWindowOpenHandler,
  hardenWebviewPopupWindow,
  popupBoundsFromFeatures,
  popupWindowTitleForUrl,
  MAX_LIVE_POPUPS_PER_PANE,
  type WebviewPopupPolicy,
} from '../../src/main/window-open-policy';

// Flushes the setImmediate the handler defers openExternal into.
function flushImmediate(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

describe('createExternalWindowOpenHandler', () => {
  it.each([
    ['http', 'http://localhost:3000'],
    ['https', 'https://kangentic.com/docs'],
    ['mailto', 'mailto:someone@example.com'],
  ])('always returns deny for an allowed %s URL (never spawns the popup)', (_label, url) => {
    const openExternal = vi.fn(() => Promise.resolve());
    const handler = createExternalWindowOpenHandler(openExternal);

    const result = handler({ url });

    expect(result).toEqual({ action: 'deny' });
  });

  it.each([
    ['javascript', 'javascript:alert(1)'],
    ['file', 'file:///etc/passwd'],
    ['a windows protocol handler', 'ms-msdt:/id PCWDiagnostic'],
    ['empty string', ''],
    ['an unparseable string', 'not a url'],
  ])('returns deny for a disallowed %s URL', (_label, url) => {
    const openExternal = vi.fn(() => Promise.resolve());
    const handler = createExternalWindowOpenHandler(openExternal);

    const result = handler({ url });

    expect(result).toEqual({ action: 'deny' });
  });

  it.each([
    ['http', 'http://localhost:3000'],
    ['https', 'https://kangentic.com/docs'],
    ['mailto', 'mailto:someone@example.com'],
  ])('routes an allowed %s URL out to openExternal, deferred past the synchronous return', async (_label, url) => {
    const openExternal = vi.fn(() => Promise.resolve());
    const handler = createExternalWindowOpenHandler(openExternal);

    handler({ url });

    // Must not have been called synchronously - the callback has to return
    // its deny verdict before ShellExecute runs.
    expect(openExternal).not.toHaveBeenCalled();

    await flushImmediate();

    expect(openExternal).toHaveBeenCalledWith(url);
  });

  it.each([
    ['javascript', 'javascript:alert(1)'],
    ['file', 'file:///etc/passwd'],
    ['a windows protocol handler', 'ms-msdt:/id PCWDiagnostic'],
    ['empty string', ''],
    ['an unparseable string', 'not a url'],
  ])('never calls openExternal for a disallowed %s URL', async (_label, url) => {
    const openExternal = vi.fn(() => Promise.resolve());
    const handler = createExternalWindowOpenHandler(openExternal);

    handler({ url });
    await flushImmediate();

    expect(openExternal).not.toHaveBeenCalled();
  });

  it('warns with the [WINDOW_OPEN] prefix and does not throw when openExternal rejects', async () => {
    const rejection = new Error('no registered handler');
    const openExternal = vi.fn(() => Promise.reject(rejection));
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const handler = createExternalWindowOpenHandler(openExternal);

    handler({ url: 'mailto:someone@example.com' });
    await flushImmediate();
    // Let the rejected promise's .catch handler run.
    await flushImmediate();

    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('[WINDOW_OPEN] shell.openExternal failed for mailto:someone@example.com'),
      rejection,
    );

    warnSpy.mockRestore();
  });

  it('warns with the [WINDOW_OPEN] prefix for a denied URL', () => {
    const openExternal = vi.fn(() => Promise.resolve());
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const handler = createExternalWindowOpenHandler(openExternal);

    handler({ url: 'file:///etc/passwd' });

    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('[WINDOW_OPEN] Denied window.open for disallowed URL: file:///etc/passwd'),
    );

    warnSpy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// The embedded Browser pane's popup policy
// ---------------------------------------------------------------------------

const GUEST_SESSION = { id: 'guest-session' } as unknown as Electron.Session;

function fakeParentWindow(bounds = { x: 100, y: 50, width: 1400, height: 900 }) {
  return {
    isDestroyed: () => false,
    getBounds: () => bounds,
  } as unknown as Electron.BrowserWindow;
}

function popupPolicy(overrides: Partial<WebviewPopupPolicy> = {}): WebviewPopupPolicy {
  return {
    guestSession: GUEST_SESSION,
    resolveParentWindow: () => fakeParentWindow(),
    hasPopupBudget: () => true,
    onPopupGranted: vi.fn(),
    onPopupOpened: vi.fn(),
    showSignInRefusalPrompt: vi.fn(),
    ...overrides,
  };
}

function openDetails(overrides: Partial<Electron.HandlerDetails> = {}): Electron.HandlerDetails {
  return {
    url: 'https://accounts.google.com/o/oauth2/v2/auth',
    frameName: '',
    features: '',
    disposition: 'new-window',
    referrer: { url: '', policy: 'default' },
    postBody: undefined,
  } as Electron.HandlerDetails;
}

describe('createWebviewWindowOpenHandler - allow and deny', () => {
  it.each([
    ['https', 'https://accounts.google.com/o/oauth2/v2/auth'],
    ['http', 'http://localhost:5173/login'],
  ])('allows an %s popup', (_label, url) => {
    const result = createWebviewWindowOpenHandler(popupPolicy())({ ...openDetails(), url });
    expect(result.action).toBe('allow');
  });

  it.each([
    ['javascript', 'javascript:alert(1)'],
    ['file', 'file:///etc/passwd'],
    ['data', 'data:text/html,<h1>hi</h1>'],
    ['chrome', 'chrome://settings'],
    ['empty string', ''],
    ['an unparseable string', 'not a url'],
  ])('denies a %s popup', (_label, url) => {
    const result = createWebviewWindowOpenHandler(popupPolicy())({ ...openDetails(), url });
    expect(result).toEqual({ action: 'deny' });
  });

  it('denies mailto:, UNLIKE the app window\'s handler', () => {
    // The load-bearing divergence between the two policies in this module. Guest
    // pages are agent-navigable and shell.openExternal is ShellExecute on
    // Windows; the guest's own will-navigate already refuses non-http(s), so
    // this is parity with the pane rather than a new restriction.
    const external = createExternalWindowOpenHandler(vi.fn(() => Promise.resolve()));
    expect(external({ url: 'mailto:someone@example.com' })).toEqual({ action: 'deny' });

    const webview = createWebviewWindowOpenHandler(popupPolicy())({
      ...openDetails(),
      url: 'mailto:someone@example.com',
    });
    expect(webview).toEqual({ action: 'deny' });
    // And crucially: it did not route out to the OS either. The webview handler
    // has no openExternal path at all, which is the whole point.
  });

  it('warns with the [WINDOW_OPEN] prefix naming the denied URL', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    createWebviewWindowOpenHandler(popupPolicy())({ ...openDetails(), url: 'file:///etc/passwd' });
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('[WINDOW_OPEN] Denied webview popup for disallowed URL: file:///etc/passwd'),
    );
    warnSpy.mockRestore();
  });

  it.each(['default', 'foreground-tab', 'background-tab', 'new-window', 'other'] as const)(
    'allows an https popup for the %s disposition',
    (disposition) => {
      // target=_blank arrives as foreground-tab and window.open with features as
      // new-window. OAuth providers use both, so any branch on disposition would
      // break sign-in for whichever ones omit features. One behavior for all.
      const result = createWebviewWindowOpenHandler(popupPolicy())({ ...openDetails(), disposition });
      expect(result.action).toBe('allow');
    },
  );

  it('denies and warns once the pane is out of popup budget', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const result = createWebviewWindowOpenHandler(popupPolicy({ hasPopupBudget: () => false }))(openDetails());
    expect(result).toEqual({ action: 'deny' });
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('live popup limit'));
    warnSpy.mockRestore();
  });

  it('caps live popups at a small number', () => {
    expect(MAX_LIVE_POPUPS_PER_PANE).toBeGreaterThan(0);
    expect(MAX_LIVE_POPUPS_PER_PANE).toBeLessThanOrEqual(8);
  });

  it('consumes the budget SYNCHRONOUSLY with the allow, not when the window appears', () => {
    // The cap is otherwise bypassable: `did-create-window` fires after this
    // handler has already answered, so a page calling window.open several times
    // in a row would see a zero count on every call and blow straight past it.
    const policy = popupPolicy();
    const handler = createWebviewWindowOpenHandler(policy);

    handler(openDetails());
    handler(openDetails());

    expect(policy.onPopupGranted).toHaveBeenCalledTimes(2);
    // And nothing has been created yet, which is exactly the window in which a
    // materialized-count check would still read zero.
    expect(policy.onPopupOpened).not.toHaveBeenCalled();
  });

  it('does not consume the budget for a denied popup', () => {
    const policy = popupPolicy();
    createWebviewWindowOpenHandler(policy)({ ...openDetails(), url: 'file:///etc/passwd' });
    expect(policy.onPopupGranted).not.toHaveBeenCalled();
  });
});

describe('createWebviewWindowOpenHandler - the popup\'s window options', () => {
  function optionsFor(overrides: Partial<Electron.HandlerDetails> = {}, policy = popupPolicy()) {
    const result = createWebviewWindowOpenHandler(policy)({ ...openDetails(), ...overrides });
    if (result.action !== 'allow') throw new Error('expected the popup to be allowed');
    return result.overrideBrowserWindowOptions ?? {};
  }

  it('gives the popup the guest Session OBJECT and never a partition string', () => {
    // Not only about cookies: a popup in a different partition is in a different
    // browsing context group, which severs window.opener, postMessage, and the
    // popup.closed poll nearly every OAuth flow hands its result back through.
    const webPreferences = optionsFor().webPreferences ?? {};
    expect(webPreferences.session).toBe(GUEST_SESSION);
    expect('partition' in webPreferences).toBe(false);
  });

  it('restates the guest hardening in full and adds webviewTag: false', () => {
    // A child window inherits NONE of its opener's webPreferences on Electron
    // 30+, so anything omitted silently reverts to the framework default.
    const webPreferences = optionsFor().webPreferences ?? {};
    expect(webPreferences).toMatchObject({
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      webviewTag: false,
    });
  });

  it('sets no preload at all, absent rather than undefined', () => {
    expect('preload' in (optionsFor().webPreferences ?? {})).toBe(false);
  });

  it('opens chromed and titled with the target origin', () => {
    // The OS title bar is the popup's only origin indicator, so it is framed
    // (unlike every other window this app creates) and labelled before the first
    // byte loads.
    const options = optionsFor();
    expect(options.frame).toBe(true);
    expect(options.title).toBe('accounts.google.com');
  });

  it('does not let the popup outlive its opener', () => {
    // Sibling of overrideBrowserWindowOptions on the response, not inside it.
    const result = createWebviewWindowOpenHandler(popupPolicy())(openDetails());
    expect(result).toMatchObject({ action: 'allow', outlivesOpener: false });
  });

  it('parents the popup to the host window, non-modal', () => {
    const options = optionsFor();
    expect(options.parent).toBeDefined();
    expect(options.modal).toBe(false);
  });

  it('omits parent and position when the host window cannot be resolved', () => {
    // A popped-out pane whose window has gone: this must not throw, and must not
    // pass `parent: undefined` (which Electron treats differently from absent).
    const options = optionsFor({}, popupPolicy({ resolveParentWindow: () => null }));
    expect('parent' in options).toBe(false);
    expect(options.x).toBeUndefined();
    expect(options.y).toBeUndefined();
    expect(options.width).toBeGreaterThan(0);
  });
});

describe('popupWindowTitleForUrl', () => {
  it('shows the bare host for https', () => {
    expect(popupWindowTitleForUrl('https://accounts.google.com/o/oauth2/v2/auth')).toBe('accounts.google.com');
  });

  it('keeps a non-default port in the host', () => {
    expect(popupWindowTitleForUrl('https://auth.example.com:8443/login')).toBe('auth.example.com:8443');
  });

  it('marks http as not secure', () => {
    // A sign-in form served over http is exactly the case a bare hostname would
    // flatter.
    expect(popupWindowTitleForUrl('http://localhost:5173/login')).toBe('Not secure - localhost:5173');
  });

  it.each([
    ['an unparseable string', 'not a url'],
    ['an empty string', ''],
    ['a non-web scheme', 'file:///etc/passwd'],
  ])('falls back to a neutral label for %s', (_label, url) => {
    expect(popupWindowTitleForUrl(url)).toBe('Unknown site');
  });
});

describe('popupBoundsFromFeatures', () => {
  const parent = { x: 100, y: 50, width: 1400, height: 900 };

  it('honors width and height from the features string', () => {
    expect(popupBoundsFromFeatures('width=600,height=700', parent)).toMatchObject({ width: 600, height: 700 });
  });

  it('falls back to a default OAuth popup size when features carry none', () => {
    const bounds = popupBoundsFromFeatures('', parent);
    expect(bounds.width).toBeGreaterThan(0);
    expect(bounds.height).toBeGreaterThan(0);
  });

  it('clamps an absurd requested size into range', () => {
    const huge = popupBoundsFromFeatures('width=99999,height=99999', parent);
    expect(huge.width).toBeLessThanOrEqual(1400);
    expect(huge.height).toBeLessThanOrEqual(1000);

    const tiny = popupBoundsFromFeatures('width=1,height=1', parent);
    expect(tiny.width).toBeGreaterThanOrEqual(360);
    expect(tiny.height).toBeGreaterThanOrEqual(400);
  });

  it('centers on the host window', () => {
    const bounds = popupBoundsFromFeatures('width=600,height=700', parent);
    expect(bounds.x).toBe(100 + Math.round((1400 - 600) / 2));
    expect(bounds.y).toBe(50 + Math.round((900 - 700) / 2));
  });

  it('never positions above or left of the host window', () => {
    // A popup larger than its parent would otherwise land partly offscreen,
    // where the title bar - the origin indicator - can be the clipped part.
    const bounds = popupBoundsFromFeatures('width=1400,height=1000', { x: 100, y: 50, width: 500, height: 400 });
    expect(bounds.x).toBeGreaterThanOrEqual(100);
    expect(bounds.y).toBeGreaterThanOrEqual(50);
  });

  it('IGNORES a page-supplied left and top', () => {
    // A page choosing its own screen position is a phishing affordance.
    const bounds = popupBoundsFromFeatures('width=600,height=700,left=0,top=0', parent);
    expect(bounds.x).not.toBe(0);
    expect(bounds.y).not.toBe(0);
  });

  it('omits position entirely with no parent bounds', () => {
    const bounds = popupBoundsFromFeatures('width=600,height=700', null);
    expect(bounds.x).toBeUndefined();
    expect(bounds.y).toBeUndefined();
  });
});

/**
 * A structural stand-in for a popup BrowserWindow that records its listeners.
 *
 * Listeners are stored as ARRAYS per event, not one handler per event. The source
 * legitimately registers two separate `did-navigate` listeners (the origin-title
 * re-assert and the sign-in-refusal check), so a last-write-wins fake silently
 * drops one of them and the test for it passes or fails on registration order
 * rather than on behavior.
 */
function fakePopupWindow() {
  const windowListeners: Record<string, ((...args: never[]) => void)[]> = {};
  const contentsListeners: Record<string, ((...args: never[]) => void)[]> = {};
  const record = (
    store: Record<string, ((...args: never[]) => void)[]>,
    event: string,
    handler: (...args: never[]) => void,
  ) => {
    (store[event] ??= []).push(handler);
  };
  let currentUrl = '';
  const setTitle = vi.fn();
  const setWindowOpenHandler = vi.fn();
  return {
    setTitle,
    setWindowOpenHandler,
    navigateTo(url: string) { currentUrl = url; },
    /** Fire EVERY listener registered for the event, as Electron would. */
    emitWindow(event: string, ...args: unknown[]) {
      for (const handler of windowListeners[event] ?? []) handler(...(args as never[]));
    },
    emitContents(event: string, ...args: unknown[]) {
      for (const handler of contentsListeners[event] ?? []) handler(...(args as never[]));
    },
    contentsListenerCount(event: string) {
      return (contentsListeners[event] ?? []).length;
    },
    asWindow: {
      isDestroyed: () => false,
      setTitle,
      on: (event: string, handler: (...args: never[]) => void) => record(windowListeners, event, handler),
      webContents: {
        getURL: () => currentUrl,
        setWindowOpenHandler,
        on: (event: string, handler: (...args: never[]) => void) => record(contentsListeners, event, handler),
      },
    } as unknown as Electron.BrowserWindow,
  };
}

describe('hardenWebviewPopupWindow', () => {
  const OPENED_URL = 'https://accounts.google.com/o/oauth2/v2/auth?client_id=abc';

  it('does NOT overwrite the constructor title before the first navigation', () => {
    // getURL() is '' at hardening time, so a synchronous re-assert here would
    // replace the good constructor title with 'Unknown site' until the first
    // navigation commits.
    const popup = fakePopupWindow();
    hardenWebviewPopupWindow(popup.asWindow, OPENED_URL, popupPolicy());
    expect(popup.setTitle).not.toHaveBeenCalled();
  });

  it('stops the page setting the OS window title and re-asserts the origin', () => {
    const popup = fakePopupWindow();
    hardenWebviewPopupWindow(popup.asWindow, OPENED_URL, popupPolicy());
    popup.navigateTo('https://accounts.google.com/signin/v2/identifier');

    const preventDefault = vi.fn();
    popup.emitWindow('page-title-updated', { preventDefault });

    expect(preventDefault).toHaveBeenCalled();
    expect(popup.setTitle).toHaveBeenCalledWith('accounts.google.com');
  });

  it.each(['did-navigate', 'did-navigate-in-page'])('re-asserts the origin title on %s', (event) => {
    const popup = fakePopupWindow();
    hardenWebviewPopupWindow(popup.asWindow, OPENED_URL, popupPolicy());
    popup.navigateTo('https://login.microsoftonline.com/common/oauth2/authorize');

    popup.emitContents(event);

    expect(popup.setTitle).toHaveBeenCalledWith('login.microsoftonline.com');
  });

  it('keeps the origin title and the refusal check as SEPARATE did-navigate listeners', () => {
    // Both are registered on the same event. Pinned because a fake (or a future
    // refactor) that collapses them to one silently drops whichever came first,
    // and the symptom is a popup titled 'Unknown site' or a prompt that never
    // fires - neither of which any other assertion here would catch.
    const popup = fakePopupWindow();
    hardenWebviewPopupWindow(popup.asWindow, OPENED_URL, popupPolicy());
    expect(popup.contentsListenerCount('did-navigate')).toBe(2);
  });

  it('blocks a popup navigation to a non-http(s) scheme and warns', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const popup = fakePopupWindow();
    hardenWebviewPopupWindow(popup.asWindow, OPENED_URL, popupPolicy());

    const preventDefault = vi.fn();
    popup.emitContents('will-navigate', { preventDefault }, 'file:///etc/passwd');

    expect(preventDefault).toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('Blocked popup navigation'));
    warnSpy.mockRestore();
  });

  it('lets an https popup navigation through untouched', () => {
    const popup = fakePopupWindow();
    hardenWebviewPopupWindow(popup.asWindow, OPENED_URL, popupPolicy());

    const preventDefault = vi.fn();
    popup.emitContents('will-navigate', { preventDefault }, 'https://accounts.google.com/signin');

    expect(preventDefault).not.toHaveBeenCalled();
  });

  it('replaces the app-window open handler with the webview allow handler', () => {
    // web-contents-created has already given the popup the external policy by
    // the time this runs; setWindowOpenHandler is a setter, so this wins. Without
    // it a chained identity-provider hop is ejected to the system browser, where
    // the cookies are different, and the flow silently breaks.
    const popup = fakePopupWindow();
    hardenWebviewPopupWindow(popup.asWindow, OPENED_URL, popupPolicy());

    expect(popup.setWindowOpenHandler).toHaveBeenCalledTimes(1);
    const installed = popup.setWindowOpenHandler.mock.calls[0][0] as (details: Electron.HandlerDetails) => Electron.WindowOpenHandlerResponse;
    expect(installed(openDetails()).action).toBe('allow');
  });

  it('hardens a NESTED popup with the same policy', () => {
    const policy = popupPolicy();
    const parentPopup = fakePopupWindow();
    hardenWebviewPopupWindow(parentPopup.asWindow, OPENED_URL, policy);

    const childPopup = fakePopupWindow();
    parentPopup.emitContents('did-create-window', childPopup.asWindow, { url: 'https://idp.example.com/authorize' });

    expect(childPopup.setWindowOpenHandler).toHaveBeenCalledTimes(1);
    expect(policy.onPopupOpened).toHaveBeenCalledTimes(2);
  });

  it('reports every popup it hardens to onPopupOpened exactly once', () => {
    const policy = popupPolicy();
    const popup = fakePopupWindow();
    hardenWebviewPopupWindow(popup.asWindow, OPENED_URL, policy);
    expect(policy.onPopupOpened).toHaveBeenCalledTimes(1);
    expect(policy.onPopupOpened).toHaveBeenCalledWith(popup.asWindow);
  });

  it('does nothing to a destroyed window', () => {
    const policy = popupPolicy();
    const destroyed = { isDestroyed: () => true } as unknown as Electron.BrowserWindow;
    expect(() => hardenWebviewPopupWindow(destroyed, OPENED_URL, policy)).not.toThrow();
    expect(policy.onPopupOpened).not.toHaveBeenCalled();
  });

  it('prompts ONCE when the popup lands on a provider refusal page', () => {
    const policy = popupPolicy();
    const popup = fakePopupWindow();
    hardenWebviewPopupWindow(popup.asWindow, OPENED_URL, policy);

    popup.navigateTo('https://accounts.google.com/signin/oauth/error/v2?authError=xyz');
    popup.emitContents('did-navigate');
    popup.emitContents('did-navigate');

    expect(policy.showSignInRefusalPrompt).toHaveBeenCalledTimes(1);
    expect(policy.showSignInRefusalPrompt).toHaveBeenCalledWith(
      popup.asWindow,
      { provider: 'Google', signInUrl: OPENED_URL },
    );
  });

  it('does not prompt on an ordinary navigation', () => {
    const policy = popupPolicy();
    const popup = fakePopupWindow();
    hardenWebviewPopupWindow(popup.asWindow, OPENED_URL, policy);

    popup.navigateTo('https://accounts.google.com/signin/v2/identifier');
    popup.emitContents('did-navigate');

    expect(policy.showSignInRefusalPrompt).not.toHaveBeenCalled();
  });
});

// createExternalWindowOpenHandler is fully covered above in isolation, but
// nothing asserted it is actually WIRED into the main window's
// web-contents-created handler in src/main/index.ts. Without this scan,
// deleting the setWindowOpenHandler(createExternalWindowOpenHandler(...))
// call silently restores Electron's default: a renderer window.open() spawns
// a bare, chrome-less BrowserWindow with no policy at all. This mirrors the
// same-PR precedent in tests/unit/terminal-link-handler.test.ts (which scans
// useTerminal.ts for its linkHandler wiring) applied to the other wiring site
// this change touches, and the existing src/main/index.ts static-scan
// precedent in tests/unit/pop-out-surface-registry.test.ts.
describe('createExternalWindowOpenHandler is wired into src/main/index.ts', () => {
  it('calls setWindowOpenHandler(createExternalWindowOpenHandler(...)) for non-webview contents', () => {
    const REPO_ROOT = path.resolve(__dirname, '../..');
    const indexPath = path.join(REPO_ROOT, 'src/main/index.ts');
    const source = fs.readFileSync(indexPath, 'utf-8');

    expect(
      source,
      "src/main/index.ts must call contents.setWindowOpenHandler(createExternalWindowOpenHandler(...)) for non-webview contents, otherwise a renderer window.open() falls through to Electron's default: a bare, chrome-less BrowserWindow with no policy at all",
    ).toMatch(/setWindowOpenHandler\(\s*createExternalWindowOpenHandler\(/);
  });
});

/**
 * The webview popup policy is likewise only useful if it is WIRED. Each scan
 * below covers a piece whose deletion is silent: the popup would still open, but
 * unchromed, unlabelled, in the wrong cookie jar, or with permissions the pane
 * denies. Positive scans only - a "the old blanket deny is gone" regex passes
 * vacuously on any reformat and asserts nothing these do not.
 */
describe('the webview popup policy is wired into src/main/index.ts', () => {
  const REPO_ROOT = path.resolve(__dirname, '../..');
  const source = fs.readFileSync(path.join(REPO_ROOT, 'src/main/index.ts'), 'utf-8');

  it('installs createWebviewWindowOpenHandler on webview contents', () => {
    expect(
      source,
      'src/main/index.ts must call contents.setWindowOpenHandler(createWebviewWindowOpenHandler(...)) for webview contents, or every popup-based sign-in is a dead button again',
    ).toMatch(/setWindowOpenHandler\(\s*createWebviewWindowOpenHandler\(/);
  });

  it('hardens every popup the guest opens, via did-create-window', () => {
    expect(
      source,
      "src/main/index.ts must call hardenWebviewPopupWindow from the guest's did-create-window handler; without it the popup keeps the app-window policy, its title is page-controlled, and its origin is unverifiable",
    ).toMatch(/'did-create-window'[\s\S]{0,400}hardenWebviewPopupWindow\(/);
  });

  it('sets a permission CHECK handler alongside the request handler on the guest session', () => {
    expect(
      source,
      'src/main/index.ts must set BOTH setPermissionRequestHandler and setPermissionCheckHandler on the guest session; with only the request handler, synchronous permission checks fall through to Electron\'s default instead of the pane\'s policy',
    ).toMatch(/setPermissionCheckHandler/);
  });

  it('reads one predicate for both permission handlers', () => {
    const matches = source.match(/isEmbeddedBrowserPermissionAllowed/g) ?? [];
    expect(matches.length, 'both the request and check handlers must read isEmbeddedBrowserPermissionAllowed, so the two cannot drift').toBeGreaterThanOrEqual(2);
  });

  it('installs the download policy on the guest session', () => {
    expect(
      source,
      'src/main/index.ts must call installWebviewDownloadPolicy for the guest session, or a download falls through to Chromium\'s native save dialog, which is modal and can block an agent-driven pane',
    ).toMatch(/installWebviewDownloadPolicy\(/);
  });
});

/**
 * `allowpopups` is the other half of the popup story and lives in the renderer.
 * Without it Electron disables `window.open` inside the guest before the main
 * process ever sees the request, so every policy asserted above is unreachable
 * and nothing else in this suite would notice.
 */
describe('the Browser pane webview carries allowpopups', () => {
  it('spreads ALLOW_POPUPS_ATTRIBUTE onto the <webview>', () => {
    const REPO_ROOT = path.resolve(__dirname, '../..');
    const source = fs.readFileSync(
      path.join(REPO_ROOT, 'src/renderer/components/browser/BrowserPane.tsx'),
      'utf-8',
    );
    expect(
      source,
      'BrowserPane.tsx must spread ALLOW_POPUPS_ATTRIBUTE onto the <webview>: without the attribute Electron disables window.open in the guest outright, and the main-process popup policy never runs',
    ).toMatch(/\{\.\.\.ALLOW_POPUPS_ATTRIBUTE\}/);
  });

  it('passes it as a STRING, never a boolean', () => {
    const REPO_ROOT = path.resolve(__dirname, '../..');
    const source = fs.readFileSync(
      path.join(REPO_ROOT, 'src/renderer/components/browser/webview-types.ts'),
      'utf-8',
    );
    // React treats `webview` as an unknown element and `allowpopups` is not in
    // react-dom's attribute table, so a boolean is dropped with a console warning
    // and the attribute never reaches the DOM - silent, and behind a passing
    // typecheck.
    expect(source).toMatch(/allowpopups:\s*''/);
  });
});
