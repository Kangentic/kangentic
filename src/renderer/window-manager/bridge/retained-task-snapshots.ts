import type { Task } from '../../../shared/types';
import type { ManagedWindow } from '../store/types';

/**
 * Frozen task rows for RETAINED task-detail windows.
 *
 * A retained window belongs to a backgrounded project, and the board store is
 * project-scoped, so its live task lookup misses. The window must keep
 * rendering anyway (its Browser pane's `<webview>` guest dies if the subtree
 * unmounts), so it falls back to the row captured at retention time.
 *
 * Deliberately NOT a Zustand store: nothing subscribes to it. A retained window
 * renders from a stable frozen reference and must NOT re-render as the active
 * project's board churns, which is the difference between "a backgrounded pane
 * is idle" and "every board update re-renders windows the user cannot see".
 *
 * The session store is not mirrored here on purpose: `sessions.list()` is
 * deliberately unscoped (it feeds the sidebar's cross-project counts), so a
 * backgrounded task's session still resolves live and only the task row is
 * missing.
 */
// HMR Pattern A (preserve): a Fast Refresh must not drop the rows a retained
// window is rendering from, or the window falls back to its placeholder and the
// unmount destroys the very guest retention exists to keep alive. Production has
// no `import.meta.hot`, so this is a no-op there.
// @ts-expect-error -- Vite handles import.meta.hot; tsc's "module": "commonjs" doesn't support it
const snapshots: Map<string, Task> = import.meta.hot?.data?.retainedTaskSnapshots ?? new Map<string, Task>();
// @ts-expect-error -- Vite handles import.meta.hot
if (import.meta.hot) {
  // @ts-expect-error -- Vite handles import.meta.hot
  import.meta.hot.dispose((data: Record<string, unknown>) => {
    data.retainedTaskSnapshots = snapshots;
  });
}

/** Capture the rows a project's retained windows will render from. */
export function captureRetainedTasks(tasks: readonly Task[]): void {
  for (const task of tasks) snapshots.set(task.id, task);
}

/** The frozen row for a retained window's task, if one was captured. */
export function getRetainedTask(taskId: string): Task | null {
  return snapshots.get(taskId) ?? null;
}

/**
 * Drop rows no longer backing a retained window. Called whenever retention is
 * recomputed, so a task that returns to the foreground goes straight back to the
 * live board row instead of rendering a stale title/labels/column forever.
 */
export function pruneRetainedTasks(retainedTaskIds: ReadonlySet<string>): void {
  for (const taskId of snapshots.keys()) {
    if (!retainedTaskIds.has(taskId)) snapshots.delete(taskId);
  }
}

/**
 * Which windows must be newly retained for the project being backgrounded, and
 * which frozen rows must survive the switch.
 *
 * Pure and exported so the multi-project case is unit-testable: the bug this
 * guards needs THREE projects (or a cache-cold switch back) to reproduce, and is
 * invisible to a test that hands `retainWindows` an already-correct anchor list.
 *
 * The two sets are deliberately NOT the same, and collapsing them into one
 * breaks the feature in one direction or the other:
 *  - `retainAnchors` covers only windows of the project being backgrounded NOW.
 *    `browserOpenTasks` is neither project-keyed nor ever cleared, so a window
 *    already retained for an EARLIER project still matches it; passing that
 *    anchor on would re-stamp the window with this switch's project id and point
 *    its pane at another project's URL sidecar.
 *  - `snapshotTaskIds` additionally keeps every ALREADY-retained window, whose
 *    frozen row must not be pruned. Losing it makes `getRetainedTask` return
 *    null, and `WindowContent` then renders the "no longer available"
 *    placeholder INSTEAD of the task-detail subtree, unmounting the very
 *    `<webview>` guest retention exists to keep alive.
 */
export function planWindowRetention(
  windows: readonly ManagedWindow[],
  browserOpenTaskIds: ReadonlySet<string>,
): { retainAnchors: string[]; snapshotTaskIds: Set<string> } {
  const retainAnchors: string[] = [];
  const snapshotTaskIds = new Set<string>();
  for (const managedWindow of windows) {
    if (managedWindow.kind !== 'task-detail') continue;
    if (managedWindow.retainedProjectId !== undefined) {
      // Belongs to a project backgrounded earlier. Keep its snapshot alive, but
      // never re-retain it under this switch's project id.
      snapshotTaskIds.add(managedWindow.anchor);
      continue;
    }
    if (!browserOpenTaskIds.has(managedWindow.anchor)) continue;
    retainAnchors.push(managedWindow.anchor);
    snapshotTaskIds.add(managedWindow.anchor);
  }
  return { retainAnchors, snapshotTaskIds };
}
