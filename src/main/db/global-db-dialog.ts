import { app, BrowserWindow, dialog } from 'electron';

import { PATHS } from '../config/paths';
import { getGlobalDb, resetGlobalDb } from './database';
import { describeSqliteFailure } from './sqlite-error';

/**
 * The user-facing policy for an unreadable global database.
 *
 * Sentry DESKTOP-9/A/B: one install hit `SQLITE_IOERR` on `index.db` at launch.
 * `SQLITE_IOERR` is environmental - an antivirus scan, a OneDrive or Dropbox
 * sync lock, or failing storage - so there is nothing to fix in the query. What
 * was worth fixing is that the app said nothing: the raw `SqliteError` crossed
 * IPC as `Error invoking remote method 'project:list'` and startup carried on
 * into a half-initialized state. Low frequency, wide blast radius. This is the
 * failure mode where the app looks broken with no explanation.
 *
 * One dialog, two entry points, so the copy cannot drift:
 *
 *   - `ensureGlobalDbReadable()` at startup, before any window exists.
 *   - `notifyGlobalDbUnavailable()` for a read that degraded mid-session.
 *
 * Always the async `dialog.showMessageBox`, never `showMessageBoxSync`: a sync
 * dialog blocks the main process, which would freeze every live PTY.
 */

const RETRY_BUTTON = 0;

/** E2E launches with NODE_ENV=test, where a modal would hang the tier with nobody to click it. */
function dialogsSuppressed(): boolean {
  return process.env.NODE_ENV === 'test';
}

async function askRetryOrQuit(error: unknown, parent: BrowserWindow | null): Promise<boolean> {
  const detail = [
    PATHS.globalDb,
    '',
    describeSqliteFailure(error),
    '',
    'This usually means another program is holding the file: an antivirus scan, '
    + 'a OneDrive or Dropbox sync, or a failing drive.',
  ].join('\n');

  const options: Electron.MessageBoxOptions = {
    type: 'error',
    title: 'Kangentic',
    message: "Kangentic can't read its database",
    detail,
    buttons: ['Retry', 'Quit'],
    defaultId: RETRY_BUTTON,
    cancelId: 1,
    noLink: true,
  };

  const result = parent && !parent.isDestroyed()
    ? await dialog.showMessageBox(parent, options)
    : await dialog.showMessageBox(options);

  return result.response === RETRY_BUTTON;
}

export type GlobalDbReadyResult = { ok: true } | { ok: false; error: unknown };

/**
 * Prove the global database is readable before startup builds anything on it.
 *
 * Resolves `{ ok: false }` when the user chose Quit, in which case the caller
 * must abandon startup. Retry drops the cached connection and reopens for real,
 * which is what makes it worth offering: an antivirus scan or a sync lock is
 * usually over within seconds, so the recoverable case does not need a
 * relaunch.
 *
 * The give-up error comes back rather than being swallowed, so the caller can
 * still count the failure. This whole cluster was only ever noticed because it
 * arrived in Sentry as an unhandled rejection; handling it must not also make
 * it invisible.
 *
 * Called EARLY in the whenReady body rather than next to `createWindow()`, so
 * a user with a locked database sees the message before the MCP server's
 * several-second startup instead of after it. This also means the database is
 * proven readable before any window exists, which is the ordering that stops
 * the renderer from ever racing a startup that died half way through.
 */
export async function ensureGlobalDbReadable(): Promise<GlobalDbReadyResult> {
  for (;;) {
    try {
      getGlobalDb();
      return { ok: true };
    } catch (error) {
      console.error('[db] Global database is unreadable at startup:', error);
      if (dialogsSuppressed()) return { ok: false, error };
      if (!await askRetryOrQuit(error, null)) return { ok: false, error };
      resetGlobalDb();
    }
  }
}

let notified = false;

/**
 * Report a global-database read that degraded while the app was already
 * running, and offer the same Retry / Quit choice.
 *
 * Fire-and-forget and once per incident: the failure is a standing condition,
 * and a second dialog for the same one teaches nothing. A successful Retry
 * re-arms the flag below, so a later failure can still speak.
 *
 * Retry reopens the connection and stops there. It deliberately does NOT
 * reload the renderer: that would destroy every `<webview>` guest, which is the
 * whole point of `.claude/rules/retained-pane-never-remounts.md`, and the
 * hard-reload recovery that does exist only re-pairs Command Terminal PTYs. So
 * a successful retry restores writes and every future read, while a list that
 * already degraded to empty stays empty until something refetches it. That
 * limit is deliberately NOT in the dialog copy, which is shared with the
 * startup path where it would be wrong: the copy stays on the cause, naming the
 * file, the SQLite code, and what is likely holding it.
 */
export function notifyGlobalDbUnavailable(
  error: unknown,
  operation: string,
  parentWindow?: BrowserWindow | null,
): void {
  if (notified) return;
  notified = true;

  console.error(`[db] Global database unavailable (${operation}); notifying the user.`, error);
  if (dialogsSuppressed()) return;

  void (async () => {
    // The caller names the parent, because `getAllWindows()` is not just the
    // main window: `browser-lane-manager.ts` creates offscreen lanes with
    // `show: false`, and pop-outs are separate windows too. Owning a modal to
    // an invisible lane would hide the very message this exists to deliver.
    // The fallback still has to skip those, since it runs when the caller had
    // no window to offer.
    const parent = parentWindow && !parentWindow.isDestroyed()
      ? parentWindow
      : BrowserWindow.getAllWindows().find((window) => !window.isDestroyed() && window.isVisible()) ?? null;
    const retry = await askRetryOrQuit(error, parent);
    if (!retry) {
      app.quit();
      return;
    }
    resetGlobalDb();
    try {
      getGlobalDb();
      // Re-arm, so a database that fails again later can still say so once more.
      notified = false;
    } catch (retryError) {
      console.error('[db] Retry failed; the global database is still unreadable.', retryError);
    }
  })().catch((dialogError) => {
    // A dialog that cannot open must not become the crash it was reporting.
    console.error('[db] Failed to show the unreadable-database dialog:', dialogError);
  });
}
