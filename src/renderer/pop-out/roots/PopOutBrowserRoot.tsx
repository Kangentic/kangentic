import { useBoardStore } from '../../stores/board-store';
import { useSessionStore } from '../../stores/session-store';
import { useProjectStore } from '../../stores/project-store';
import { BrowserPane } from '../../components/browser/BrowserPane';
import type { PopOutTaskParams } from '../../../shared/pop-out';

/**
 * Pop-out root for the 'browser' surface (the hard case). Resolves sessionId +
 * cwd from params.taskId and renders the SAME BrowserPane component the in-app
 * embed uses. BrowserPane's own dom-ready effect re-registers the guest's fresh
 * webContentsId under the same sessionId - see the unregisterIfMatches
 * compare-and-delete in browser-pane-registry.ts, which is what stops the in-app
 * pane's unmount cleanup from clobbering this pop-out's registration.
 */
export function PopOutBrowserRoot({ params }: { params: PopOutTaskParams }) {
  const task = useBoardStore((state) => state.tasks.find((candidate) => candidate.id === params.taskId));
  const projectPath = useProjectStore((state) => state.currentProject?.path ?? null);
  const sessionId = useSessionStore((state) =>
    state.sessions.find((candidate) => candidate.taskId === params.taskId)?.id ?? null,
  );

  if (!task || !sessionId || !projectPath) {
    return (
      <div className="flex items-center justify-center h-full text-sm text-fg-disabled">
        No active session for this task
      </div>
    );
  }

  // projectId comes from `params`, never this window's own project store: a
  // pop-out is a separate renderer whose ambient `currentProject` tracks the
  // MAIN window's board and goes stale the moment the user switches projects.
  // See .claude/rules/pop-out-surface-registry.md.
  return (
    <BrowserPane
      sessionId={sessionId}
      taskId={task.id}
      cwd={task.worktree_path ?? projectPath}
      projectId={params.projectId}
    />
  );
}
