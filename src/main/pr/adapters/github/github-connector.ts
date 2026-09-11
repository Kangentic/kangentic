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
import type {
  PRConnector,
  DetectedPR,
  ResolvedPR,
  PRState,
  PRMergeReadiness,
  PRResolveOptions,
} from '../../shared/pr-connector';
import { PRResolverUnavailableError, PRResolverTransientError } from '../../shared/pr-errors';
import {
  GitHubImporter,
  GhUnavailableError,
  GhTransientError,
  type GhPrListItem,
  type GhMergeable,
  type GhMergeStateStatus,
  type GhCheckRunStatus,
  type GhCheckRunConclusion,
  type GhStatusState,
  type GhStatusCheckRollupItem,
} from '../../../boards/adapters/github-common/gh-client';
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

/**
 * Fold GitHub's mergeability triple into the normalized verdict, or undefined
 * when the item carries none (the commit tier's REST payload). The promise is
 * "a Merge click would succeed", read literally: UNSTABLE is `ready` because the
 * button works with failing NON-required checks (required ones report BLOCKED
 * instead), and a `ready` verdict is downgraded to `blocked` only when a review
 * is still REQUIRED. CHANGES_REQUESTED is deliberately not a downgrade: where
 * reviews are required GitHub already reports BLOCKED, and where they are not
 * the button works, so calling it `blocked` would break the promise.
 * `mergeable` is the fallback when `mergeStateStatus` is absent or a value this
 * code does not know. `reviewDecision` is compared against the one named value:
 * gh renders a null decision as ''.
 *
 * BLOCKED is the one state the triple cannot tell apart: a required check
 * still running, a required check that failed, and a review still required all
 * report it. The check rollup splits the first from the others (see
 * `checksInFlight`), and a check in flight wins over a required review on
 * purpose, so the chip tracks CI while it runs and flips to `blocked` when only
 * the review remains. A failed check never yields to a running one.
 */
function mapMergeReadiness(item: GhPrListItem): PRMergeReadiness | undefined {
  if (item.mergeStateStatus === undefined && item.mergeable === undefined) return undefined;
  if (item.mergeStateStatus === 'BLOCKED') return checksInFlight(item.statusCheckRollup) ?? 'blocked';
  const verdict = mapMergeStateStatus(item.mergeStateStatus) ?? mapMergeable(item.mergeable);
  return verdict === 'ready' && item.reviewDecision === 'REVIEW_REQUIRED' ? 'blocked' : verdict;
}

/**
 * CheckRun conclusions and StatusContext states that mean the check has FAILED,
 * so the merge stays blocked. Typed on the gh unions rather than `string` so a
 * misspelled member fails `tsc` instead of silently never matching.
 */
const FAILED_CHECK_RUN_CONCLUSIONS: ReadonlySet<GhCheckRunConclusion> = new Set<GhCheckRunConclusion>([
  'FAILURE', 'TIMED_OUT', 'CANCELLED', 'ACTION_REQUIRED', 'STARTUP_FAILURE',
]);
const FAILED_STATUS_STATES: ReadonlySet<GhStatusState> = new Set<GhStatusState>(['ERROR', 'FAILURE']);
/** CheckRun statuses short of IN_PROGRESS that still mean the check has not run yet. */
const WAITING_CHECK_RUN_STATUSES: ReadonlySet<GhCheckRunStatus> = new Set<GhCheckRunStatus>([
  'QUEUED', 'PENDING', 'WAITING', 'REQUESTED',
]);
const WAITING_STATUS_STATES: ReadonlySet<GhStatusState> = new Set<GhStatusState>(['PENDING', 'EXPECTED']);

/**
 * Whether a BLOCKED PR's checks are still in flight: `running` when any check
 * run is IN_PROGRESS, `queued` when the only unfinished ones are waiting to
 * start, and undefined when the rollup is absent, nothing is unfinished, or
 * ANY check has failed (a failure is what blocks, whatever else is running).
 *
 * A heuristic, because `gh` carries no `isRequired` on the rollup: a BLOCKED
 * PR whose only unfinished checks are optional reads `running` too, and a
 * required check that GitHub still EXPECTS but that has not reported yet is
 * not in the rollup at all, so it reads `blocked` for one sweep. Both correct
 * themselves on the next resolve.
 */
function checksInFlight(rollup: GhStatusCheckRollupItem[] | undefined): 'queued' | 'running' | undefined {
  if (!rollup || rollup.length === 0) return undefined;
  let running = false;
  let waiting = false;
  for (const item of rollup) {
    if (item.__typename === 'CheckRun') {
      if (item.status === 'COMPLETED') {
        if (item.conclusion !== null && FAILED_CHECK_RUN_CONCLUSIONS.has(item.conclusion)) return undefined;
      } else if (item.status === 'IN_PROGRESS') {
        running = true;
      } else if (WAITING_CHECK_RUN_STATUSES.has(item.status)) {
        waiting = true;
      }
    } else if (item.__typename === 'StatusContext') {
      if (FAILED_STATUS_STATES.has(item.state)) return undefined;
      if (WAITING_STATUS_STATES.has(item.state)) waiting = true;
    }
  }
  if (running) return 'running';
  if (waiting) return 'queued';
  return undefined;
}

/**
 * BLOCKED is deliberately absent: `mapMergeReadiness` folds it through the
 * check rollup before this switch runs, so a case here would be unreachable.
 */
function mapMergeStateStatus(mergeStateStatus: GhMergeStateStatus | undefined): PRMergeReadiness | undefined {
  switch (mergeStateStatus) {
    case 'CLEAN':
    case 'HAS_HOOKS':
    case 'UNSTABLE':
      return 'ready';
    case 'BEHIND':
    case 'DRAFT':
      return 'blocked';
    case 'DIRTY':
      return 'conflicting';
    case 'UNKNOWN':
      return 'unknown';
    default:
      // Absent or unrecognized: fall back to `mergeable`.
      return undefined;
  }
}

function mapMergeable(mergeable: GhMergeable | undefined): PRMergeReadiness {
  return mergeable === 'CONFLICTING' ? 'conflicting' : 'unknown';
}

/** Project a raw gh PR item into the platform-agnostic ResolvedPR shape. */
function toResolvedPR(item: GhPrListItem): ResolvedPR {
  const mergeReadiness = mapMergeReadiness(item);
  return {
    url: item.url,
    number: item.number,
    state: mapState(item),
    baseRefName: item.baseRefName,
    updatedAt: item.updatedAt,
    // Conditional spread, not `mergeReadiness: undefined`: an absent key is what
    // "this tier cannot judge it" looks like to the linker and to exact-shape tests.
    ...(mergeReadiness === undefined ? {} : { mergeReadiness }),
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
  // `gh api commits/<sha>/pulls` returns every PR whose head branch CONTAINS
  // the commit, so ownership is not free here - it is established client-side,
  // by the `mergeCommitOid` check and `dropCandidatesSharingBaseHistory` below.
  // The KNOWN GAP documented on that filter (a kept-undetermined lone survivor)
  // is a narrowing of this claim, not a refutation: it needs an un-fetched base
  // ref, and it degrades to the `branchHint` rule rather than to no check.
  verifiesCommitOwnership: true,

  /**
   * Any host label containing `github`, not the literal `github.com`, so a
   * GitHub Enterprise host such as `github.mycorp.com` keeps resolving.
   *
   * KNOWN GAP: GHE hosted on a name with no `github` in it (`ghe.corp.example`)
   * no longer resolves PRs. Before the ownership gate this connector ran on
   * every remote and would have tried; the failure is now at least diagnosable,
   * because the thrown message names the unmatched remote URL. A per-project
   * list of extra hosts is the follow-up.
   */
  matchesRemote(remoteUrls: readonly string[]): boolean {
    return remoteUrls.some((url) => /(^|\/\/|@)[^/:@]*github[^/:@]*[:/]/i.test(url));
  },

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

  // `options` (branch-policy evaluation) is accepted for contract parity and
  // ignored: GitHub's verdict already carries policy through `mergeStateStatus`
  // and `reviewDecision` on the same call, so there is nothing extra to spend.
  async resolveForBranch(
    repoCwd: string,
    branchName: string,
    baseBranch?: string,
    _options?: PRResolveOptions,
  ): Promise<ResolvedPR | null> {
    return viaGh(async () => {
      const items = await ghImporter.resolvePRByBranch(repoCwd, branchName);
      // Every item already matches head=branchName; the hint also drops fork PRs
      // that share the branch name.
      const best = disambiguate(items, { baseBranch, branchHint: branchName });
      return best ? toResolvedPR(best) : null;
    });
  },

  async resolveByNumber(repoCwd: string, prNumber: number, _options?: PRResolveOptions): Promise<ResolvedPR | null> {
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
