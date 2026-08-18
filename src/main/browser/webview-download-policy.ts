import { app, BrowserWindow, type DownloadItem, type Session, type WebContents } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { IPC } from '../../shared/ipc-channels';

/**
 * The embedded Browser pane's download policy: save to the OS Downloads folder,
 * dedupe the filename, show progress on the host window's taskbar, and tell the
 * renderer so it can toast.
 *
 * WHY ALLOW RATHER THAN DENY. A deny would buy nothing: the agent driving the
 * pane already has full filesystem write through its own tools, so refusing
 * `will-download` only breaks the HUMAN's use of the pane. Leaving the event
 * unhandled is worse still - Chromium raises a native save dialog, which is
 * modal and can block a pane an agent is mid-way through driving. Saving
 * silently to Downloads is what Chrome does, and the toast is what stops an
 * agent-triggered download being invisible.
 *
 * WHY THE INSTALL GUARD IS THE POINT OF THIS MODULE. The pane's partition is per
 * WORKTREE, so several panes share one `Session`. `session.on('will-download')`
 * ACCUMULATES listeners, where `setPermissionRequestHandler` merely overwrites -
 * so an unguarded install would give a single download three save paths, three
 * progress-bar owners, and three toasts once three panes are open in one
 * worktree.
 *
 * See `docs/embedded-browser.md` decision 13.
 */

const sessionsWithDownloadPolicy = new WeakSet<Session>();

/**
 * First free path for `fileName` under `directory`, suffixing ` (1)`, ` (2)`...
 * BEFORE the extension, so `report.pdf` collides to `report (1).pdf` rather than
 * `report.pdf (1)`, which no OS would open by double-click.
 *
 * `fileExists` is injected so this stays a pure, testable function.
 */
export function uniqueDownloadPath(
  directory: string,
  fileName: string,
  fileExists: (candidate: string) => boolean,
): string {
  // Reduce to a bare basename FIRST. `fileName` originates in a remote
  // `Content-Disposition` header, so it is untrusted: a name carrying path
  // separators would otherwise be joined verbatim on the no-collision path and
  // land outside `directory`, while the collision path below already reduced it
  // via `basename` - so the two branches disagreed about the same input. One
  // sanitize, both branches, no asymmetry.
  const safeFileName = path.basename(fileName);
  const extension = path.extname(safeFileName);
  const stem = path.basename(safeFileName, extension);
  let candidate = path.join(directory, safeFileName);
  let suffix = 0;
  // Bounded only by collisions actually on disk; a user with thousands of
  // same-named downloads pays a few stat calls, which is cheaper than guessing.
  while (fileExists(candidate)) {
    suffix += 1;
    candidate = path.join(directory, `${stem} (${suffix})${extension}`);
  }
  return candidate;
}

/**
 * Install the policy on a guest `Session`. Idempotent per Session.
 *
 * `resolveHostWindow` is deliberately NOT a parameter. The handler is installed
 * once per Session but serves every pane sharing it, so a host window captured
 * at install time belongs to whichever pane happened to be first - and once that
 * pane closes, a download started by a second pane would drive `setProgressBar`
 * on a stale window and route its toast to a dead renderer. `will-download`
 * carries the INITIATING webContents as its third argument, so the host is
 * resolved from that, per download.
 */
export function installWebviewDownloadPolicy(guestSession: Session): void {
  if (sessionsWithDownloadPolicy.has(guestSession)) return;
  sessionsWithDownloadPolicy.add(guestSession);

  guestSession.on('will-download', (_event, item: DownloadItem, initiator: WebContents) => {
    const hostWindow = resolveHostWindowFor(initiator);

    // `app.getPath('downloads')` THROWS when the OS cannot resolve the folder -
    // a headless Linux box with no XDG user dirs, or a stripped container. Left
    // unguarded that exception escapes the `will-download` handler, so the save
    // path is never set and the download dies with no explanation. Falling back
    // to Chromium's own behavior (prompt / default location) is the honest
    // degradation: the user still gets their file, just not silently into
    // Downloads. Windows and macOS always resolve it, so this is a Linux-shaped
    // failure that a Windows-only test run would never surface.
    let downloadsDirectory: string;
    try {
      downloadsDirectory = app.getPath('downloads');
    } catch {
      console.warn('[BROWSER_DOWNLOAD] no downloads folder; leaving the save path to Chromium');
      return;
    }

    const savePath = uniqueDownloadPath(downloadsDirectory, item.getFilename(), fs.existsSync);
    item.setSavePath(savePath);
    console.log(`[BROWSER_DOWNLOAD] ${item.getFilename()} -> ${savePath}`);

    item.on('updated', (_updatedEvent, state) => {
      if (state !== 'progressing' || !hostWindow || hostWindow.isDestroyed()) return;
      const total = item.getTotalBytes();
      // A server that sends no Content-Length reports 0 total; -1 is Electron's
      // "indeterminate" value and is the honest answer there.
      hostWindow.setProgressBar(total > 0 ? item.getReceivedBytes() / total : -1);
    });

    item.once('done', (_doneEvent, state) => {
      if (hostWindow && !hostWindow.isDestroyed()) {
        hostWindow.setProgressBar(-1);
        hostWindow.webContents.send(IPC.BROWSER_DOWNLOAD_DONE, {
          fileName: path.basename(savePath),
          filePath: savePath,
          state,
        });
      }
      console.log(`[BROWSER_DOWNLOAD] ${path.basename(savePath)} finished: ${state}`);
    });
  });
}

/** The OS window hosting a guest, or null. Same shape the zoom broadcast uses,
 *  so a popped-out pane's own window is found rather than the main one. */
function resolveHostWindowFor(initiator: WebContents): BrowserWindow | null {
  if (!initiator || initiator.isDestroyed()) return null;
  const hostWindow = BrowserWindow.fromWebContents(initiator.hostWebContents ?? initiator);
  return hostWindow && !hostWindow.isDestroyed() ? hostWindow : null;
}

/** Test seam: forget that a Session was configured. Never called by product code. */
export function resetDownloadPolicyForTests(guestSession: Session): void {
  sessionsWithDownloadPolicy.delete(guestSession);
}
