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
      const boardState = useBoardStore.getState();
      const backlogState = useBacklogStore.getState();
      const configState = useConfigStore.getState();
      const sessionState = useSessionStore.getState();
      snapshotProject(previousProjectId, {
        board: {
          tasks: boardState.tasks,
          swimlanes: boardState.swimlanes,
          archivedTasks: boardState.archivedTasks,
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

        // Restore the persisted window layout. Warm switches keep sessions live,
        // so this resolves synchronously; a cheap setState lets the restored
        // windows appear with the board (no flash) without blocking the swap.
        restoreWorkspaceForProject(currentProject.id);
      } else {
        // Cold path: fire the IPC fan-out and reset stale per-project
        // view state. After loads resolve, mark the project as seen so
        // the next switch to it takes the warm path.
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

          markProjectSeen(currentProject.id);

          // Restore the persisted window layout once the board + config loads AND
          // sessions have all resolved, so windows re-bind to live sessions and the
          // task-existence check sees the real board. Deferred off the switch's
          // critical path (the board paints first); skipped if a newer switch has
          // superseded this one mid-load.
          void coldLoads.then(() => {
            if (previousProjectIdRef.current !== currentProject.id) return;
            restoreWorkspaceForProject(currentProject.id);
          });
        });
      }

      // Restore persisted usage period regardless of cache path. Cheap
      // setState if the value already matches.
      const savedPeriod = useConfigStore.getState().config.statusBarPeriod;
      if (savedPeriod && savedPeriod !== useSessionStore.getState().selectedPeriod) {
        useSessionStore.getState().setSelectedPeriod(savedPeriod);
      }
    } else {
      useBoardStore.setState({ tasks: [], swimlanes: [], archivedTasks: [] });
      useSessionStore.setState({
        activeSessionId: null,
        dialogSessionIds: [],
        detailTaskId: null,
      });
      // Reset effective config to global defaults (no project overrides)
      useConfigStore.getState().loadConfig();
    }
  }, [currentProject]);
}
