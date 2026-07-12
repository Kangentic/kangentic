import { Suspense, lazy } from 'react';
import { GitCompare, Loader2 } from 'lucide-react';
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
  const defaultBaseBranch = useConfigStore((state) => state.config.git.defaultBaseBranch);

  const title = (
    <span className="truncate">
      Changes - #{task.display_id} {task.title}
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
            No changes on this branch
          </div>
        ) : (
          <PanelErrorBoundary label="Changes panel">
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
                emptyMessage="No changes on this branch"
                task={task}
              />
            </Suspense>
          </PanelErrorBoundary>
        )}
      </div>
    </BaseDialog>
  );
}
