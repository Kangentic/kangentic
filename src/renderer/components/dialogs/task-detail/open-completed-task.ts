import { useSessionStore } from '../../../stores/session-store';
import type { CompletedTab } from '../../../stores/session-store/task-changes-panel-slice';

/**
 * Open a completed task's window on one of its tabs: the archived card's Show
 * changes and View conversation. The request is written before the window
 * opens, so a new window's first render reads it; a window already open for
 * the task switches to the tab.
 */
export function openCompletedTask(taskId: string, tab: CompletedTab): void {
  const store = useSessionStore.getState();
  store.requestCompletedView({ taskId, tab });
  store.setDetailTaskId(taskId);
}
