import { Suspense, lazy } from 'react';
import { AppWindow } from 'lucide-react';
import { PanelErrorBoundary } from '../../../PanelErrorBoundary';
import { ChangesPanelSkeleton } from '../changes/ChangesPanelSkeleton';
import { usePopOut } from '../../../../pop-out/usePopOut';
import { COMPLETED_CHANGES_ENTITY_PREFIX } from '../../../../stores/session-store/task-changes-panel-slice';
import { CompletedChangesEmpty } from './CompletedChangesEmpty';
import type { GitTaskChangesResult, Task } from '../../../../../shared/types';

// Lazy, as every other host loads it: a static import would pull Monaco into
// the entry chunk, which the build refuses.
const ChangesPanel = lazy(() => import('../changes/ChangesPanel').then((module) => ({ default: module.ChangesPanel })));

/** The entity id a completed task's Changes tab keys its panel state under. */
export function completedChangesEntityId(taskId: string): string {
  return `${COMPLETED_CHANGES_ENTITY_PREFIX}${taskId}`;
}

/**
 * A completed task's Changes tab: the live task's Changes panel, reading the
 * task's commits from git (`completedChanges`) instead of a working tree. The
 * tab always shows; a task with nothing to show says why in one line.
 */
export function CompletedChangesTab({ task, projectId, isFocused, changes, loading, error, onRetry }: {
  task: Task;
  projectId: string;
  isFocused: boolean;
  changes: GitTaskChangesResult | null;
  loading: boolean;
  error: string | null;
  onRetry: () => void;
}) {
  const changesPopOut = usePopOut('changes', { taskId: task.id, projectId });

  if (loading) return <ChangesPanelSkeleton />;
  if (error || !changes) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-2 p-4" data-testid="completed-changes-error">
        <span className="text-sm text-fg-muted">{error ?? 'The task\'s changes could not be read'}</span>
        <button
          type="button"
          onClick={onRetry}
          className="rounded bg-surface-raised px-3 py-1 text-xs text-fg-secondary transition-colors hover:bg-surface-raised/80"
          data-testid="completed-changes-retry"
        >
          Retry
        </button>
      </div>
    );
  }
  if (changes.emptyReason) return <CompletedChangesEmpty reason={changes.emptyReason} />;
  // One home at a time, as the live task's panel: while the detached window
  // is open the tab points there rather than showing a second copy.
  if (changesPopOut.isOpen) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-2 p-4 text-center" data-testid="completed-changes-popped-out">
        <AppWindow size={24} className="text-fg-disabled" />
        <span className="text-sm text-fg-muted">Changes are open in their own window</span>
      </div>
    );
  }
  return (
    <PanelErrorBoundary label="Changes panel">
      <Suspense fallback={<ChangesPanelSkeleton />}>
        <ChangesPanel
          entityId={completedChangesEntityId(task.id)}
          isFocused={isFocused}
          scrollKey={completedChangesEntityId(task.id)}
          projectPath={changes.projectPath}
          baseBranch={changes.baseBranch}
          task={task}
          popOutParams={{ taskId: task.id, projectId }}
          filePopOutParams={{ taskId: task.id, projectId }}
          completedChanges={changes}
        />
      </Suspense>
    </PanelErrorBoundary>
  );
}
