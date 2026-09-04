import { useBoardStore } from '../../stores/board-store';
import { useSessionStore } from '../../stores/session-store';
import { findSessionForTask } from '../../stores/session-store/session-index';
import { useProjectStore } from '../../stores/project-store';
import { BrowserPane } from '../../components/browser/BrowserPane';
import type { PopOutTaskParams } from '../../../shared/pop-out';

/**
 * Pop-out root for the 'browser' surface (the hard case). Resolves sessionId +
 * cwd from params.taskId and renders the SAME BrowserPane component the in-app
 * embed uses. BrowserPane's own dom-ready effect registers the pop-out's fresh
 * guest, which main binds to a NEW surface handle (a handle names one guest for
 * its whole life). The in-app pane's unmount cleanup unregisters only the guest
 * id it registered, so it cannot clobber this registration; an agent still
 * holding the in-app pane's old handle is told `surface-gone` and pointed at
 * this one.
 */
export function PopOutBrowserRoot({ params }: { params: PopOutTaskParams }) {
  const task = useBoardStore((state) => state.tasks.find((candidate) => candidate.id === params.taskId));
  const projectPath = useProjectStore((state) => state.currentProject?.path ?? null);
  const sessionId = useSessionStore((state) =>
    findSessionForTask(state.sessions, params.taskId)?.id ?? null,
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
