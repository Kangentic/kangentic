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

/**
 * Whether `sha` is already CONTAINED in `ref` - the inverse question to
 * {@link hasCommitsAheadOfBase}, asked about someone else's branch. `rev-list
 * --count <ref>..<sha>` is 0 exactly when every commit reachable from `sha` is
 * already reachable from `ref`.
 *
 * TRI-STATE, unlike `hasCommitsAheadOfBase`. `null` means "cannot tell" (the ref
 * is not present locally, the object is missing, the ref is option-shaped and so
 * refused, or git errored) so the caller
 * can fall back to whatever rule it used before instead of reading a git failure
 * as an answer. A two-value contract would force an unfetched ref to mean either
 * "reject every candidate" (a badge silently disappears) or "accept every
 * candidate" (the mislink this helper exists to prevent).
 *
 * Prefers `origin/<ref>` over the bare local `<ref>`, matching every other base
 * comparison in this folder (branch-summary.ts, commit-graph.ts,
 * local-only-commits.ts, diff-service.ts). Callers ask about a branch name that
 * lives on the REMOTE, and a local branch that is BEHIND origin reports commits
 * ahead that the remote already contains - failing open in exactly the direction
 * that matters. A `ref` that already carries a remote prefix produces
 * `origin/origin/<ref>`, which simply throws and falls through to the bare form:
 * that is the intended handling, not an oversight.
 *
 * Queued through the global read cap (`viaGitRead`), same as the helpers above.
 */
export async function isShaContainedInRef(repoCwd: string, ref: string, sha: string): Promise<boolean | null> {
  // `ref` is remote-controlled: it arrives as `baseRefName` off the GitHub REST
  // payload, and git permits a leading dash (`git check-ref-format
  // refs/heads/-x` exits 0). The bare-ref fallback below would then hand git an
  // argv token STARTING with `-`, which `rev-list` parses as an option rather
  // than a revision: `--output=<path>..<sha>` creates and truncates that file as
  // this process's user. A `--` separator cannot fix it (in `rev-list`, `--`
  // separates revisions from pathspecs), so reject an option-shaped ref outright.
  // No legitimate branch name starts with a dash.
  if (!ref || !sha || ref.startsWith('-')) return null;
  return viaGitRead(async () => {
    try {
      const git = simpleGit(repoCwd);
      for (const candidateRef of [`origin/${ref}`, ref]) {
        let commitCountOutput: string;
        try {
          commitCountOutput = (await git.raw(['rev-list', '--count', `${candidateRef}..${sha}`])).trim();
        } catch {
          // This ref form does not resolve here (never fetched, or no remote) - try the next.
          continue;
        }
        const aheadCount = Number.parseInt(commitCountOutput, 10);
        return Number.isNaN(aheadCount) ? null : aheadCount === 0;
      }
      return null;
    } catch {
      // `simpleGit()` itself throws when repoCwd is not an existing directory (a
      // relocated project, a reclaimed worktree). The outer try keeps the
      // never-answers-with-a-failure contract INSIDE the queued job, as
      // git-read-queue.ts requires: a rejection here would surface to
      // pr-linking.ts as a non-PRResolver error, which clears the task's PR link.
      return null;
    }
  });
}

/** Which refs, if any, have a given commit as their exact tip. */
export interface RefsPointingAtSha {
  /**
   * REMOTE branch names whose tip is exactly the sha, remote prefix stripped and
   * deduped across remotes. Never contains `HEAD`, never an option-shaped name,
   * never the base branch. Local branches are deliberately absent.
   */
  remoteBranches: string[];
  /**
   * True when the sha is also a BASE tip: `refs/heads/<base>`, any remote's
   * `<base>`, or a remote's `HEAD` symref points at it. Callers bail on this,
   * because a sha that is a base tip belongs to whatever last landed on base,
   * never to the task sitting on it.
   */
  pointsAtBaseTip: boolean;
}

/** A value git will accept as an object name. Anything else is refused unread. */
const HEX_SHA_PATTERN = /^[0-9a-f]{7,64}$/i;
const LOCAL_REF_PREFIX = 'refs/heads/';
const REMOTE_REF_PREFIX = 'refs/remotes/';

/**
 * The remote branches whose TIP is exactly `sha`, plus whether `sha` is also a
 * base tip. Both come from ONE `for-each-ref`, so the bail signal costs no extra
 * subprocess on the refresh sweep's hot path.
 *
 * This is the anchor for the PR ladder's last tier: a task whose local worktree
 * branch is the Kangentic slug while the branch actually PUSHED as the PR source
 * carries a team-convention name. Nothing reconciles the two, so the branch tiers
 * query the slug and miss, and the commit tier is gated off once the PR has
 * merged into base (`rev-list --count <base>..<sha>` is 0 by then).
 *
 * LOCAL refs are read but NEVER returned as candidates. Linked worktrees share
 * this repo's ref store, so several other tasks' slug branches routinely sit on
 * the same tip (measured: five local branches point at HEAD in a fresh Kangentic
 * worktree). None of them is a PR source branch, and querying one spends a
 * provider round trip on a guaranteed miss. They matter only for the base
 * signal, which is what a worktree cut OFFLINE from a stale local base produces:
 * there `origin/<base>` has moved on and does not point at the sha, but
 * `refs/heads/<base>` still does.
 *
 * `refs/remotes/<remote>/HEAD` is dropped as a candidate because
 * `%(refname:short)` renders it as the bare remote name (`origin`), which is not
 * a branch. It is promoted to a base signal instead, since a sha at the default
 * branch's tip is a base tip whatever `base_branch` claims.
 *
 * The `refs/remotes/` prefix requirement is load-bearing, not defensive. Several
 * unit suites mock simple-git's `raw` with a single catch-all string
 * (`pr-remote-gate-no-wipe.test.ts`, `pr-link-degrade-hints.test.ts`), and a
 * lenient parser would read `'0'` as a branch name and spend a provider call on
 * it. Real `for-each-ref` output is always full refnames, and git forbids
 * whitespace and control characters in a ref name, so splitting on newlines is
 * exact.
 *
 * Fails SAFE and NEVER throws, the same contract as {@link isShaContainedInRef}:
 * an empty result skips the tier. The outer try wraps `simpleGit()` itself,
 * which throws synchronously when `repoCwd` does not exist (a relocated project,
 * a reclaimed worktree); a rejection escaping here would reach pr-linking.ts as
 * a non-PRResolver error and suppress its confident-not-found clear.
 *
 * `pointsAtBaseTip` is a two-state answer to a three-state question, and it is
 * only safe because of one invariant: EVERY path that could not read the refs
 * returns `remoteBranches: []` alongside it. `false` therefore never means
 * "could not tell" in any way a caller can act on, since the caller drives the
 * tier off the branch list and consults the flag only to EMPTY a list that was
 * genuinely read. Keep that pairing. A future failure path that returned some
 * branches with `pointsAtBaseTip: false` would turn the base-tip bail into a
 * fail-open, which is the fresh-worktree magnet this whole tier is guarded
 * against. The five failure cases in `worktree-head.test.ts` assert the whole
 * object rather than one field, so breaking the pairing goes red.
 *
 * Queued through the global read cap (`viaGitRead`), same as the helpers above.
 */
export async function readRefsPointingAtSha(
  repoCwd: string,
  sha: string,
  baseBranch: string,
): Promise<RefsPointingAtSha> {
  const empty: RefsPointingAtSha = { remoteBranches: [], pointsAtBaseTip: false };
  // `sha` comes from tasks.head_sha, which a pasted value or a future writer
  // could make option-shaped. `--points-at=<value>` is a single argv token so
  // git cannot reparse it as an option, but refusing a non-hex value unread
  // keeps the guard local and costs no subprocess. Same guard class as
  // isShaContainedInRef above.
  if (!sha || !HEX_SHA_PATTERN.test(sha)) return empty;

  return viaGitRead(async () => {
    try {
      const git = simpleGit(repoCwd);
      // A sha with no refs pointing at it, or an object gc has already dropped,
      // exits 0 with empty output rather than erroring.
      const output = await git.raw([
        'for-each-ref',
        '--format=%(refname)',
        `--points-at=${sha}`,
        LOCAL_REF_PREFIX,
        REMOTE_REF_PREFIX,
      ]);

      const seen = new Set<string>();
      const remoteBranches: string[] = [];
      let pointsAtBaseTip = false;

      for (const line of output.split('\n')) {
        const refname = line.trim();
        if (!refname) continue;

        // Local refs are a base signal only, never a candidate.
        if (refname.startsWith(LOCAL_REF_PREFIX)) {
          if (refname === `${LOCAL_REF_PREFIX}${baseBranch}`) pointsAtBaseTip = true;
          continue;
        }
        if (!refname.startsWith(REMOTE_REF_PREFIX)) continue;

        // A base stored remote-qualified ("origin/develop") matches here.
        if (refname === `${REMOTE_REF_PREFIX}${baseBranch}`) {
          pointsAtBaseTip = true;
          continue;
        }

        const withoutPrefix = refname.slice(REMOTE_REF_PREFIX.length);
        const separator = withoutPrefix.indexOf('/');
        // `refs/remotes/<remote>` on its own names no branch.
        if (separator < 0) continue;
        const name = withoutPrefix.slice(separator + 1);

        // The default-branch symref: not a branch, and proof of a base tip.
        if (name === 'HEAD') {
          pointsAtBaseTip = true;
          continue;
        }
        // A base stored bare ("develop"), matched on ANY remote.
        if (name === baseBranch) {
          pointsAtBaseTip = true;
          continue;
        }
        if (!name || name.startsWith('-')) continue;
        if (seen.has(name)) continue;
        seen.add(name);
        remoteBranches.push(name);
      }

      return { remoteBranches, pointsAtBaseTip };
    } catch {
      return empty;
    }
  });
}
