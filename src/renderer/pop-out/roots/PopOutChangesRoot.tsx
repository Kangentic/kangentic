import { Suspense, lazy } from 'react';
import { Loader2 } from 'lucide-react';
import { useLingui } from '@lingui/react/macro';
import { useProjectStore } from '../../stores/project-store';
import { useConfigStore } from '../../stores/config-store';
import { useBoardStore } from '../../stores/board-store';
import { usePopOutTaskRow } from '../use-pop-out-task-row';
import { PanelErrorBoundary } from '../../components/PanelErrorBoundary';
import { useTaskChanges } from '../../components/dialogs/task-detail/completed/useTaskReport';
import { completedChangesEntityId } from '../../components/dialogs/task-detail/completed/CompletedChangesTab';
import { CompletedChangesEmpty } from '../../components/dialogs/task-detail/completed/CompletedChangesEmpty';
import type { PopOutTaskParams } from '../../../shared/pop-out';
import type { Task } from '../../../shared/types';

const ChangesPanel = lazy(() =>
  import('../../components/dialogs/task-detail/changes/ChangesPanel').then((module) => ({ default: module.ChangesPanel })),
);

function PanelFallback() {
  return (
    <div className="flex items-center justify-center h-full">
      <Loader2 size={20} className="animate-spin text-fg-muted" />
    </div>
  );
}

/**
 * Pop-out root for the 'changes' surface. Re-hydrates the same way
 * TaskChangesDialog.tsx does: resolve projectPath from project-store,
 * defaultBaseBranch from config-store, and the task itself from board-store by
 * params.taskId.
 *
 * board-store's loadBoard() is ambient-project-scoped (ipc TASK_LIST has no
 * projectId argument), so this relies on the main process's ambient current
 * project matching params.projectId - true at open time (a "changes" pop-out is
 * only opened from the currently-open project's board). The surface bootstrap
 * loads the board after the current project, through `loadAmbientBoard`, which
 * says why. If the user switches projects in the main window
 * before this pop-out's own bootstrap/HMR resync resolves, the task lookup below
 * simply misses and shows "No changes on this branch" rather than any incorrect
 * cross-project data.
 *
 * A task the loaded board does not hold is a completed one (the board keeps
 * only live tasks in `tasks`), opened from its Changes tab: it reads the task's
 * commits from git by `params`, as that tab does, rather than a working tree.
 */
export function PopOutChangesRoot({ params }: { params: PopOutTaskParams }) {
  const { t } = useLingui();
  const projectPath = useProjectStore((state) => state.currentProject?.path ?? null);
  const defaultBaseBranch = useConfigStore((state) => state.config.git.defaultBaseBranch);
  const task = useBoardStore((state) => state.tasks.find((candidate) => candidate.id === params.taskId));

  // Not on the board: the row itself says whether it is a completed task. The
  // board cannot decide it, since it holds only the live tasks of the project
  // the main window had open when this window booted.
  if (!task) return <UnboardedTaskRoot params={params} />;

  if (!projectPath) {
    return (
      <div className="flex items-center justify-center h-full text-sm text-fg-disabled">
        No changes on this branch
      </div>
    );
  }

  return (
    <PanelErrorBoundary panel="Changes panel" message={t`Failed to load the Changes panel`}>
      <Suspense fallback={<PanelFallback />}>
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

/**
 * A task the loaded board does not hold. Its row is read by params, archived
 * tasks included: an archived row is what the board store does not hold, and
 * the panel needs it for its History section and for naming a file window. An
 * archived row reads its commits from git. A live one waits for the board, and
 * once the board has answered without it (the main window switched projects)
 * keeps the old answer, since this path shows a completed task's commits only.
 */
function UnboardedTaskRoot({ params }: { params: PopOutTaskParams }) {
  const boardHydrated = useBoardStore((state) => state.hydrated);
  const { task, loading } = usePopOutTaskRow(params.projectId, params.taskId);
  if (loading) return <PanelFallback />;
  if (task?.archived_at) return <CompletedChangesRoot params={params} task={task} />;
  // A live row usually lands before the board does. Wait for the board's answer
  // rather than say the branch has no changes for a frame and then show them.
  if (!boardHydrated) return <PanelFallback />;
  return (
    <div className="flex items-center justify-center h-full text-sm text-fg-disabled" data-testid="popout-changes-none">
      No changes on this branch
    </div>
  );
}

function CompletedChangesRoot({ params, task }: { params: PopOutTaskParams; task: Task }) {
  const { t } = useLingui();
  const { changes, loading, error } = useTaskChanges(params.projectId, params.taskId);

  if (loading) return <PanelFallback />;
  if (error || !changes) {
    return (
      <div className="flex items-center justify-center h-full text-sm text-fg-disabled" data-testid="popout-completed-changes-error">
        {error ?? 'The task\'s changes could not be read'}
      </div>
    );
  }
  if (changes.emptyReason) return <CompletedChangesEmpty reason={changes.emptyReason} />;
  return (
    <PanelErrorBoundary panel="Changes panel" message={t`Failed to load the Changes panel`}>
      <Suspense fallback={<PanelFallback />}>
        {/* The completed tab's panel state is keyed `completed-<id>`; the pop-out
            keys its own (`popout-completed-<id>`), as the live pop-out does. */}
        <ChangesPanel
          entityId={`popout-${completedChangesEntityId(params.taskId)}`}
          isFocused
          scrollKey={completedChangesEntityId(params.taskId)}
          projectPath={changes.projectPath}
          baseBranch={changes.baseBranch}
          task={task}
          filePopOutParams={{ taskId: params.taskId, projectId: params.projectId }}
          completedChanges={changes}
        />
      </Suspense>
    </PanelErrorBoundary>
  );
}
