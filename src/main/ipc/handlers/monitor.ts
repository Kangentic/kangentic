/**
 * Agent Monitor IPC. Machine-global: nothing here takes a projectId, because the
 * snapshot deliberately spans every registered project.
 *
 * Freshness contract (see monitor-aggregator.ts for why this is cheap):
 *   - Live activity does NOT come through this handler. `SESSION_ACTIVITY` is
 *     already broadcast unbuffered with its projectId, and the renderer patches it
 *     onto the matching row in place. That is the common case and costs nothing.
 *   - This handler only re-pushes when the DB-resident half of a row can have
 *     changed: a session appeared / changed status / exited, or an AGENT edited a
 *     board (the BoardEventBus is agent-driven only). A USER edit can only ever
 *     target the project whose board is open, so the renderer covers that case
 *     itself rather than us broadcasting on every local keystroke.
 *   - There is no timer. Elapsed time ticks client-side.
 */
import { ipcMain } from 'electron';
import { IPC } from '../../../shared/ipc-channels';
import { broadcast } from '../../pop-out/window-broadcast';
import { buildMonitorSnapshot } from '../../monitor/monitor-aggregator';
import { buildTaskDetailBundle } from '../../monitor/task-detail-bundle';
import type { IpcContext } from '../ipc-context';

/**
 * Coalescing window for snapshot rebuilds. A single board move can emit several
 * events back to back (session-changed, then exit, then a board change); without
 * this every one of them would rebuild and re-push the full cross-project snapshot.
 */
const MONITOR_PUSH_DEBOUNCE_MS = 250;

export function registerMonitorHandlers(context: IpcContext): void {
  let pushTimer: ReturnType<typeof setTimeout> | null = null;

  ipcMain.handle(IPC.MONITOR_GET_SNAPSHOT, () => buildMonitorSnapshot(context));

  /**
   * The project-scoped half of a task detail, for a host that is not that
   * project's board. Read-only: the WRITES a monitor-hosted detail performs go
   * through the existing project-stamped task channels, which already take an
   * explicit projectId per .claude/rules/project-scoped-ipc.md.
   */
  ipcMain.handle(
    IPC.MONITOR_GET_TASK_DETAIL,
    (_event, projectId: string, taskId: string) => buildTaskDetailBundle(context, projectId, taskId),
  );

  /**
   * Reveal a task in the MAIN window, on behalf of the detached monitor.
   *
   * The pop-out is a separate renderer with its own Zustand stores, so clicking a
   * row there cannot open the task by setting local state - it would set state in
   * a window that shows no board. The request therefore travels through main and
   * is re-emitted to the main window.
   *
   * Deliberately reuses the notification-click push rather than inventing a
   * parallel one: the main window already handles that channel with exactly the
   * behavior wanted here (switch project if needed, else set the detail task
   * directly), so there is one reveal path to keep working, not two.
   */
  ipcMain.handle(IPC.MONITOR_REVEAL_TASK, (_event, projectId: string, taskId: string) => {
    if (context.mainWindow.isDestroyed()) return;
    if (context.mainWindow.isMinimized()) context.mainWindow.restore();
    context.mainWindow.focus();
    context.mainWindow.webContents.send(IPC.NOTIFICATION_CLICKED, projectId, taskId);
  });

  const schedulePush = (): void => {
    if (pushTimer) return;
    pushTimer = setTimeout(() => {
      pushTimer = null;
      if (context.mainWindow.isDestroyed()) return;
      try {
        // broadcast (not webContents.send) so a detached monitor window receives
        // it too. MONITOR_CHANGED is declared in the surface's `channels`, without
        // which the pop-out would silently never update.
        broadcast(context.mainWindow, IPC.MONITOR_CHANGED, buildMonitorSnapshot(context));
      } catch (error) {
        // A snapshot failure must never take down the session event pipeline it
        // is riding on.
        console.error('[monitor] Failed to build snapshot for push:', error);
      }
    }, MONITOR_PUSH_DEBOUNCE_MS);
  };

  context.sessionManager.on('session-changed', schedulePush);
  context.sessionManager.on('exit', schedulePush);
  context.boardEvents.onBoardChanged(schedulePush);
}
