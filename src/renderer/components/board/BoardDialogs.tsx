import { useCallback } from 'react';
import { Check, Trash2 } from 'lucide-react';
import { Plural, Trans, useLingui } from '@lingui/react/macro';
import { ConfirmDialog } from '../dialogs/ConfirmDialog';
import { BoardManagerDialog } from '../dialogs/BoardManagerDialog';
import { useBoardStore } from '../../stores/board-store';
import { useConfigStore } from '../../stores/config-store';
import { useProjectStore } from '../../stores/project-store';

/** The branch name inside the Done confirm's sentences. */
const BRANCH_CODE_CLASS = 'font-mono text-[11px] bg-surface px-1 py-0.5 rounded break-all';

/** Confirm dialog for board config changes, showing the project name. */
function ConfigChangeDialog({ projectId, onConfirm, onCancel }: {
  projectId: string;
  onConfirm: (dontAskAgain: boolean) => void;
  onCancel: () => void;
}) {
  const { t } = useLingui();
  const projects = useProjectStore((s) => s.projects);
  const currentProject = useProjectStore((s) => s.currentProject);
  const project = projects.find((p) => p.id === projectId);
  const projectName = project?.name;
  const isCrossProject = currentProject?.id !== projectId;
  // One whole sentence per case: a project that is no longer listed reads
  // "Unknown project" in its place.
  let message: string;
  if (!isCrossProject) message = t`Changes detected in kangentic.json. Apply the updated board configuration?`;
  else if (projectName === undefined) message = t`Changes detected in kangentic.json for "Unknown project". Apply the updated board configuration? This will switch to that project.`;
  else message = t`Changes detected in kangentic.json for "${projectName}". Apply the updated board configuration? This will switch to that project.`;

  return (
    <ConfirmDialog
      testId="config-change-dialog"
      title={t`Board configuration changed`}
      message={message}
      confirmLabel={t`Apply`}
      cancelLabel={t`Dismiss`}
      showDontAskAgain
      dontAskAgainLabel={t`Always apply automatically`}
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
  // Raw, as printed before: a `#` would group a count past 999 ("1,234").
  const fileCountText = String(uncommittedFileCount);
  const commitCountText = String(unpushedCommitCount);
  return (
    <div className="space-y-2">
      <p>
        {hasWorktree
          ? <Trans>Resetting <span className="font-medium">"{taskTitle}"</span> will delete its worktree and destroy its session history.</Trans>
          : <Trans>Resetting <span className="font-medium">"{taskTitle}"</span> will destroy its session history.</Trans>}
      </p>
      {hasSpecificCounts ? (
        <ul className="list-disc list-inside text-red-400 font-medium">
          {uncommittedFileCount > 0 && (
            <li>
              <Plural value={uncommittedFileCount} one={`${fileCountText} uncommitted file`} other={`${fileCountText} uncommitted files`} />
            </li>
          )}
          {unpushedCommitCount > 0 && (
            <li>
              <Plural value={unpushedCommitCount} one={`${commitCountText} unpushed commit`} other={`${commitCountText} unpushed commits`} />
            </li>
          )}
        </ul>
      ) : (
        <p className="text-red-400 font-medium">
          <Trans>Unable to verify pending changes. There may be unsaved work.</Trans>
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
  const { t } = useLingui();

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
          title={t`Reset task?`}
          variant="danger"
          confirmLabel={t({ message: 'Reset', context: 'Action' })}
          cancelLabel={t`Keep Working`}
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
        const doneTaskTitle = pendingDoneConfirm.task.title;
        // Raw, as printed before: a `#` would group a count past 999 ("1,234").
        const fileCountText = String(uncommittedFileCount);
        const commitCountText = String(unpushedCommitCount);
        return (
          <ConfirmDialog
            title={t`Move to Done?`}
            // This dialog only opens when the probe found pending changes (or
            // failed); a clean Done move is recoverable and skips confirmation
            // entirely, so there is no "don't ask again" escape hatch here.
            variant="danger"
            confirmLabel={t`Move`}
            cancelLabel={t`Cancel`}
            message={
              <div className="space-y-2">
                <p className="font-medium text-fg break-words">
                  <Trans>"{doneTaskTitle}"</Trans>
                </p>
                {/* Red is reserved for data the move genuinely destroys:
                    uncommitted files, at-risk local-only commits (below), and the
                    probe-failure fallback where the worktree is suspect. */}
                {uncommittedFileCount > 0 && (
                  <ul className="list-disc list-inside text-red-400 font-medium" data-testid="done-confirm-uncommitted">
                    <li>
                      <Plural
                        value={uncommittedFileCount}
                        one={`${fileCountText} uncommitted file will be lost`}
                        other={`${fileCountText} uncommitted files will be lost`}
                      />
                    </li>
                  </ul>
                )}
                {hasPendingChanges && uncommittedFileCount === 0 && unpushedCommitCount === 0 && (
                  // Git probe failed; we don't know the exact damage, but we
                  // know the worktree is suspect. Mirror MoveConfirmMessage's
                  // fallback copy so the user still sees a danger signal.
                  <p className="text-red-400 font-medium">
                    <Trans>Unable to verify pending changes. There may be unsaved work.</Trans>
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
                      {/* One message per branch fact, each a plural, so "exists"
                          agrees with the count and the branch name sits inside
                          the sentence. */}
                      {displayBranch ? (
                        <Plural
                          value={unpushedCommitCount}
                          one={<>{commitCountText} commit exists only on branch <code className={BRANCH_CODE_CLASS}>{displayBranch}</code> and will be lost when the branch is deleted</>}
                          other={<>{commitCountText} commits exist only on branch <code className={BRANCH_CODE_CLASS}>{displayBranch}</code> and will be lost when the branch is deleted</>}
                        />
                      ) : (
                        <Plural
                          value={unpushedCommitCount}
                          one={`${commitCountText} commit exists only on the local branch and will be lost when the branch is deleted`}
                          other={`${commitCountText} commits exist only on the local branch and will be lost when the branch is deleted`}
                        />
                      )}
                    </li>
                  </ul>
                )}
                <ul className="space-y-1.5">
                  <li className="flex items-start gap-2">
                    <Check size={14} className="text-emerald-500 mt-0.5 shrink-0" aria-hidden />
                    <span><Trans>Local worktree will be deleted</Trans></span>
                  </li>
                  {displayBranch && (
                    autoCleanup ? (
                      // Branch is force-deleted on this move; state it plainly
                      // rather than the old (false) "will be unaffected".
                      <li className="flex items-start gap-2" data-testid="done-confirm-branch-fate">
                        <Trash2 size={14} className="text-fg-muted mt-0.5 shrink-0" aria-hidden />
                        <span>
                          <Trans>Branch <code className={BRANCH_CODE_CLASS}>{displayBranch}</code> will be deleted</Trans>
                        </span>
                      </li>
                    ) : (
                      <li className="flex items-start gap-2" data-testid="done-confirm-branch-fate">
                        <Check size={14} className="text-emerald-500 mt-0.5 shrink-0" aria-hidden />
                        <span>
                          <Trans>Branch <code className={BRANCH_CODE_CLASS}>{displayBranch}</code> will be kept</Trans>
                        </span>
                      </li>
                    )
                  )}
                  <li className="flex items-start gap-2">
                    <Check size={14} className="text-emerald-500 mt-0.5 shrink-0" aria-hidden />
                    <span><Trans>Session history will be kept</Trans></span>
                  </li>
                </ul>
                {!autoCleanup && (
                  <p className="text-fg-muted">
                    <Trans>If this task is resumed, the worktree will be recreated from the branch's last commit.</Trans>
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
