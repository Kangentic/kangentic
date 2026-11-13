/**
 * Bridges the renderer's single "which task detail is open" signal
 * (`session-store.detailTaskId`) to a managed window. Every existing entry point
 * (card click, context Edit, search palette, session-event notification, the
 * terminal panel double-click, project-switch restore) already calls
 * `setDetailTaskId`; this hook turns that into an `openWindow` so none of them
 * needed to learn about the window store. It also mirrors a window close back to
 * the signal so persistence and re-open logic stay consistent.
 *
 * Ownership: the signal does NOT open a window directly any more. It asks MAIN
 * where the detail should go (`taskDetailOwnership.requestOpen`), and a window
 * mounts only when main pushes `onOpenHere` back to THIS renderer. That is what
 * enforces "a task's detail can never be open twice" across renderers: a pop-out
 * is a separate renderer with its own stores, so neither host can see the other's
 * windows, and only main can arbitrate. The two rules live in
 * `src/main/task-detail/detail-owner-registry.ts` - deliberately not duplicated
 * here.
 *
 * Multi-window: opening a DIFFERENT task's detail opens a second window (windows
 * are modeless and stack); the prior window stays open. `detailTaskId` tracks the
 * most-recently-opened detail (for focus + persistence). Terminal ownership is a
 * per-session set (`dialogSessionIds`), so each window owns its own session
 * without colliding; the bottom panel steps aside while any window is open.
 *
 * Mounted once by `WindowLayer`.
 */

import { useCallback, useEffect, useRef } from 'react';
import { useSessionStore } from '../../stores/session-store';
import { useBoardStore } from '../../stores/board-store';
import { reportRendererFailure } from '../../utils/renderer-failure';
import { useProjectStore } from '../../stores/project-store';
import { useWindowStore } from '../store/window-store';
import { taskDetailWindowInput } from './window-parking';

export function useTaskDetailWindowBridge(): void {
  const detailTaskId = useSessionStore((state) => state.detailTaskId);
  const windows = useWindowStore((state) => state.windows);

  // The window id we opened for the current detail signal, so the mirror effect
  // can detect when the user closed THAT window and clear the signal.
  const detailWindowIdRef = useRef<string | null>(null);
  // No per-window claim bookkeeping here. Ownership is DERIVED from this layer's
  // window store by `useDetailOwnershipSync` (mounted in `BoardBridges`), because a
  // remembered map is lost by any remount - and a lost release stranded a claim in
  // main, which made the task permanently unopenable.

  /**
   * Mount a window for a task in THIS renderer, and tell main we own it. Called
   * only from main's `onOpenHere` push, never directly from the signal. Stable
   * for the mount: it reads every store through `getState()` and closes over
   * nothing from render, so its dependency list is genuinely empty.
   */
  const openWindowFor = useCallback((projectId: string, taskId: string): void => {
    // This host renders from the OPEN project's board, so it cannot mount a task
    // belonging to another one. Switch to that project first and park the id; the
    // project-open path re-fires `detailTaskId`, which asks main again - by then
    // the board holds the task and this mounts normally. One extra round trip, no
    // loop: nothing was claimed, so the second resolve reaches the same decision.
    const currentProjectId = useProjectStore.getState().currentProject?.id ?? null;
    if (currentProjectId !== projectId) {
      useSessionStore.getState().setPendingOpenTaskId(taskId);
      void useProjectStore.getState().openProject(projectId);
      return;
    }

    const windowStore = useWindowStore.getState();

    // agent-focus-ok: this push is only ever a user's request, so this raise and
    // this focus are theirs. An agent's kangentic_browser_open_pane never asks
    // main to open a detail; its pane mounts through useBrowserPaneRequestBridge.

    // Focus an existing window for this task instead of opening a duplicate.
    // Scope to task-detail windows: a conversation window's anchor is a session
    // id, not a taskId, and must never be matched here.
    const existing = Object.values(windowStore.windows).find(
      (candidate) => candidate.kind === 'task-detail' && candidate.anchor === taskId,
    );
    if (existing) {
      // A PARKED window (the user closed it while its agent was live, or an
      // agent's pane opened it hidden) is un-parked in place rather than rebuilt:
      // same DOM node, same guest, same surface handle.
      if (existing.parked) windowStore.unparkWindow(existing.id);
      else windowStore.focusWindow(existing.id);
      detailWindowIdRef.current = existing.id;
      return;
    }

    const board = useBoardStore.getState();
    const task = board.tasks.find((candidate) => candidate.id === taskId)
      ?? board.archivedTasks.find((candidate) => candidate.id === taskId);
    // Not loaded: `openWhenLoaded` fetches the full archive for a finished task
    // older than the board's preview before calling this, so what is left is a
    // task that no longer exists.
    if (!task) return;

    const windowId = windowStore.openWindow({
      ...taskDetailWindowInput(task),
      initialEdit: useSessionStore.getState().detailTaskInitialEdit,
    });
    detailWindowIdRef.current = windowId;
    // No claim call: opening the window changed the store, and the derived reporter
    // turns that into main's record. A request that never becomes a window therefore
    // leaves nothing behind, with no ordering to get right.
  }, []);

  /**
   * `openWindowFor`, after making sure the board holds the task.
   *
   * The board loads only the newest few finished tasks until something asks for
   * the rest, so a finished task older than that preview was not there, and the
   * window silently never opened: on a preview mirroring a real board, 657 of 672
   * finished tasks could not be opened from Quick Find or the Knowledge Graph.
   * A task that is loaded opens synchronously, exactly as before.
   */
  const openWhenLoaded = useCallback((projectId: string, taskId: string): void => {
    const board = useBoardStore.getState();
    const inThisProject = (useProjectStore.getState().currentProject?.id ?? null) === projectId;
    const loaded = board.tasks.some((candidate) => candidate.id === taskId)
      || board.archivedTasks.some((candidate) => candidate.id === taskId);
    if (!inThisProject || loaded || board.archivedFullyLoaded) {
      openWindowFor(projectId, taskId);
      return;
    }
    void board.loadArchivedTasks()
      .catch(() => undefined)
      .then(() => {
        // A project switch while the archive loaded makes this a stale request.
        if ((useProjectStore.getState().currentProject?.id ?? null) !== projectId) return;
        openWindowFor(projectId, taskId);
      });
  }, [openWindowFor]);

  // Main asking the BOARD to mount a detail. The only path that opens one here.
  // The host filter matters: the monitor's layer lives in this same renderer and
  // listens to the same channel, so an unfiltered handler would have both mount.
  useEffect(() => {
    const ownership = window.electronAPI?.taskDetailOwnership;
    if (!ownership?.onOpenHere) return;
    return ownership.onOpenHere((projectId, taskId, host) => {
      if (host !== 'board') return;
      openWhenLoaded(projectId, taskId);
    });
  }, [openWhenLoaded]);

  // Main asking the board to let go, because the monitor took this task.
  useEffect(() => {
    const ownership = window.electronAPI?.taskDetailOwnership;
    if (!ownership?.onCloseHere) return;
    return ownership.onCloseHere((_projectId, taskId, host) => {
      if (host !== 'board') return;
      const store = useWindowStore.getState();
      const owned = Object.values(store.windows).find(
        (candidate) => candidate.kind === 'task-detail' && candidate.anchor === taskId,
      );
      if (owned) store.closeWindow(owned.id);
    });
  }, []);

  // Route the signal through main's arbiter rather than opening directly.
  useEffect(() => {
    if (!detailTaskId) {
      detailWindowIdRef.current = null;
      return;
    }
    const projectId = useProjectStore.getState().currentProject?.id;
    if (!projectId) return;

    const ownership = window.electronAPI?.taskDetailOwnership;
    if (!ownership?.requestOpen) {
      // No arbiter available (an old preload). Mount locally rather than making
      // the board's primary interaction silently dead.
      openWhenLoaded(projectId, detailTaskId);
      return;
    }
    void ownership.requestOpen(projectId, detailTaskId, 'board').then((destination) => {
      // Another host already has it and was focused for us. Clear the signal so a
      // later click on the same task asks again (rather than being swallowed as
      // "no change") and so the mirror effect below does not chase a window that
      // was never opened here.
      if (destination.kind === 'focused-existing') {
        useSessionStore.getState().setDetailTaskId(null);
      }
    }).catch((error) => {
      console.error('[task-detail] Failed to resolve where to open:', error);
      // A card click that opens nothing, with nothing on screen to say so.
      reportRendererFailure('task_detail', 'open', error);
    });
  }, [detailTaskId, openWhenLoaded]);

  // Mirror window closure back to the signal: when the detail window we opened is
  // gone (the user closed it via the title bar / Escape), clear `detailTaskId`.
  // A PARKED window counts as gone here: the user closed it, and if the signal
  // kept naming its task a second click on the same card would be a no-op
  // `setDetailTaskId` (same value), the request effect would never re-fire, and
  // the window would never un-park.
  // Telling main is not this effect's job any more - the same store change drives
  // the derived report.
  useEffect(() => {
    if (!detailTaskId) return;
    const id = detailWindowIdRef.current;
    if (!id) return;
    const mirrored = useWindowStore.getState().windows[id];
    if (!mirrored || mirrored.parked) {
      detailWindowIdRef.current = null;
      useSessionStore.getState().setDetailTaskId(null);
    }
  }, [windows, detailTaskId]);
}
