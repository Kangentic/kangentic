import type { ExternalSource, ImportCheckCliResult, ImportFetchInput, ImportFetchResult } from '../../../shared/types';
import type { Importer, DownloadedAttachment } from '../importer';
import { GitHubImporter } from '../github/github-importer';
import { AzureDevOpsImporter } from './azure-devops-importer';

/**
 * Adapter that wraps AzureDevOpsImporter,
 * implementing the common Importer interface.
 *
 * Uses GitHubImporter.downloadInlineImages for markdown image downloading
 * since the logic is source-agnostic (extracts image URLs from markdown).
 */
export class AzureDevOpsAdapter implements Importer {
  constructor(
    private readonly azure: AzureDevOpsImporter,
    private readonly imageDownloader: GitHubImporter,
  ) {}

  async checkCli(): Promise<ImportCheckCliResult> {
    const available = await this.azure.detect();
    if (!available) {
      return { available: false, authenticated: false, error: 'Azure CLI not found. Install it from https://aka.ms/azure-cli' };
    }
    const authResult = await this.azure.checkAuth();
    if (!authResult.authenticated) {
      return { available: true, authenticated: false, error: authResult.error };
    }
    const extensionResult = await this.azure.checkDevOpsExtension();
    if (!extensionResult.installed) {
      return { available: true, authenticated: false, error: extensionResult.error };
    }
    return { available: true, authenticated: true };
  }

  async fetch(
    input: ImportFetchInput,
    findAlreadyImported: (source: ExternalSource, externalIds: string[]) => Set<string>,
  ): Promise<ImportFetchResult> {
    // Repository format: "org/project" or "org/project::iterationPath"
    const [orgProject, iterationPath] = input.repository.split('::');
    const [organization, project] = orgProject.split('/');
    if (!organization || !project) {
      throw new Error(`Invalid Azure DevOps reference: ${input.repository}. Expected format: org/project`);
    }

    const { items: rawItems, hasNextPage, totalCount } = await this.azure.fetchWorkItems(
      organization, project, input.searchQuery, input.state, iterationPath,
    );

    const externalIds = rawItems.map((item) => String(item.id));
    const alreadyImportedIds = findAlreadyImported('azure_devops', externalIds);
    const issues = this.azure.mapToExternalIssues(rawItems, organization, project, alreadyImportedIds);

    return { issues, totalCount, hasNextPage };
  }

  async downloadImages(markdownBody: string): Promise<{ attachments: DownloadedAttachment[]; skippedCount: number }> {
    return this.imageDownloader.downloadInlineImages(markdownBody);
  }
}
