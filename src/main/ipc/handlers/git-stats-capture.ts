import fs from 'node:fs';
import path from 'node:path';
import { DiffService, type ChurnSummary } from '../../git/diff-service';
import { viaGitRead, GitReadPriority } from '../../git/git-read-queue';
import { isInsideGitCheckout } from '../../git/git-checks';
import { remoteGitRunnerFor } from '../../git/remote-git';
import type { SessionRepository } from '../../db/repositories/session-repository';
import type { UsageHistoryRepository } from '../../db/repositories/usage-history-repository';
import type { Task } from '../../../shared/types';
import type { IpcContext } from '../ipc-context';
import { handlerStepReporter } from '../helpers/handler-step-report';

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
 * How long a worktree removal waits for the churn capture fired into the
 * worktree just before it: the Done move's own, or the one the agent's exit
 * fired ahead of a delete (from the board or an MCP tool), a To Do reset or a
 * Backlog demote. That read is six git processes at background priority,
 * about a second on a quiet machine; past this the removal goes ahead, and a
 * read that then finds its folder gone writes nothing and is not reported
 * (`churnFolderGone`), so it never overwrites an earlier capture.
 */
const CHURN_READ_WAIT_MS = 15_000;

/**
 * Wait, at most `timeoutMs` (`CHURN_READ_WAIT_MS` unless a caller names
 * another), for every churn read in flight in `gitDir` to settle. A Done move fires its capture into the worktree just before it moves
 * the worktree aside, and a delete, a To Do reset or a Backlog demote fires one
 * from the agent's exit just before it removes the worktree. Waiting keeps that
 * last capture. A read that outlives the wait and finds its folder gone is
 * skipped, not reported (`churnFolderGone`). Never rejects.
 */
export async function waitForChurnRead(gitDir: string, timeoutMs: number = CHURN_READ_WAIT_MS): Promise<void> {
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
 * Whether a task's worktree folder is still there with its `.git` file gone,
 * as partway through a removal, or after one that failed halfway. A
 * Kangentic worktree sits inside the project's own checkout
 * (`.kangentic/worktrees/`), so git started there walks up and reads the main
 * checkout instead, and its churn would be written as the task's. A remote
 * project's folder here is an empty stand-in with no `.git`, and its git runs
 * on the host, so it never counts.
 */
function worktreeLostItsGitFile(worktreePath: string): boolean {
  if (remoteGitRunnerFor(worktreePath) !== null) return false;
  return fs.existsSync(worktreePath) && !fs.existsSync(path.join(worktreePath, '.git'));
}

/**
 * Whether a failed churn read met a folder that is gone or is no longer a
 * repository: a worktree removed under the read, which is expected and not a
 * defect. Matched by `name` and shape, not `instanceof`: this runs in a
 * rejection handler, and an import of either class reads a module that many
 * tests replace with a partial mock, where a missing export throws and the
 * skip becomes an unhandled rejection. `churnFailureLine` matches the same way.
 * - `GitCommandError` with `not_a_repository`: git started in a folder that
 *   was mid-removal (Sentry DESKTOP-5R, 5Y), or one with no repository.
 * - `GitDirectoryMissingError`: `gitAt` found the folder gone (DESKTOP-5X).
 * - ENOENT: the pty host could not start git in a cwd that is gone
 *   (DESKTOP-5S). Only while the folder is in fact gone, since a git binary
 *   missing from PATH fails with ENOENT too.
 */
function churnFolderGone(error: unknown, gitDir: string): boolean {
  if (!(error instanceof Error)) return false;
  if (error.name === 'GitDirectoryMissingError') return true;
  if (error.name === 'GitCommandError') return (error as { gitCause?: unknown }).gitCause === 'not_a_repository';
  return (error as NodeJS.ErrnoException).code === 'ENOENT' && !fs.existsSync(gitDir);
}

/**
 * One line for the local log about a failed churn read: git's own `fatal:` or
 * `error:` line from stderr, else the error's name and code. Never the
 * message, which for git starts with stdout, and a failed diff's stdout can
 * hold file text. The line can name paths, so it goes to the local log only,
 * under a tag that is not a Sentry breadcrumb.
 */
function churnFailureLine(error: unknown): string {
  if (!(error instanceof Error)) return typeof error;
  const stderr = (error as { stderr?: unknown }).stderr;
  if (error.name === 'GitCommandError' && typeof stderr === 'string') {
    const gitLine = stderr.split(/\r?\n/).find((line) => /^(?:fatal|error): /.test(line));
    if (gitLine) return gitLine;
  }
  const code = (error as NodeJS.ErrnoException).code;
  return code ? `${error.name} ${code}` : error.name;
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
 * - A no-clobber guard: an all-zero result (a capture that runs after the
 *   branch is already merged, where HEAD is already past the merge-base) is
 *   treated as "nothing to report," not "the branch has 0 churn," so it can
 *   never wipe a real capture made earlier in the task's life. A read that
 *   fails writes nothing either, so it never wipes one.
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
 * Best-effort. It returns early, reading nothing, in three cases:
 * - there is no git directory;
 * - the task has no worktree and no repository sits at or above the project
 *   folder, so the read cannot succeed;
 * - the task's worktree folder has lost its `.git` file, so git would read the
 *   main checkout (`worktreeLostItsGitFile`).
 *
 * No failure reaches the calling finalization flow. A read whose folder was
 * removed under it is logged and skipped; every other failure is reported.
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
    // A task with no worktree reads the project folder, and in a folder with no
    // repository above it every read fails (`git diff` exits 128).
    if (!task.worktree_path && !isInsideGitCheckout(gitDir)) return;
    const worktreePath = task.worktree_path;
    if (worktreePath && worktreeLostItsGitFile(worktreePath)) return;

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
        // The `.git` file can go while the read runs; what it read then was the main checkout.
        if (worktreePath && worktreeLostItsGitFile(worktreePath)) return;
        sessionRepo.setTaskGitStats(recordIds, canonicalRecordId, stats);
        usageHistoryRepo.setTaskGitStats(recordIds, canonicalRecordId, stats);
      })
      .catch((error: unknown) => {
        // The churn since the last capture never reaches Stats. The read throws on git's
        // failures, and the common one is a worktree removed under it, which is skipped.
        // The rest (a fatal line the classifier does not know, a failed write) report.
        console.warn(`[GIT_STATS] Churn read failed for task ${task.id.slice(0, 8)}: ${churnFailureLine(error)}`);
        if (churnFolderGone(error, gitDir)) return;
        handlerStepReporter.report(error, { tags: { area: 'git_stats', step: 'churn_write' } });
      });
  } catch (error) {
    // Never break the calling finalization flow. The capture never started, so the
    // task's lines changed never reach Stats.
    handlerStepReporter.report(error, { tags: { area: 'git_stats', step: 'churn_capture' } });
  }
}
