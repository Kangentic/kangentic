/**
 * Restore the persisted window layout for the just-loaded project. Reads
 * `AppConfig.workspace` and rebuilds the windows via the window-store, re-resolving
 * each window's live session from its durable taskId and dropping windows whose
 * task is no longer on the board. A no-op when no layout was persisted.
 *
 * Called from useProjectSwitchEffect (warm + cold paths) AFTER the incoming
 * project's board, config, and sessions have resolved, so session re-binding and
 * the task-existence check see live data. Cheap by design: it reads three stores
 * and performs one setState; the cost of mounting the restored terminals is the
 * same as the user opening those windows by hand, and is React-scheduled rather
 * than run inline, so it does not block the project switch.
 *
 * Deliberately NOT wired into App.tsx's `vite:afterUpdate`: the window-store is
 * HMR-preserved (Pattern A), so a Fast Refresh keeps the live windows; re-applying
 * from config would reset them.
 */

import { useConfigStore } from '../../stores/config-store';
import { useBoardStore } from '../../stores/board-store';
import { useSessionStore } from '../../stores/session-store';
import { useWindowStore } from '../store/window-store';

export function restoreWorkspaceForProject(): void {
  const workspace = useConfigStore.getState().config.workspace;
  if (!workspace) return;
  useWindowStore.getState().applyWorkspace(
    workspace,
    // The window's live session, re-resolved from its durable taskId - the same
    // lookup the normal window-open path uses (useTaskDetailWindowBridge).
    (taskId) => useSessionStore.getState()._sessionByTaskId.get(taskId)?.id ?? null,
    // Only restore windows whose task is still on the live board; a task archived
    // or deleted since the layout was saved is dropped (no restore-then-autoclose).
    (taskId) => useBoardStore.getState().tasks.some((task) => task.id === taskId),
  );
}
