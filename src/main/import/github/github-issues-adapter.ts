import type { ExternalSource, ImportCheckCliResult, ImportFetchInput, ImportFetchResult } from '../../../shared/types';
import type { Importer, DownloadedAttachment } from '../importer';
import { GitHubImporter } from './github-importer';

/**
 * Adapter that wraps GitHubImporter for GitHub Issues,
 * implementing the common Importer interface.
 */
export class GitHubIssuesAdapter implements Importer {
  constructor(private readonly github: GitHubImporter) {}

  async checkCli(): Promise<ImportCheckCliResult> {
    const ghPath = await this.github.detect();
    if (!ghPath) {
      return { available: false, authenticated: false, error: 'gh CLI not found. Install it from https://cli.github.com' };
    }
    const authResult = await this.github.checkAuth();
    if (!authResult.authenticated) {
      return { available: true, authenticated: false, error: authResult.error };
    }
    return { available: true, authenticated: true };
  }

  async fetch(
    input: ImportFetchInput,
    findAlreadyImported: (source: ExternalSource, externalIds: string[]) => Set<string>,
  ): Promise<ImportFetchResult> {
    const { issues: rawIssues, hasNextPage } = await this.github.fetchIssues(
      input.repository,
      input.page,
      input.perPage,
      input.searchQuery,
      input.state,
    );

    const externalIds = rawIssues.map((issue) => String(issue.number));
    const alreadyImportedIds = findAlreadyImported('github_issues', externalIds);
    const issues = this.github.mapToExternalIssues(rawIssues, alreadyImportedIds);

    return { issues, totalCount: issues.length, hasNextPage };
  }

  async downloadImages(markdownBody: string): Promise<{ attachments: DownloadedAttachment[]; skippedCount: number }> {
    return this.github.downloadInlineImages(markdownBody);
  }
}
