/**
 * Orchestrates the per-project warm-switch cache: snapshot the
 * outgoing project's slice state, restore the incoming project's
 * snapshot when available, fall through to the IPC fan-out + hard
 * reset on cold misses.
 *
 * Pairs with `src/renderer/stores/project-cache.ts`. The cache module
 * holds the map; this hook decides when to capture, when to restore,
 * and what cold-path reset looks like.
 *
 * Why a hook and not inline in App.tsx: this is the renderer-side
 * lifecycle of `project-cache.ts`. Co-locating them gives the cache
 * layer one home, lets the hook grow its own unit/integration tests
 * without going through the full app render, and keeps App.tsx
 * focused on top-level wiring rather than per-project lifecycle.
 *
 * The hook reads stores via `getState()` rather than selectors. The
 * effect only depends on `currentProject`; the store accessors must
 * not become reactive dependencies or the effect would re-run on
 * every unrelated store mutation and over-snapshot.
 */
import { useEffect, useRef } from 'react';
import type { Project, SessionEvent } from '../../shared/types';
import { useBoardStore } from '../stores/board-store';
import { useBacklogStore } from '../stores/backlog-store';
import { useConfigStore } from '../stores/config-store';
import { useSessionStore, cancelSync } from '../stores/session-store';
import {
  isWarmProject,
  markProjectSeen,
  snapshotProject,
  getProjectSnapshot,
} from '../stores/project-cache';
import { restoreWorkspaceForProject } from '../window-manager/persistence/restore-workspace';
import { useWindowStore } from '../window-manager/store/window-store';

export function useProjectSwitchEffect(currentProject: Project | null): void {
  // Tracks the project we last rendered so we can snapshot its store
  // state at switch-away. Held in a ref rather than derived state so
  // the effect closure can read the previous id without becoming a
  // dependency (we only want to react to currentProject changes).
  const previousProjectIdRef = useRef<string | null>(null);

  useEffect(() => {
    const previousProjectId = previousProjectIdRef.current;

    // HMR parity: a Vite Fast Refresh runs App.tsx's `vite:afterUpdate` handler,
    // which calls `loadCurrent()` / `loadProjects()` and replaces `currentProject`
    // with a NEW object that has the SAME id. That reference change re-fires this
    // effect even though no project switch happened. Running the switch logic then
    // wrongly resets per-project view state - notably `dialogSessionIds: []`, which
    // wipes the claims of HMR-preserved detail windows. Those windows do not
    // re-claim (their claim effect is keyed on `session?.id`, unchanged across
    // HMR), so the bottom-panel focus set collapses and every non-active window's
    // PTY output is suppressed (a frozen, unresizable terminal). A same-id re-fire
    // is never a real switch, and `vite:afterUpdate` already re-syncs board /
    // config / sessions on its own, so this effect must be inert here.
    if (previousProjectId !== null && previousProjectId === (currentProject?.id ?? null)) {
      return;
    }

    // Capture the outgoing project's slice state before we mutate the
    // stores. Skip self-switches (same id) and the initial cold mount
    // (no previous project to snapshot).
    if (previousProjectId && previousProjectId !== (currentProject?.id ?? null)) {
      // Persist the OUTGOING project's window layout FIRST, before snapshotting its
      // config and before the incoming restore mutates the window store. The
      // per-window debounced save (useWorkspacePersistence) may not have fired yet -
      // e.g. a window closed in the last 500ms - so without this, switching away and
      // back would restore a stale, pre-close layout. Reading the live window store
      // here, keyed by the explicit outgoing id, keeps the two consistent (never a
      // cross-project write); doing it before the snapshot means the warm-switch
      // restore (which sets config from the snapshot) carries the corrected layout.
      useConfigStore.getState().saveWorkspaceForProject(
        previousProjectId,
        useWindowStore.getState().serializeWorkspace(),
      );

      // Now that the outgoing project's conversation windows are captured in its
      // blob, close them promptly: unlike task-detail windows (removed by
      // useWindowAutoCloseOnDone's board-membership check, which deliberately
      // skips conversation windows since their anchor is a session id, not a
      // taskId), nothing else removes a conversation window on switch. Closing
      // here - synchronously, before the incoming restore runs - means a
      // carried-over window never appears on the destination project, with no
      // cold-path flash. The destination's own conversation windows (if any)
      // are added back by restoreWorkspaceForProject below.
      const closeWindow = useWindowStore.getState().closeWindow;
      for (const managedWindow of Object.values(useWindowStore.getState().windows)) {
        if (managedWindow.kind === 'conversation') {
          closeWindow(managedWindow.id);
        }
      }

      const boardState = useBoardStore.getState();
      const backlogState = useBacklogStore.getState();
      const configState = useConfigStore.getState();
      const sessionState = useSessionStore.getState();
      snapshotProject(previousProjectId, {
        board: {
          tasks: boardState.tasks,
          swimlanes: boardState.swimlanes,
          archivedTasks: boardState.archivedTasks,
          archivedTotalCount: boardState.archivedTotalCount,
          archivedFullyLoaded: boardState.archivedFullyLoaded,
          shortcuts: boardState.shortcuts,
        },
        backlog: backlogState.items,
        config: configState.config,
        view: {
          detailTaskId: sessionState.detailTaskId,
          // activeSessionId is intentionally NOT snapshotted; see the
          // comment in ProjectSnapshot. Warm restore re-derives it from
          // config.lastActiveTaskByProject below.
        },
      });
    }

    previousProjectIdRef.current = currentProject?.id ?? null;

    if (currentProject) {
      // Invalidate any in-flight syncSessions() calls from a previous
      // cold switch. Cheap; safe to run on warm switches too.
      cancelSync();

      // Arm the bottom terminal panel to render collapsed from the first frame if this project
      // will restore detail windows. `dialogSessionIds` is cleared synchronously just below and
      // only repopulated asynchronously by the (cold-path: doubly-deferred) workspace restore, so
      // without this the panel would flash expanded for that gap. `workspaceByProject` is
      // renderer-authoritative and preserved across config reloads, so it is readable
      // synchronously even on a cold switch. Arming to null for a no-window destination also
      // disarms any prior arm, so it can never leak into a switch to an expanded project. The arm
      // is cleared once the restore for this project completes (warm + cold below).
      //
      // Only a `task-detail` window (default kind for a window with no persisted `kind`, i.e.
      // every pre-existing blob) claims a PTY and forces the collapse - a persisted conversation
      // window never claims `dialogSessionIds` (useWindowSessionClaims skips it), so it must not
      // arm this signal or the panel would collapse-then-reopen for no reason while it restores.
      const destinationHasPersistedDetailWindows = (
        useConfigStore.getState().config.workspaceByProject?.[currentProject.id]?.windows ?? []
      ).some((window) => (window.kind ?? 'task-detail') === 'task-detail');
      useSessionStore.getState().setPendingDetailWindowsProjectId(
        destinationHasPersistedDetailWindows ? currentProject.id : null,
      );

      const warmCacheHit = isWarmProject(currentProject.id);

      if (warmCacheHit) {
        // Pointer-swap path. The slices we restore here cover the full
        // board/backlog/config/view state. Sessions, sessionActivity,
        // sessionUsage, and sessionEvents are deliberately NOT in the
        // cache: those span projects (or are pushed incrementally) and
        // are kept fresh by `onStatus`/`onActivity`/`onUsage`/`onEvent`
        // listeners regardless of which project is current.
        const snapshot = getProjectSnapshot(currentProject.id)!;
        useBoardStore.setState({
          tasks: snapshot.board.tasks,
          swimlanes: snapshot.board.swimlanes,
          archivedTasks: snapshot.board.archivedTasks,
          archivedTotalCount: snapshot.board.archivedTotalCount,
          archivedFullyLoaded: snapshot.board.archivedFullyLoaded,
          shortcuts: snapshot.board.shortcuts,
          hydrated: true,
          loading: false,
        });
        useBacklogStore.setState({
          items: snapshot.backlog,
          hydrated: true,
          loading: false,
        });
        useConfigStore.setState({ config: snapshot.config, loading: false });

        useSessionStore.setState({
          detailTaskId: snapshot.view.detailTaskId,
          // Reset activeSessionId so the re-derivation below is not
          // shadowed by a stale carry-over from the project we are
          // leaving. The TerminalPanel auto-select effect runs child-first
          // and may have written the previous project's session id here;
          // clearing it lets the lastActiveTaskByProject lookup land.
          activeSessionId: null,
          // Window-owned session claims are per-window and re-claimed when a
          // detail window re-renders against the live session list, so they
          // need no separate restore - clear them on switch.
          dialogSessionIds: [],
          // The conversation signal ("open/focus this conversation now") is
          // per-project, so drop it on switch; the window itself persists via the
          // workspace blob and restores below. A cross-project handoff re-arms the
          // signal via `_pendingOpenConversation` below.
          conversationSessionId: null,
          scrollToTurnUuid: null,
        });

        // Re-derive the active tab from config rather than the live
        // store: the user's persisted choice (`lastActiveTaskByProject`)
        // is the single source of truth. Same logic as the cold path's
        // syncSessions().then() callback.
        const rememberedTaskId =
          useConfigStore.getState().config.lastActiveTaskByProject?.[currentProject.id];
        if (rememberedTaskId) {
          const sessionForTask = useSessionStore.getState()._sessionByTaskId.get(rememberedTaskId);
          if (
            sessionForTask
            && sessionForTask.projectId === currentProject.id
            && sessionForTask.status === 'running'
            && !sessionForTask.transient
          ) {
            useSessionStore.getState().setActiveSession(sessionForTask.id);
          }
        }

        useSessionStore.getState().markIdleSessionsSeen(currentProject.id);

        // Open task detail dialog if a notification click set a pending task ID
        const pendingTaskId = useSessionStore.getState()._pendingOpenTaskId;
        if (pendingTaskId) {
          useSessionStore.getState().setPendingOpenTaskId(null);
          useSessionStore.getState().setDetailTaskId(pendingTaskId);
        }

        // Open the conversation viewer if a cross-project search hit queued one.
        const pendingConversation = useSessionStore.getState()._pendingOpenConversation;
        if (pendingConversation) {
          const pendingScrollToTurnUuid = useSessionStore.getState()._pendingScrollToTurnUuid;
          useSessionStore.getState().setPendingOpenConversation(null);
          useSessionStore.getState().setPendingScrollToTurnUuid(null);
          // Arm the scroll target before the session id so it is set when the
          // conversation window mounts and consumes it.
          if (pendingScrollToTurnUuid) {
            useSessionStore.getState().setScrollToTurnUuid(pendingScrollToTurnUuid);
          }
          useSessionStore.getState().setConversationSessionId(pendingConversation);
        }

        // Restore the persisted window layout. Warm switches keep sessions live,
        // so this resolves synchronously; a cheap setState lets the restored
        // windows appear with the board (no flash) without blocking the swap.
        restoreWorkspaceForProject(currentProject.id);

        // The destination's windows are now in the window store, so the live
        // `dialogSessionIds` (reconciled next frame by useWindowSessionClaims) takes over the
        // collapse decision. Disarm the pending signal. On the warm path this whole effect is
        // synchronous, so this is effectively a no-op (warm never flashed); kept for symmetry.
        useSessionStore.getState().setPendingDetailWindowsProjectId(null);
      } else {
        // Cold path: fire the IPC fan-out and reset stale per-project
        // view state. After loads resolve, mark the project as seen so
        // the next switch to it takes the warm path.
        //
        // Clear the archive state BEFORE loadBoard so a leftover
        // archivedFullyLoaded:true from the previous project can neither keep
        // the old archive visible nor make this project's first loadBoard
        // fetch the full archive. archiveViewers is intentionally NOT reset:
        // it is refcounted by live component mount/unmount, not by switches.
        useBoardStore.setState({ archivedTasks: [], archivedTotalCount: 0, archivedFullyLoaded: false });
        const coldLoads = Promise.all([
          useBoardStore.getState().loadBoard(),
          useBacklogStore.getState().loadBacklog(),
          useConfigStore.getState().loadConfig(),
        ]);

        // Clear per-project view state before syncing. This prevents
        // stale data from the previous project leaking into the new
        // project's terminal/events. sessionActivity, sessions, and
        // sessionUsage are intentionally preserved (cross-project /
        // harmless stale keys / would cause a flash-to-0%). Preserve
        // sessionEvents for stashed transient sessions (they have no
        // DB backup).
        const currentSessionState = useSessionStore.getState();
        const stashedTransientSessionIds = new Set(
          Object.values(currentSessionState.transientSessions)
            .map((entry) => entry.sessionId),
        );
        const preservedEvents: Record<string, SessionEvent[]> = {};
        for (const [sessionId, events] of Object.entries(currentSessionState.sessionEvents)) {
          if (stashedTransientSessionIds.has(sessionId)) {
            preservedEvents[sessionId] = events;
          }
        }
        useSessionStore.setState({
          activeSessionId: null,
          dialogSessionIds: [],
          detailTaskId: null,
          conversationSessionId: null,
          scrollToTurnUuid: null,
          sessionEvents: preservedEvents,
        });

        useSessionStore.getState().syncSessions().then((applied) => {
          if (!applied) {
            useSessionStore.getState().setPendingOpenTaskId(null);
            return;
          }
          useSessionStore.getState().markIdleSessionsSeen(currentProject.id);

          // Restore the last user-selected task tab for this project.
          // If the task no longer has a running session, fall through and
          // let TerminalPanel's auto-select pick a default.
          const rememberedTaskId =
            useConfigStore.getState().config.lastActiveTaskByProject?.[currentProject.id];
          if (rememberedTaskId) {
            const sessionForTask = useSessionStore.getState()._sessionByTaskId.get(rememberedTaskId);
            if (
              sessionForTask
              && sessionForTask.projectId === currentProject.id
              && sessionForTask.status === 'running'
              && !sessionForTask.transient
            ) {
              useSessionStore.getState().setActiveSession(sessionForTask.id);
            }
          }

          // Open task detail dialog if a notification click set a pending task ID
          const pendingTaskId = useSessionStore.getState()._pendingOpenTaskId;
          if (pendingTaskId) {
            useSessionStore.getState().setPendingOpenTaskId(null);
            useSessionStore.getState().setDetailTaskId(pendingTaskId);
          }

          // Open the conversation viewer if a cross-project search hit queued one.
          const pendingConversation = useSessionStore.getState()._pendingOpenConversation;
          if (pendingConversation) {
            const pendingScrollToTurnUuid = useSessionStore.getState()._pendingScrollToTurnUuid;
            useSessionStore.getState().setPendingOpenConversation(null);
            useSessionStore.getState().setPendingScrollToTurnUuid(null);
            // Arm the scroll target before the session id so it is set when the
            // conversation window mounts and consumes it.
            if (pendingScrollToTurnUuid) {
              useSessionStore.getState().setScrollToTurnUuid(pendingScrollToTurnUuid);
            }
            useSessionStore.getState().setConversationSessionId(pendingConversation);
          }

          markProjectSeen(currentProject.id);

          // Restore the persisted window layout once the board + config loads AND
          // sessions have all resolved, so windows re-bind to live sessions and the
          // task-existence check sees the real board. Deferred off the switch's
          // critical path (the board paints first); skipped if a newer switch has
          // superseded this one mid-load.
          void coldLoads.then(
            () => {
              if (previousProjectIdRef.current !== currentProject.id) return;
              restoreWorkspaceForProject(currentProject.id);
              // Restore for this project is complete (its detail windows, if any, are now in the
              // window store). Disarm the pending collapse signal; the live `dialogSessionIds`
              // (reconciled by useWindowSessionClaims) drives the panel from here. Guarded above
              // so a superseding switch keeps its own newer arm.
              useSessionStore.getState().setPendingDetailWindowsProjectId(null);
            },
            () => {
              // A board / backlog / config load rejected: no workspace will restore, so disarm
              // rather than leave the panel stuck collapsed. Skip if a newer switch superseded
              // this one (it owns the signal now).
              if (previousProjectIdRef.current !== currentProject.id) return;
              useSessionStore.getState().setPendingDetailWindowsProjectId(null);
            },
          );
        });
      }

      // Restore persisted usage period regardless of cache path. Cheap
      // setState if the value already matches.
      const savedPeriod = useConfigStore.getState().config.statusBarPeriod;
      if (savedPeriod && savedPeriod !== useSessionStore.getState().selectedPeriod) {
        useSessionStore.getState().setSelectedPeriod(savedPeriod);
      }
    } else {
      useBoardStore.setState({ tasks: [], swimlanes: [], archivedTasks: [], archivedTotalCount: 0, archivedFullyLoaded: false });
      useSessionStore.setState({
        activeSessionId: null,
        dialogSessionIds: [],
        detailTaskId: null,
        conversationSessionId: null,
        scrollToTurnUuid: null,
        pendingDetailWindowsProjectId: null,
      });
      // Reset effective config to global defaults (no project overrides)
      useConfigStore.getState().loadConfig();
    }
  }, [currentProject]);
}
