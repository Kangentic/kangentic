import simpleGit from 'simple-git';
import { readWorktreeHeadUnqueued } from './worktree-head';
import type { GitBranchSummaryInput, GitBranchSummaryResult } from '../../shared/types';

/**
 * Compute the Changes panel header context for a worktree (or project): the live
 * HEAD branch, ahead/behind counts vs the base branch, and the tip commit.
 *
 * Deliberately local and cheap (no remote fetch, no `gh` lookup): it runs on
 * every panel open, fs.watch fire, and manual refresh, so it must not pay the
 * cost of the Done-dialog probe ({@link probePendingChanges}). Ahead/behind use
 * `rev-list --left-right --count <base>...HEAD`, whose output is "<behind>
 * <ahead>" (commits only in the base on the left, commits only in HEAD on the
 * right). The base ref prefers `origin/<base>` (the local ref may be stale) and
 * falls back to the local `<base>`.
 *
 * Fails SAFE: any git error yields an all-empty summary so the header simply
 * omits the context rather than surfacing an error.
 */
export async function getBranchSummary(input: GitBranchSummaryInput): Promise<GitBranchSummaryResult> {
  const workingDirectory = input.worktreePath ?? input.projectPath;
  const emptySummary: GitBranchSummaryResult = { currentBranch: null, ahead: 0, behind: 0, lastCommit: null };

  try {
    const git = simpleGit(workingDirectory);
    // Unqueued: this interactive panel refresh stays off the global read cap
    // (a queued read would wait behind a BACKGROUND churn capture's slot).
    const { branch: currentBranch } = await readWorktreeHeadUnqueued(workingDirectory);

    let ahead = 0;
    let behind = 0;
    for (const baseRef of [`origin/${input.baseBranch}`, input.baseBranch]) {
      try {
        const revListOutput = (await git.raw(['rev-list', '--left-right', '--count', `${baseRef}...HEAD`])).trim();
        const [behindCount, aheadCount] = revListOutput.split(/\s+/);
        behind = Number.parseInt(behindCount, 10) || 0;
        ahead = Number.parseInt(aheadCount, 10) || 0;
        break;
      } catch {
        // Base ref does not exist (e.g. repo uses 'master', or no remote) - try the next.
        continue;
      }
    }

    // Tip commit. The unit separator (%x1f) cannot appear in a commit message,
    // so it splits the fields without colliding with subject content.
    let lastCommit: GitBranchSummaryResult['lastCommit'] = null;
    try {
      const logOutput = (await git.raw(['log', '-1', '--format=%h%x1f%s%x1f%cI'])).trim();
      if (logOutput) {
        const [hash, subject, timestamp] = logOutput.split('\x1f');
        if (hash) {
          lastCommit = { hash, subject: subject ?? '', timestamp: timestamp ?? '' };
        }
      }
    } catch {
      // Unborn branch (no commits yet) - leave lastCommit null.
    }

    return { currentBranch, ahead, behind, lastCommit };
  } catch {
    return emptySummary;
  }
}
