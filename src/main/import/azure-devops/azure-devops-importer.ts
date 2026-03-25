import which from 'which';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { ExternalIssue } from '../../../shared/types';
import { extractInlineImageUrls } from '../github/github-importer';

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
  url: string;
}

/** Cache key for paginated results. */
interface QueryCacheEntry {
  items: AzureDevOpsWorkItemRaw[];
  timestamp: number;
}

const COMMAND_TIMEOUT = 30_000;
const QUERY_CACHE_TTL = 60_000; // 1 minute

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

  /** Map raw Azure DevOps work items to ExternalIssue format. */
  mapToExternalIssues(
    rawItems: AzureDevOpsWorkItemRaw[],
    organization: string,
    project: string,
    alreadyImportedIds: Set<string>,
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
      const body = convertHtmlToMarkdown(htmlDescription);

      // Tags only (work item type is a separate field)
      const tags = fields['System.Tags'] ?? '';
      const labels = tags ? tags.split(';').map((tag) => tag.trim()).filter(Boolean) : [];

      // AssignedTo can be a string or an object depending on API version
      const rawAssignee = fields['System.AssignedTo'];
      const assignee = resolveAssignee(rawAssignee);

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
        attachmentCount: extractInlineImageUrls(body).length,
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
  }
}

/** Resolve AssignedTo field which can be a string or an object with displayName. */
function resolveAssignee(value: string | { displayName: string; uniqueName: string } | undefined | null): string | null {
  if (!value) return null;
  if (typeof value === 'string') return value;
  if (typeof value === 'object' && 'displayName' in value) return value.displayName;
  return null;
}

/** Build a WIQL query string with optional state, search, and iteration filters. */
function buildWiqlQuery(project: string, state?: string, searchQuery?: string, iterationPath?: string): string {
  const conditions: string[] = [
    `[System.TeamProject] = '${escapeWiqlString(project)}'`,
  ];

  if (iterationPath) {
    // UNDER matches the iteration and all child iterations
    conditions.push(`[System.IterationPath] UNDER '${escapeWiqlString(iterationPath)}'`);
  }

  if (state === 'open') {
    conditions.push(`[System.State] NOT IN ('Closed', 'Done', 'Removed', 'Resolved')`);
  } else if (state === 'closed') {
    conditions.push(`[System.State] IN ('Closed', 'Done', 'Removed', 'Resolved')`);
  }

  if (searchQuery && searchQuery.trim()) {
    conditions.push(`[System.Title] CONTAINS '${escapeWiqlString(searchQuery.trim())}'`);
  }

  const whereClause = conditions.join(' AND ');

  return [
    'SELECT [System.Id], [System.Title], [System.Description], [System.State],',
    '  [System.Tags], [System.AssignedTo], [System.CreatedDate],',
    '  [System.ChangedDate], [System.WorkItemType],',
    '  [Microsoft.VSTS.Common.Priority],',
    '  [Microsoft.VSTS.TCM.ReproSteps],',
    '  [Microsoft.VSTS.TCM.SystemInfo],',
    '  [Microsoft.VSTS.Common.AcceptanceCriteria]',
    'FROM WorkItems',
    `WHERE ${whereClause}`,
    'ORDER BY [System.ChangedDate] DESC',
  ].join(' ');
}

/** Escape single quotes in WIQL string literals. */
function escapeWiqlString(value: string): string {
  return value.replace(/'/g, "''");
}

/** Convert HTML (from Azure DevOps rich text) to markdown. */
export function convertHtmlToMarkdown(html: string): string {
  if (!html) return '';

  let result = html;

  // Handle line breaks and horizontal rules
  result = result.replace(/<br\s*\/?>/gi, '\n');
  result = result.replace(/<hr\s*\/?>/gi, '\n\n---\n\n');

  // Handle headings (h1 through h6)
  for (let level = 1; level <= 6; level++) {
    const prefix = '#'.repeat(level);
    const pattern = new RegExp(`<h${level}[^>]*>([\\s\\S]*?)<\\/h${level}>`, 'gi');
    result = result.replace(pattern, (_, content) => `${prefix} ${stripTags(content).trim()}\n\n`);
  }

  // Handle code blocks (before inline code to avoid conflicts)
  result = result.replace(/<pre[^>]*><code[^>]*>([\s\S]*?)<\/code><\/pre>/gi, (_, content) => `\n\`\`\`\n${decodeEntities(content)}\n\`\`\`\n`);
  result = result.replace(/<pre[^>]*>([\s\S]*?)<\/pre>/gi, (_, content) => `\n\`\`\`\n${decodeEntities(stripTags(content))}\n\`\`\`\n`);

  // Handle inline code
  result = result.replace(/<code[^>]*>([\s\S]*?)<\/code>/gi, (_, content) => `\`${decodeEntities(content)}\``);

  // Handle bold and italic
  result = result.replace(/<(?:strong|b)[^>]*>([\s\S]*?)<\/(?:strong|b)>/gi, '**$1**');
  result = result.replace(/<(?:em|i)[^>]*>([\s\S]*?)<\/(?:em|i)>/gi, '*$1*');

  // Handle links
  result = result.replace(/<a\s+[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi, '[$2]($1)');

  // Handle images
  result = result.replace(/<img\s+[^>]*src=["']([^"']+)["'][^>]*alt=["']([^"']*?)["'][^>]*\/?>/gi, '![$2]($1)');
  result = result.replace(/<img\s+[^>]*src=["']([^"']+)["'][^>]*\/?>/gi, '![]($1)');

  // Handle unordered lists
  result = result.replace(/<ul[^>]*>([\s\S]*?)<\/ul>/gi, (_, content) => {
    return content.replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, (_fullMatch: string, itemContent: string) => `- ${stripTags(itemContent).trim()}\n`);
  });

  // Handle ordered lists
  result = result.replace(/<ol[^>]*>([\s\S]*?)<\/ol>/gi, (_, content) => {
    let counter = 0;
    return content.replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, (_fullMatch: string, itemContent: string) => {
      counter++;
      return `${counter}. ${stripTags(itemContent).trim()}\n`;
    });
  });

  // Handle paragraphs
  result = result.replace(/<p[^>]*>([\s\S]*?)<\/p>/gi, '$1\n\n');

  // Handle divs (treat as block elements)
  result = result.replace(/<div[^>]*>([\s\S]*?)<\/div>/gi, '$1\n');

  // Strip remaining HTML tags
  result = stripTags(result);

  // Decode HTML entities
  result = decodeEntities(result);

  // Clean up excessive whitespace
  result = result.replace(/\n{3,}/g, '\n\n');
  result = result.trim();

  return result;
}

/** Strip all HTML tags from a string. */
function stripTags(html: string): string {
  return html.replace(/<[^>]+>/g, '');
}

/** Decode common HTML entities. */
function decodeEntities(text: string): string {
  return text
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(parseInt(code, 10)));
}
