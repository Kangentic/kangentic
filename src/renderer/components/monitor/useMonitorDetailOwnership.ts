/**
 * The Agent Monitor's half of task-detail ownership: mount when main says so, close
 * when main asks for it back, and report what is mounted.
 *
 * MOUNTED FOR THE LIFETIME OF THE RENDERER, not inside `MonitorDetailLayer`, and
 * that placement is the entire point of this module existing.
 *
 * `AppLayout` renders the monitor as `{monitorOpen && !popOut.isOpen && <MonitorPage />}`,
 * so the layer unmounts every time the monitor is closed OR detached - while
 * `monitorWindowManager`'s windows deliberately survive (the same windows come back
 * when you reopen it). With these handlers inside the layer, that left a window
 * mounted-in-store, owned in main, with nobody left to report on it and nobody
 * listening for `DETAIL_CLOSE_HERE`: a phantom owner that outlived its surface, which
 * made the task answer `focused-existing` for a window nothing could focus and never
 * open again. Ownership has to be reported by something that lives as long as the
 * window store it describes.
 *
 * Mounted exactly once per renderer, at the two always-mounted roots:
 *   - `AppLayout` for the main window
 *   - `PopOutMonitorRoot` for the detached monitor (a separate renderer, whose
 *     reports main scopes by its own webContents id)
 *
 * What stays in the layer is only what genuinely needs the surface on screen: light
 * dismiss, and the detached-window focused-session publisher.
 */

import { monitorWindowManager } from '../../window-manager';
import { useDetailOwnershipSync } from '../../window-manager/bridge/useDetailOwnershipSync';
import { monitorDetailAnchor, parseMonitorAnchor } from '../../window-manager/store/monitor-anchor';
import { useEffect } from 'react';

/**
 * Anchors whose next mount should open straight into edit mode.
 *
 * `initialEdit` cannot ride the ownership request: main arbitrates WHERE a detail
 * opens, and how it opens is none of its business. Parking it here keeps the
 * arbiter's payload about placement only, and the flag is consumed exactly once so a
 * later open of the same task is a normal view.
 */
// hmr-safe: a pending one-shot edit flag; losing it across a Fast Refresh just opens
// the detail in view mode, which self-corrects on the next request.
const pendingInitialEdit = new Set<string>();

/**
 * Ask main to open a task detail in the MONITOR. The single entry point for the
 * monitor's rows and its context menu, so both go through the same arbitration.
 */
export function requestMonitorDetail(
  projectId: string,
  taskId: string,
  options?: { initialEdit?: boolean },
): void {
  if (options?.initialEdit) pendingInitialEdit.add(monitorDetailAnchor(projectId, taskId));
  void window.electronAPI?.taskDetailOwnership
    ?.requestOpen(projectId, taskId, 'monitor')
    .catch((error) => {
      console.error('[monitor] Failed to open task detail:', error);
    });
}

export function useMonitorDetailOwnership(): void {
  // Main telling this renderer's monitor to mount a detail.
  useEffect(() => {
    const ownership = window.electronAPI?.taskDetailOwnership;
    if (!ownership?.onOpenHere) return;
    return ownership.onOpenHere((projectId, taskId, host) => {
      if (host !== 'monitor') return;
      const store = monitorWindowManager.store.getState();
      const anchor = monitorDetailAnchor(projectId, taskId);
      const existing = Object.values(store.windows).find((candidate) => candidate.anchor === anchor);
      if (existing) {
        store.focusWindow(existing.id);
        return;
      }
      // Consumed once: a later open of the same task is a normal view.
      const initialEdit = pendingInitialEdit.delete(anchor);
      store.openWindow({
        kind: 'task-detail',
        anchor,
        sessionId: null,
        // Placeholder until the bundle resolves; the window's own header shows the
        // real title once it does.
        title: 'Task',
        initialEdit,
        // Terminal-hosting windows open FLAT, matching the board layer and the
        // Command Terminal.
        //
        // The entrance is a `scale()` transform, which does not change an element's
        // border box (so ResizeObserver stays silent) but does change
        // `getBoundingClientRect()`, which is what xterm's FitAddon measures. A fit
        // that lands mid-animation therefore computes `cols` from a shrunken box with
        // nothing to correct it afterwards. This layer is the most exposed to that,
        // because its terminal mounts late off an async bundle fetch and can land
        // anywhere in the animation window.
        //
        // Reuses the `skipEnterAnimation` flag workspace restore already sets
        // (restore-no-animation-replay.md).
        skipEnterAnimation: true,
      });
      // No claim call here on purpose. Opening the window changes the store, and the
      // derived reporter below turns that into main's record - so a request that
      // never becomes a window leaves nothing behind.
    });
  }, []);

  // Main asking the monitor to let go, because the task was opened on the board (or
  // because another surface's report displaced this one). This is the one exception
  // to "a monitor click keeps it here".
  useEffect(() => {
    const ownership = window.electronAPI?.taskDetailOwnership;
    if (!ownership?.onCloseHere) return;
    return ownership.onCloseHere((projectId, taskId, host) => {
      if (host !== 'monitor') return;
      const store = monitorWindowManager.store.getState();
      const anchor = monitorDetailAnchor(projectId, taskId);
      const owned = Object.values(store.windows).find((candidate) => candidate.anchor === anchor);
      if (owned) store.closeWindow(owned.id);
    });
  }, []);

  // The monitor's anchor already carries the project, so its decoder is the report.
  // No `ready` gate: this host never depends on the open project.
  useDetailOwnershipSync({
    manager: monitorWindowManager,
    host: 'monitor',
    anchorToDetail: parseMonitorAnchor,
  });
}
