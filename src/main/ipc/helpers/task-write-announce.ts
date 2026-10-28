import type { WebContents } from 'electron';
import { IPC } from '../../../shared/ipc-channels';
import { isShuttingDown } from '../../shutdown-state';
import { sendToRenderer } from '../send-to-renderer';
import type { IpcContext } from '../ipc-context';
import type { BoardChange } from '../../mobile-bridge/board-event-bus';

/**
 * What a task write changed, as the board-changed bus names it: the change kind
 * and the task ids it touched. `null` at a call site means the handler's own core
 * already announced on the bus (see `ANNOUNCED_TASK_WRITE_CHANNELS`).
 */
export interface TaskBoardChange {
  change: BoardChange;
  ids: string[];
}

/**
 * Announce a desktop task write to everything outside the window that made it.
 *
 * Two audiences, one call, so a handler cannot remember one and forget the other:
 *
 * 1. The board-changed bus (`announceTaskBoardChange`), for EVERY write, whichever
 *    window made it. Its listeners are a paired phone's read-board subscription,
 *    the Agent Monitor, the workflow engine and the retrieval record sweep, and
 *    none of them is the window that wrote. Before this, no desktop IPC task write
 *    reached the bus, so a card's Pause automations, a rename, a restore from
 *    the archive or a delete left a phone's board stale until something unrelated
 *    fired.
 * 2. The main window, for a write made from ANOTHER window. The pop-out Agent
 *    Monitor is a separate renderer with its own stores. Its row menu and the task
 *    details it hosts write through the same project-stamped IPC as the board, but
 *    the main window's board store never sees those calls, so the card under them
 *    kept its old column (or a deleted task) until something else reloaded the
 *    board. A write from the main window itself needs no push: the board updates
 *    optimistically, and the in-app monitor, the Workflows canvas menu and the
 *    board card's session row resync the board on their own
 *    (`resyncBoardAfterMonitorWrite`), because the sender check below sees each
 *    of them as the main window. Quiet on purpose (no toast): the user made
 *    the change, in the window they are looking at. Carries the resolved project
 *    id so the main window reloads its board for the open project, or invalidates
 *    that project's warm cache.
 *
 * `boardChange` is required, so every caller decides what its write changed;
 * `null` is for a handler whose core already announces on the bus.
 *
 * Every caller runs this from a `finally`, so it announces a write that committed
 * and then failed (a demote whose task delete throws after its backlog row
 * landed). That is also why it never throws: a throw from a `finally` would
 * replace the handler's own result or error.
 */
export function announceTaskWrite(
  context: IpcContext,
  event: { sender: WebContents } | null | undefined,
  projectId: string | null,
  boardChange: TaskBoardChange | null,
): void {
  if (boardChange) announceTaskBoardChange(context, projectId, boardChange);
  announceToMainWindow(context, event, projectId);
}

/**
 * The bus half of `announceTaskWrite`, for a task write with no IPC event to
 * speak for: BACKLOG_PROMOTE, which resolves the open project itself, and the
 * commit and settle emits of `handleTaskMove` in task-move.ts.
 *
 * Gated on the quit, because the database is already closed then and the bus
 * would still wake a phone subscription mid-teardown. Wrapped because the bus is
 * a plain EventEmitter that dispatches synchronously on this stack, so a
 * listener that threw would escape the caller's `finally`.
 */
export function announceTaskBoardChange(
  context: IpcContext,
  projectId: string | null,
  boardChange: TaskBoardChange,
): void {
  if (!projectId || isShuttingDown()) return;
  try {
    context.boardEvents.emitBoardChanged({ projectId, change: boardChange.change, ids: boardChange.ids });
  } catch (error) {
    console.warn('[task-write-announce] A board-changed listener threw on a task write:', error);
  }
}

function announceToMainWindow(
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
    console.warn('[task-write-announce] Could not tell the main window about a task write:', error);
  }
}

/**
 * The renderer-driven mutation channels whose handlers call `announceTaskWrite`.
 * Every TASK_* channel in the project-scoped mutation set
 * (`.claude/rules/project-scoped-ipc.md`) plus BACKLOG_DEMOTE, which removes a
 * task from the board.
 *
 * TASK_MOVE passes `null` for the bus, because `handleTaskMove` emits at the
 * commit point and again at settle, for every caller, not just this IPC one.
 *
 * Left out on purpose:
 * - TASK_SET_DETAIL_VIEW_STATE writes only a task detail's layout blob, which the
 *   board never shows. It is saved on a debounce while a pane is resized, so a
 *   push would reload the board on every resize.
 * - SESSION_* reaches the main window already: session state comes from main's
 *   own session pushes, and a restart that changes `task.session_id` sends
 *   `TASK_SESSION_RESYNC`. The session-lifecycle feed puts the same edges on the
 *   bus.
 * - BACKLOG_PROMOTE is not project-scoped and has no window to answer; it calls
 *   `announceTaskBoardChange` directly.
 *
 * `tests/unit/task-write-announce.test.ts` holds every handler on this list to
 * calling the helper once, from a `finally`, with the board change it pins per
 * channel, and holds the list to the mutation set.
 */
export const ANNOUNCED_TASK_WRITE_CHANNELS = [
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
