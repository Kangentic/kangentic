import { simpleGit } from 'simple-git';
import { viaGitRead } from './git-read-queue';

/**
 * Read the worktree's live HEAD: the actual branch (preferred over the stored
 * slug, which agents rename) and the tip commit SHA (an immutable anchor we
 * persist so resolution survives worktree deletion and renames).
 *
 * `branch` is null on a detached HEAD or any git error; `sha` is null only on
 * a git error. Best-effort: callers treat null as "keep what we already have".
 *
 * Queued through the global read cap (`viaGitRead`) so a burst of callers
 * (batch Done-moves, PR-link fan-in) cannot spawn unbounded git children; the
 * never-throws catch stays inside the queued job so the contract holds.
 */
export async function readWorktreeHead(worktreePath: string): Promise<{ branch: string | null; sha: string | null }> {
  return viaGitRead(() => readWorktreeHeadUnqueued(worktreePath));
}

/**
 * Unqueued variant of {@link readWorktreeHead} for interactive single-flight
 * panel paths (the Changes panel header in branch-summary.ts, the commit
 * graph in commit-graph.ts). Those refresh on every pane open and fs.watch
 * fire and must not wait behind the global read cap while a BACKGROUND churn
 * capture holds a slot (git-read-queue.ts exempts interactive paths by
 * design). Burst-prone callers (batch Done-moves, PR-link fan-in) use the
 * queued readWorktreeHead instead.
 */
export async function readWorktreeHeadUnqueued(worktreePath: string): Promise<{ branch: string | null; sha: string | null }> {
  try {
    const git = simpleGit(worktreePath);
    const branchRaw = (await git.revparse(['--abbrev-ref', 'HEAD'])).trim();
    const sha = (await git.revparse(['HEAD'])).trim();
    return {
      branch: branchRaw && branchRaw !== 'HEAD' ? branchRaw : null,
      sha: sha || null,
    };
  } catch {
    // Worktree gone or git error.
    return { branch: null, sha: null };
  }
}

/**
 * Whether `sha` has any commits of its own beyond `baseBranch` - i.e. it is
 * genuinely a task's work and not a base-branch tip a freshly-branched worktree
 * sits on. A fresh worktree is branched from the base with zero commits, so its
 * HEAD equals the base tip, which equals the last-merged PR's commit; the
 * commit-SHA PR anchor must not run there or it attributes that PR to the task.
 *
 * `rev-list --count <base>..<sha>` is the number of commits reachable from `sha`
 * but not from `baseBranch`, which is 0 exactly when `sha` is already contained
 * in `baseBranch`. Unlike a parent-count merge check this also catches the
 * single-parent commits that `gh pr merge --rebase` / `--squash` produce (the
 * team default). The commit survives in the object store after the worktree is
 * reclaimed, so this works from the main repo too.
 *
 * Fails SAFE: on any git error (bad base ref, missing object) returns false so
 * the caller skips the commit anchor rather than risking a mis-link.
 *
 * Queued through the global read cap (`viaGitRead`), same as readWorktreeHead.
 */
export async function hasCommitsAheadOfBase(repoCwd: string, baseBranch: string, sha: string): Promise<boolean> {
  return viaGitRead(async () => {
    try {
      const git = simpleGit(repoCwd);
      const commitCountOutput = (await git.raw(['rev-list', '--count', `${baseBranch}..${sha}`])).trim();
      return Number.parseInt(commitCountOutput, 10) > 0;
    } catch {
      return false;
    }
  });
}
