import type { ExternalSource, ImportCheckCliResult, ImportFetchInput, ImportFetchResult } from '../../../shared/types';
import type { Importer, DownloadedAttachment } from '../importer';
import { GitHubImporter } from './github-importer';

/**
 * Adapter that wraps GitHubImporter for GitHub Projects,
 * implementing the common Importer interface.
 */
export class GitHubProjectsAdapter implements Importer {
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
    // GitHub Projects requires the project scope
    const scopeResult = await this.github.checkProjectScope();
    if (!scopeResult.hasScope) {
      return { available: true, authenticated: false, error: scopeResult.error };
    }
    return { available: true, authenticated: true };
  }

  async fetch(
    input: ImportFetchInput,
    findAlreadyImported: (source: ExternalSource, externalIds: string[]) => Set<string>,
  ): Promise<ImportFetchResult> {
    const [owner, numberString] = input.repository.split('/');
    const projectNumber = parseInt(numberString, 10);
    if (!owner || isNaN(projectNumber)) {
      throw new Error(`Invalid project reference: ${input.repository}. Expected format: owner/number`);
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
