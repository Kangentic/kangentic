import { simpleGit } from 'simple-git';

/**
 * Read the worktree's live HEAD: the actual branch (preferred over the stored
 * slug, which agents rename) and the tip commit SHA (an immutable anchor we
 * persist so resolution survives worktree deletion and renames).
 *
 * `branch` is null on a detached HEAD or any git error; `sha` is null only on
 * a git error. Best-effort: callers treat null as "keep what we already have".
 */
export async function readWorktreeHead(worktreePath: string): Promise<{ branch: string | null; sha: string | null }> {
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
 */
export async function hasCommitsAheadOfBase(repoCwd: string, baseBranch: string, sha: string): Promise<boolean> {
  try {
    const git = simpleGit(repoCwd);
    const commitCountOutput = (await git.raw(['rev-list', '--count', `${baseBranch}..${sha}`])).trim();
    return Number.parseInt(commitCountOutput, 10) > 0;
  } catch {
    return false;
  }
}
