/**
 * Restore the persisted window layout for the just-loaded project. Reads this
 * project's entry from `AppConfig.workspaceByProject` and rebuilds the windows via the
 * window-store, re-resolving each window's live session from its durable anchor
 * (kind-aware: a taskId for task-detail, a session id for conversation) and
 * dropping task-detail windows whose task is no longer on the board (conversation
 * windows always restore; a gone session shows the viewer's own empty state). A
 * no-op when no layout was persisted for the project.
 *
 * Called from useProjectSwitchEffect (warm + cold paths) AFTER the incoming
 * project's board, config, and sessions have resolved, so session re-binding and
 * the task-existence check see live data. Cheap by design: it reads three stores
 * and performs one setState; the cost of mounting the restored terminals is the
 * same as the user opening those windows by hand, and is React-scheduled rather
 * than run inline, so it does not block the project switch.
 *
 * Deliberately NOT wired into App.tsx's `vite:afterUpdate`: the window-store
 * instance is HMR-preserved (pinned via `import.meta.hot.data`, Pattern E), so a
 * Fast Refresh keeps the live windows; re-applying from config would reset them.
 */

import { useConfigStore } from '../../stores/config-store';
import { useBoardStore } from '../../stores/board-store';
import { useSessionStore } from '../../stores/session-store';
import { useWindowStore } from '../store/window-store';

export function restoreWorkspaceForProject(projectId: string): void {
  const workspace = useConfigStore.getState().config.workspaceByProject?.[projectId];
  if (!workspace) return;
  useWindowStore.getState().applyWorkspace(
    workspace,
    // The window's live session, re-resolved from its durable anchor. A
    // conversation window's anchor IS its session id (matching the live-open
    // path in useConversationWindowBridge); a task-detail window's anchor is a
    // taskId, re-resolved the same way useTaskDetailWindowBridge does.
    (anchor, kind) => kind === 'conversation'
      ? anchor
      : useSessionStore.getState()._sessionByTaskId.get(anchor)?.id ?? null,
    // Task-detail: only restore windows whose task is still on the live board; a
    // task archived or deleted since the layout was saved is dropped (no
    // restore-then-autoclose). Conversation: a session-id anchor is never a
    // board task, so it is always "known" here - a session that no longer
    // exists still restores the window, which then shows its own empty /
    // unavailable state (ConversationWindow resolves its transcript from the
    // anchor directly) rather than silently vanishing.
    (anchor, kind) => kind === 'conversation'
      ? true
      : useBoardStore.getState().tasks.some((task) => task.id === anchor),
  );
}
