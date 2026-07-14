import { DiffService } from '../../git/diff-service';
import { viaGitRead, GitReadPriority } from '../../git/git-read-queue';
import type { SessionRepository } from '../../db/repositories/session-repository';
import type { UsageHistoryRepository } from '../../db/repositories/usage-history-repository';
import type { Task } from '../../../shared/types';
import type { IpcContext } from '../ipc-context';

/**
 * Resolve the effective default base branch for a project: the team-shared
 * board config default, falling back to the per-project/global config, then
 * 'main'. Centralized here (rather than re-derived at every finalization call
 * site) so churn capture always resolves the base the same way the worktree
 * and diff panel do.
 */
export function resolveDefaultBaseBranch(context: IpcContext, projectPath: string | null | undefined): string {
  const boardDefaultBranch = context.boardConfigManager.getDefaultBaseBranch();
  const effectiveConfig = context.configManager.getEffectiveConfig(projectPath || undefined);
  return boardDefaultBranch || effectiveConfig.git.defaultBaseBranch || 'main';
}

/**
 * Capture git churn (lines added/removed, files changed) for a task, and
 * write it to BOTH the `sessions` row and the `usage_history` row for
 * `canonicalRecordId` - the record id finalizing right now (the caller's
 * fresh capture point), NOT necessarily the task's only session record.
 *
 * Fire-and-forget (mirrors `refineTranscriptTokens`): reads the task's full
 * record-id list synchronously up front (while the task + sessions still
 * exist), then does the git diff off the task lock so it never blocks a
 * suspend/move/exit finalization path. Safe to call from every finalization
 * point (suspend, move, handoff, respawn, natural exit) because:
 *
 * - Churn is branch-cumulative (`git diff <base>...<HEAD>` over the whole
 *   worktree), so writing it to every `--resume` record and letting the
 *   dashboard SUM would double-count. Instead this writes ONLY to
 *   `canonicalRecordId` and zeros out every other record for the same task
 *   (see `setTaskGitStats`), keeping exactly one non-zero row per task
 *   lineage - consistent with the snapshot-token design in
 *   `captureSessionMetrics`.
 * - A no-clobber guard: an all-zero result (a git error, or a capture that
 *   runs after the branch is already merged - e.g. move-to-Done in the PR
 *   flow, where the worktree is gone and HEAD is already past the merge-base)
 *   is treated as "nothing to report," not "the branch has 0 churn," so it
 *   can never wipe a real capture made earlier in the task's life.
 *
 * Best-effort: returns early if there is no git directory; every failure is
 * swallowed so a git error never breaks the calling finalization flow.
 */
export function captureGitChurn(
  task: Task,
  sessionRepo: SessionRepository,
  usageHistoryRepo: UsageHistoryRepository,
  canonicalRecordId: string,
  projectPath: string | null | undefined,
  defaultBaseBranch?: string,
): void {
  try {
    const gitDir = task.worktree_path ?? projectPath;
    if (!gitDir) return;

    const recordIds = sessionRepo.listForTaskNewestFirst(task.id).map((record) => record.id);
    const baseBranch = task.base_branch || defaultBaseBranch || 'main';

    // Global read-queue cap at BACKGROUND priority: every finalization branch
    // fires one of these, and a batch Done-move used to fan out ~4 unqueued
    // git children per task simultaneously. Stats capture yields to
    // user-action reads (readWorktreeHead, PR linking).
    void viaGitRead(
      () => new DiffService(gitDir).getChurnSummary(baseBranch),
      { priority: GitReadPriority.BACKGROUND },
    )
      .then((stats) => {
        if (stats.linesAdded === 0 && stats.linesRemoved === 0 && stats.filesChanged === 0) return;
        sessionRepo.setTaskGitStats(recordIds, canonicalRecordId, stats);
        usageHistoryRepo.setTaskGitStats(recordIds, canonicalRecordId, stats);
      })
      .catch(() => {
        // Git stats capture is best-effort
      });
  } catch {
    // Never break the calling finalization flow
  }
}
