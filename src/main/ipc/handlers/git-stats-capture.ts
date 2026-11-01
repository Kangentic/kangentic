import { DiffService, type ChurnSummary } from '../../git/diff-service';
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

const churnReadsInFlight = new Map<string, Promise<ChurnSummary>>();

function churnDirectoryKey(gitDir: string): string {
  return process.platform === 'win32' ? gitDir.toLowerCase() : gitDir;
}

/**
 * Wait, at most `timeoutMs`, for every churn read in flight in `gitDir` to
 * settle. A Done move fires its capture into the worktree just before it moves
 * the worktree aside, and a read whose directory vanished mid-diff reports
 * nothing. Never rejects.
 */
export async function waitForChurnRead(gitDir: string, timeoutMs: number): Promise<void> {
  const prefix = `${churnDirectoryKey(gitDir)}\0`;
  const reads = [...churnReadsInFlight].filter(([key]) => key.startsWith(prefix)).map(([, read]) => read);
  if (reads.length === 0) return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const bound = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, timeoutMs);
    timer.unref?.();
  });
  await Promise.race([Promise.allSettled(reads), bound]);
  if (timer) clearTimeout(timer);
}

/**
 * The churn read for one directory and base, shared while it is queued or
 * running. A suspend fires two captures for the same stopped agent, one from
 * the move or Done branch and one from the session's exit handler, and each
 * read is six git processes. One asked for after the shared read settles runs
 * again, so a result is never reused past the overlap. A capture that joins a
 * read already running gets that read's figures, which can predate a change
 * made while it ran; at worst a few lines of churn, and a stale empty result
 * never overwrites a real capture (the zero-churn guard below).
 */
function readChurnShared(gitDir: string, baseBranch: string): Promise<ChurnSummary> {
  const key = `${churnDirectoryKey(gitDir)}\0${baseBranch}`;
  const inFlight = churnReadsInFlight.get(key);
  if (inFlight) return inFlight;
  // Global read-queue cap at BACKGROUND priority: every finalization branch
  // fires one of these, and a batch Done-move used to fan out ~4 unqueued
  // git children per task simultaneously. Stats capture yields to
  // user-action reads (readWorktreeHead, PR linking).
  const read = viaGitRead(
    () => new DiffService(gitDir).getChurnSummary(baseBranch),
    { priority: GitReadPriority.BACKGROUND },
  ).finally(() => {
    churnReadsInFlight.delete(key);
  });
  churnReadsInFlight.set(key, read);
  return read;
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
 * - A landed-work guard: once the task's PR is merged, or the task is archived
 *   (only the move into Done archives) with a capture already stored, the
 *   stored capture is the branch's final measure and nothing is read. A merged
 *   branch is often reset onto the base and gains unrelated commits or
 *   leftover edits, which read as a small NON-zero churn the zero guard lets
 *   through: #732's +52,801 / -2,054 over 489 files was overwritten that way by
 *   a later release commit's +38 / -1 in 1 file.
 * - Two captures that overlap share one git read (`readChurnShared`), and each
 *   still writes its own record, in the order its read settled.
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
    if (task.pr_state === 'merged') return;

    const records = sessionRepo.listForTaskNewestFirst(task.id);
    const hasStoredCapture = records.some((record) => (
      (record.lines_added ?? 0) > 0 || (record.lines_removed ?? 0) > 0 || (record.files_changed ?? 0) > 0
    ));
    if (task.archived_at !== null && hasStoredCapture) return;

    const recordIds = records.map((record) => record.id);
    const baseBranch = task.base_branch || defaultBaseBranch || 'main';

    void readChurnShared(gitDir, baseBranch)
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
