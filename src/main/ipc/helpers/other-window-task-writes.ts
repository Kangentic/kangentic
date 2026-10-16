import type { WebContents } from 'electron';
import { IPC } from '../../../shared/ipc-channels';
import { isShuttingDown } from '../../shutdown-state';
import { sendToRenderer } from '../send-to-renderer';
import type { IpcContext } from '../ipc-context';

/**
 * Tell the main window about a task write the user made from ANOTHER window.
 *
 * The pop-out Agent Monitor is a separate renderer with its own stores. Its row
 * menu and the task details it hosts write through the same project-stamped IPC
 * as the board, but the main window's board store never sees those calls, so
 * the card under them kept its old column (or a deleted task) until something
 * else reloaded the board. A write from the main window itself needs no push:
 * the board updates optimistically, and the in-app monitor resyncs the board on
 * its own (`resyncBoardAfterMonitorWrite`), because the sender check below
 * cannot tell the in-app monitor from the board.
 *
 * Quiet on purpose (no toast): the user made the change, in the window they
 * are looking at. Carries the resolved project id so the main window reloads
 * its board for the open project, or invalidates that project's warm cache.
 *
 * Every caller runs this from a `finally`, so it announces a write that
 * committed and then failed (a demote whose task delete throws after its
 * backlog row landed). That is also why it never throws: a throw from a
 * `finally` would replace the handler's own result or error.
 */
export function announceTaskWriteFromOtherWindow(
  context: IpcContext,
  event: { sender: WebContents } | null | undefined,
  projectId: string | null,
): void {
  // A call with no IPC event (a unit harness driving the handler directly) has
  // no sender, so there is no other window to speak for.
  const sender = event?.sender;
  if (!projectId || !sender) return;
  // The user quit: the board is going away, and a reload would only hit a
  // closed database.
  if (isShuttingDown()) return;
  // Checked before reading `webContents`: a destroyed BrowserWindow throws on
  // that access, and this runs in handlers that may settle during shutdown.
  if (context.mainWindow.isDestroyed()) return;
  // A sender closed while its write was in flight (the pop-out shut mid-move)
  // is not the live main window, and the write still happened. Asked first
  // because a destroyed WebContents throws on `id`.
  const fromMainWindow = !sender.isDestroyed() && sender.id === context.mainWindow.webContents.id;
  if (fromMainWindow) return;
  try {
    sendToRenderer(context.mainWindow, IPC.TASK_CHANGED_IN_OTHER_WINDOW, projectId);
  } catch (error) {
    console.warn('[other-window-task-writes] Could not tell the main window about a task write:', error);
  }
}

/**
 * The renderer-driven mutation channels whose handlers call
 * `announceTaskWriteFromOtherWindow`. Every TASK_* channel in the project-scoped
 * mutation set (`.claude/rules/project-scoped-ipc.md`) plus BACKLOG_DEMOTE, which
 * removes a task from the board.
 *
 * Left out on purpose:
 * - TASK_SET_DETAIL_VIEW_STATE writes only a task detail's layout blob, which the
 *   board never shows. It is saved on a debounce while a pane is resized, so a
 *   push would reload the board on every resize.
 * - SESSION_* reaches the main window already: session state comes from main's
 *   own session pushes, and a restart that changes `task.session_id` sends
 *   `TASK_SESSION_RESYNC`.
 *
 * `tests/unit/other-window-task-writes.test.ts` holds every handler on this list
 * to calling the helper once, from a `finally`, and holds the list to the
 * mutation set.
 */
export const OTHER_WINDOW_ANNOUNCED_CHANNELS = [
  'TASK_CREATE',
  'TASK_UPDATE',
  'TASK_DELETE',
  'TASK_MOVE',
  'TASK_UNARCHIVE',
  'TASK_BULK_DELETE',
  'TASK_BULK_UNARCHIVE',
  'TASK_SWITCH_BRANCH',
  'TASK_UPDATE_FROM_BASE',
  'TASK_SET_RUNTIME_OVERRIDE',
  'TASK_RESOLVE_PR',
  'BACKLOG_DEMOTE',
] as const satisfies readonly (keyof typeof IPC)[];
