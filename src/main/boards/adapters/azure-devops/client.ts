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

// --- Pull requests ---------------------------------------------------------
// The PR resolvers live here, in the board importer, for the same reason the
// GitHub ones live in `github-common/gh-client.ts`: `az` detection and error
// classification are shared with the import path rather than duplicated, and
// `src/main/pr/adapters/azure-devops/` deep-imports them.

/** Azure's own PR states, before normalization to the app-wide `PRState`. */
export type AzurePrStatus = 'active' | 'completed' | 'abandoned';

/**
 * A normalized Azure DevOps pull request, shaped to mirror `GhPrListItem` so
 * the connector's disambiguation logic reads identically for both providers.
 */
export interface AzurePrItem {
  number: number;
  state: AzurePrStatus;
  isDraft: boolean;
  /** BARE branch name: Azure returns `refs/heads/x`, and the prefix is stripped here, once. */
  headRefName: string;
  baseRefName: string;
  /**
   * `closedDate ?? creationDate`, because Azure exposes no `updatedAt` on ANY
   * tier. This is not a bug to "fix" back to `creationDate`: disambiguation
   * scores state first, so the timestamp only breaks ties WITHIN a state
   * bucket - where `closedDate` is the right recency key for completed and
   * abandoned PRs, and is null (so `creationDate` applies) for active ones.
   */
  updatedAt: string;
  /**
   * `forkSource != null`. Present on the branch and number tiers only: the
   * `pullrequestquery` payload carries no `forkSource` field at all, so this
   * stays undefined there and those candidates pass the falsy fork filter
   * exactly as GitHub's own optional `isCrossRepository` does.
   */
  isCrossRepository?: boolean;
}

/** The raw projection each resolver's `--query` produces. */
interface AzurePrRaw {
  id?: number;
  status?: string;
  draft?: boolean;
  src?: string;
  tgt?: string;
  created?: string;
  closed?: string | null;
  fork?: unknown;
}

/** `az` is missing, unauthenticated, or lacks the azure-devops extension. */
export class AzUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AzUnavailableError';
  }
}

/** Network / Azure 5xx / rate-limit / timeout - preserve the link, do not report not-found. */
export class AzTransientError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AzTransientError';
  }
}

/**
 * Classify a failed `az` invocation, mirroring `classifyGhError`:
 *   - 'unavailable': az missing / unauthenticated / extension absent -> degrade.
 *   - 'transient':   network / 5xx / rate-limit / timeout -> preserve, retry later.
 *   - 'not-found':   az ran and the thing simply is not there.
 *
 * TF401180 (no such PR) and TF401019 (no such repo, or no permission on it)
 * both fall through to 'not-found' deliberately. A repo the org does not have
 * is indistinguishable from "not our repo", and classifying it 'unavailable'
 * would permanently suppress the confident-not-found clear for that project.
 *
 * ORDERING HAZARD: TF401019's text embeds "you do not have permissions", so the
 * auth patterns below must stay specific and must never gain a bare
 * `permission` alternative, or a missing repo reads as an auth failure.
 */
function classifyAzError(error: unknown): 'unavailable' | 'transient' | 'not-found' {
  // THIS MODULE's own failure to read az's answer, not a failure az reported:
  // empty or non-JSON stdout throws SyntaxError out of `JSON.parse`, and a
  // projected field that is not the string this code assumes throws TypeError
  // out of `stripRefsHeads`. Such an error carries neither `stderr` nor `code`,
  // so every pattern below misses it and the not-found default would report
  // that the PR simply is not there. That is a CLEAN MISS from an owning,
  // capable connector, which is exactly what makes `pr-linking.ts` CLEAR the
  // task's PR link - and `resolveFailed` cannot catch it, because the throw is
  // absorbed here and never escapes the ladder. An answer we could not read is
  // "could not check", so it degrades instead. Kept ahead of every pattern
  // below: the message is our own text, so matching it against az's vocabulary
  // is meaningless.
  if (error instanceof SyntaxError || error instanceof TypeError) return 'unavailable';
  const failure = error as { message?: string; stderr?: string; code?: string; killed?: boolean };
  const text = `${failure.message ?? ''}\n${failure.stderr ?? ''}`;
  // execFile kills on timeout (killed=true / ETIMEDOUT) -> transient.
  if (failure.killed || failure.code === 'ETIMEDOUT') return 'transient';
  if (failure.code === 'ENOENT' || /is not recognized as an internal or external command|command not found/i.test(text)) {
    return 'unavailable';
  }
  if (/az extension add|azure-devops.*extension|extension.*azure-devops|is misspelled or not recognized/i.test(text)) {
    return 'unavailable';
  }
  if (/az login|AADSTS\d+|refresh token|HTTP 401|Unauthorized|TF400813|VS30063|no subscription/i.test(text)) {
    return 'unavailable';
  }
  if (/HTTP 4(03|29)|HTTP 5\d\d|ECONNRESET|ENOTFOUND|EAI_AGAIN|timed? ?out|network|temporar|ServiceUnavailable/i.test(text)) {
    return 'transient';
  }
  return 'not-found';
}

/** Map a classified az failure to the throw the resolvers use (null = swallow as not-found). */
function azErrorToThrow(error: unknown): AzUnavailableError | AzTransientError | null {
  const message = error instanceof Error ? error.message : String(error);
  // See the head of classifyAzError. This degrades exactly like an unavailable
  // CLI, but the remedy is not `az login`, so the message must not say so.
  if (error instanceof SyntaxError || error instanceof TypeError) {
    return new AzUnavailableError(`Could not read the Azure DevOps CLI response for this PR lookup.\n${message}`);
  }
  switch (classifyAzError(error)) {
    case 'unavailable':
      return new AzUnavailableError(`Azure CLI unavailable for PR lookup. Check: az login, az extension add --name azure-devops\n${message}`);
    case 'transient':
      return new AzTransientError(`Temporary Azure DevOps error - try again.\n${message}`);
    default:
      return null;
  }
}

/** `refs/heads/feature/x` -> `feature/x`. Any other ref namespace is left intact so an oddity stays visible. */
function stripRefsHeads(ref: string): string {
  return ref.startsWith('refs/heads/') ? ref.slice('refs/heads/'.length) : ref;
}

function normalizeAzurePr(raw: AzurePrRaw): AzurePrItem | null {
  if (typeof raw.id !== 'number' || !raw.status) return null;
  return {
    number: raw.id,
    state: raw.status as AzurePrStatus,
    isDraft: raw.draft === true,
    headRefName: stripRefsHeads(raw.src ?? ''),
    baseRefName: stripRefsHeads(raw.tgt ?? ''),
    updatedAt: raw.closed ?? raw.created ?? '',
    ...(raw.fork === undefined ? {} : { isCrossRepository: raw.fork != null }),
  };
}

/** Shared field projection; `az` applies --query in-process, so stdout stays small. */
const AZ_PR_FIELDS =
  '{id:pullRequestId,status:status,draft:isDraft,src:sourceRefName,tgt:targetRefName,created:creationDate,closed:closedDate,fork:forkSource}';
/** The commit tier's payload has no forkSource, so its projection omits it. */
const AZ_PR_FIELDS_NO_FORK =
  '{id:pullRequestId,status:status,draft:isDraft,src:sourceRefName,tgt:targetRefName,created:creationDate,closed:closedDate}';

/** Azure PR payloads embed full descriptions; the projection shrinks stdout, this is the backstop. */
const PR_MAX_BUFFER = 10 * 1024 * 1024;

function azureOrgUrl(organization: string): string {
  return `https://dev.azure.com/${encodeURIComponent(organization)}`;
}

/** Parse a projected PR array, tolerating the `null` / non-array shapes a --query can yield. */
function parseAzurePrList(stdout: string): AzurePrItem[] {
  const parsed = JSON.parse(stdout) as AzurePrRaw[] | null;
  if (!Array.isArray(parsed)) return [];
  return parsed.map(normalizeAzurePr).filter((item): item is AzurePrItem => item !== null);
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

  /** Throw the platform-neutral "cannot run at all" error when `az` is absent. */
  private async requireAz(): Promise<void> {
    if (await this.detect()) return;
    throw new AzUnavailableError('Azure CLI not found. Install it from https://aka.ms/azure-cli');
  }

  /**
   * Pull requests whose SOURCE branch is `sourceBranch`, in any state.
   *
   * Passes an explicit organization / project / repository plus `--detect
   * false` rather than letting `az` sniff them from the cwd, so this works from
   * ANY working directory - including after a task's worktree has been
   * reclaimed, which is the normal shape once a task reaches Done.
   */
  async resolvePRByBranch(
    organization: string,
    project: string,
    repository: string,
    sourceBranch: string,
  ): Promise<AzurePrItem[]> {
    // `az` parses a leading dash as an option, so an option-shaped branch name
    // would rewrite the command. Same class of guard as `isShaContainedInRef`'s
    // option-shaped ref rejection in worktree-head.ts.
    if (!sourceBranch || sourceBranch.startsWith('-')) return [];
    await this.requireAz();
    try {
      const { stdout } = await execAz(
        [
          'repos', 'pr', 'list',
          '--organization', azureOrgUrl(organization),
          '--project', project,
          '--repository', repository,
          '--source-branch', sourceBranch,
          '--status', 'all',
          '--detect', 'false',
          '--output', 'json',
          '--query', `[].${AZ_PR_FIELDS}`,
        ],
        { timeout: COMMAND_TIMEOUT, maxBuffer: PR_MAX_BUFFER },
      );
      return parseAzurePrList(stdout);
    } catch (error) {
      const toThrow = azErrorToThrow(error);
      if (toThrow) throw toThrow;
      return [];
    }
  }

  /**
   * One pull request by its id, which is unique across the organization (so no
   * project or repository is needed). A missing id exits 1 with TF401180, which
   * classifies as not-found and returns null rather than throwing.
   */
  async resolvePRByNumber(organization: string, prNumber: number): Promise<AzurePrItem | null> {
    await this.requireAz();
    try {
      const { stdout } = await execAz(
        [
          'repos', 'pr', 'show',
          '--organization', azureOrgUrl(organization),
          '--id', String(prNumber),
          '--detect', 'false',
          '--output', 'json',
          '--query', AZ_PR_FIELDS,
        ],
        { timeout: COMMAND_TIMEOUT, maxBuffer: PR_MAX_BUFFER },
      );
      const parsed = JSON.parse(stdout) as AzurePrRaw | null;
      return parsed ? normalizeAzurePr(parsed) : null;
    } catch (error) {
      const toThrow = azErrorToThrow(error);
      if (toThrow) throw toThrow;
      return null;
    }
  }

  /**
   * Pull requests associated with a commit, via the `pullrequestquery` API.
   * There is no `az repos pr` verb for this, so it goes through `az rest`, and
   * this is the only POST in this client.
   *
   * IMPORTANT: Azure records a PR's commit associations at COMPLETION, so this
   * matches completed PRs only - active and abandoned ones are invisible to it
   * (verified against 8 real PRs). It also matches only a PR's own source
   * commits, never its merge product nor its base tip, which is why the GitHub
   * connector's two base-history filters have no Azure counterpart.
   */
  async resolvePRByCommit(
    organization: string,
    project: string,
    repository: string,
    commitSha: string,
  ): Promise<AzurePrItem[]> {
    // Also the injection guard for the JSON body below.
    if (!/^[0-9a-f]{7,40}$/i.test(commitSha)) return [];
    await this.requireAz();
    // Unlike the work-item calls above, the query string is NOT passed via
    // --url-parameters: that workaround exists because cmd.exe treats `&` as a
    // command separator, and this URL has a single parameter. Any `&` inside a
    // project or repository name is encoded to %26 by encodeURIComponent.
    const url =
      `${azureOrgUrl(organization)}/${encodeURIComponent(project)}` +
      `/_apis/git/repositories/${encodeURIComponent(repository)}/pullrequestquery?api-version=7.0`;
    const body = JSON.stringify({ queries: [{ type: 'commit', items: [commitSha] }] });
    try {
      const { stdout } = await execAz(
        [
          'rest', '--method', 'post',
          '--resource', AZURE_DEVOPS_RESOURCE_ID,
          '--url', url,
          '--headers', 'Content-Type=application/json',
          '--body', body,
          '--output', 'json',
          // `results` is keyed by the sha itself, so the wildcard flattens the
          // dynamic key away. A clean miss is `results: [{}]`, which projects to [].
          '--query', `results[0].*[][].${AZ_PR_FIELDS_NO_FORK}`,
        ],
        { timeout: COMMAND_TIMEOUT, maxBuffer: PR_MAX_BUFFER },
      );
      return parseAzurePrList(stdout);
    } catch (error) {
      const toThrow = azErrorToThrow(error);
      if (toThrow) throw toThrow;
      return [];
    }
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

