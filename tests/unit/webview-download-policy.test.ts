/**
 * Unit tests for the Browser pane's download policy.
 *
 * Two properties, and the second is the one a casual test would miss.
 *
 *  1. `uniqueDownloadPath` suffixes BEFORE the extension. `report.pdf (1)` is a
 *     file no OS opens by double-click.
 *  2. The handler is installed once per `Session`, and it resolves its host
 *     window PER DOWNLOAD rather than from an install-time closure. Panes in one
 *     worktree share a Session, so a captured host belongs to whichever pane was
 *     first - and once that pane closes, a second pane's download would drive the
 *     progress bar on a stale window and toast a dead renderer.
 *
 * Tier: Unit (vitest; electron is mocked, the fs probe is injected).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import path from 'node:path';

const setProgressBar = vi.fn();
const windowsByContentsId = new Map<number, unknown>();

vi.mock('electron', () => ({
  app: { getPath: vi.fn(() => path.join(path.sep, 'downloads')) },
  BrowserWindow: {
    fromWebContents: vi.fn((contents: { id: number }) => windowsByContentsId.get(contents.id) ?? null),
  },
}));

import {
  uniqueDownloadPath,
  installWebviewDownloadPolicy,
  resetDownloadPolicyForTests,
} from '../../src/main/browser/webview-download-policy';
import { IPC } from '../../src/shared/ipc-channels';
import { app } from 'electron';

describe('uniqueDownloadPath', () => {
  const directory = path.join(path.sep, 'downloads');

  it('returns the plain name when nothing is in the way', () => {
    expect(uniqueDownloadPath(directory, 'report.pdf', () => false))
      .toBe(path.join(directory, 'report.pdf'));
  });

  it('suffixes BEFORE the extension on a collision', () => {
    const taken = new Set([path.join(directory, 'report.pdf')]);
    expect(uniqueDownloadPath(directory, 'report.pdf', (candidate) => taken.has(candidate)))
      .toBe(path.join(directory, 'report (1).pdf'));
  });

  it('keeps counting past the first collision', () => {
    const taken = new Set([
      path.join(directory, 'report.pdf'),
      path.join(directory, 'report (1).pdf'),
    ]);
    expect(uniqueDownloadPath(directory, 'report.pdf', (candidate) => taken.has(candidate)))
      .toBe(path.join(directory, 'report (2).pdf'));
  });

  it('handles an extensionless name', () => {
    const taken = new Set([path.join(directory, 'LICENSE')]);
    expect(uniqueDownloadPath(directory, 'LICENSE', (candidate) => taken.has(candidate)))
      .toBe(path.join(directory, 'LICENSE (1)'));
  });

  it('treats only the LAST dot as the extension', () => {
    const taken = new Set([path.join(directory, 'archive.tar.gz')]);
    expect(uniqueDownloadPath(directory, 'archive.tar.gz', (candidate) => taken.has(candidate)))
      .toBe(path.join(directory, 'archive.tar (1).gz'));
  });

  it('handles a dotfile without inventing a stem', () => {
    expect(uniqueDownloadPath(directory, '.gitignore', () => false))
      .toBe(path.join(directory, '.gitignore'));
  });
});

/** A minimal stand-in for an Electron Session that records its listeners. */
function fakeSession() {
  const listeners: ((...args: unknown[]) => void)[] = [];
  return {
    listeners,
    on: (event: string, listener: (...args: unknown[]) => void) => {
      if (event === 'will-download') listeners.push(listener);
    },
  };
}

describe('installWebviewDownloadPolicy - the per-Session install guard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    windowsByContentsId.clear();
  });

  it('installs ONE will-download listener for two calls on the same Session', () => {
    // Panes sharing a worktree share a partition, and `session.on` ACCUMULATES
    // where `setPermissionRequestHandler` overwrites. Unguarded, three panes give
    // every download three save paths and three toasts.
    const session = fakeSession();
    installWebviewDownloadPolicy(session as never);
    installWebviewDownloadPolicy(session as never);
    expect(session.listeners).toHaveLength(1);
    resetDownloadPolicyForTests(session as never);
  });

  it('installs on each DIFFERENT Session', () => {
    const first = fakeSession();
    const second = fakeSession();
    installWebviewDownloadPolicy(first as never);
    installWebviewDownloadPolicy(second as never);
    expect(first.listeners).toHaveLength(1);
    expect(second.listeners).toHaveLength(1);
    resetDownloadPolicyForTests(first as never);
    resetDownloadPolicyForTests(second as never);
  });
});

describe('installWebviewDownloadPolicy - host resolution is per download', () => {
  let session: ReturnType<typeof fakeSession>;

  function fakeWindow(label: string) {
    return {
      label,
      isDestroyed: () => false,
      setProgressBar,
      webContents: { send: vi.fn() },
    };
  }

  function fakeDownloadItem(fileName: string) {
    const handlers: Record<string, (...args: unknown[]) => void> = {};
    return {
      handlers,
      savePath: '',
      getFilename: () => fileName,
      getTotalBytes: () => 100,
      getReceivedBytes: () => 50,
      setSavePath(next: string) { this.savePath = next; },
      on: (event: string, handler: (...args: unknown[]) => void) => { handlers[event] = handler; },
      once: (event: string, handler: (...args: unknown[]) => void) => { handlers[event] = handler; },
    };
  }

  beforeEach(() => {
    vi.clearAllMocks();
    windowsByContentsId.clear();
    session = fakeSession();
    installWebviewDownloadPolicy(session as never);
  });

  it('routes a SECOND pane\'s download to the SECOND pane\'s host window', () => {
    // The load-bearing case, and the one the install-guard test above passes
    // straight through. Both guests share the Session that was configured when
    // only the first existed.
    const firstHost = fakeWindow('first-pane-window');
    const secondHost = fakeWindow('second-pane-window');
    windowsByContentsId.set(1, firstHost);
    windowsByContentsId.set(2, secondHost);
    const secondGuest = { id: 2, isDestroyed: () => false, hostWebContents: { id: 2 } };

    const item = fakeDownloadItem('spec.pdf');
    session.listeners[0]({}, item, secondGuest);
    item.handlers.done?.({}, 'completed');

    expect(secondHost.webContents.send).toHaveBeenCalledWith(
      IPC.BROWSER_DOWNLOAD_DONE,
      expect.objectContaining({ fileName: 'spec.pdf', state: 'completed' }),
    );
    expect(firstHost.webContents.send).not.toHaveBeenCalled();
  });

  it('reports the DEDUPED filename, not the one the server sent', () => {
    // What lands on disk is what the toast must name, or "Show in folder" points
    // at a file the user cannot find.
    const host = fakeWindow('window');
    windowsByContentsId.set(1, host);
    const guest = { id: 1, isDestroyed: () => false, hostWebContents: { id: 1 } };

    const item = fakeDownloadItem('spec.pdf');
    session.listeners[0]({}, item, guest);
    item.handlers.done?.({}, 'completed');

    expect(host.webContents.send).toHaveBeenCalledWith(
      IPC.BROWSER_DOWNLOAD_DONE,
      expect.objectContaining({ filePath: item.savePath, fileName: path.basename(item.savePath) }),
    );
  });

  it('drives and then clears the host window\'s progress bar', () => {
    const host = fakeWindow('window');
    windowsByContentsId.set(1, host);
    const guest = { id: 1, isDestroyed: () => false, hostWebContents: { id: 1 } };

    const item = fakeDownloadItem('spec.pdf');
    session.listeners[0]({}, item, guest);
    item.handlers.updated?.({}, 'progressing');
    expect(setProgressBar).toHaveBeenCalledWith(0.5);

    item.handlers.done?.({}, 'completed');
    expect(setProgressBar).toHaveBeenLastCalledWith(-1);
  });

  it('still saves the file when no host window can be resolved', () => {
    // A pane whose window has already gone: the download must not throw, it just
    // has nowhere to report to.
    const guest = { id: 99, isDestroyed: () => false, hostWebContents: { id: 99 } };
    const item = fakeDownloadItem('spec.pdf');

    expect(() => {
      session.listeners[0]({}, item, guest);
      item.handlers.done?.({}, 'completed');
    }).not.toThrow();
    expect(item.savePath).toBe(path.join(path.sep, 'downloads', 'spec.pdf'));
  });

  it('degrades to Chromium when the OS cannot resolve a Downloads folder', () => {
    // A LINUX-SHAPED FAILURE a Windows-only run never surfaces: `getPath`
    // THROWS on a box with no XDG user dirs. Unguarded, that exception escapes
    // the `will-download` handler and the download dies with no save path and no
    // explanation. Leaving the path unset hands it back to Chromium, so the user
    // still gets the file.
    const host = fakeWindow('window');
    windowsByContentsId.set(1, host);
    const guest = { id: 1, isDestroyed: () => false, hostWebContents: { id: 1 } };
    const item = fakeDownloadItem('spec.pdf');

    vi.mocked(app.getPath).mockImplementationOnce(() => {
      throw new Error('Failed to get downloads path');
    });

    expect(() => session.listeners[0]({}, item, guest)).not.toThrow();
    // The fake starts with an empty savePath, so "still empty" is "setSavePath
    // was never called" - which is what hands the decision back to Chromium.
    expect(item.savePath).toBe('');
  });

  it('reports a non-completed terminal state honestly', () => {
    const host = fakeWindow('window');
    windowsByContentsId.set(1, host);
    const guest = { id: 1, isDestroyed: () => false, hostWebContents: { id: 1 } };

    const item = fakeDownloadItem('spec.pdf');
    session.listeners[0]({}, item, guest);
    item.handlers.done?.({}, 'interrupted');

    expect(host.webContents.send).toHaveBeenCalledWith(
      IPC.BROWSER_DOWNLOAD_DONE,
      expect.objectContaining({ state: 'interrupted' }),
    );
  });
});
