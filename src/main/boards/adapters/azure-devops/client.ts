import which from 'which';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { ExternalIssue } from '../../../../shared/types';
import { extractInlineImageUrls } from '../../shared';
import { convertHtmlToMarkdown } from './html-to-markdown';
import { buildWiqlQuery } from './wiql';

const execFileAsync = promisify(execFile);

/** Raw work item shape from az boards query. */
interface AzureDevOpsWorkItemRaw {
  id: number;
  fields?: {
    'System.Title'?: string;
    'System.Description'?: string;
    'System.State'?: string;
    'System.Tags'?: string;
    'System.AssignedTo'?: string | { displayName: string; uniqueName: string };
    'System.CreatedDate'?: string;
    'System.ChangedDate'?: string;
    'System.WorkItemType'?: string;
    'Microsoft.VSTS.Common.Priority'?: number;
    'Microsoft.VSTS.TCM.ReproSteps'?: string;
    'Microsoft.VSTS.TCM.SystemInfo'?: string;
    'Microsoft.VSTS.Common.AcceptanceCriteria'?: string;
  };
  relations?: Array<{
    rel: string;
    url: string;
    attributes: { name?: string; resourceSize?: number; comment?: string };
  }>;
  url: string;
}

/** Comment shape from the Azure DevOps work item comments API. */
export interface AzureDevOpsComment {
  id: number;
  text: string;
  createdBy: { displayName: string };
  createdDate: string;
}

/** File attachment extracted from a work item relation. */
export interface AzureDevOpsFileAttachment {
  url: string;
  filename: string;
  sizeBytes: number;
}

/** Cache key for paginated results. */
interface QueryCacheEntry {
  items: AzureDevOpsWorkItemRaw[];
  timestamp: number;
}

const COMMAND_TIMEOUT = 30_000;
const QUERY_CACHE_TTL = 60_000; // 1 minute
const COMMENT_FETCH_CONCURRENCY = 5;
const AZURE_DEVOPS_RESOURCE_ID = '499b84ac-1321-427f-aa17-267ca6975798';
const TOKEN_REFRESH_BUFFER = 5 * 60_000; // Refresh token 5 minutes before expiry

// On Windows, `az` is a .cmd batch script. execFile cannot spawn .cmd files
// directly (EINVAL). We spawn `cmd.exe /c az ...` instead, which properly
// handles .cmd scripts and double-quotes arguments to protect special chars
// (parentheses, pipes) from cmd.exe interpretation.
const IS_WINDOWS = process.platform === 'win32';

/** Run an az CLI command, handling Windows .cmd wrapper transparently. */
function execAz(
  args: string[],
  options: { timeout?: number; maxBuffer?: number },
): Promise<{ stdout: string; stderr: string }> {
  const fullOptions = { ...options, encoding: 'utf-8' as const };
  if (IS_WINDOWS) {
    return execFileAsync('cmd.exe', ['/c', 'az', ...args], fullOptions);
  }
  return execFileAsync('az', args, fullOptions);
}

export class AzureDevOpsImporter {
  private azDetected = false;
  private detectPromise: Promise<boolean> | null = null;
  private queryCache = new Map<string, QueryCacheEntry>();
  private tokenCache: { token: string; expiresAt: number } | null = null;

  /** Check if the az CLI binary is available. */
  async detect(): Promise<boolean> {
    if (this.azDetected) return true;
    if (this.detectPromise) return this.detectPromise;

    this.detectPromise = this.performDetection();
    try {
      return await this.detectPromise;
    } finally {
      this.detectPromise = null;
    }
  }

  private async performDetection(): Promise<boolean> {
    try {
      await which('az');
      this.azDetected = true;
      return true;
    } catch {
      return false;
    }
  }

  /** Check if az CLI is authenticated. */
  async checkAuth(): Promise<{ authenticated: boolean; error?: string }> {
    const available = await this.detect();
    if (!available) {
      return { authenticated: false, error: 'Azure CLI not found. Install it from https://aka.ms/azure-cli' };
    }
    try {
      await execAz(['account', 'show'], { timeout: COMMAND_TIMEOUT });
      return { authenticated: true };
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      return { authenticated: false, error: `Azure CLI not authenticated. Run: az login\n${message}` };
    }
  }

  /** Check if the azure-devops CLI extension is installed. */
  async checkDevOpsExtension(): Promise<{ installed: boolean; error?: string }> {
    const available = await this.detect();
    if (!available) return { installed: false, error: 'Azure CLI not found' };
    try {
      await execAz(['extension', 'show', '--name', 'azure-devops'], { timeout: COMMAND_TIMEOUT });
      return { installed: true };
    } catch {
      return {
        installed: false,
        error: 'Azure DevOps CLI extension required. Run: az extension add --name azure-devops',
      };
    }
  }

  /** Fetch all work items from an Azure DevOps project using WIQL. */
  async fetchWorkItems(
    organization: string,
    project: string,
    searchQuery?: string,
    state?: string,
    iterationPath?: string,
  ): Promise<{ items: AzureDevOpsWorkItemRaw[]; hasNextPage: boolean; totalCount: number }> {
    const available = await this.detect();
    if (!available) throw new Error('Azure CLI not found');

    // Check cache to avoid re-fetching the full dataset on every page
    const cacheKey = `${organization}/${project}:${state ?? ''}:${searchQuery ?? ''}:${iterationPath ?? ''}`;
    const cached = this.queryCache.get(cacheKey);
    const now = Date.now();

    let allItems: AzureDevOpsWorkItemRaw[];

    if (cached && (now - cached.timestamp) < QUERY_CACHE_TTL) {
      allItems = cached.items;
    } else {
      const wiql = buildWiqlQuery(project, state, searchQuery, iterationPath);
      const organizationUrl = `https://dev.azure.com/${organization}`;

      const { stdout } = await execAz(
        [
          'boards', 'query',
          '--wiql', wiql,
          '--organization', organizationUrl,
          '--project', project,
          '--output', 'json',
        ],
        { timeout: COMMAND_TIMEOUT, maxBuffer: 50 * 1024 * 1024 },
      );

      const parsed = JSON.parse(stdout) as AzureDevOpsWorkItemRaw[];

      // az boards query returns full work item data, but guard against
      // API changes where only IDs might be returned (fields missing)
      if (parsed.length > 0 && !parsed[0].fields) {
        allItems = await this.batchFetchWorkItems(organizationUrl, parsed.map((item) => item.id));
      } else {
        allItems = parsed;
      }

      // Evict stale entries and cap cache size
      for (const [key, entry] of this.queryCache) {
        if (now - entry.timestamp >= QUERY_CACHE_TTL) {
          this.queryCache.delete(key);
        }
      }
      if (this.queryCache.size >= 10) {
        const oldestKey = this.queryCache.keys().next().value;
        if (oldestKey) this.queryCache.delete(oldestKey);
      }
      this.queryCache.set(cacheKey, { items: allItems, timestamp: now });
    }

    // Return all items at once - no pagination needed since WIQL fetches everything
    return { items: allItems, hasNextPage: false, totalCount: allItems.length };
  }

  /**
   * Batch fetch full work item data by IDs.
   * Fallback for when WIQL returns only IDs without field data.
   */
  private async batchFetchWorkItems(
    organizationUrl: string,
    workItemIds: number[],
  ): Promise<AzureDevOpsWorkItemRaw[]> {
    const allItems: AzureDevOpsWorkItemRaw[] = [];
    const batchSize = 200; // Azure DevOps API limit

    for (let batchStart = 0; batchStart < workItemIds.length; batchStart += batchSize) {
      const batchIds = workItemIds.slice(batchStart, batchStart + batchSize);
      const { stdout } = await execAz(
        [
          'boards', 'work-item', 'show',
          '--id', batchIds.join(','),
          '--organization', organizationUrl,
          '--output', 'json',
        ],
        { timeout: COMMAND_TIMEOUT, maxBuffer: 50 * 1024 * 1024 },
      );

      const parsed = JSON.parse(stdout);
      // Single item returns an object, multiple returns an array
      const items = Array.isArray(parsed) ? parsed : [parsed];
      allItems.push(...(items as AzureDevOpsWorkItemRaw[]));
    }

    return allItems;
  }

  /**
   * Get an Azure DevOps access token for authenticated API calls.
   * Caches the token and refreshes it before expiry.
   */
  async getAccessToken(): Promise<string> {
    if (this.tokenCache && Date.now() < this.tokenCache.expiresAt - TOKEN_REFRESH_BUFFER) {
      return this.tokenCache.token;
    }

    const { stdout } = await execAz(
      ['account', 'get-access-token', '--resource', AZURE_DEVOPS_RESOURCE_ID, '--output', 'json'],
      { timeout: COMMAND_TIMEOUT },
    );

    const parsed = JSON.parse(stdout) as { accessToken: string; expiresOn: string };
    this.tokenCache = {
      token: parsed.accessToken,
      expiresAt: new Date(parsed.expiresOn).getTime(),
    };

    return this.tokenCache.token;
  }

  /**
   * Batch fetch work items with relations expanded.
   * Uses az rest to call the Work Items API with $expand=relations.
   *
   * Query parameters are passed via --url-parameters (not in the URL) because
   * cmd.exe on Windows interprets & as a command separator, breaking URLs
   * with multiple query params.
   */
  async fetchWorkItemsWithRelations(
    organization: string,
    project: string,
    workItemIds: number[],
  ): Promise<Map<number, AzureDevOpsWorkItemRaw['relations']>> {
    const relationsMap = new Map<number, AzureDevOpsWorkItemRaw['relations']>();
    if (workItemIds.length === 0) return relationsMap;

    const batchSize = 200;
    const organizationUrl = `https://dev.azure.com/${organization}`;

    for (let batchStart = 0; batchStart < workItemIds.length; batchStart += batchSize) {
      const batchIds = workItemIds.slice(batchStart, batchStart + batchSize);

      const { stdout } = await execAz(
        [
          'rest', '--method', 'get',
          '--url', `${organizationUrl}/${project}/_apis/wit/workitems`,
          '--resource', AZURE_DEVOPS_RESOURCE_ID,
          '--url-parameters', `ids=${batchIds.join(',')}`, '$expand=relations', 'api-version=7.0',
        ],
        { timeout: COMMAND_TIMEOUT, maxBuffer: 50 * 1024 * 1024 },
      );

      const parsed = JSON.parse(stdout) as { value: AzureDevOpsWorkItemRaw[] };
      for (const item of parsed.value) {
        if (item.relations) {
          relationsMap.set(item.id, item.relations);
        }
      }
    }

    return relationsMap;
  }

  /**
   * Fetch comments for multiple work items.
   * Uses az rest to call the Work Item Comments API, concurrency-limited.
   */
  async fetchCommentsForItems(
    organization: string,
    project: string,
    workItemIds: number[],
  ): Promise<Map<number, AzureDevOpsComment[]>> {
    const commentsMap = new Map<number, AzureDevOpsComment[]>();
    if (workItemIds.length === 0) return commentsMap;

    const organizationUrl = `https://dev.azure.com/${organization}`;

    for (let batchStart = 0; batchStart < workItemIds.length; batchStart += COMMENT_FETCH_CONCURRENCY) {
      const batch = workItemIds.slice(batchStart, batchStart + COMMENT_FETCH_CONCURRENCY);
      const results = await Promise.allSettled(
        batch.map(async (workItemId) => {
          const { stdout } = await execAz(
            [
              'rest', '--method', 'get',
              '--url', `${organizationUrl}/${project}/_apis/wit/workitems/${workItemId}/comments`,
              '--resource', AZURE_DEVOPS_RESOURCE_ID,
              '--url-parameters', 'api-version=7.0-preview.4',
            ],
            { timeout: COMMAND_TIMEOUT },
          );

          const parsed = JSON.parse(stdout) as { comments: AzureDevOpsComment[] };
          return { workItemId, comments: parsed.comments ?? [] };
        }),
      );

      for (const result of results) {
        if (result.status === 'fulfilled' && result.value.comments.length > 0) {
          commentsMap.set(result.value.workItemId, result.value.comments);
        }
      }
    }

    return commentsMap;
  }

  /** Extract file attachments from work item relations. */
  extractFileAttachments(
    relations: AzureDevOpsWorkItemRaw['relations'],
  ): AzureDevOpsFileAttachment[] {
    if (!relations) return [];

    return relations
      .filter((relation) => relation.rel === 'AttachedFile')
      .map((relation) => {
        // Azure DevOps attachment URLs require api-version to return file content
        const attachmentUrl = relation.url.includes('?')
          ? `${relation.url}&api-version=7.0`
          : `${relation.url}?api-version=7.0`;
        return {
          url: attachmentUrl,
          filename: relation.attributes.name ?? `attachment_${Date.now()}`,
          sizeBytes: relation.attributes.resourceSize ?? 0,
        };
      });
  }

  /** Map raw Azure DevOps work items to ExternalIssue format. */
  mapToExternalIssues(
    rawItems: AzureDevOpsWorkItemRaw[],
    organization: string,
    project: string,
    alreadyImportedIds: Set<string>,
    commentsMap?: Map<number, AzureDevOpsComment[]>,
    relationsMap?: Map<number, AzureDevOpsWorkItemRaw['relations']>,
  ): ExternalIssue[] {
    return rawItems.map((item) => {
      const externalId = String(item.id);
      const fields = item.fields ?? {};
      // Azure DevOps stores content in different HTML fields by work item type:
      // Bugs use ReproSteps + SystemInfo, User Stories use Description + AcceptanceCriteria, etc.
      // Combine all non-empty content fields with section labels.
      const contentFields: Array<{ label: string; value: string | undefined }> = [
        { label: 'Description', value: fields['System.Description'] },
        { label: 'Repro Steps', value: fields['Microsoft.VSTS.TCM.ReproSteps'] },
        { label: 'Acceptance Criteria', value: fields['Microsoft.VSTS.Common.AcceptanceCriteria'] },
        { label: 'System Info', value: fields['Microsoft.VSTS.TCM.SystemInfo'] },
      ];
      const populatedFields = contentFields.filter((field) => field.value);
      let htmlDescription = '';
      if (populatedFields.length === 1) {
        // Single field - no need for section headers
        htmlDescription = populatedFields[0].value ?? '';
      } else {
        // Multiple fields - add section headers for clarity
        htmlDescription = populatedFields
          .map((field) => `<h3>${field.label}</h3>\n${field.value}`)
          .join('\n');
      }
      let body = convertHtmlToMarkdown(htmlDescription);

      // Append work item comments to the body
      const comments = commentsMap?.get(item.id);
      if (comments && comments.length > 0) {
        const commentSection = formatCommentsSection(comments);
        body = body ? `${body}\n\n${commentSection}` : commentSection;
      }

      // Tags only (work item type is a separate field)
      const tags = fields['System.Tags'] ?? '';
      const labels = tags ? tags.split(';').map((tag) => tag.trim()).filter(Boolean) : [];

      // AssignedTo can be a string or an object depending on API version
      const rawAssignee = fields['System.AssignedTo'];
      const assignee = resolveAssignee(rawAssignee);

      // Extract file attachments from relations
      const relations = relationsMap?.get(item.id);
      const fileAttachments = this.extractFileAttachments(relations);

      return {
        externalId,
        externalSource: 'azure_devops' as const,
        externalUrl: `https://dev.azure.com/${organization}/${project}/_workitems/edit/${item.id}`,
        title: fields['System.Title'] ?? `Work Item ${item.id}`,
        body,
        labels,
        assignee,
        state: fields['System.State'] ?? 'Unknown',
        workItemType: fields['System.WorkItemType'],
        createdAt: fields['System.CreatedDate'] ?? new Date().toISOString(),
        updatedAt: fields['System.ChangedDate'] ?? new Date().toISOString(),
        alreadyImported: alreadyImportedIds.has(externalId),
        attachmentCount: extractInlineImageUrls(body).length + fileAttachments.length,
        fileAttachments: fileAttachments.length > 0 ? fileAttachments : undefined,
      };
    });
  }

  /** Clear the query cache (called when filters change or on refresh). */
  clearQueryCache(): void {
    this.queryCache.clear();
  }

  invalidateCache(): void {
    this.azDetected = false;
    this.detectPromise = null;
    this.queryCache.clear();
    this.tokenCache = null;
  }
}

/** Resolve AssignedTo field which can be a string or an object with displayName. */
function resolveAssignee(value: string | { displayName: string; uniqueName: string } | undefined | null): string | null {
  if (!value) return null;
  if (typeof value === 'string') return value;
  if (typeof value === 'object' && 'displayName' in value) return value.displayName;
  return null;
}

/** Format work item comments as a markdown section. */
function formatCommentsSection(comments: AzureDevOpsComment[]): string {
  const lines = ['## Comments', ''];

  for (const comment of comments) {
    const author = comment.createdBy?.displayName ?? 'Unknown';
    const date = formatCommentDate(comment.createdDate);
    lines.push(`### ${author} - ${date}`);
    lines.push('');
    lines.push(convertHtmlToMarkdown(comment.text));
    lines.push('');
  }

  return lines.join('\n').trim();
}

/** Format an ISO date string for comment display. */
function formatCommentDate(isoDate: string): string {
  try {
    const date = new Date(isoDate);
    return date.toLocaleDateString('en-US', {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    return isoDate;
  }
}

