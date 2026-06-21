/**
 * Bridges the renderer's single "which task detail is open" signal
 * (`session-store.detailTaskId`) to a managed window. Every existing entry point
 * (card click, context Edit, search palette, session-event notification, the
 * terminal panel double-click, project-switch restore) already calls
 * `setDetailTaskId`; this hook turns that into an `openWindow` so none of them
 * needed to learn about the window store. It also mirrors a window close back to
 * the signal so persistence and re-open logic stay consistent.
 *
 * Multi-window: opening a different task's detail opens a SECOND window (windows
 * are modeless and stack); the prior window stays open. `detailTaskId` tracks
 * the most-recently-opened detail (for focus + persistence). Terminal ownership
 * is a per-session set (`dialogSessionIds`), so each window owns its own session
 * without colliding; the bottom panel steps aside while any window is open.
 *
 * Mounted once by `WindowLayer`.
 */

import { useEffect, useRef } from 'react';
import { useSessionStore } from '../../stores/session-store';
import { useBoardStore } from '../../stores/board-store';
import { useWindowStore } from '../store/window-store';

export function useTaskDetailWindowBridge(): void {
  const detailTaskId = useSessionStore((state) => state.detailTaskId);
  const windows = useWindowStore((state) => state.windows);

  // The window id we opened for the current detail signal, so the mirror effect
  // can detect when the user closed THAT window and clear the signal.
  const detailWindowIdRef = useRef<string | null>(null);

  // Open (or focus) a window for the current `detailTaskId`. Other open windows
  // are left untouched (multi-window).
  useEffect(() => {
    if (!detailTaskId) {
      detailWindowIdRef.current = null;
      return;
    }
    const windowStore = useWindowStore.getState();

    // Focus an existing window for this task instead of opening a duplicate.
    const existing = Object.values(windowStore.windows).find((candidate) => candidate.taskId === detailTaskId);
    if (existing) {
      windowStore.focusWindow(existing.id);
      detailWindowIdRef.current = existing.id;
      return;
    }

    const board = useBoardStore.getState();
    const task = board.tasks.find((candidate) => candidate.id === detailTaskId)
      ?? board.archivedTasks.find((candidate) => candidate.id === detailTaskId);
    if (!task) return; // task not loaded yet; a later board load re-fires this effect

    const session = useSessionStore.getState();
    // Baseline for auto-close: a task opened while already Done/archived (e.g. from
    // the Completed Tasks list) must NOT auto-close - only a later transition into
    // Done does. Captured here so it survives the content remount the Done fly causes.
    const openedDone =
      task.archived_at !== null
      || board.swimlanes.find((lane) => lane.id === task.swimlane_id)?.role === 'done';
    detailWindowIdRef.current = windowStore.openWindow({
      taskId: detailTaskId,
      sessionId: session._sessionByTaskId.get(detailTaskId)?.id ?? null,
      title: task.title,
      initialEdit: session.detailTaskInitialEdit,
      openedDone,
    });
  }, [detailTaskId]);

  // Mirror window closure back to the signal: when the detail window we opened is
  // gone (the user closed it via the title bar / Escape), clear `detailTaskId`.
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
