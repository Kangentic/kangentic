/**
 * Main's half of a link click for a Browser pane in a window of its own: the URL
 * goes to that one window and the window comes forward, or nothing is sent and
 * the renderer opens the default browser. A relay that sent to the wrong window,
 * answered true with no window, or sent to a page still loading (no listener
 * yet) would lose the user's click.
 */
import { describe, expect, it, vi } from 'vitest';
import type { BrowserWindow } from 'electron';
import { IPC } from '../../src/shared/ipc-channels';
import { relayLinkToPopOut, type PopOutLinkRelayWindows } from '../../src/main/browser/pop-out-link-relay';
import type { PopOutTaskParams } from '../../src/shared/pop-out';

const PROJECT_ID = 'proj-1';
const OWNER_KEY = 'task-1';
const URL_TEXT = 'https://example.com/docs';

function fakeWindow(options: { destroyed?: boolean; contentsDestroyed?: boolean; loading?: boolean } = {}) {
  const send = vi.fn();
  const loadListeners: Array<() => void> = [];
  const popOutWindow = {
    isDestroyed: () => options.destroyed === true,
    webContents: {
      isDestroyed: () => options.contentsDestroyed === true,
      isLoadingMainFrame: () => options.loading === true,
      once: (event: string, listener: () => void) => {
        if (event === 'did-finish-load') loadListeners.push(listener);
      },
      send,
    },
  } as unknown as BrowserWindow;
  const finishLoad = (): void => {
    for (const listener of loadListeners.splice(0)) listener();
  };
  return { popOutWindow, send, finishLoad };
}

function fakeWindows(windowsByOwner: Record<string, BrowserWindow>) {
  const focus = vi.fn();
  const lookups: PopOutTaskParams[] = [];
  const windows: PopOutLinkRelayWindows = {
    windowFor: (_kind, params) => {
      lookups.push(params);
      return params.projectId === PROJECT_ID ? windowsByOwner[params.taskId] ?? null : null;
    },
    focus,
  };
  return { windows, focus, lookups };
}

describe('relayLinkToPopOut', () => {
  it('sends the link to the owner\'s Browser window only, and raises that window', () => {
    const ownerWindow = fakeWindow();
    const otherWindow = fakeWindow();
    const { windows, focus, lookups } = fakeWindows({ [OWNER_KEY]: ownerWindow.popOutWindow, 'task-2': otherWindow.popOutWindow });

    expect(relayLinkToPopOut(windows, PROJECT_ID, OWNER_KEY, URL_TEXT)).toBe(true);

    expect(lookups).toEqual([{ projectId: PROJECT_ID, taskId: OWNER_KEY }]);
    expect(ownerWindow.send).toHaveBeenCalledExactlyOnceWith(IPC.BROWSER_NAVIGATE_REQUEST, OWNER_KEY, URL_TEXT);
    expect(otherWindow.send).not.toHaveBeenCalled();
    expect(focus).toHaveBeenCalledExactlyOnceWith('browser', { projectId: PROJECT_ID, taskId: OWNER_KEY });
  });

  it('holds the link for a window whose page is still loading, and sends it once the page has loaded', () => {
    const bootingWindow = fakeWindow({ loading: true });
    const { windows, focus } = fakeWindows({ [OWNER_KEY]: bootingWindow.popOutWindow });

    expect(relayLinkToPopOut(windows, PROJECT_ID, OWNER_KEY, URL_TEXT)).toBe(true);
    // A push now would reach no listener in that window.
    expect(bootingWindow.send).not.toHaveBeenCalled();
    expect(focus).toHaveBeenCalledOnce();

    bootingWindow.finishLoad();
    expect(bootingWindow.send).toHaveBeenCalledExactlyOnceWith(IPC.BROWSER_NAVIGATE_REQUEST, OWNER_KEY, URL_TEXT);
  });

  it('sends nothing when a window closes before its page loads', () => {
    let destroyed = false;
    const send = vi.fn();
    const loadListeners: Array<() => void> = [];
    const closingWindow = {
      isDestroyed: () => destroyed,
      webContents: {
        isDestroyed: () => destroyed,
        isLoadingMainFrame: () => true,
        once: (_event: string, listener: () => void) => { loadListeners.push(listener); },
        send,
      },
    } as unknown as BrowserWindow;
    const { windows } = fakeWindows({ [OWNER_KEY]: closingWindow });

    expect(relayLinkToPopOut(windows, PROJECT_ID, OWNER_KEY, URL_TEXT)).toBe(true);
    destroyed = true;
    for (const listener of loadListeners) listener();
    expect(send).not.toHaveBeenCalled();
  });

  it('answers false and raises nothing when the owner has no Browser window', () => {
    const { windows, focus } = fakeWindows({});
    expect(relayLinkToPopOut(windows, PROJECT_ID, OWNER_KEY, URL_TEXT)).toBe(false);
    expect(focus).not.toHaveBeenCalled();
  });

  it('answers false for a window that is closing', () => {
    for (const closing of [fakeWindow({ destroyed: true }), fakeWindow({ contentsDestroyed: true })]) {
      const { windows, focus } = fakeWindows({ [OWNER_KEY]: closing.popOutWindow });
      expect(relayLinkToPopOut(windows, PROJECT_ID, OWNER_KEY, URL_TEXT)).toBe(false);
      expect(closing.send).not.toHaveBeenCalled();
      expect(focus).not.toHaveBeenCalled();
    }
  });

  it('refuses anything but an http(s) URL, and malformed arguments, without sending', () => {
    const ownerWindow = fakeWindow();
    const { windows, focus } = fakeWindows({ [OWNER_KEY]: ownerWindow.popOutWindow });
    for (const url of ['file:///etc/passwd', 'javascript:alert(1)', 'not a url', '', 42, null]) {
      expect(relayLinkToPopOut(windows, PROJECT_ID, OWNER_KEY, url)).toBe(false);
    }
    expect(relayLinkToPopOut(windows, '', OWNER_KEY, URL_TEXT)).toBe(false);
    expect(relayLinkToPopOut(windows, PROJECT_ID, null, URL_TEXT)).toBe(false);
    expect(ownerWindow.send).not.toHaveBeenCalled();
    expect(focus).not.toHaveBeenCalled();
  });
});
