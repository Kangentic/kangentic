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
      // task's own PR is never dropped here.) This backstops the linker's
      // commits-ahead-of-base guard, which misfires when the task's base branch is
      // wrong or unknown.
      const candidates = items.filter((item) => item.mergeCommitOid !== commitSha);
      // The commit can still belong to several PRs (shared/squashed commits); the
      // branch hint ties it back to this task and ambiguous matches return null.
      const best = disambiguate(candidates, { branchHint });
      return best ? toResolvedPR(best) : null;
    });
  },
};
