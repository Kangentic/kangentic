/**
 * The Agent Monitor's task-detail window layer: the SAME `TaskDetailWindow` the
 * board hosts, mounted over the monitor for a task in any project.
 *
 * This is the third instance of the window engine (board, command terminal, this
 * one). Tiling, snapping, maximize, the seam drag and the min-pane floor all come
 * from the engine, so several agents across several projects can be watched and
 * driven side by side with no new layout code.
 *
 * Two things differ from the board layer, both supplied rather than branched:
 *   - windows are anchored by `projectId:taskId`, because a task id alone does
 *     not identify a row when rows span projects;
 *   - the layer supplies `renderTaskDetail`, so its windows resolve through the
 *     per-project bundle (`MonitorTaskDetailHost`) instead of the board store.
 *
 * Opening is arbitrated by MAIN, never locally: `taskDetailOwnership.requestOpen`
 * decides whether this layer, the board, or an already-open window gets the
 * task. That is what enforces "a task's detail can never be open twice" across
 * renderers - see src/main/task-detail/detail-owner-registry.ts.
 */

import { useCallback, useEffect, useRef } from 'react';
import { WindowManagerLayer, monitorWindowManager } from '../../window-manager';
import type { WindowManagerLayerOptions, TaskDetailRenderInput } from '../../window-manager';
import { TaskDetailWindow } from '../../window-manager/components/TaskDetailWindow';
import { scheduleWindowTerminalResize } from '../../window-manager/terminal/resize-coalescer';
import type { Task } from '../../../shared/types';
import { DEFAULT_MIN_WIDTH_PX, DEFAULT_MIN_HEIGHT_PX } from '../../window-manager/dnd/useWindowResize';
import { MonitorTaskDetailHost } from './MonitorTaskDetailHost';
import { useSessionStore } from '../../stores/session-store';
import { useClickOutsideToClose } from '../../window-manager/bridge/useClickOutsideToClose';
import { monitorDetailAnchor, parseMonitorAnchor } from '../../window-manager/store/monitor-anchor';
import { readPopOutDescriptor } from '../../pop-out/read-descriptor';
import { boardWindowManager } from '../../window-manager';
import { useConfigStore } from '../../stores/config-store';
import { createWorkspaceSaver } from '../../window-manager/persistence/workspace-saver';
import { planMonitorWorkspaceRestore, shouldPersistMonitorWorkspace } from './monitor-workspace-restore';

/** Long enough to clear the window frame's entrance transition, so the settle
 *  refit measures the committed size rather than a mid-animation transform. */
const ENTRANCE_SETTLE_MS = 260;

export { monitorDetailAnchor };
// Re-exported so the monitor's rows and context menu keep one import site while the
// ownership half lives in a module that outlives this layer.
export { requestMonitorDetail } from './useMonitorDetailOwnership';

/**
 * Sits above the monitor overlay (z-42) and below the Command Terminal layer
 * (z-45), which the monitor already hides on open. `pointer-events-none` so the
 * monitor's own rows stay clickable in the gaps between windows, exactly like the
 * board layer over the board.
 */
const MONITOR_DETAIL_OVERLAY_CLASS =
  'fixed left-0 right-0 top-10 bottom-9 z-[43] pointer-events-none';

function MonitorDetailContent({ anchor, ...rest }: TaskDetailRenderInput) {
  const parsed = parseMonitorAnchor(anchor);
  const close = rest.requestClose;
  const handleUnavailable = useCallback(() => { close(); }, [close]);

  if (!parsed) return null;
  return (
    <MonitorTaskDetailHost
      projectId={parsed.projectId}
      taskId={parsed.taskId}
      onUnavailable={handleUnavailable}
    >
      {(task) => (
        <MonitorDetailBody
          task={task}
          windowId={rest.windowId}
          isFocused={rest.isFocused}
          isMaximized={rest.isMaximized}
          initialEdit={rest.initialEdit}
          titleBarPointerDown={rest.titleBarPointerDown}
          requestClose={rest.requestClose}
        />
      )}
    </MonitorTaskDetailHost>
  );
}

/**
 * The window body, plus the one thing this layer needs that the board's does not:
 * a refit once the content actually mounts.
 *
 * A window-manager terminal deliberately has NO per-container ResizeObserver
 * (`TerminalTab`'s `deferContainerResize`) - the engine owns sizing and refits on
 * a single `terminal-panel-resize`, which `WindowFrame` dispatches from a layout
 * effect when the FRAME mounts. On the board that is the same commit as the
 * terminal, because the task comes out of the store synchronously.
 *
 * Here the task arrives from an async bundle fetch (`MonitorTaskDetailHost`), so
 * the frame's dispatch necessarily fires while this subtree is still `null` and
 * the terminal mounts some frames later, having missed the only resize the engine
 * was going to send. This re-sends it once the content is really there.
 *
 * Re-using the engine's own coalescer (rather than a bespoke fit) keeps this on
 * the single settle-resize path every other host uses.
 */
function MonitorDetailBody(props: {
  task: Task;
  windowId: string;
  isFocused: boolean;
  isMaximized: boolean;
  initialEdit?: boolean;
  titleBarPointerDown: (event: React.PointerEvent) => void;
  requestClose: () => void;
}) {
  useEffect(() => {
    // After the entrance animation settles, so the fit measures the window's real
    // size rather than its mid-transform one.
    const timer = setTimeout(scheduleWindowTerminalResize, ENTRANCE_SETTLE_MS);
    scheduleWindowTerminalResize();
    return () => clearTimeout(timer);
  }, [props.windowId, props.task.id]);

  return <TaskDetailWindow {...props} />;
}

const MONITOR_LAYER_OPTIONS: WindowManagerLayerOptions = {
  minSize: { width: DEFAULT_MIN_WIDTH_PX, height: DEFAULT_MIN_HEIGHT_PX },
  renderTaskDetail: (input) => <MonitorDetailContent key={input.windowId} {...input} />,
};

/** The saver's key slot: the monitor's blob is GLOBAL (not project-keyed), but
 *  `createWorkspaceSaver` bails on a null id, so it gets a constant - the same trick
 *  `useCommandWorkspacePersistence` uses. */
const MONITOR_WORKSPACE_KEY = 'monitor';

/**
 * Persist the monitor's detail layout, and restore it when this host takes over.
 *
 * Mounted INSIDE the layer rather than at renderer lifetime, and that is the whole
 * concurrency argument: the layer is mounted in exactly one renderer at a time (the
 * in-app monitor and the pop-out are mutually exclusive - `AppLayout` renders the
 * overlay as `{monitorOpen && !popOut.isOpen}`), so the global blob never has two
 * writers racing it.
 *
 * The flush on unmount is what makes DETACH work: closing or detaching the monitor
 * writes the layout synchronously, so the host that takes over reads it back.
 */
function useMonitorWorkspacePersistence(): void {
  const save = useConfigStore((state) => state.saveMonitorWorkspace);
  const flush = useConfigStore((state) => state.flushMonitorWorkspace);

  useEffect(() => {
    // A host may only write the blob once it has actually held a window - see
    // `shouldPersistMonitorWorkspace` for why an empty store is ambiguous and what
    // ignoring that cost us.
    let hasHeldWindows = Object.keys(monitorWindowManager.store.getState().windows).length > 0;
    const mayPersist = (workspace: { windows: unknown[] }): boolean =>
      shouldPersistMonitorWorkspace({ windowCount: workspace.windows.length, hasHeldWindows });

    const saver = createWorkspaceSaver({
      getProjectId: () => MONITOR_WORKSPACE_KEY,
      getWorkspace: () => monitorWindowManager.store.getState().serializeWorkspace(),
      save: (_key, workspace) => {
        if (mayPersist(workspace)) save(workspace);
      },
      saveSync: (_key, workspace) => {
        if (mayPersist(workspace)) flush(workspace);
      },
    });

    const onChange = (): void => {
      if (Object.keys(monitorWindowManager.store.getState().windows).length > 0) hasHeldWindows = true;
      saver.onChange();
    };
    const unsubscribe = monitorWindowManager.store.subscribe(onChange);

    // Assert this host's layout once on mount when it already holds windows, mirroring
    // the ownership reporter's initial report. Without it, a host that opens the layer
    // over an existing window and then changes nothing never writes the blob - so
    // detaching would hand the next host a stale or empty layout even though a window
    // was plainly on screen.
    if (hasHeldWindows) saver.onChange();
    const flushBeforeUnload = (): void => saver.flush();
    window.addEventListener('beforeunload', flushBeforeUnload);
    return () => {
      window.removeEventListener('beforeunload', flushBeforeUnload);
      unsubscribe();
      // Deliberately NO flush on unmount. Closing or detaching the monitor tears this
      // layer down while the layout is still wanted; the debounced save has already
      // written every real change, and a teardown write can only ever be a worse,
      // more race-prone copy of it.
      saver.dispose();
    };
  }, [save, flush]);
}

/**
 * Restore the saved layout when this host mounts the layer with NOTHING open.
 *
 * The empty-store guard is what keeps the blob subordinate to live state. The window
 * store is a module singleton that outlives the layer, so the in-app monitor already
 * brings its own windows back on reopen; the blob is only consulted when this
 * renderer genuinely has none - a fresh pop-out, or an in-app monitor whose windows
 * were displaced while it was detached. Closing every detail saves an empty layout,
 * so windows the user deliberately closed do not reappear.
 *
 * Safe to open windows here for the same reason `useEnsureCommandWindow` is: an empty
 * store has committed zero frames, so no window mount effect can race this one.
 */
function useRestoreMonitorWorkspace(): void {
  // Read the blob REACTIVELY rather than once on mount. A pop-out loads its config
  // asynchronously (`usePopOutBootstrap`), so this layer can mount before the blob has
  // arrived; a one-shot read would see null and the detached monitor would come up
  // empty - silently losing exactly the handoff this exists for.
  const savedWorkspace = useConfigStore((state) => state.globalConfig.monitorWorkspace);
  // Also re-run when the session list lands. A pop-out seeds its sessions
  // asynchronously (`syncSessions` in the monitor surface's bootstrap), so a
  // restore that ran before they arrived would find no live agent and restore
  // nothing - permanently, if it burned its one shot doing so.
  const sessions = useSessionStore((state) => state.sessions);
  // At most one ACTUAL restore per layer mount, consumed only when something is really
  // restored. Reopening the monitor mounts a fresh layer and restores again, which is
  // the intent; a run that restores nothing leaves the shot unspent so a later session
  // or config update can still do it.
  const restoredRef = useRef(false);

  useEffect(() => {
    if (restoredRef.current) return;
    const store = monitorWindowManager.store;
    if (Object.keys(store.getState().windows).length > 0) return;

    const saved = savedWorkspace;
    if (!saved) return;

    const sessionState = useSessionStore.getState();
    const boardTaskIds = Object.values(boardWindowManager.store.getState().windows)
      .filter((managedWindow) => managedWindow.kind === 'task-detail')
      .map((managedWindow) => managedWindow.anchor);

    const plan = planMonitorWorkspaceRestore({
      workspace: saved,
      ownedElsewhere: sessionState.remoteDetailTaskIds,
      boardTaskIds,
      liveTaskIds: sessionState.sessions
        .filter((candidate) => candidate.status === 'running')
        .map((candidate) => candidate.taskId),
    });
    // Nothing restorable (yet): leave `restoredRef` unspent so a later session-list or
    // config update gets another chance.
    if (plan.restorableAnchors.size === 0) return;
    if (plan.skippedAnchors.length > 0) {
      console.info('[monitor] skipped restoring details that are finished or open elsewhere:', plan.skippedAnchors);
    }
    restoredRef.current = true;

    store.getState().applyWorkspace(
      saved,
      // Resolve the live session by the anchor's task id, not the persisted session id,
      // which goes stale across a respawn - the same rule every other host follows.
      (anchor) => {
        const parsed = parseMonitorAnchor(anchor);
        if (!parsed) return null;
        return useSessionStore.getState().sessions
          .find((candidate) => candidate.taskId === parsed.taskId)?.id ?? null;
      },
      (anchor) => plan.restorableAnchors.has(anchor),
    );
    // No ownership call here: `useMonitorDetailOwnership`'s derived reporter turns the
    // restored windows into main's record, exactly as it does for a user-opened one.
  }, [savedWorkspace, sessions]);
}

/**
 * Mounts a window when MAIN tells this renderer to, and releases the claim when
 * one closes. Mirrors the board's bridge; kept separate because the two layers
 * have different stores and different anchors.
 */
function MonitorDetailBridge(): null {
  // Restore BEFORE persistence subscribes, so the restore's own store writes are not
  // immediately saved back over the blob being read.
  useRestoreMonitorWorkspace();
  useMonitorWorkspacePersistence();

  // Light dismiss, matching the board: a click on empty space outside a window
  // closes it per the user's "Close on Outside Click" setting. The board gets this
  // from its own layer bridges; without mounting it here the monitor's windows
  // would silently ignore a setting the user has already chosen. The `monitor`
  // scope is load-bearing: it binds this instance to the monitor's own
  // `data-dismiss-layer` subtree AND to the monitor's window store (via the layer
  // context), so it closes these windows rather than the board's underneath.
  //
  // Ownership is deliberately NOT here. Mounting / closing on main's instruction and
  // reporting what is mounted all live in `useMonitorDetailOwnership`, mounted for the
  // renderer's lifetime, because this bridge unmounts whenever the monitor is closed
  // or detached while its window store survives - see that module's header.
  useClickOutsideToClose('monitor');

  /**
   * Publish this layer's visible sessions, which is what makes its terminals
   * receive PTY data at all: main gates emitting on the union of every renderer's
   * focused set and routes each session's bytes to the renderers that declared it
   * (see SessionManager.setFocusedSessions / getRenderersFocusedOn).
   *
   * ONLY in a pop-out window. `SESSION_SET_FOCUSED` is a whole-set REPLACE keyed
   * on the sender's webContents id, so two publishers inside one renderer fight:
   * last writer wins and the loser's terminals go silent. The main window already
   * has a single coordinator, `useFocusedSessionsSync`, which covers this layer
   * too - a monitor window's session reaches its focused set through
   * `dialogSessionIds` (rule 1 of `deriveFocusedSessionIds`), reconciled across
   * every layer by `useWindowSessionClaims`. A detached window has no such
   * coordinator, so there this layer is the only publisher and must do it itself.
   *
   * The gate cannot mis-fire in the direction that would silence a pop-out's
   * terminals: `index.tsx` mounts `PopOutSurfaceRoot` (and therefore this layer's
   * detached host) on exactly this call, so in any renderer where a detached
   * monitor exists the descriptor is non-null by construction. It is read from
   * `process.argv` at PRELOAD time, so there is no first-render race either. If it
   * were ever null here, the window would have booted the full app instead of the
   * monitor surface, and this layer would not be mounted at all.
   */
  const windows = monitorWindowManager.store((state) => state.windows);
  const sessions = useSessionStore((state) => state.sessions);
  const isDetachedWindow = readPopOutDescriptor() !== null;
  useEffect(() => {
    if (!isDetachedWindow) return;
    const focusedIds: string[] = [];
    for (const managedWindow of Object.values(windows)) {
      const parsed = parseMonitorAnchor(managedWindow.anchor);
      if (!parsed) continue;
      const session = sessions.find((candidate) => candidate.taskId === parsed.taskId);
      if (session && !focusedIds.includes(session.id)) focusedIds.push(session.id);
    }
    void window.electronAPI?.sessions?.setFocused(focusedIds);
  }, [windows, sessions, isDetachedWindow]);

  return null;
}

export function MonitorDetailLayer() {
  return (
    <WindowManagerLayer
      manager={monitorWindowManager}
      layer={MONITOR_LAYER_OPTIONS}
      portalHostId="monitor-detail-layer-root"
      overlayTestId="monitor-detail-overlay"
      overlayClassName={MONITOR_DETAIL_OVERLAY_CLASS}
      bridges={<MonitorDetailBridge />}
    />
  );
}
