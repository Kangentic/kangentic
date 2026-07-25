import { EXTERNAL_OPEN_SCHEMES, isAllowedExternalUrl } from '../shared/external-url';

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
