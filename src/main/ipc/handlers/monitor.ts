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
import type { WebContents } from 'electron';
import { IPC } from '../../../shared/ipc-channels';
import { broadcast } from '../../pop-out/window-broadcast';
import { buildMonitorSnapshot } from '../../monitor/monitor-aggregator';
import { MonitorPeekTracker } from '../../monitor/monitor-peek-tracker';
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

  /**
   * Renderers with a live monitor mounted, keyed by webContents id. The push
   * pipeline below builds and broadcasts snapshots only while this set is
   * non-empty, so with no monitor open anywhere a session event costs no
   * snapshot build, no serialization, and no renderer deserialization (#464
   * finding 2; measured 112KB -> 19.6KB earlier, this removes the residual
   * per-event build entirely).
   */
  const subscribers = new Set<number>();
  /** Senders whose lifecycle hooks are currently armed, so repeated
   *  subscribe/unsubscribe cycles from one renderer never stack listeners. */
  const hookedSenders = new Set<number>();

  const hookSenderLifecycle = (sender: WebContents): void => {
    if (hookedSenders.has(sender.id)) return;
    hookedSenders.add(sender.id);
    const senderId = sender.id;
    const dropSubscription = (): void => {
      subscribers.delete(senderId);
    };
    // Same teardown trio as task-detail-ownership.ts: a closed window, a crashed
    // renderer, and a hard reload all invalidate the renderer-side listener
    // without an unsubscribe call. The reload case matters most in dev - the
    // webContents survives with the same id, so without the navigation hook a
    // Ctrl+R with the monitor open would leave main pushing snapshots to a page
    // that no longer listens. In-page HMR does not navigate, so a dev session
    // keeps its subscription. Same-document (hash / history) navigations do not
    // tear the page down and are ignored. Registered with `on`, not `once`, and
    // the sender stays in `hookedSenders` across reloads (the webContents
    // survives), so a re-subscribe after a reload never stacks a second
    // listener; only real teardown unhooks.
    sender.on('did-start-navigation', (details) => {
      if (!details.isMainFrame || details.isSameDocument) return;
      dropSubscription();
    });
    const dropOnTeardown = (): void => {
      dropSubscription();
      hookedSenders.delete(senderId);
    };
    sender.once('destroyed', dropOnTeardown);
    sender.once('render-process-gone', dropOnTeardown);
  };

  const buildSnapshotSafe = () => {
    try {
      return buildMonitorSnapshot(context);
    } catch (error) {
      // Same reasoning as the push path below: one project's DB hiccup must not
      // fail the whole cross-project fetch. `resolveProject` already guards the
      // per-project OPEN, but the per-row reads against an already-open handle
      // are not individually wrapped, so a mid-loop throw would otherwise reject
      // this invoke and leave the monitor blank for every project.
      console.error('[monitor] Failed to build snapshot for fetch:', error);
      return { rows: [], generatedAt: new Date().toISOString() };
    }
  };

  ipcMain.handle(IPC.MONITOR_GET_SNAPSHOT, () => buildSnapshotSafe());

  ipcMain.handle(IPC.MONITOR_SUBSCRIBE, (event) => {
    subscribers.add(event.sender.id);
    hookSenderLifecycle(event.sender);
    // One round trip: registering and seeding are the same call, so a mounting
    // monitor cannot race the next push for its first frame of data.
    return buildSnapshotSafe();
  });

  ipcMain.handle(IPC.MONITOR_UNSUBSCRIBE, (event) => {
    subscribers.delete(event.sender.id);
  });

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
    // No monitor mounted anywhere: skip the whole pipeline. Checked again when
    // the debounce fires, because the last subscriber can vanish inside the
    // window. A monitor that mounts BETWEEN events needs no catch-up push -
    // subscribing returned it a fresh snapshot.
    if (subscribers.size === 0) return;
    if (pushTimer) return;
    pushTimer = setTimeout(() => {
      pushTimer = null;
      if (subscribers.size === 0) return;
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

  /**
   * The live output peek. Broadcast (not `webContents.send`) for the same reason
   * MONITOR_CHANGED is: a detached monitor is its own renderer and subscribes on
   * its own behalf, so it must receive these directly.
   */
  const peekTracker = new MonitorPeekTracker({
    sessionManager: context.sessionManager,
    emit: (peeks) => {
      if (context.mainWindow.isDestroyed()) return;
      broadcast(context.mainWindow, IPC.MONITOR_PEEK, peeks);
    },
  });

  /** Renderers whose peek teardown is already wired, so repeated subscribes do
   *  not stack duplicate listeners. The monitor overlay mounts and unmounts on
   *  every open/close, so without this a long dogfooding session accumulates one
   *  `destroyed` listener per open on the same long-lived webContents. Mirrors
   *  `focusTeardownWatched` in handlers/sessions.ts. */
  const peekTeardownWatched = new Set<number>();

  /**
   * Subscribe-gated, unlike every other monitor push. The peek is the one stream
   * with a standing cost (a PTY output listener plus a sampling timer), so main
   * only pays it while a monitor is actually on screen.
   *
   * Keyed by the SENDER's id rather than a bare boolean: the main window and a
   * detached monitor window subscribe independently, and the listener's lifetime
   * follows the union. The renderer sends its own unsubscribe on unmount; the
   * three hooks below cover every way it can go away without getting to.
   */
  ipcMain.handle(IPC.MONITOR_SET_PEEK_SUBSCRIBED, (event, subscribed: boolean) => {
    const sender = event.sender;
    const rendererId = sender.id;
    if (!subscribed) {
      peekTracker.unsubscribe(rendererId);
      return;
    }
    peekTracker.subscribe(rendererId);
    if (peekTeardownWatched.has(rendererId)) return;
    peekTeardownWatched.add(rendererId);

    /**
     * A RELOAD is the case that bites, and it is not a teardown.
     *
     * `destroyed` never fires for one: the webContents survives with the SAME id,
     * so the tracker keeps the subscription while the fresh page comes up with no
     * memory of it. The renderer cannot self-correct either - `monitorOpen` boots
     * false, so `MonitorBody` never remounts to send its unsubscribe. Main would
     * then keep the PTY output listener and the 500ms sampler running forever for
     * a window that is not listening, permanently defeating the cost bound this
     * channel is subscribe-gated to enforce. Reachable in one click: the monitor
     * is wrapped in `PanelErrorBoundary`, whose Reload calls `location.reload()`.
     *
     * Registered with `on`, not `once` - a renderer can reload any number of
     * times - and `peekTeardownWatched` is what keeps that from stacking
     * listeners. Mirrors handlers/task-detail-ownership.ts.
     */
    sender.on('did-start-navigation', (details) => {
      if (!details.isMainFrame || details.isSameDocument) return;
      peekTracker.unsubscribe(rendererId);
    });

    // `render-process-gone` as well as `destroyed`: a crashed renderer never
    // fires `destroyed`, and would otherwise hold the stream open for nobody.
    const forget = (): void => {
      peekTracker.unsubscribe(rendererId);
      peekTeardownWatched.delete(rendererId);
    };
    sender.once('destroyed', forget);
    sender.once('render-process-gone', forget);
  });
}
