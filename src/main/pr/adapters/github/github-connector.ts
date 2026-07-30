/**
 * GitHub PR connector - resolves PRs via the `gh` CLI and detects PR URLs from
 * terminal output.
 *
 * Detects from:
 * - `gh pr create` stdout: bare URL on a line
 * - `gh pr view` TTY mode: "View this pull request on GitHub: <url>"
 * - `gh pr view` non-TTY: "url:\t<url>"
 * - `gh pr view --json` output containing URL in JSON value
 *
 * Does NOT match:
 * - `git push` output: /pull/new/branch-name (no numeric ID)
 * - `gh pr merge` output: owner/repo#123 (no full URL)
 */

import PQueue from 'p-queue';
import type { PRConnector, DetectedPR, ResolvedPR, PRState } from '../../shared/pr-connector';
import { PRResolverUnavailableError, PRResolverTransientError } from '../../shared/pr-errors';
import { GitHubImporter, GhUnavailableError, GhTransientError, type GhPrListItem } from '../../../boards/adapters/github-common/gh-client';
import { isShaContainedInRef } from '../../../git/worktree-head';

/**
 * Shared gh client for authoritative PR resolution. Reuses the same binary
 * detection + auth plumbing as the board importer; detection is cached on the
 * instance, so a module-level singleton avoids re-probing `gh` per call.
 */
const ghImporter = new GitHubImporter();

/**
 * Global cap on concurrent `gh` subprocesses across ALL tasks. Each ladder tier
 * is a `gh` spawn (~hundreds of ms + an API round-trip); without this, a
 * multi-card drag or board-load burst could fan out into dozens of concurrent
 * processes and stall the event loop / burn the GitHub rate limit.
 */
const GH_CONCURRENCY = 3;
const ghQueue = new PQueue({ concurrency: GH_CONCURRENCY });

/**
 * Run a gh-backed resolve through the global concurrency limiter, translating the
 * GitHub-specific errors into the platform-agnostic ones so the generic layer
 * (`pr-linking.ts`) never imports a provider-specific error type.
 */
async function viaGh<T>(fn: () => Promise<T>): Promise<T> {
  return ghQueue.add(async () => {
    try {
      return await fn();
    } catch (error) {
      if (error instanceof GhUnavailableError) throw new PRResolverUnavailableError(error.message);
      if (error instanceof GhTransientError) throw new PRResolverTransientError(error.message);
      throw error;
    }
  }) as Promise<T>;
}

/** Map GitHub's API state (OPEN/CLOSED/MERGED + isDraft) to our normalized PRState. */
function mapState(item: GhPrListItem): PRState {
  if (item.state === 'MERGED') return 'merged';
  if (item.state === 'CLOSED') return 'closed';
  return item.isDraft ? 'draft' : 'open';
}

/** Project a raw gh PR item into the platform-agnostic ResolvedPR shape. */
function toResolvedPR(item: GhPrListItem): ResolvedPR {
  return {
    url: item.url,
    number: item.number,
    state: mapState(item),
    baseRefName: item.baseRefName,
    updatedAt: item.updatedAt,
  };
}

/**
 * Pick the best PR from a candidate list for inferred (branch- or commit-based)
 * resolution, guarding against mislinks:
 *   - drop fork (cross-repository) PRs - an inferred match on a shared branch name
 *     or commit is never reliably this task's PR (resolveByNumber bypasses this
 *     guard, since an explicit number is unambiguous),
 *   - when a `branchHint` is given, restrict to PRs whose head ref matches it;
 *     if none match and the list is ambiguous (>1), return null rather than guess,
 *   - then prefer open/draft over merged/closed, then a matching base branch,
 *     then the most recently updated.
 */
function disambiguate(items: GhPrListItem[], opts: { baseBranch?: string; branchHint?: string } = {}): GhPrListItem | null {
  const { baseBranch, branchHint } = opts;
  let pool = items.filter((item) => !item.isCrossRepository);
  if (pool.length === 0) return null;

  if (branchHint) {
    const matching = pool.filter((item) => item.headRefName === branchHint);
    if (matching.length > 0) {
      pool = matching;
    } else if (pool.length > 1) {
      // Multiple PRs contain the commit and none is on this task's branch -> don't guess.
      return null;
    }
  }

  const score = (item: GhPrListItem): number => {
    let value = 0;
    if (item.state === 'OPEN') value += 100;
    if (baseBranch && item.baseRefName === baseBranch) value += 10;
    return value;
  };
  return [...pool].sort((left, right) => {
    const scoreDelta = score(right) - score(left);
    if (scoreDelta !== 0) return scoreDelta;
    return (right.updatedAt ?? '').localeCompare(left.updatedAt ?? '');
  })[0];
}

/**
 * Drop every candidate whose OWN base branch already contains the commit we
 * resolved from. `gh api commits/<sha>/pulls` returns every PR whose head branch
 * contains the commit, which includes a sibling PR that merely branched off the
 * same base tip: its head contains the commit only as inherited base history,
 * never as its own work. That is the mislink - a task whose worktree has no
 * commits of its own sits on the base tip and magnets onto whichever open
 * sibling shares it.
 *
 * This generalizes the `mergeCommitOid` filter below from the last-merged PR to
 * any PR sharing base history, and asks the question against the CANDIDATE's
 * known base rather than the task's often-unknown one (a worktree cut from a
 * non-default branch never records a base, which is what made the linker's
 * commits-ahead-of-base guard unsound). `baseRefName` already rides along on the
 * REST response, so there is no extra API call.
 *
 * Two candidates are deliberately kept:
 *
 * - **MERGED.** A merged PR's own commits ARE in its base afterwards, so
 *   containment cannot tell "this task's work, now merged" from "inherited base
 *   history", and rejecting would clear a correct link (a task on a non-default
 *   base whose own PR landed via a real merge commit). The merged shape is
 *   already covered by the `mergeCommitOid` filter. Every other state has at
 *   least one commit between base and head, so containment there proves the
 *   commit is not that PR's work.
 * - **Undetermined** (`null`: the base ref was never fetched locally). Fall back
 *   to the `branchHint` rule in `disambiguate`, so an unfetched ref costs a
 *   mislink guard rather than an existing badge.
 *
 *   KNOWN GAP, not a settled trade-off: because this filter runs before
 *   `disambiguate`, dropping a proven-contained sibling can leave a
 *   kept-undetermined candidate as the LONE survivor, which then slips past the
 *   hint rule's ambiguity guard (it only returns null when MORE than one
 *   non-matching candidate remains). A candidate never verified as its own work
 *   can therefore win a comparison that previously returned null. Deciding
 *   whether an undetermined survivor should still count toward that threshold is
 *   open; see docs/pr-integration.md.
 *
 * The probes are memoized per base ref and awaited sequentially on purpose: this
 * runs inside a `ghQueue` slot, so the cost is throughput, not a deadlock. The
 * git read queue caps EXECUTION at 2 whatever we do here, so a `Promise.all`
 * could not defeat that cap; what it would do is submit every probe at once and
 * deepen that shared queue (up to `GH_CONCURRENCY` resolves can be in flight),
 * delaying the other USER-priority readers on it such as the Done-move confirm
 * probe. Awaiting sequentially holds this call to one slot at a time.
 */
async function dropCandidatesSharingBaseHistory(
  repoCwd: string,
  commitSha: string,
  items: GhPrListItem[],
): Promise<GhPrListItem[]> {
  const containmentByBaseRef = new Map<string, Promise<boolean | null>>();
  const survivors: GhPrListItem[] = [];
  for (const item of items) {
    if (item.state === 'MERGED' || !item.baseRefName) {
      survivors.push(item);
      continue;
    }
    let containment = containmentByBaseRef.get(item.baseRefName);
    if (!containment) {
      containment = isShaContainedInRef(repoCwd, item.baseRefName, commitSha);
      containmentByBaseRef.set(item.baseRefName, containment);
    }
    if ((await containment) !== true) survivors.push(item);
  }
  return survivors;
}

/**
 * Strip all common terminal escape sequences:
 * - CSI sequences: ESC [ ... letter  (colors, cursor, etc.)
 * - OSC sequences: ESC ] ... BEL  or  ESC ] ... ESC \  (hyperlinks, title)
 * - Two-byte sequences: ESC + single char  (e.g. ESC M reverse index)
 */
const ANSI_ESCAPE_PATTERN = /\x1b\[[0-9;]*[a-zA-Z]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[^[\]]/g;
const GITHUB_PR_URL_PATTERN = /https:\/\/github\.com\/[^/\s]+\/[^/\s]+\/pull\/(\d+)/g;

/** Maximum bytes to scan from the end of scrollback for performance. */
const SCAN_WINDOW = 4096;

export const gitHubPRConnector: PRConnector = {
  name: 'GitHub',

  matchesCommand(commandDetail: string): boolean {
    return /^gh\s+pr\s+(create|view|merge)/.test(commandDetail);
  },

  extract(scrollback: string): DetectedPR | null {
    if (!scrollback) return null;

    // Only scan the tail of the scrollback for performance
    const tail = scrollback.length > SCAN_WINDOW
      ? scrollback.slice(-SCAN_WINDOW)
      : scrollback;

    // Strip ANSI escape sequences so color codes don't break matching
    const clean = tail.replace(ANSI_ESCAPE_PATTERN, '');

    // Find all matches and return the last one (most recent)
    let lastMatch: DetectedPR | null = null;
    let match: RegExpExecArray | null;

    GITHUB_PR_URL_PATTERN.lastIndex = 0;
    while ((match = GITHUB_PR_URL_PATTERN.exec(clean)) !== null) {
      lastMatch = {
        url: match[0],
        number: parseInt(match[1], 10),
      };
    }

    return lastMatch;
  },

  async resolveForBranch(repoCwd: string, branchName: string, baseBranch?: string): Promise<ResolvedPR | null> {
    return viaGh(async () => {
      const items = await ghImporter.resolvePRByBranch(repoCwd, branchName);
      // Every item already matches head=branchName; the hint also drops fork PRs
      // that share the branch name.
      const best = disambiguate(items, { baseBranch, branchHint: branchName });
      return best ? toResolvedPR(best) : null;
    });
  },

  async resolveByNumber(repoCwd: string, prNumber: number): Promise<ResolvedPR | null> {
    return viaGh(async () => {
      const item = await ghImporter.resolvePRByNumber(repoCwd, prNumber);
      // Explicit number lookup is unambiguous: a PR number is unique within the repo,
      // so there is no cross-repo collision risk. Unlike resolveForBranch/resolveByCommit
      // (which drop fork PRs because a fork can share a branch name or commit), trusting a
      // fork PR here is safe - the caller already named the exact PR.
      return item ? toResolvedPR(item) : null;
    });
  },

  async resolveByCommit(repoCwd: string, commitSha: string, branchHint?: string): Promise<ResolvedPR | null> {
    return viaGh(async () => {
      const items = await ghImporter.resolvePRByCommit(repoCwd, commitSha);
      // Drop any PR whose merge product IS the commit we resolved from. A fresh
      // worktree branched from base sits on base's tip, which is the last-merged
      // PR's merge/squash/rebase commit - that commit is shared base history, not
      // this task's work, and `gh api commits/{sha}/pulls` would otherwise magnet
      // the task onto a sibling's merged PR. (An open PR's `merge_commit_sha` is a
      // synthetic test-merge that can never equal a real authored commit, so a
      // task's own PR is never dropped here.) This is the merged half of the
      // backstop for the linker's commits-ahead-of-base guard, which misfires when
      // the task's base branch is wrong or unknown; the filter below covers the
      // rest.
      const candidates = items.filter((item) => item.mergeCommitOid !== commitSha);
      // Then drop any sibling PR that merely branched off the same base tip: its
      // head branch contains the commit as inherited base history, not as work of
      // its own. Runs on the smaller pool, and filters BEFORE disambiguation so a
      // genuine runner-up can still win.
      const survivors = await dropCandidatesSharingBaseHistory(repoCwd, commitSha, candidates);
      // The commit can still belong to several PRs (shared/squashed commits); the
      // branch hint ties it back to this task and ambiguous matches return null.
      const best = disambiguate(survivors, { branchHint });
      return best ? toResolvedPR(best) : null;
    });
  },
};
