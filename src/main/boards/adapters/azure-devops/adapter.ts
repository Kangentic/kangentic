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
  type FileAttachmentRef,
  type PrerequisiteResult,
  prerequisiteToCheckCli,
  registerSourceUrlParser,
  downloadFile,
  DOWNLOAD_CONCURRENCY,
  extractInlineImageUrls,
} from '../../shared';
import { AzureDevOpsImporter } from './client';
import { parseAzureDevOpsUrl, buildAzureDevOpsLabel } from './url-parser';

registerSourceUrlParser('azure_devops', { parse: parseAzureDevOpsUrl, buildLabel: buildAzureDevOpsLabel });

const AZURE_DEVOPS_HOST = 'dev.azure.com';

/**
 * Board adapter for Azure DevOps work items.
 *
 * Downloads inline images with bearer token auth for Azure DevOps URLs
 * (comment screenshots are hosted on dev.azure.com and require authentication).
 * Adds authenticated file attachment downloading for Azure DevOps AttachedFile relations.
 */
export class AzureDevOpsAdapter implements BoardAdapter {
  readonly id: ExternalSource = 'azure_devops';
  readonly displayName = 'Azure DevOps';
  readonly icon = 'cloud';
  readonly status: AdapterStatus = 'stable';

  constructor(private readonly azure: AzureDevOpsImporter = new AzureDevOpsImporter()) {}

  async checkPrerequisites(): Promise<PrerequisiteResult> {
    const available = await this.azure.detect();
    if (!available) {
      return { cliOk: false, authOk: false, message: 'Azure CLI not found. Install it from https://aka.ms/azure-cli' };
    }
    const authResult = await this.azure.checkAuth();
    if (!authResult.authenticated) {
      return { cliOk: true, authOk: false, message: authResult.error };
    }
    const extensionResult = await this.azure.checkDevOpsExtension();
    if (!extensionResult.installed) {
      return { cliOk: true, authOk: false, message: extensionResult.error };
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
    // Repository format: "org/project" or "org/project::iterationPath"
    const [orgProject, iterationPath] = input.repository.split('::');
    const [organization, project] = orgProject.split('/');
    if (!organization || !project) {
      throw new Error(`Invalid Azure DevOps reference: ${input.repository}. Expected format: org/project`);
    }

    const { items: rawItems, hasNextPage, totalCount } = await this.azure.fetchWorkItems(
      organization, project, input.searchQuery, input.state, iterationPath,
    );

    const workItemIds = rawItems.map((item) => item.id);
    const externalIds = workItemIds.map(String);
    const alreadyImportedIds = findAlreadyImported('azure_devops', externalIds);

    // Fetch comments and relations in parallel (both are independent per-item REST calls).
    const [commentsMap, relationsMap] = await Promise.all([
      this.azure.fetchCommentsForItems(organization, project, workItemIds),
      this.azure.fetchWorkItemsWithRelations(organization, project, workItemIds),
    ]);

    const issues = this.azure.mapToExternalIssues(
      rawItems, organization, project, alreadyImportedIds, commentsMap, relationsMap,
    );

    return { issues, totalCount, hasNextPage };
  }

  async downloadImages(markdownBody: string): Promise<{ attachments: DownloadedAttachment[]; skippedCount: number }> {
    const imageUrls = extractInlineImageUrls(markdownBody);
    if (imageUrls.length === 0) {
      return { attachments: [], skippedCount: 0 };
    }

    const needsAuth = imageUrls.some((image) => image.url.includes(AZURE_DEVOPS_HOST));
    const authHeaders = needsAuth
      ? { Authorization: `Bearer ${await this.azure.getAccessToken()}` }
      : undefined;

    const attachments: DownloadedAttachment[] = [];
    let skippedCount = 0;

    for (let batchStart = 0; batchStart < imageUrls.length; batchStart += DOWNLOAD_CONCURRENCY) {
      const batch = imageUrls.slice(batchStart, batchStart + DOWNLOAD_CONCURRENCY);
      const results = await Promise.allSettled(
        batch.map((imageInfo) => {
          // Only attach the bearer token to dev.azure.com URLs - sending it
          // to external image hosts would leak credentials.
          const headers = imageInfo.url.includes(AZURE_DEVOPS_HOST) ? authHeaders : undefined;
          return downloadFile(imageInfo.url, imageInfo.filename, headers ? { headers } : undefined);
        }),
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

  async downloadFileAttachments(
    attachments: Array<FileAttachmentRef>,
  ): Promise<{ attachments: DownloadedAttachment[]; skippedCount: number }> {
    if (attachments.length === 0) {
      return { attachments: [], skippedCount: 0 };
    }

    const token = await this.azure.getAccessToken();
    const authHeaders = { Authorization: `Bearer ${token}` };

    const downloadedAttachments: DownloadedAttachment[] = [];
    let skippedCount = 0;

    for (let batchStart = 0; batchStart < attachments.length; batchStart += DOWNLOAD_CONCURRENCY) {
      const batch = attachments.slice(batchStart, batchStart + DOWNLOAD_CONCURRENCY);
      const results = await Promise.allSettled(
        batch.map((attachment) => downloadFile(attachment.url, attachment.filename, { headers: authHeaders })),
      );

      for (const result of results) {
        if (result.status === 'fulfilled' && result.value) {
          downloadedAttachments.push(result.value);
        } else {
          skippedCount++;
        }
      }
    }

    return { attachments: downloadedAttachments, skippedCount };
  }
}
