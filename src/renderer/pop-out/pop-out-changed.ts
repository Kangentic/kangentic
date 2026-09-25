import { parsePopOutInstanceKey } from '../../shared/pop-out';
import { usePopOutStore } from '../stores/pop-out-store';
import { useSessionStore } from '../stores/session-store';

/**
 * Handler for the main process's `popOut:changed` push: mirror the new open set
 * into the pop-out store, then apply the side effects a window CLOSING implies.
 *
 * Why this is not `pop-out-store.setOpen()` itself: `setOpen` is also the target
 * of `loadOpen()`, which App.tsx calls at mount and again on every HMR
 * `vite:afterUpdate` re-sync. Those are re-syncs, not lifetime events, and
 * hanging a cross-store write (plus its debounced DB save) off them would mean a
 * Fast Refresh could silently close a user's panel. The push is the only signal
 * that means "a window's lifetime ended", so the effects live here and `setOpen`
 * stays a plain setter.
 *
 * Why App level rather than an effect inside the task-detail body: nothing closes
 * a task's pop-outs when its task-detail window closes, so a `changes` pop-out
 * outlives the component that spawned it. A component-local effect would miss
 * exactly that case, and the panel would be back on the task's next open.
 *
 * The push carries the whole open-key set and no per-key close event, so the
 * disappearance is derived by diffing against the previous set.
 */
export function receivePopOutOpenSet(openInstanceKeys: string[]): void {
  const previousKeys = usePopOutStore.getState().openInstanceKeys;
  usePopOutStore.getState().setOpen(openInstanceKeys);

  const stillOpen = new Set(openInstanceKeys);
  for (const key of Object.keys(previousKeys)) {
    if (stillOpen.has(key)) continue;
    const closed = parsePopOutInstanceKey(key);
    // Only the task-detail Changes view reclaims its in-app split on close, and
    // leaving it open there is the unwanted extra step this clears. The two
    // deliberate omissions:
    //   - 'changes-file' is an ADDITIVE per-file read opened FROM the inline
    //     panel, so closing one must leave that panel exactly as it was.
    //   - 'browser' masks its pane identically (browserOpenTasks) but is
    //     deliberately left alone; reclaiming is still its behavior.
    if (closed?.kind !== 'changes') continue;
    // Clear against the key's OWN project, never the ambient one: the window can
    // outlive a board switch, and the panel state is persisted per task.
    useSessionStore.getState().setChangesOpen(closed.taskId, false, closed.projectId);
  }
}
