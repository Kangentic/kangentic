import which from 'which';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import https from 'node:https';
import http from 'node:http';
import { URL } from 'node:url';
import type { ExternalIssue } from '../../../shared/types';

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

interface DownloadedAttachment {
  filename: string;
  data: string;
  mediaType: string;
  sizeBytes: number;
  sourceUrl: string;
}

const MAX_ATTACHMENT_SIZE = 10 * 1024 * 1024; // 10 MB
const DOWNLOAD_CONCURRENCY = 3;
const COMMAND_TIMEOUT = 15_000;

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

/** Extract image URLs from markdown text. */
export function extractInlineImageUrls(markdown: string): Array<{ url: string; altText: string; filename: string }> {
  const results: Array<{ url: string; altText: string; filename: string }> = [];
  const seen = new Set<string>();

  // Match markdown image syntax: ![alt](url)
  const markdownImagePattern = /!\[([^\]]*)\]\(([^)]+)\)/g;
  let match: RegExpExecArray | null;
  while ((match = markdownImagePattern.exec(markdown)) !== null) {
    const altText = match[1];
    const url = match[2];
    if (url && !seen.has(url) && isHttpUrl(url)) {
      seen.add(url);
      results.push({ url, altText, filename: filenameFromUrl(url, altText) });
    }
  }

  // Match HTML img tags: <img src="url" ...>
  const htmlImagePattern = /<img\s+[^>]*src=["']([^"']+)["'][^>]*>/gi;
  while ((match = htmlImagePattern.exec(markdown)) !== null) {
    const url = match[1];
    if (url && !seen.has(url) && isHttpUrl(url)) {
      seen.add(url);
      results.push({ url, altText: '', filename: filenameFromUrl(url, '') });
    }
  }

  return results;
}

function isHttpUrl(url: string): boolean {
  return url.startsWith('http://') || url.startsWith('https://');
}

function filenameFromUrl(url: string, altText: string): string {
  try {
    const parsed = new URL(url);
    const pathSegments = parsed.pathname.split('/').filter(Boolean);
    const lastSegment = pathSegments[pathSegments.length - 1];
    if (lastSegment && /\.\w{2,5}$/.test(lastSegment)) {
      return decodeURIComponent(lastSegment);
    }
  } catch { /* fallback below */ }

  if (altText && altText.length > 0 && altText.length < 80) {
    const sanitized = altText.replace(/[^a-zA-Z0-9._-]/g, '_');
    return `${sanitized}.png`;
  }

  return `image_${Date.now()}.png`;
}

function mediaTypeFromFilename(filename: string): string {
  const extension = filename.split('.').pop()?.toLowerCase();
  const mimeTypes: Record<string, string> = {
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    gif: 'image/gif',
    webp: 'image/webp',
    svg: 'image/svg+xml',
    bmp: 'image/bmp',
    ico: 'image/x-icon',
    pdf: 'application/pdf',
  };
  return mimeTypes[extension ?? ''] ?? 'application/octet-stream';
}

const MAX_REDIRECTS = 3;

/** Download a file from a URL, returning base64 data. Returns null if too large or failed. */
async function downloadFile(url: string, filename: string, remainingRedirects = MAX_REDIRECTS): Promise<DownloadedAttachment | null> {
  return new Promise((resolve) => {
    const protocol = url.startsWith('https://') ? https : http;
    const request = protocol.get(url, { timeout: 30_000 }, (response) => {
      // Follow redirects with depth limit
      if (response.statusCode && response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
        request.destroy();
        if (remainingRedirects <= 0) {
          resolve(null);
          return;
        }
        downloadFile(response.headers.location, filename, remainingRedirects - 1).then(resolve).catch(() => resolve(null));
        return;
      }

      if (response.statusCode !== 200) {
        request.destroy();
        resolve(null);
        return;
      }

      // Check content-length header first
      const contentLength = parseInt(response.headers['content-length'] ?? '0', 10);
      if (contentLength > MAX_ATTACHMENT_SIZE) {
        request.destroy();
        resolve(null);
        return;
      }

      const chunks: Buffer[] = [];
      let totalSize = 0;
      let aborted = false;

      response.on('data', (chunk: Buffer) => {
        totalSize += chunk.length;
        if (totalSize > MAX_ATTACHMENT_SIZE) {
          aborted = true;
          request.destroy();
          resolve(null);
          return;
        }
        chunks.push(chunk);
      });

      response.on('end', () => {
        if (aborted) return;
        const buffer = Buffer.concat(chunks);
        resolve({
          filename,
          data: buffer.toString('base64'),
          mediaType: mediaTypeFromFilename(filename),
          sizeBytes: buffer.length,
          sourceUrl: url,
        });
      });

      response.on('error', () => {
        if (!aborted) resolve(null);
      });
    });

    request.on('error', () => resolve(null));
    request.on('timeout', () => {
      request.destroy();
      resolve(null);
    });
  });
}
