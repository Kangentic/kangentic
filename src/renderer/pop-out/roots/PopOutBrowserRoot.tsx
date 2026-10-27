import { useEffect, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { Trans } from '@lingui/react/macro';
import { useSessionStore } from '../../stores/session-store';
import { findSessionForTask } from '../../stores/session-store/session-index';
import { BrowserPane } from '../../components/browser/BrowserPane';
import { usePopOutTaskRow } from '../use-pop-out-task-row';
import type { PopOutTaskParams } from '../../../shared/pop-out';

/**
 * Pop-out root for the 'browser' surface (the hard case). Resolves the task,
 * its project path and its session from `params`, and renders the SAME
 * BrowserPane component the in-app embed uses. BrowserPane's own dom-ready
 * effect registers the pop-out's fresh guest, which main binds to a NEW surface
 * handle (a handle names one guest for its whole life). The in-app pane's
 * unmount cleanup unregisters only the guest id it registered, so it cannot
 * clobber this registration; an agent still holding the in-app pane's old
 * handle is told `surface-gone` and pointed at this one.
 *
 * Nothing here reads the board store or `currentProject`. Both describe the
 * MAIN window's open project, which a backgrounded task is not in, and the
 * board store's first load in a fresh window publishes nothing at all (see
 * `usePopOutTaskRow`). Reading the task from the board is what left a detached
 * window on "No active session for this task" with no guest, and
 * `kangentic_browser_pop_out` timing out on it.
 */
export function PopOutBrowserRoot({ params }: { params: PopOutTaskParams }) {
  const { task, projectPath, loading: taskLoading } = usePopOutTaskRow(params.projectId, params.taskId);
  const sessionId = useSessionStore((state) =>
    findSessionForTask(state.sessions, params.taskId)?.id ?? null,
  );

  // The session list is unscoped, so it holds a backgrounded task's agent too.
  // The window's one boot sync lives here, not in the surface bootstrap, so the
  // empty message can wait for the list's answer: the task read usually lands
  // first, and deciding "no session" then flashed it before the session came.
  const [sessionsSynced, setSessionsSynced] = useState(false);
  useEffect(() => {
    let cancelled = false;
    void useSessionStore.getState().syncSessions()
      .catch((error: unknown) => console.warn('[pop-out browser] session sync failed:', error))
      .finally(() => {
        if (!cancelled) setSessionsSynced(true);
      });
    return () => { cancelled = true; };
  }, []);

  if (task && sessionId && projectPath) {
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

  if (taskLoading || !sessionsSynced) {
    return (
      <div className="flex items-center justify-center h-full" data-testid="popout-browser-loading">
        <Loader2 size={20} className="animate-spin text-fg-muted" />
      </div>
    );
  }

  return (
    <div className="flex items-center justify-center h-full text-sm text-fg-disabled">
      <Trans>No active session for this task</Trans>
    </div>
  );
}
