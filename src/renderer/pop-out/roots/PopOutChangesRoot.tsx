import { Suspense, lazy } from 'react';
import { Loader2 } from 'lucide-react';
import { useProjectStore } from '../../stores/project-store';
import { useConfigStore } from '../../stores/config-store';
import { useBoardStore } from '../../stores/board-store';
import { PanelErrorBoundary } from '../../components/PanelErrorBoundary';
import type { PopOutTaskParams } from '../../../shared/pop-out';

const ChangesPanel = lazy(() =>
  import('../../components/dialogs/task-detail/changes/ChangesPanel').then((module) => ({ default: module.ChangesPanel })),
);

/**
 * Pop-out root for the 'changes' surface. Re-hydrates the same way
 * TaskChangesDialog.tsx does: resolve projectPath from project-store,
 * defaultBaseBranch from config-store, and the task itself from board-store by
 * params.taskId.
 *
 * board-store's loadBoard() is ambient-project-scoped (ipc TASK_LIST has no
 * projectId argument), so this relies on the main process's ambient current
 * project matching params.projectId - true at open time (a "changes" pop-out is
 * only opened from the currently-open project's board). If the user switches
 * projects in the main window before this pop-out's own bootstrap/HMR resync
 * resolves, the task lookup below simply misses and shows "No changes on this
 * branch" rather than any incorrect cross-project data.
 */
export function PopOutChangesRoot({ params }: { params: PopOutTaskParams }) {
  const projectPath = useProjectStore((state) => state.currentProject?.path ?? null);
  const defaultBaseBranch = useConfigStore((state) => state.config.git.defaultBaseBranch);
  const task = useBoardStore((state) => state.tasks.find((candidate) => candidate.id === params.taskId));

  if (!task || !projectPath) {
    return (
      <div className="flex items-center justify-center h-full text-sm text-fg-disabled">
        No changes on this branch
      </div>
    );
  }

  return (
    <PanelErrorBoundary label="Changes panel">
      <Suspense
        fallback={
          <div className="flex items-center justify-center h-full">
            <Loader2 size={20} className="animate-spin text-fg-muted" />
          </div>
        }
      >
        {/* Render the FULL task-detail layout (history region + Working/Staged/
            Branch tabs + file tree + diff pane), NOT the stripped standalone-dialog
            view. So we mirror TaskDetailBody's props: no `emptyMessage` (which would
            trigger ChangesPanel's bare empty-state early return), and `isFocused` so
            keyboard file navigation works in this dedicated window. No `panelMode`
            (there is no split to expand/collapse here) and no `popOutParams` (already
            detached - must not offer to detach again). `filePopOutParams` IS passed:
            per-file diff windows can be spawned from the detached panel too, and the
            maxInstances cap is enforced main-side precisely because this window never
            receives POPOUT_CHANGED and cannot count its siblings. */}
        <ChangesPanel
          entityId={`popout-${task.id}`}
          isFocused
          scrollKey={task.id}
          projectPath={projectPath}
          worktreePath={task.worktree_path ?? undefined}
          baseBranch={task.base_branch || defaultBaseBranch || 'main'}
          task={task}
          filePopOutParams={{ taskId: params.taskId, projectId: params.projectId }}
        />
      </Suspense>
    </PanelErrorBoundary>
  );
}
