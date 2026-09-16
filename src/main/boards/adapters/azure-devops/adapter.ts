import type {
  ExternalSource,
  ImportCheckCliResult,
  ImportExecuteInput,
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
import { parseAzureDevOpsUrl, buildAzureDevOpsLabel, isAzureDevOpsAuthedDownloadUrl } from './url-parser';

registerSourceUrlParser('azure_devops', { parse: parseAzureDevOpsUrl, buildLabel: buildAzureDevOpsLabel });

/**
 * Board adapter for Azure DevOps work items.
 *
 * Downloads inline images with bearer token auth for Azure DevOps URLs
 * (comment screenshots are hosted on the org's own host and require
 * authentication). Adds authenticated file attachment downloading for Azure
 * DevOps AttachedFile relations. Both download paths gate the token on
 * `isAzureDevOpsAuthedDownloadUrl` so it never reaches a third-party host.
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
      organization, project, input.searchQuery, input.state, iterationPath, input.since,
    );

    const workItemIds = rawItems.map((item) => item.id);
    const externalIds = workItemIds.map(String);
    const alreadyImportedIds = findAlreadyImported('azure_devops', externalIds);

    // Comments are deferred to import time (hydrateForImport): fetching them here
    // spawned one `az rest` per work item, the dominant cost of rendering the list.
    // Only the batched, cheap relations fetch runs at list time - it powers the
    // attachment badge and the file-attachment download at import.
    const relationsMap = await this.azure.fetchWorkItemsWithRelations(organization, project, workItemIds);

    const issues = this.azure.mapToExternalIssues(
      rawItems, organization, project, alreadyImportedIds, undefined, relationsMap,
    );

    return { issues, totalCount, hasNextPage };
  }

  /**
   * Fetch work item comments for the items being imported and fold them into each
   * body, matching the pre-defer behavior for the imported backlog item. Called by
   * BACKLOG_IMPORT_EXECUTE only, so the per-item comment cost is paid just for the
   * selected items.
   */
  async hydrateForImport(
    repository: string,
    issues: ImportExecuteInput['issues'],
  ): Promise<ImportExecuteInput['issues']> {
    const [orgProject] = repository.split('::');
    const [organization, project] = orgProject.split('/');
    if (!organization || !project) return issues;

    const numericIds = issues
      .map((issue) => Number(issue.externalId))
      .filter((id) => Number.isFinite(id));
    if (numericIds.length === 0) return issues;

    const sections = await this.azure.fetchCommentSectionsForItems(organization, project, numericIds);
    return issues.map((issue) => {
      const section = sections.get(Number(issue.externalId));
      if (!section) return issue;
      return { ...issue, body: issue.body ? `${issue.body}\n\n${section}` : section };
    });
  }

  /**
   * List every current work item id, for the reconcile's auto-prune sweep. An
   * empty result means the project genuinely has no work items, so a malformed
   * repository reference THROWS rather than returning an empty list: the caller
   * prunes against whatever comes back, and returning `[]` for "I could not parse
   * this" would tell it the remote is empty and wipe the source's whole cache.
   */
  async listExternalIds(input: { source: ExternalSource; repository: string }): Promise<string[]> {
    const [orgProject, iterationPath] = input.repository.split('::');
    const [organization, project] = orgProject.split('/');
    if (!organization || !project) {
      throw new Error(`Malformed Azure DevOps repository reference: ${input.repository}`);
    }
    const ids = await this.azure.fetchWorkItemIds(organization, project, iterationPath);
    // Enforce the contract here as well as at the CLI parse: an id that is not a
    // real number stringifies to something no cached row carries, so it would drop
    // a live item out of the prune keep-list and delete it.
    return ids.filter((id) => typeof id === 'number' && Number.isFinite(id)).map(String);
  }

  async downloadImages(markdownBody: string): Promise<{ attachments: DownloadedAttachment[]; skippedCount: number }> {
    const imageUrls = extractInlineImageUrls(markdownBody);
    if (imageUrls.length === 0) {
      return { attachments: [], skippedCount: 0 };
    }

    const needsAuth = imageUrls.some((image) => isAzureDevOpsAuthedDownloadUrl(image.url));
    const authHeaders = needsAuth
      ? { Authorization: `Bearer ${await this.azure.getAccessToken()}` }
      : undefined;

    const attachments: DownloadedAttachment[] = [];
    let skippedCount = 0;

    for (let batchStart = 0; batchStart < imageUrls.length; batchStart += DOWNLOAD_CONCURRENCY) {
      const batch = imageUrls.slice(batchStart, batchStart + DOWNLOAD_CONCURRENCY);
      const results = await Promise.allSettled(
        batch.map((imageInfo) => {
          // Only attach the bearer token when the URL's host is an Azure DevOps
          // host - image URLs come from user-authored work item bodies, so
          // sending it to an external host would leak credentials.
          const headers = isAzureDevOpsAuthedDownloadUrl(imageInfo.url) ? authHeaders : undefined;
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

    const needsAuth = attachments.some((attachment) => isAzureDevOpsAuthedDownloadUrl(attachment.url));
    const authHeaders = needsAuth
      ? { Authorization: `Bearer ${await this.azure.getAccessToken()}` }
      : undefined;

    const downloadedAttachments: DownloadedAttachment[] = [];
    let skippedCount = 0;

    for (let batchStart = 0; batchStart < attachments.length; batchStart += DOWNLOAD_CONCURRENCY) {
      const batch = attachments.slice(batchStart, batchStart + DOWNLOAD_CONCURRENCY);
      const results = await Promise.allSettled(
        batch.map((attachment) => {
          // Same host gate as the inline images. Relation URLs come back from the
          // Azure REST API rather than from work item HTML, so this is a backstop
          // rather than the primary defense, but it fails closed either way.
          const headers = isAzureDevOpsAuthedDownloadUrl(attachment.url) ? authHeaders : undefined;
          return downloadFile(attachment.url, attachment.filename, headers ? { headers } : undefined);
        }),
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
