import type { ILinkHandler } from '@xterm/xterm';
import { TERMINAL_LINK_SCHEMES, isAllowedExternalUrl } from '../../shared/external-url';
import type { TerminalLinkGesture } from './terminal-links/link-gesture';
import type { TerminalLinkTargets } from './terminal-links/link-targets';

/**
 * Routes OSC 8 hyperlink activation to the browser a link hotkey names
 * (`terminal-links/link-actions.ts`) instead of xterm's built-in fallback,
 * which shows a native confirm() dialog and then opens the URL in a bare
 * chrome-less window.open() BrowserWindow.
 *
 * Opens only on a link hotkey (Ctrl or Cmd click by default), like every
 * terminal link. xterm's Linkifier activates on a plain click, and a plain click
 * in an agent's TUI expands a tool result or starts a selection, so it must not
 * also open a browser tab.
 *
 * `allowNonHttpProtocols` is deliberately left unset on the returned handler:
 * xterm's own OscLinkProvider only applies its http(s)-only filter while that
 * flag is falsy, so leaving it unset keeps that filter live as an independent
 * check alongside the one below. Do not set it without adding equivalent
 * protection here first - see the enforcement scan in
 * tests/unit/terminal-link-handler.test.ts.
 */
export function createTerminalLinkHandler(
  targets: TerminalLinkTargets,
  gesture?: Pick<TerminalLinkGesture, 'noteLinkHover' | 'noteLinkLeave'>,
): ILinkHandler {
  return {
    activate: (event, uri) => {
      const target = targets.plan().targetFor(event);
      if (target === null) return;
      if (!isAllowedExternalUrl(uri, TERMINAL_LINK_SCHEMES)) {
        console.warn(`[terminal-link-handler] Blocked link with disallowed scheme: ${uri}`);
        return;
      }
      targets.open(target, uri);
    },
    // The text xterm hands an OSC 8 hover is the link's URI, not the cells it
    // covers, which may read something else entirely ("canvas").
    hover: (event, uri, range) => gesture?.noteLinkHover({ event, range, kind: 'url', osc8Uri: uri }),
    leave: () => gesture?.noteLinkLeave(),
  };
}
