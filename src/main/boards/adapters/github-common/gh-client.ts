import which from 'which';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { ExternalIssue } from '../../../../shared/types';
import {
  type DownloadedAttachment,
  downloadFile,
  DOWNLOAD_CONCURRENCY,
  extractInlineImageUrls,
} from '../../shared';

const execFileAsync = promisify(execFile);

/** Raw issue shape from the GitHub REST API. */
interface GitHubIssueRaw {
  number: number;
  title: string;
  body: string | null;
  html_url: string;
  state: string;
  labels: Array<{ name: string }>;
  assignee: { login: string } | null;
  milestone: { title: string; number: number } | null;
  reactions: Record<string, number>;
  created_at: string;
  updated_at: string;
  pull_request?: unknown;
}

/** Raw project item shape from gh project item-list --format json. */
interface GitHubProjectItemRaw {
  id: string;
  title: string;
  labels?: string[];
  assignees?: string[];
  status?: string;
  repository?: string;
  content?: {
    body?: string;
    number?: number;
    repository?: string;
    title?: string;
    type?: string;       // 'Issue' | 'PullRequest'
    url?: string;
    createdAt?: string;
    updatedAt?: string;
  };
}

const COMMAND_TIMEOUT = 15_000;

/**
 * Raw PR shape from `gh pr list --json number,url,state,isDraft,headRefName,baseRefName,updatedAt,isCrossRepository`.
 * `state` is GitHub's uppercase enum: OPEN | CLOSED | MERGED. `isCrossRepository`
 * is true for PRs opened from a fork - the disambiguator filters those out so a
 * fork PR that happens to share a branch name can't be mislinked.
 */
export interface GhPrListItem {
  number: number;
  url: string;
  state: 'OPEN' | 'CLOSED' | 'MERGED';
  isDraft: boolean;
  headRefName: string;
  baseRefName: string;
  updatedAt: string;
  isCrossRepository?: boolean;
  /**
   * The commit the PR landed on its base branch: the merge commit (merge), the
   * squashed commit (squash), or the new base tip (rebase). Used by commit-based
   * resolution to reject a PR whose merge product IS the commit being resolved
   * from - that commit is shared base history, never the task's own work.
   * Populated from the REST `merge_commit_sha` on the commit-pulls path only.
   */
  mergeCommitOid?: string;
}

/** JSON field set requested from `gh pr list` / `gh pr view`. */
const PR_JSON_FIELDS = 'number,url,state,isDraft,headRefName,baseRefName,updatedAt,isCrossRepository';

/**
 * Thrown by resolver paths when the `gh` CLI is missing or unauthenticated, so
 * callers can degrade to the scrollback scraper instead of treating it as a
 * "no PR found" result.
 */
export class GhUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GhUnavailableError';
  }
}

/**
 * Thrown when a gh call fails transiently (network error, GitHub 5xx, rate-limit
 * 403/429, or a timeout) rather than because there is genuinely no PR. Callers
 * must NOT treat this as "not found" or overwrite an existing link - the truth is
 * "couldn't check", so the prior link is preserved.
 */
export class GhTransientError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GhTransientError';
  }
}

/**
 * Classify a failed gh invocation. Inspects message + stderr + node error fields:
 *   - 'unavailable': gh missing / unauthenticated -> degrade to scraper.
 *   - 'transient': network / 5xx / rate-limit / timeout -> preserve, don't report not-found.
 *   - 'not-found': gh ran cleanly but matched nothing (or not a GitHub repo).
 */
function classifyGhError(error: unknown): 'unavailable' | 'transient' | 'not-found' {
  const err = error as { message?: string; stderr?: string; code?: string; killed?: boolean };
  const text = `${err.message ?? ''}\n${err.stderr ?? ''}`;
  // execFile kills on timeout (killed=true / ETIMEDOUT) -> transient.
  if (err.killed || err.code === 'ETIMEDOUT') return 'transient';
  if (/HTTP 401|not logged|auth|login/i.test(text)) return 'unavailable';
  if (/HTTP 4(03|29)|HTTP 5\d\d|rate limit|ECONNRESET|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|timed? ?out|network|temporar/i.test(text)) {
    return 'transient';
  }
  return 'not-found';
}

/** Map a classified gh error to the throw the resolver paths use (null = swallow as not-found). */
function ghErrorToThrow(error: unknown): GhUnavailableError | GhTransientError | null {
  const message = error instanceof Error ? error.message : String(error);
  switch (classifyGhError(error)) {
    case 'unavailable':
      return new GhUnavailableError(`gh CLI not authenticated. Run: gh auth login\n${message}`);
    case 'transient':
      return new GhTransientError(`Temporary GitHub/gh error - try again.\n${message}`);
    default:
      return null;
  }
}

/** Raw PR shape from the REST endpoint `repos/{owner}/{repo}/commits/{sha}/pulls`. */
interface GhCommitPullRaw {
  number: number;
  html_url: string;
  state: string;          // 'open' | 'closed' (REST does not surface 'merged' here)
  draft?: boolean;
  merged_at?: string | null;
  merge_commit_sha?: string | null;
  head?: { ref?: string; repo?: { full_name?: string } | null };
  base?: { ref?: string; repo?: { full_name?: string } | null };
  updated_at?: string;
}

/** Normalize a REST commit-pull object into the camelCase GhPrListItem shape. */
function normalizeCommitPull(raw: GhCommitPullRaw): GhPrListItem {
  const state: GhPrListItem['state'] = raw.merged_at ? 'MERGED' : (raw.state === 'closed' ? 'CLOSED' : 'OPEN');
  // A fork PR has a head repo distinct from the base repo (or a null head repo
  // when the fork was deleted). Same-repo PRs share the full_name.
  const headRepo = raw.head?.repo?.full_name ?? null;
  const baseRepo = raw.base?.repo?.full_name ?? null;
  const isCrossRepository = headRepo == null || (baseRepo != null && headRepo !== baseRepo);
  return {
    number: raw.number,
    url: raw.html_url,
    state,
    isDraft: raw.draft ?? false,
    headRefName: raw.head?.ref ?? '',
    baseRefName: raw.base?.ref ?? '',
    updatedAt: raw.updated_at ?? '',
    isCrossRepository,
    mergeCommitOid: raw.merge_commit_sha ?? undefined,
  };
}

export class GitHubImporter {
  private ghPath: string | null = null;
  private detectPromise: Promise<string | null> | null = null;

  /** Find the gh CLI binary path with caching. */
  async detect(): Promise<string | null> {
    if (this.ghPath) return this.ghPath;
    if (this.detectPromise) return this.detectPromise;

    this.detectPromise = this.performDetection();
    try {
      return await this.detectPromise;
    } finally {
      this.detectPromise = null;
    }
  }

  private async performDetection(): Promise<string | null> {
    try {
      const ghPath = await which('gh');
      this.ghPath = ghPath;
      return ghPath;
    } catch {
      return null;
    }
  }

  /** Check if gh CLI is authenticated. */
  async checkAuth(): Promise<{ authenticated: boolean; error?: string }> {
    const ghPath = await this.detect();
    if (!ghPath) {
      return { authenticated: false, error: 'gh CLI not found. Install it from https://cli.github.com' };
    }
    try {
      await execFileAsync(ghPath, ['auth', 'status'], { timeout: COMMAND_TIMEOUT });
      return { authenticated: true };
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      return { authenticated: false, error: `gh CLI not authenticated. Run: gh auth login\n${message}` };
    }
  }

  /**
   * Resolve open/closed/merged PRs whose head ref matches `branchName`, run from
   * inside the repo/worktree at `cwd` so `gh` auto-detects the owner/repo.
   *
   * Returns the raw list (caller disambiguates). Throws GhUnavailableError when
   * gh is missing/unauthenticated; returns [] when the query runs but finds no PR.
   */
  async resolvePRByBranch(cwd: string, branchName: string): Promise<GhPrListItem[]> {
    const ghPath = await this.detect();
    if (!ghPath) {
      throw new GhUnavailableError('gh CLI not found. Install it from https://cli.github.com');
    }
    try {
      const { stdout } = await execFileAsync(
        ghPath,
        [
          'pr', 'list',
          '--head', branchName,
          '--state', 'all',
          '--json', PR_JSON_FIELDS,
          '--limit', '30',
        ],
        { cwd, timeout: COMMAND_TIMEOUT },
      );
      const parsed = JSON.parse(stdout) as GhPrListItem[];
      return Array.isArray(parsed) ? parsed : [];
    } catch (error: unknown) {
      // Auth/missing -> degrade to scraper; transient (network/5xx/timeout) ->
      // preserve link; anything else is a genuine "no PR / not a gh repo" -> [].
      const toThrow = ghErrorToThrow(error);
      if (toThrow) throw toThrow;
      return [];
    }
  }

  /**
   * Resolve a single PR by its number via `gh pr view`. The exact, branch-independent
   * anchor used to refresh an already-linked PR's state.
   *
   * Throws GhUnavailableError when gh is missing/unauthenticated; returns null when
   * the number no longer resolves (deleted/wrong repo).
   */
  async resolvePRByNumber(cwd: string, prNumber: number): Promise<GhPrListItem | null> {
    const ghPath = await this.detect();
    if (!ghPath) {
      throw new GhUnavailableError('gh CLI not found. Install it from https://cli.github.com');
    }
    try {
      const { stdout } = await execFileAsync(
        ghPath,
        [
          'pr', 'view', String(prNumber),
          '--json', PR_JSON_FIELDS,
        ],
        { cwd, timeout: COMMAND_TIMEOUT },
      );
      return JSON.parse(stdout) as GhPrListItem;
    } catch (error: unknown) {
      const toThrow = ghErrorToThrow(error);
      if (toThrow) throw toThrow;
      return null;
    }
  }

  /**
   * Resolve PRs associated with a commit SHA via the REST endpoint
   * `repos/{owner}/{repo}/commits/{sha}/pulls`. `gh api` fills `{owner}/{repo}` from
   * the remote of the repo at `cwd`, so this works from the main repo even after a
   * task's worktree has been reclaimed - an immutable anchor immune to branch renames.
   *
   * Returns the list normalized to GhPrListItem (caller disambiguates). Throws
   * GhUnavailableError when gh is missing/unauthenticated; returns [] otherwise.
   */
  async resolvePRByCommit(cwd: string, commitSha: string): Promise<GhPrListItem[]> {
    const ghPath = await this.detect();
    if (!ghPath) {
      throw new GhUnavailableError('gh CLI not found. Install it from https://cli.github.com');
    }
    try {
      const { stdout } = await execFileAsync(
        ghPath,
        ['api', `repos/{owner}/{repo}/commits/${commitSha}/pulls`],
        { cwd, timeout: COMMAND_TIMEOUT },
      );
      const parsed = JSON.parse(stdout) as GhCommitPullRaw[];
      return Array.isArray(parsed) ? parsed.map(normalizeCommitPull) : [];
    } catch (error: unknown) {
      const toThrow = ghErrorToThrow(error);
      if (toThrow) throw toThrow;
      return [];
    }
  }

  /** Fetch issues from a GitHub repository using gh api. */
  async fetchIssues(
    repository: string,
    page: number,
    perPage: number,
    searchQuery?: string,
    state?: string,
  ): Promise<{ issues: GitHubIssueRaw[]; hasNextPage: boolean }> {
    const ghPath = await this.detect();
    if (!ghPath) throw new Error('gh CLI not found');

    const issueState = state ?? 'open';

    // Use gh api for proper pagination support
    const queryParams = new URLSearchParams({
      state: issueState,
      page: String(page),
      per_page: String(perPage),
      sort: 'updated',
      direction: 'desc',
    });

    if (searchQuery) {
      // Use the GitHub search API for text queries
      const searchParams = new URLSearchParams({
        q: `repo:${repository} is:issue ${issueState !== 'all' ? `is:${issueState}` : ''} ${searchQuery}`.trim(),
        page: String(page),
        per_page: String(perPage),
      });

      const { stdout } = await execFileAsync(
        ghPath,
        ['api', `search/issues?${searchParams.toString()}`, '--jq', '.items'],
        { timeout: COMMAND_TIMEOUT },
      );

      const issues = JSON.parse(stdout) as GitHubIssueRaw[];
      // Filter out pull requests (GitHub search API includes them)
      const filteredIssues = issues.filter((issue) => !issue.pull_request);
      return {
        issues: filteredIssues,
        hasNextPage: filteredIssues.length >= perPage,
      };
    }

    const { stdout } = await execFileAsync(
      ghPath,
      ['api', `repos/${repository}/issues?${queryParams.toString()}`],
      { timeout: COMMAND_TIMEOUT },
    );

    const issues = JSON.parse(stdout) as GitHubIssueRaw[];
    // GitHub issues API also returns pull requests - filter them out
    const filteredIssues = issues.filter((issue) => !issue.pull_request);
    return {
      issues: filteredIssues,
      hasNextPage: issues.length >= perPage,
    };
  }

  /** Fetch all items from a GitHub Project using gh project item-list. */
  async fetchProjectItems(
    owner: string,
    projectNumber: number,
  ): Promise<{ items: GitHubProjectItemRaw[] }> {
    const ghPath = await this.detect();
    if (!ghPath) throw new Error('gh CLI not found');

    const { stdout } = await execFileAsync(
      ghPath,
      ['project', 'item-list', String(projectNumber), '--owner', owner, '--format', 'json', '--limit', '500'],
      { timeout: 30_000 },
    );

    const parsed = JSON.parse(stdout) as { items: GitHubProjectItemRaw[]; totalCount: number };
    // Filter out pull requests - keep issues and draft issues (drafts have no content)
    const filteredItems = parsed.items.filter(
      (item) => !item.content?.type || item.content.type !== 'PullRequest',
    );
    return { items: filteredItems };
  }

  /** Check if gh CLI has the project scope for GitHub Projects access. */
  async checkProjectScope(): Promise<{ hasScope: boolean; error?: string }> {
    const ghPath = await this.detect();
    if (!ghPath) return { hasScope: false, error: 'gh CLI not found' };
    try {
      // Try listing projects for current user - will fail if no project scope
      await execFileAsync(ghPath, ['project', 'list', '--owner', '@me', '--limit', '1', '--format', 'json'], { timeout: COMMAND_TIMEOUT });
      return { hasScope: true };
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes('scope') || message.includes('permission') || message.includes('401')) {
        return { hasScope: false, error: 'GitHub Projects requires the "project" scope. Run: gh auth refresh -s project' };
      }
      // If it fails for another reason (e.g., no projects), that's fine
      return { hasScope: true };
    }
  }

  /** Map raw GitHub issues to ExternalIssue format, marking already-imported ones. */
  mapToExternalIssues(
    rawIssues: GitHubIssueRaw[],
    alreadyImportedIds: Set<string>,
  ): ExternalIssue[] {
    return rawIssues.map((issue) => {
      const externalId = String(issue.number);
      const body = issue.body ?? '';
      return {
        externalId,
        externalSource: 'github_issues' as const,
        externalUrl: issue.html_url,
        title: issue.title,
        body,
        labels: issue.labels.map((label) => label.name),
        assignee: issue.assignee?.login ?? null,
        state: issue.state,
        createdAt: issue.created_at,
        updatedAt: issue.updated_at,
        alreadyImported: alreadyImportedIds.has(externalId),
        attachmentCount: extractInlineImageUrls(body).length,
      };
    });
  }

  /** Map raw GitHub Project items to ExternalIssue format. */
  mapProjectItemsToExternalIssues(
    items: GitHubProjectItemRaw[],
    alreadyImportedIds: Set<string>,
  ): ExternalIssue[] {
    return items.map((item) => {
      const externalId = item.id;
      const body = item.content?.body ?? '';
      const labels = item.labels ?? [];
      const assignee = item.assignees && item.assignees.length > 0 ? item.assignees[0] : null;
      return {
        externalId,
        externalSource: 'github_projects' as const,
        externalUrl: item.content?.url ?? '',
        title: item.title,
        body,
        labels,
        assignee,
        state: item.status ?? 'unknown',
        createdAt: item.content?.createdAt ?? new Date().toISOString(),
        updatedAt: item.content?.updatedAt ?? new Date().toISOString(),
        alreadyImported: alreadyImportedIds.has(externalId),
        attachmentCount: extractInlineImageUrls(body).length,
      };
    });
  }

  /** Download inline images from a markdown body, respecting size limits and concurrency. */
  async downloadInlineImages(markdownBody: string): Promise<{
    attachments: DownloadedAttachment[];
    skippedCount: number;
  }> {
    const imageUrls = extractInlineImageUrls(markdownBody);
    if (imageUrls.length === 0) {
      return { attachments: [], skippedCount: 0 };
    }

    const attachments: DownloadedAttachment[] = [];
    let skippedCount = 0;

    // Process in batches for concurrency limiting
    for (let batchStart = 0; batchStart < imageUrls.length; batchStart += DOWNLOAD_CONCURRENCY) {
      const batch = imageUrls.slice(batchStart, batchStart + DOWNLOAD_CONCURRENCY);
      const results = await Promise.allSettled(
        batch.map((imageInfo) => downloadFile(imageInfo.url, imageInfo.filename)),
      );

      for (const result of results) {
        if (result.status === 'fulfilled' && result.value) {
          attachments.push(result.value);
        } else {
          skippedCount++;
        }
      }
    }

    return { attachments, skippedCount };
  }

  invalidateCache(): void {
    this.ghPath = null;
    this.detectPromise = null;
  }
}

