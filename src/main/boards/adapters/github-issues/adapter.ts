import type {
  ExternalSource,
  ImportCheckCliResult,
  ImportFetchInput,
  ImportFetchResult,
} from '../../../../shared/types';
import {
  type BoardAdapter,
  type AdapterStatus,
  type DownloadedAttachment,
  type PrerequisiteResult,
  prerequisiteToCheckCli,
  registerSourceUrlParser,
} from '../../shared';
import { GitHubImporter } from '../github-common';
import { parseGitHubIssuesUrl, buildGitHubLabel } from './url-parser';

registerSourceUrlParser('github_issues', { parse: parseGitHubIssuesUrl, buildLabel: buildGitHubLabel });

/** Board adapter for GitHub Issues. Wraps the shared `gh` CLI client. */
export class GitHubIssuesAdapter implements BoardAdapter {
  readonly id: ExternalSource = 'github_issues';
  readonly displayName = 'GitHub Issues';
  readonly icon = 'github';
  readonly status: AdapterStatus = 'stable';

  constructor(private readonly github: GitHubImporter = new GitHubImporter()) {}

  async checkPrerequisites(): Promise<PrerequisiteResult> {
    const ghPath = await this.github.detect();
    if (!ghPath) {
      return { cliOk: false, authOk: false, message: 'gh CLI not found. Install it from https://cli.github.com' };
    }
    const authResult = await this.github.checkAuth();
    if (!authResult.authenticated) {
      return { cliOk: true, authOk: false, message: authResult.error };
    }
    return { cliOk: true, authOk: true };
  }

  async checkCli(): Promise<ImportCheckCliResult> {
    return prerequisiteToCheckCli(await this.checkPrerequisites());
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
      input.since,
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
