import { IPC } from '../../shared/ipc-channels';
import { sendToRenderer } from '../ipc/send-to-renderer';
import { cancelVerdictRepollsForTask } from './pr-linking';
import { holdsPRIdentity, type PRIdentityColumn } from './pr-identity';
import type { TaskRepository } from '../db/repositories/task-repository';
import type { Task } from '../../shared/types';
import type { IpcContext } from '../ipc/ipc-context';

/**
 * Make a task that was just moved to To Do forget its PR.
 *
 * A To Do move throws the task's work away: the session, the worktree and the
 * local branch all go, and the next run starts from base. The PR the old work
 * opened is no longer this task's, so its identity goes too: `pr_url`,
 * `pr_number`, `pr_state` and `pr_merge_readiness`, and the two anchors that
 * would find it again. `pushed_branch` is the Tier 5 anchor, and a PR keeps its
 * source branch name after the branch is deleted, so keeping it re-links the
 * old PR on the first resolve after the task leaves To Do. `head_sha` feeds
 * Tiers 3 and 6 on a run with no worktree.
 *
 * Only a task that did work of its own is cleared: one that had a worktree, a
 * branch, a pushed branch or a captured commit. Every one of those comes from
 * the task's own checkout or push. A review task whose PR link was typed in and
 * never started has none of them and keeps its link.
 *
 * `snapshot` is the row as it was BEFORE the move, which `cleanupTaskResources`
 * changes by nulling `worktree_path` and `branch_name` once the directory is
 * removed. `handleTaskMove` calls this twice. The first call runs in the same
 * tick as `tasks.move`, so a quit or crash during the seconds of cleanup that
 * follow cannot leave the old link on a To Do card. The second runs after the
 * cleanup, in a finally, and clears the `head_sha` the cleanup captures from the
 * old checkout. Both run under the task lock `handleTaskMove` holds; this never
 * takes it, since the lock is not reentrant.
 *
 * The other cleanup paths (delete, the Backlog sweep, the startup fallbacks for
 * a missing worktree, Done, and an unarchive into To Do) keep `pushed_branch`:
 * the PR is still the task's work there. This module is the one cleanup write
 * that `tests/unit/pushed-branch-cleanup-parity.test.ts` allows to null it. The
 * Backlog sweep reads a leftover branch's tip into `head_sha` only for a row
 * that still holds one of the six columns this clears, so it never gives a
 * forgotten task the old commit back.
 *
 * Returns true when it cleared anything.
 */
export function forgetPRLinkOnTodoReset(
  context: IpcContext,
  tasks: TaskRepository,
  snapshot: Pick<Task, 'id' | 'worktree_path' | 'branch_name' | 'pushed_branch' | 'head_sha'>,
  projectId: string,
): boolean {
  const hadOwnWork = Boolean(snapshot.worktree_path || snapshot.branch_name || snapshot.pushed_branch || snapshot.head_sha);
  if (!hadOwnWork) return false;

  // A concurrent delete may already have removed the row.
  const current = tasks.getById(snapshot.id);
  if (!current || !holdsPRIdentity(current)) return false;
  const holdsPRLink = [
    current.pr_url,
    current.pr_number,
    current.pr_state,
    current.pr_merge_readiness,
  ].some((value) => value != null);

  // Typed against the shared list, so a column added there and not here fails
  // to compile instead of surviving the reset.
  const forgottenIdentity: Record<PRIdentityColumn, null> = {
    pr_url: null,
    pr_number: null,
    pr_state: null,
    pr_merge_readiness: null,
    pushed_branch: null,
    head_sha: null,
  };
  tasks.update({ id: snapshot.id, ...forgottenIdentity });
  cancelVerdictRepollsForTask(snapshot.id);
  // Most hosts reload the board once their own move resolves. The Monitor's
  // task-detail host refreshes only its own copy, so a cleared link also gets
  // this quiet board reload. The anchors alone draw no chip, and the cleanup
  // captures a head_sha on nearly every worktree task, so clearing only those
  // sends nothing.
  if (holdsPRLink) {
    sendToRenderer(context.mainWindow, IPC.TASK_PR_LINK_CHANGED, projectId);
  }
  const forgotten = current.pr_number != null ? `PR #${current.pr_number}` : 'its PR anchors';
  console.log(`[TASK_MOVE] Forgot ${forgotten} for task ${snapshot.id.slice(0, 8)} (moved to To Do)`);
  return true;
}
