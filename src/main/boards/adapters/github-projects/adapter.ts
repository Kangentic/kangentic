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
import { parseGitHubProjectsUrl, buildGitHubProjectsLabel } from './url-parser';
import { RefusalError } from '../../../../shared/refusal';

registerSourceUrlParser('github_projects', { parse: parseGitHubProjectsUrl, buildLabel: buildGitHubProjectsLabel });

/** Board adapter for GitHub Projects (v2). Wraps the shared `gh` CLI client. */
export class GitHubProjectsAdapter implements BoardAdapter {
  readonly id: ExternalSource = 'github_projects';
  readonly displayName = 'GitHub Projects';
  readonly icon = 'kanban-square';
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
    const scopeResult = await this.github.checkProjectScope();
    if (!scopeResult.hasScope) {
      return { cliOk: true, authOk: false, message: scopeResult.error };
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
    const [owner, numberString] = input.repository.split('/');
    const projectNumber = parseInt(numberString, 10);
    if (!owner || isNaN(projectNumber)) {
      throw new RefusalError(`Invalid project reference: ${input.repository}. Expected format: owner/number`);
    }

    const { items: rawItems } = await this.github.fetchProjectItems(owner, projectNumber);

    const externalIds = rawItems.map((item) => item.id);
    const alreadyImportedIds = findAlreadyImported('github_projects', externalIds);
    const issues = this.github.mapProjectItemsToExternalIssues(rawItems, alreadyImportedIds);

    return { issues, totalCount: issues.length, hasNextPage: false };
  }

  async downloadImages(markdownBody: string): Promise<{ attachments: DownloadedAttachment[]; skippedCount: number }> {
    return this.github.downloadInlineImages(markdownBody);
  }
}
