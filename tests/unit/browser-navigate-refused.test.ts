/**
 * What `navigateGuest` decides when a load fails, through the REAL cdp.ts dialog
 * ring against a fake debugger.
 *
 * A page's `beforeunload`, dismissed by the driver's default, keeps the page and
 * rejects the load with a bare `ERR_FAILED (-2)`. An agent read that as a load
 * problem while its next calls ran against the old page. What a real guest does
 * is pinned by `tests/e2e/browser-beforeunload-navigate.spec.ts`. This file pins
 * which failures count: the attribution has to stay by timestamp, because the
 * ring also holds dialogs from earlier attempts.
 *
 * Tier: Unit (vitest; the debugger is a stub, no Electron).
 */
import { EventEmitter } from 'node:events';
import { describe, it, expect, vi, afterEach } from 'vitest';
import type { WebContents } from 'electron';

vi.mock('electron', () => ({
  webContents: { fromId: vi.fn() },
  BrowserWindow: { fromWebContents: vi.fn(() => null) },
}));

import { navigateGuest } from '../../src/main/browser/browser-pane-driver';
import { attachDebugger, setDialogResponse } from '../../src/main/browser/cdp/cdp';

const URL_NEXT = 'http://localhost:4200/next';
const REFUSED = 'NavigationRefusedByPageError';

function fakeGuest(loadURL: () => Promise<void>) {
  const debuggerListeners = new EventEmitter();
  const guest = Object.assign(new EventEmitter(), {
    isDestroyed: () => false,
    loadURL: vi.fn(loadURL),
    debugger: {
      attach: vi.fn(),
      detach: vi.fn(),
      sendCommand: vi.fn(() => Promise.resolve({})),
      on: (event: string, handler: (...args: unknown[]) => void) => debuggerListeners.on(event, handler),
      removeListener: () => {},
    },
  });
  const webContents = guest as unknown as WebContents;
  attachDebugger(webContents);
  return {
    guest,
    webContents,
    /** The page raises a dialog, as Chromium reports it to the driver. */
    raiseDialog: (type: string) => debuggerListeners.emit('message', {}, 'Page.javascriptDialogOpening', { type, message: '' }),
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('navigateGuest', () => {
  it('names a refusal when this attempt dismissed a beforeunload', async () => {
    const page = fakeGuest(async () => {
      page.raiseDialog('beforeunload');
      throw new Error('ERR_FAILED (-2) loading');
    });

    await expect(navigateGuest(page.webContents, URL_NEXT)).rejects.toMatchObject({
      name: REFUSED,
      message: expect.stringMatching(/beforeunload[\s\S]*kangentic_browser_handle_dialog/),
    });
  });

  it('keeps the load\'s own error when the only beforeunload in the ring is an earlier attempt\'s', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const page = fakeGuest(async () => {
      throw new Error('ERR_CONNECTION_REFUSED (-102) loading');
    });
    page.raiseDialog('beforeunload');
    vi.setSystemTime(Date.now() + 1000);

    await expect(navigateGuest(page.webContents, URL_NEXT)).rejects.toThrow('ERR_CONNECTION_REFUSED');
  });

  it('keeps the load\'s own error when the page raised another kind of dialog', async () => {
    const page = fakeGuest(async () => {
      page.raiseDialog('confirm');
      throw new Error('ERR_FAILED (-2) loading');
    });

    await expect(navigateGuest(page.webContents, URL_NEXT)).rejects.toThrow('ERR_FAILED');
  });

  it('keeps the load\'s own error when the beforeunload was accepted: the page did not refuse', async () => {
    const page = fakeGuest(async () => {
      page.raiseDialog('beforeunload');
      throw new Error('ERR_ABORTED (-3) loading');
    });
    setDialogResponse(page.webContents, { accept: true, once: true });

    await expect(navigateGuest(page.webContents, URL_NEXT)).rejects.toThrow('ERR_ABORTED');
  });

  it('gives an armed accept to Electron too, which is what lets the load finish cleanly', async () => {
    const preventDefault = vi.fn();
    const page = fakeGuest(async () => {
      page.guest.emit('will-prevent-unload', { preventDefault });
    });
    setDialogResponse(page.webContents, { accept: true, once: true });

    await navigateGuest(page.webContents, URL_NEXT);

    expect(preventDefault).toHaveBeenCalledOnce();
  });

  it('leaves Electron\'s answer alone without an armed accept, so the dismiss default keeps the page', async () => {
    const preventDefault = vi.fn();
    const page = fakeGuest(async () => {
      page.guest.emit('will-prevent-unload', { preventDefault });
    });

    await navigateGuest(page.webContents, URL_NEXT);

    expect(preventDefault).not.toHaveBeenCalled();
  });

  it('takes its listener off when the page raised no beforeunload, so a later dismiss is not overridden', async () => {
    const page = fakeGuest(async () => {});
    setDialogResponse(page.webContents, { accept: true, once: true });

    await navigateGuest(page.webContents, URL_NEXT);

    expect(page.guest.listenerCount('will-prevent-unload')).toBe(0);
  });
});
