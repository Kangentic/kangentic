import { useCallback } from 'react';
import { Check, Trash2 } from 'lucide-react';
import { ConfirmDialog } from '../dialogs/ConfirmDialog';
import { BoardManagerDialog } from '../dialogs/BoardManagerDialog';
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
  const boardManagerOpen = useBoardStore((s) => s.boardManagerOpen);
  const boardManagerInitialId = useBoardStore((s) => s.boardManagerInitialId);
  const boardManagerSeedNew = useBoardStore((s) => s.boardManagerSeedNew);
  const boardManagerAddDraftRequest = useBoardStore((s) => s.boardManagerAddDraftRequest);
  const closeBoardManager = useBoardStore((s) => s.closeBoardManager);
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

      {pendingDoneConfirm && (() => {
        const { hasPendingChanges, uncommittedFileCount, unpushedCommitCount, autoCleanup } = pendingDoneConfirm;
        // Prefer the worktree's live HEAD branch over the stored slug: agents
        // rename branches inside the worktree, so the slug can be stale.
        const displayBranch = pendingDoneConfirm.currentBranch ?? pendingDoneConfirm.task.branch_name;
        const branchCode = displayBranch ? (
          <code className="font-mono text-[11px] bg-surface px-1 py-0.5 rounded break-all">
            {displayBranch}
          </code>
        ) : null;
        return (
          <ConfirmDialog
            title="Move to Done?"
            // This dialog only opens when the probe found pending changes (or
            // failed); a clean Done move is recoverable and skips confirmation
            // entirely, so there is no "don't ask again" escape hatch here.
            variant="danger"
            confirmLabel="Move"
            cancelLabel="Cancel"
            message={
              <div className="space-y-2">
                <p className="font-medium text-fg break-words">
                  "{pendingDoneConfirm.task.title}"
                </p>
                {/* Red is reserved for data the move genuinely destroys:
                    uncommitted files, at-risk local-only commits (below), and the
                    probe-failure fallback where the worktree is suspect. */}
                {uncommittedFileCount > 0 && (
                  <ul className="list-disc list-inside text-red-400 font-medium" data-testid="done-confirm-uncommitted">
                    <li>
                      {uncommittedFileCount} uncommitted file{uncommittedFileCount !== 1 ? 's' : ''} will be lost
                    </li>
                  </ul>
                )}
                {hasPendingChanges && uncommittedFileCount === 0 && unpushedCommitCount === 0 && (
                  // Git probe failed; we don't know the exact damage, but we
                  // know the worktree is suspect. Mirror MoveConfirmMessage's
                  // fallback copy so the user still sees a danger signal.
                  <p className="text-red-400 font-medium">
                    Unable to verify pending changes. There may be unsaved work.
                  </p>
                )}
                {/* The count is non-zero only when the move force-deletes the
                    branch (autoCleanup) AND the commits exist nowhere
                    recoverable, so this is genuine loss: red, worded to say so.
                    Merged or pushed commits are already excluded upstream. The
                    `autoCleanup` guard is redundant with the probe (which zeroes
                    the count when the branch is kept) but keeps the dialog
                    self-consistent: no "will be lost when the branch is deleted"
                    line while the branch is being kept. */}
                {autoCleanup && unpushedCommitCount > 0 && (
                  <ul className="list-disc list-inside text-red-400 font-medium" data-testid="done-confirm-unpushed">
                    <li>
                      {unpushedCommitCount} commit{unpushedCommitCount !== 1 ? 's' : ''} exist{unpushedCommitCount !== 1 ? '' : 's'} only on {branchCode ? <>branch {branchCode}</> : 'the local branch'} and will be lost when the branch is deleted
                    </li>
                  </ul>
                )}
                <ul className="space-y-1.5">
                  <li className="flex items-start gap-2">
                    <Check size={14} className="text-emerald-500 mt-0.5 shrink-0" aria-hidden />
                    <span>Local worktree will be deleted</span>
                  </li>
                  {displayBranch && (
                    autoCleanup ? (
                      // Branch is force-deleted on this move; state it plainly
                      // rather than the old (false) "will be unaffected".
                      <li className="flex items-start gap-2" data-testid="done-confirm-branch-fate">
                        <Trash2 size={14} className="text-fg-muted mt-0.5 shrink-0" aria-hidden />
                        <span>
                          Branch {branchCode} will be deleted
                        </span>
                      </li>
                    ) : (
                      <li className="flex items-start gap-2" data-testid="done-confirm-branch-fate">
                        <Check size={14} className="text-emerald-500 mt-0.5 shrink-0" aria-hidden />
                        <span>
                          Branch {branchCode} will be kept
                        </span>
                      </li>
                    )
                  )}
                  <li className="flex items-start gap-2">
                    <Check size={14} className="text-emerald-500 mt-0.5 shrink-0" aria-hidden />
                    <span>Session history will be kept</span>
                  </li>
                </ul>
                {!autoCleanup && (
                  <p className="text-fg-muted">
                    If this task is resumed, the worktree will be recreated from the branch's last commit.
                  </p>
                )}
              </div>
            }
            onConfirm={() => void confirmPendingDone()}
            onCancel={cancelPendingDone}
          />
        );
      })()}

      {boardManagerOpen && (
        <BoardManagerDialog
          initialColumnId={boardManagerInitialId}
          seedNewDraft={boardManagerSeedNew}
          addDraftRequest={boardManagerAddDraftRequest}
          onClose={closeBoardManager}
        />
      )}
    </>
  );
}
