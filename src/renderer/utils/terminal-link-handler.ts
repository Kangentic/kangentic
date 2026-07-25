import type { ILinkHandler } from '@xterm/xterm';
import { TERMINAL_LINK_SCHEMES, isAllowedExternalUrl } from '../../shared/external-url';

/**
 * Routes OSC 8 hyperlink activation to the OS default browser instead of
 * xterm's built-in fallback, which shows a native confirm() dialog and then
 * opens the URL in a bare chrome-less window.open() BrowserWindow.
 *
 * `allowNonHttpProtocols` is deliberately left unset on the returned handler:
 * xterm's own OscLinkProvider only applies its http(s)-only filter while that
 * flag is falsy, so leaving it unset keeps that filter live as an independent
 * check alongside the one below. Do not set it without adding equivalent
 * protection here first - see the enforcement scan in
 * tests/unit/terminal-link-handler.test.ts.
 */
export function createTerminalLinkHandler(openExternal: (url: string) => void): ILinkHandler {
  return {
    activate: (_event, uri) => {
      if (!isAllowedExternalUrl(uri, TERMINAL_LINK_SCHEMES)) {
        console.warn(`[terminal-link-handler] Blocked link with disallowed scheme: ${uri}`);
        return;
      }
      openExternal(uri);
    },
  };
}
