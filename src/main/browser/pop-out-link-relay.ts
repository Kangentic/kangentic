/**
 * A user's click on a link, relayed to an owner's Browser pane that lives in a
 * window of its own.
 *
 * The pop-out window runs its own renderer with its own session store, so the
 * main window's `requestBrowserNavigate` never reaches its pane. Main sends the
 * URL to that one window, which puts it in its own store, and the pane loads it
 * the way it loads a docked link click: as its first page when it is empty, or
 * through the webview's `loadURL` when it already shows one.
 *
 * Deliberately not the `kangentic_browser_navigate` path. That one runs through
 * the CDP driver, which veils the pane as agent-driven, applies the automation
 * policy, and needs a registered guest an empty pane does not have. A user's
 * navigation never goes through the driver.
 *
 * The window is raised: it is the user's own click, and a link that loads in a
 * window behind the app looks like nothing happened. `focus` restores a
 * minimized window too.
 *
 * The main window counts a pop-out as open from the moment main creates it, so
 * a click can arrive while the window's page is still loading. A push sent then
 * reaches no listener, so the relay holds the URL until the page has loaded.
 * The preload's own listener keeps it from there until the pane subscribes.
 */

import type { BrowserWindow } from 'electron';
import { IPC } from '../../shared/ipc-channels';
import type { PopOutTaskParams } from '../../shared/pop-out';
import { EMBEDDED_BROWSER_SCHEMES, isAllowedExternalUrl } from '../../shared/external-url';

/** The part of `PopOutWindowManager` the relay uses, so a test can stand in for it. */
export interface PopOutLinkRelayWindows {
  windowFor(kind: 'browser', params: PopOutTaskParams): BrowserWindow | null;
  focus(kind: 'browser', params: PopOutTaskParams): void;
}

/**
 * Send `url` to the Browser pop-out window of `ownerKey` and raise it. Returns
 * false, sending nothing, when no such window is open or the URL is not
 * http(s); the caller then opens the default browser so the click is not lost.
 */
export function relayLinkToPopOut(
  windows: PopOutLinkRelayWindows,
  projectId: unknown,
  ownerKey: unknown,
  url: unknown,
): boolean {
  if (typeof projectId !== 'string' || projectId === '') return false;
  if (typeof ownerKey !== 'string' || ownerKey === '') return false;
  if (typeof url !== 'string' || !isAllowedExternalUrl(url, EMBEDDED_BROWSER_SCHEMES)) return false;
  const params: PopOutTaskParams = { projectId, taskId: ownerKey };
  const popOutWindow = windows.windowFor('browser', params);
  if (!popOutWindow || popOutWindow.isDestroyed() || popOutWindow.webContents.isDestroyed()) return false;
  const contents = popOutWindow.webContents;
  const send = (): void => {
    if (popOutWindow.isDestroyed() || contents.isDestroyed()) return;
    contents.send(IPC.BROWSER_NAVIGATE_REQUEST, ownerKey, url);
  };
  if (contents.isLoadingMainFrame()) contents.once('did-finish-load', send);
  else send();
  windows.focus('browser', params);
  return true;
}
