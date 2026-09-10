import type { TaskRepository } from '../../db/repositories/task-repository';
import { readLocalBranchSha } from '../../git/worktree-head';

/**
 * A task's worktree directory is gone (deleted by hand, by a janitor, or by a
 * failed removal), so the task becomes a no-worktree task in the shared
 * checkout. The checkout facts die with the directory: `worktree_path`,
 * `branch_name` (the LOCAL branch a restore re-attaches to), and
 * `resolved_base_branch` (the base that checkout was cut from).
 *
 * The WORK does not die with it, and the PR ladder's durable anchors describe
 * the work: `pushed_branch` is a remote fact and stays untouched, and the
 * commit at the tip of the surviving local branch ref is captured into
 * `head_sha` before the name is dropped. A named ref is per task, not the
 * shared HEAD, so reading it here is sound where a HEAD read would not be.
 * Without the capture the task could never link its PR again if the resolver
 * happened to be down when the directory vanished, which is the shape that
 * stranded three tasks on 2026-09-10.
 *
 * Shared by the two startup passes (resume and auto-spawn) so the reasoning
 * lives once.
 */
export async function demoteMissingWorktree(
  taskRepo: TaskRepository,
  task: { id: string; branch_name: string | null },
  projectPath: string,
): Promise<void> {
  const capturedSha = task.branch_name ? await readLocalBranchSha(projectPath, task.branch_name) : null;
  taskRepo.update({
    id: task.id,
    worktree_path: null,
    branch_name: null,
    resolved_base_branch: null,
    ...(capturedSha ? { head_sha: capturedSha } : {}),
  });
  // The fallback is silent otherwise: record it so the board can say the
  // agent is now in the shared checkout, and why.
  taskRepo.setWorktreeSkipReason(task.id, 'worktree-missing');
}
