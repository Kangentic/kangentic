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

import { useEffect, useRef } from 'react';
import { useSessionStore } from '../../stores/session-store';
import { useBoardStore } from '../../stores/board-store';
import { useProjectStore } from '../../stores/project-store';
import { useWindowStore } from '../store/window-store';

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
   * only from main's `onOpenHere` push, never directly from the signal.
   */
  const openWindowFor = useRef((projectId: string, taskId: string): void => {
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

    // Focus an existing window for this task instead of opening a duplicate.
    // Scope to task-detail windows: a conversation window's anchor is a session
    // id, not a taskId, and must never be matched here.
    const existing = Object.values(windowStore.windows).find(
      (candidate) => candidate.kind === 'task-detail' && candidate.anchor === taskId,
    );
    if (existing) {
      windowStore.focusWindow(existing.id);
      detailWindowIdRef.current = existing.id;
      return;
    }

    const board = useBoardStore.getState();
    const task = board.tasks.find((candidate) => candidate.id === taskId)
      ?? board.archivedTasks.find((candidate) => candidate.id === taskId);
    if (!task) return; // task not loaded yet; a later board load re-fires this effect

    const session = useSessionStore.getState();
    // Baseline for auto-close: a task opened while already Done/archived (e.g. from
    // the Completed Tasks list) must NOT auto-close - only a later transition into
    // Done does. Captured here so it survives the content remount the Done fly causes.
    const openedDone =
      task.archived_at !== null
      || board.swimlanes.find((lane) => lane.id === task.swimlane_id)?.role === 'done';
    const windowId = windowStore.openWindow({
      kind: 'task-detail',
      anchor: taskId,
      sessionId: session._sessionByTaskId.get(taskId)?.id ?? null,
      title: task.title,
      initialEdit: session.detailTaskInitialEdit,
      openedDone,
      // Terminal-hosting windows open FLAT, deliberately.
      //
      // The entrance is a `scale()` transform, and a transform does not change an
      // element's border box - so it never triggers ResizeObserver - while it DOES
      // change `getBoundingClientRect()`, which is what xterm's FitAddon measures.
      // Any terminal that fits mid-animation computes `cols` from a shrunken box
      // and is never corrected, because the real box never moved. That reads as a
      // frozen, horizontally-overflowing terminal until the user resizes by hand.
      //
      // Correctness over motion: a surface that spawns a terminal is worth more
      // fast and accurate than animated.
      skipEnterAnimation: true,
    });
    detailWindowIdRef.current = windowId;
    // No claim call: opening the window changed the store, and the derived reporter
    // turns that into main's record. A request that never becomes a window therefore
    // leaves nothing behind, with no ordering to get right.
  }).current;

  // Main asking the BOARD to mount a detail. The only path that opens one here.
  // The host filter matters: the monitor's layer lives in this same renderer and
  // listens to the same channel, so an unfiltered handler would have both mount.
  useEffect(() => {
    const ownership = window.electronAPI?.taskDetailOwnership;
    if (!ownership?.onOpenHere) return;
    return ownership.onOpenHere((projectId, taskId, host) => {
      if (host !== 'board') return;
      openWindowFor(projectId, taskId);
    });
  }, [openWindowFor]);

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
      openWindowFor(projectId, detailTaskId);
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
    });
  }, [detailTaskId, openWindowFor]);

  // Mirror window closure back to the signal: when the detail window we opened is
  // gone (the user closed it via the title bar / Escape), clear `detailTaskId`.
  // Telling main is not this effect's job any more - the same store change drives
  // the derived report.
  useEffect(() => {
    if (!detailTaskId) return;
    const id = detailWindowIdRef.current;
    if (!id) return;
    if (!useWindowStore.getState().windows[id]) {
      detailWindowIdRef.current = null;
      useSessionStore.getState().setDetailTaskId(null);
    }
  }, [windows, detailTaskId]);
}
