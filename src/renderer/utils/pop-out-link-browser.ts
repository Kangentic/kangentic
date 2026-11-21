/**
 * The Kangentic browser of an owner (a task, or a Command Terminal's slot)
 * whose Browser pane is in a window of its own.
 *
 * That window runs its own renderer with its own session store, so the
 * `requestBrowserNavigate` a docked pane takes a link through never reaches it.
 * The click goes to main instead, which relays the URL to that window and
 * raises it (`src/main/browser/pop-out-link-relay.ts`). Nothing in this window
 * changes: the in-app pane stays closed while its pop-out is open.
 *
 * When main finds no window (it closed between the hover and the click, before
 * this window heard), the link opens in the default browser, so the click is
 * never lost.
 */

import type { TerminalLinkBrowser } from './terminal-links/link-targets';
import { reportRendererFailure } from './renderer-failure';

function openInDefaultBrowser(url: string): void {
  void window.electronAPI.shell.openExternal(url);
}

export function popOutLinkBrowser(
  projectId: string,
  ownerKey: string,
  openExternal: (url: string) => void = openInDefaultBrowser,
): TerminalLinkBrowser {
  return {
    open: (url) => {
      window.electronAPI.browser.navigatePopOut(projectId, ownerKey, url)
        .then((relayed) => {
          if (!relayed) openExternal(url);
        })
        .catch((error: unknown) => {
          reportRendererFailure('browser', 'pop_out_link', error);
          openExternal(url);
        });
    },
  };
}
