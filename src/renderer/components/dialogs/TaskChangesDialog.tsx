import { Suspense, lazy } from 'react';
import { GitCompare, Loader2 } from 'lucide-react';
import { i18n } from '@lingui/core';
import { msg } from '@lingui/core/runtime-macro';
import { BaseDialog } from './BaseDialog';
import { useProjectStore } from '../../stores/project-store';
import { useConfigStore } from '../../stores/config-store';
import { PanelErrorBoundary } from '../PanelErrorBoundary';
import type { Task } from '../../../shared/types';

const ChangesPanel = lazy(() =>
  import('./task-detail/changes/ChangesPanel').then((module) => ({ default: module.ChangesPanel })),
);

interface TaskChangesDialogProps {
  task: Task;
  onClose: () => void;
}

export function TaskChangesDialog({ task, onClose }: TaskChangesDialogProps) {
  const projectPath = useProjectStore((state) => state.currentProject?.path ?? null);
  const projectId = useProjectStore((state) => state.currentProject?.id ?? null);
  const defaultBaseBranch = useConfigStore((state) => state.config.git.defaultBaseBranch);

  // Hookless on purpose (tests/unit/pop-out-changes-root-guard.test.ts calls this as a
  // plain function), so the text resolves with i18n._ at render time, after the catalog loads.
  const displayId = task.display_id;
  const taskTitle = task.title;
  const emptyMessage = i18n._(msg`No changes on this branch`);
  const title = (
    <span className="truncate">
      {i18n._(msg`Changes - #${{ displayId }} ${{ taskTitle }}`)}
    </span>
  );

  return (
    <BaseDialog
      onClose={onClose}
      title={title}
      icon={<GitCompare size={16} />}
      rawBody
      className="w-[92vw] h-[85vh] max-w-[1400px] flex flex-col"
      zIndex="z-50"
      testId="task-changes-dialog"
    >
      <div className="flex-1 min-h-0">
        {!projectPath ? (
          <div className="flex items-center justify-center h-full text-sm text-fg-disabled">
            {emptyMessage}
          </div>
        ) : (
          <PanelErrorBoundary panel="Changes panel" message={i18n._(msg`Failed to load the Changes panel`)}>
            <Suspense
              fallback={
                <div className="flex items-center justify-center h-full">
                  <Loader2 size={20} className="animate-spin text-fg-muted" />
                </div>
              }
            >
              <ChangesPanel
                entityId={`dialog-${task.id}`}
                scrollKey={task.id}
                projectPath={projectPath}
                worktreePath={task.worktree_path ?? undefined}
                baseBranch={task.base_branch || defaultBaseBranch || 'main'}
                emptyMessage={emptyMessage}
                task={task}
                filePopOutParams={projectId ? { taskId: task.id, projectId } : undefined}
              />
            </Suspense>
          </PanelErrorBoundary>
        )}
      </div>
    </BaseDialog>
  );
}
