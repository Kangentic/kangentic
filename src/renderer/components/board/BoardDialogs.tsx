import { useCallback } from 'react';
import { Check } from 'lucide-react';
import { ConfirmDialog } from '../dialogs/ConfirmDialog';
import { useBoardStore } from '../../stores/board-store';
import { useConfigStore } from '../../stores/config-store';
import { useProjectStore } from '../../stores/project-store';

/** Confirm dialog for board config changes, showing the project name. */
function ConfigChangeDialog({ projectId, onConfirm, onCancel }: {
  projectId: string;
  onConfirm: (dontAskAgain: boolean) => void;
  onCancel: () => void;
}) {
  const projects = useProjectStore((s) => s.projects);
  const currentProject = useProjectStore((s) => s.currentProject);
  const project = projects.find((p) => p.id === projectId);
  const projectName = project?.name ?? 'Unknown project';
  const isCrossProject = currentProject?.id !== projectId;
  const message = isCrossProject
    ? `Changes detected in kangentic.json for "${projectName}". Apply the updated board configuration? This will switch to that project.`
    : 'Changes detected in kangentic.json. Apply the updated board configuration?';

  return (
    <ConfirmDialog
      title="Board configuration changed"
      message={message}
      confirmLabel="Apply"
      cancelLabel="Dismiss"
      showDontAskAgain
      dontAskAgainLabel="Always apply automatically"
      onConfirm={onConfirm}
      onCancel={onCancel}
    />
  );
}

/** Message body for the destructive move-to-To Do confirmation dialog. */
function MoveConfirmMessage({ uncommittedFileCount, unpushedCommitCount, hasWorktree, taskTitle }: {
  uncommittedFileCount: number;
  unpushedCommitCount: number;
  hasWorktree: boolean;
  taskTitle: string;
}) {
  const hasSpecificCounts = uncommittedFileCount > 0 || unpushedCommitCount > 0;
  return (
    <div className="space-y-2">
      <p>
        Resetting <span className="font-medium">"{taskTitle}"</span> will
        {hasWorktree ? ' delete its worktree and' : ''} destroy its session history.
      </p>
      {hasSpecificCounts ? (
        <ul className="list-disc list-inside text-red-400 font-medium">
          {uncommittedFileCount > 0 && (
            <li>{uncommittedFileCount} uncommitted file{uncommittedFileCount !== 1 ? 's' : ''}</li>
          )}
          {unpushedCommitCount > 0 && (
            <li>{unpushedCommitCount} unpushed commit{unpushedCommitCount !== 1 ? 's' : ''}</li>
          )}
        </ul>
      ) : (
        <p className="text-red-400 font-medium">
          Unable to verify pending changes. There may be unsaved work.
        </p>
      )}
    </div>
  );
}

/**
 * Hosts all board-scoped confirmation dialogs. Subscribes only to the pending*
 * state slots, so dialog transitions (open/close) do not re-render the board
 * grid itself - a hot path during drag and during search typing.
 */
export function BoardDialogs() {
  const pendingConfigChange = useBoardStore((s) => s.pendingConfigChange);
  const applyConfigChange = useBoardStore((s) => s.applyConfigChange);
  const dismissConfigChange = useBoardStore((s) => s.dismissConfigChange);
  const pendingMoveConfirm = useBoardStore((s) => s.pendingMoveConfirm);
  const confirmPendingMove = useBoardStore((s) => s.confirmPendingMove);
  const cancelPendingMove = useBoardStore((s) => s.cancelPendingMove);
  const pendingDoneConfirm = useBoardStore((s) => s.pendingDoneConfirm);
  const confirmPendingDone = useBoardStore((s) => s.confirmPendingDone);
  const cancelPendingDone = useBoardStore((s) => s.cancelPendingDone);
  const updateConfig = useConfigStore((s) => s.updateConfig);

  const handleConfigConfirm = useCallback((dontAskAgain: boolean) => {
    if (dontAskAgain) {
      updateConfig({ skipBoardConfigConfirm: true });
    }
    applyConfigChange();
  }, [applyConfigChange, updateConfig]);

  return (
    <>
      {pendingConfigChange && (
        <ConfigChangeDialog
          projectId={pendingConfigChange}
          onConfirm={handleConfigConfirm}
          onCancel={dismissConfigChange}
        />
      )}

      {pendingMoveConfirm && (
        <ConfirmDialog
          title="Reset task?"
          variant="danger"
          confirmLabel="Reset"
          cancelLabel="Keep Working"
          message={
            <MoveConfirmMessage
              uncommittedFileCount={pendingMoveConfirm.uncommittedFileCount}
              unpushedCommitCount={pendingMoveConfirm.unpushedCommitCount}
              hasWorktree={pendingMoveConfirm.hasWorktree}
              taskTitle={pendingMoveConfirm.taskTitle}
            />
          }
          onConfirm={() => confirmPendingMove()}
          onCancel={cancelPendingMove}
        />
      )}

      {pendingDoneConfirm && (
        <ConfirmDialog
          title="Move to Done?"
          variant="warning"
          confirmLabel="Move"
          cancelLabel="Cancel"
          showDontAskAgain
          dontAskAgainLabel="Delete automatically in the future"
          message={
            <div className="space-y-2">
              <p className="font-medium text-fg break-words">
                "{pendingDoneConfirm.task.title}"
              </p>
              <ul className="space-y-1.5">
                <li className="flex items-start gap-2">
                  <Check size={14} className="text-emerald-500 mt-0.5 shrink-0" aria-hidden />
                  <span>Local worktree will be deleted</span>
                </li>
                {pendingDoneConfirm.task.branch_name && (
                  <li className="flex items-start gap-2">
                    <Check size={14} className="text-emerald-500 mt-0.5 shrink-0" aria-hidden />
                    <span>
                      Branch{' '}
                      <code className="font-mono text-[11px] bg-surface px-1 py-0.5 rounded break-all">
                        {pendingDoneConfirm.task.branch_name}
                      </code>{' '}
                      will be unaffected
                    </span>
                  </li>
                )}
                <li className="flex items-start gap-2">
                  <Check size={14} className="text-emerald-500 mt-0.5 shrink-0" aria-hidden />
                  <span>Session history will be kept</span>
                </li>
              </ul>
              <p className="text-fg-muted">
                If this task is resumed, session history and worktree will be restored.
              </p>
            </div>
          }
          onConfirm={(dontAskAgain) => {
            if (dontAskAgain) updateConfig({ skipDoneWorktreeConfirm: true });
            void confirmPendingDone();
          }}
          onCancel={cancelPendingDone}
        />
      )}
    </>
  );
}
