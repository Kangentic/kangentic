/**
 * Task-detail ownership IPC: the single arbiter of WHERE a task detail opens.
 *
 * Every entry point (a board card click, the Agent Monitor in either host, a
 * desktop notification, the search palette) asks main the same question, so the
 * two product rules in `detail-owner-registry.ts` have exactly one
 * implementation. A renderer-side copy would have to be written once per host
 * and could not see the other hosts anyway.
 *
 * Flow:
 *   renderer -> DETAIL_REQUEST_OPEN -> main resolves + focuses the target window
 *            -> DETAIL_OPEN_HERE     -> the target renderer mounts the window
 *            -> DETAIL_SYNC_OWNED    -> the host reports its FULL mounted set, and
 *                                       main reconciles its records to match
 *
 * Ownership is DERIVED, never assumed at resolve time and never tallied from
 * increments. A host reports what it actually has mounted, so a request that never
 * became a window leaves nothing behind, and a report that is lost, duplicated, or
 * arrives out of order is repaired by the next one. The incremental claim/release
 * pair this replaced could strand a claim, which presented as a task answering
 * `focused-existing` for a window that no longer existed - permanently unopenable,
 * with nothing on screen and no error.
 */
import { BrowserWindow, ipcMain, webContents } from 'electron';
import { IPC } from '../../../shared/ipc-channels';
import { DetailOwnerRegistry } from '../../task-detail/detail-owner-registry';
import type { DetailDestination, DetailHost, OwnedDetail } from '../../task-detail/detail-owner-registry';

/** Process-global: ownership spans renderers by definition. */
export const detailOwnerRegistry = new DetailOwnerRegistry();

/**
 * Bring a renderer's window forward. Focusing the OWNER is what makes "never
 * open twice" feel like an answer rather than a no-op: the user asked to see the
 * task, and they now see it, just in the window that already had it.
 */
function focusWindowOf(targetWebContentsId: number): void {
  const target = webContents.fromId(targetWebContentsId);
  if (!target || target.isDestroyed()) return;
  const browserWindow = BrowserWindow.fromWebContents(target);
  if (!browserWindow || browserWindow.isDestroyed()) return;
  if (browserWindow.isMinimized()) browserWindow.restore();
  browserWindow.focus();
}

/**
 * Tell every live renderer which details are held by SOMEONE ELSE.
 *
 * Terminal ownership ("one xterm per PTY") was renderer-local: the bottom panel
 * consulted `dialogSessionIds`, which only ever knew about that renderer's own
 * detail windows. A detail hosted in the detached Agent Monitor is a different
 * renderer, so the main window could not tell the session already had a terminal
 * on screen and mounted a second one - two fitters resizing one PTY, which is the
 * blank/garbled panel the user sees on the board while the pop-out drives the
 * agent.
 *
 * Each window gets its own filtered payload (its own claims excluded), so a
 * renderer never has to know its webContents id or reason about the direction of
 * the comparison. Called after every mutation of the registry, including the
 * teardown path - a closed pop-out must hand its sessions back.
 */
function publishRemoteOwners(): void {
  for (const browserWindow of BrowserWindow.getAllWindows()) {
    if (browserWindow.isDestroyed()) continue;
    const target = browserWindow.webContents;
    if (target.isDestroyed()) continue;
    target.send(IPC.DETAIL_REMOTE_OWNERS, detailOwnerRegistry.ownedElsewhere(target.id));
  }
}

/**
 * Takes no `IpcContext` on purpose. The rule used to consult the main window and
 * the currently-open project to decide placement; now the requester simply wins,
 * so the arbiter needs nothing but the request itself. Fewer inputs, fewer ways
 * for the answer to depend on state the user cannot see.
 */
export function registerTaskDetailOwnershipHandlers(): void {
  ipcMain.handle(
    IPC.DETAIL_REQUEST_OPEN,
    (event, projectId: string, taskId: string, host: DetailHost): DetailDestination => {
      const destination = detailOwnerRegistry.resolveOpen({
        projectId,
        taskId,
        requesterWebContentsId: event.sender.id,
        requesterHost: host,
      });

      focusWindowOf(destination.owner.webContentsId);

      // Re-asking the surface that already holds it: focusing is the whole
      // action, and a remount would tear down a live agent's terminal.
      if (destination.kind === 'focused-existing') return destination;

      // Hand it over: tell the previous holder to let go BEFORE the new one
      // mounts, so the task detail is never briefly present twice (which would
      // mean two xterms on one PTY).
      if (destination.closedElsewhere) {
        const previous = webContents.fromId(destination.closedElsewhere.webContentsId);
        if (previous && !previous.isDestroyed()) {
          previous.send(
            IPC.DETAIL_CLOSE_HERE,
            projectId,
            taskId,
            destination.closedElsewhere.host,
          );
        }
      }

      const target = webContents.fromId(destination.owner.webContentsId);
      if (target && !target.isDestroyed()) {
        target.send(IPC.DETAIL_OPEN_HERE, projectId, taskId, destination.owner.host);
      }

      return destination;
    },
  );

  // Renderers whose teardown is already wired, so a host reporting a second time
  // does not stack duplicate listeners on the same webContents.
  const teardownWatched = new Set<number>();

  ipcMain.on(IPC.DETAIL_SYNC_OWNED, (
    event,
    host: DetailHost,
    entries: ReadonlyArray<OwnedDetail>,
  ) => {
    const sender = event.sender;
    const result = detailOwnerRegistry.syncOwned(sender.id, host, entries);

    // A report that took a detail from another surface has to close the loser's
    // window, exactly as `resolveOpen`'s handover does. Without this, ownership
    // moves while both windows stay mounted - the same task open twice.
    for (const entry of result.displaced) {
      const previous = webContents.fromId(entry.previous.webContentsId);
      if (!previous || previous.isDestroyed()) continue;
      previous.send(IPC.DETAIL_CLOSE_HERE, entry.projectId, entry.taskId, entry.previous.host);
    }

    // Only on a real change. A host reports its whole set on every window-store
    // change, which includes geometry during a drag, so an unconditional fan-out
    // here would push to every renderer many times a second.
    const changed = result.added.length > 0 || result.removed.length > 0;
    if (changed) publishRemoteOwners();

    // A renderer that goes away (a closed pop-out, a crashed render process) must
    // not keep its claims, or those tasks become permanently unopenable with no
    // way for the user to recover. Wired on first claim rather than at
    // registration because pop-out renderers do not exist yet when handlers are
    // registered.
    if (teardownWatched.has(sender.id)) return;
    teardownWatched.add(sender.id);

    const releaseClaims = (): void => {
      detailOwnerRegistry.releaseAllFor(sender.id);
      // A renderer that let go must hand its sessions back, or the surviving
      // windows go on believing a terminal they cannot see still owns them.
      publishRemoteOwners();
    };

    /**
     * A RELOAD is the case that bites, and it is not a teardown.
     *
     * `destroyed` / `render-process-gone` never fire for a reload: the webContents
     * survives with the SAME id, so the registry kept every claim while the fresh
     * page came up with no memory of them. The renderer cannot recover on its own
     * either - it has nothing to release - so `resolveOpen` answered
     * `focused-existing` for a window that no longer existed and the task could
     * never be opened again. Silent: no error, nothing on screen.
     *
     * This is the whole-app version of the bug already fixed inside the monitor
     * layer (claims tracked per component, lost when that component unmounted).
     * The lesson is the same: ownership must be derived from what is actually
     * mounted, never from bookkeeping that a lifecycle event can quietly erase.
     *
     * `did-start-navigation` on the main frame, ignoring same-document (hash /
     * history) navigations, which do not tear the window tree down. Registered
     * with `on`, not `once`: a renderer can reload any number of times, and
     * `teardownWatched` keeps this from stacking duplicate listeners.
     */
    sender.on('did-start-navigation', (details) => {
      if (!details.isMainFrame || details.isSameDocument) return;
      releaseClaims();
    });

    const releaseOnTeardown = (): void => {
      releaseClaims();
      teardownWatched.delete(sender.id);
    };
    sender.once('destroyed', releaseOnTeardown);
    sender.once('render-process-gone', releaseOnTeardown);
  });
}
