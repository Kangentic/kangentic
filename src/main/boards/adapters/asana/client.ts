import { URL } from 'node:url';
import {
  ASANA_API_BASE,
  ASANA_TASK_OPT_FIELDS,
  DEFAULT_PAGE_SIZE,
  isAsanaAuthedDownloadHost,
} from './constants';
import {
  clearAsanaCredential,
  loadAsanaCredential,
  saveAsanaCredential,
  type AsanaCredential,
} from './credential-store';
import { refreshAsanaToken, shouldRefresh } from './oauth';
import type { AsanaTaskRaw } from './mapper';
import {
  downloadFile,
  extractInlineImageUrls,
  mediaTypeFromFilename,
  withBackoff,
  type DownloadedAttachment,
} from '../../shared';

interface AsanaListResponse<T> {
  data: T[];
  next_page: { offset: string; path: string; uri: string } | null;
}

interface AsanaSingleResponse<T> {
  data: T;
}

interface AsanaUserRaw {
  gid: string;
  name?: string;
  email?: string;
}

interface AsanaProjectRaw {
  gid: string;
  name?: string;
  workspace?: { gid: string; name?: string };
}

interface AsanaAttachmentRaw {
  gid: string;
  name?: string;
  size?: number;
  download_url?: string | null;
  resource_subtype?: string;
}

export interface ListTasksOptions {
  searchQuery?: string;
  state?: 'open' | 'closed' | 'all';
  page: number;
  perPage?: number;
}

export interface ListTasksResult {
  tasks: AsanaTaskRaw[];
  hasNextPage: boolean;
}

/** HTTP request timeout in milliseconds. Matches the downloadFile helper. */
const REQUEST_TIMEOUT_MS = 30_000;

export class AsanaError extends Error {
  constructor(message: string, public readonly status: number) {
    super(message);
    this.name = 'AsanaError';
  }
}

/**
 * Return a human-friendly error message for known Asana HTTP failure modes,
 * or null if the raw `Asana ... failed (status): ...` format is fine.
 * Catches the common cases that appear during first-run setup so users get
 * an actionable instruction instead of inline JSON.
 */
function friendlyAsanaError(status: number, rawBody: string): string | null {
  if (status !== 403) return null;
  try {
    const parsed = JSON.parse(rawBody) as { errors?: Array<{ message?: string }> };
    const message = parsed.errors?.[0]?.message ?? '';
    const scopeMatch = /scopes? must be present[^:]*:\s*(.+)/i.exec(message);
    if (scopeMatch) {
      const missing = scopeMatch[1].trim().replace(/\.$/, '');
      return (
        `Your Asana app is missing the required scope(s): ${missing}. ` +
        `Open your Asana app settings at app.asana.com/0/my-apps, enable the scope, ` +
        `then click "Change Asana app" in Kangentic to re-authorize.`
      );
    }
  } catch {
    /* non-JSON body, fall through to raw message */
  }
  return null;
}

export class AsanaClient {
  private credential: AsanaCredential | null = null;
  private readonly cursorCache = new Map<string, Map<number, string>>();
  private readonly projectCache = new Map<string, AsanaProjectRaw>();
  /**
   * Holds the in-flight refresh promise. Concurrent requests that hit
   * `shouldRefresh` within the same microtask (e.g. parallel workers from
   * `fetchAttachmentsForTasks`) await the same refresh instead of kicking
   * off duplicate token-endpoint calls.
   */
  private refreshInFlight: Promise<void> | null = null;

  constructor(credential?: AsanaCredential | null) {
    this.credential = credential ?? null;
  }

  hasCredential(): boolean {
    return this.ensureCredential(false) !== null;
  }

  getCredentialEmail(): string | null {
    return this.ensureCredential(false)?.userEmail ?? null;
  }

  private ensureCredential(required: boolean): AsanaCredential | null {
    if (!this.credential) {
      this.credential = loadAsanaCredential();
    }
    if (!this.credential && required) {
      throw new Error('Not connected to Asana. Click "Connect Asana" to sign in.');
    }
    return this.credential;
  }

  async getMe(): Promise<AsanaUserRaw> {
    const response = await this.request<AsanaSingleResponse<AsanaUserRaw>>('GET', '/users/me');
    return response.data;
  }

  /**
   * Fetch project metadata (name + workspace reference). Cached for the
   * lifetime of the client instance since both the label resolver and the
   * workspace-scoped search endpoint read the same object. Throws on HTTP
   * failures so callers can decide whether to degrade - `resolveLabel` in
   * the adapter swallows errors, `resolveWorkspaceGid` propagates them.
   */
  async getProject(projectGid: string): Promise<AsanaProjectRaw | null> {
    const cached = this.projectCache.get(projectGid);
    if (cached) return cached;
    const response = await this.request<AsanaSingleResponse<AsanaProjectRaw>>(
      'GET',
      `/projects/${projectGid}?opt_fields=name,workspace.gid,workspace.name`,
    );
    const project = response.data ?? null;
    if (project) this.projectCache.set(projectGid, project);
    return project;
  }

  async listTasks(projectGid: string, options: ListTasksOptions): Promise<ListTasksResult> {
    const perPage = options.perPage ?? DEFAULT_PAGE_SIZE;
    const searchQuery = options.searchQuery?.trim() ?? '';
    const stateFilter = options.state ?? 'all';
    const cacheKey = `${projectGid}|${searchQuery}|${stateFilter}`;

    // Page 1 always starts fresh. Clear any stale cursors for this key.
    if (options.page === 1) {
      this.cursorCache.set(cacheKey, new Map());
    }

    const offset = this.cursorCache.get(cacheKey)?.get(options.page);
    if (options.page > 1 && offset === undefined) {
      throw new Error(
        `Asana pagination skipped: caller asked for page ${options.page} without first fetching page ${options.page - 1}.`,
      );
    }

    const path = searchQuery
      ? await this.buildSearchPath(projectGid)
      : `/projects/${projectGid}/tasks`;

    const params = new URLSearchParams();
    params.set('opt_fields', ASANA_TASK_OPT_FIELDS);
    params.set('limit', String(perPage));
    if (offset) params.set('offset', offset);

    if (searchQuery) {
      params.set('text', searchQuery);
      params.set('projects.any', projectGid);
      if (stateFilter === 'open') params.set('completed', 'false');
      if (stateFilter === 'closed') params.set('completed', 'true');
    } else if (stateFilter === 'open') {
      // `completed_since=now` returns only tasks not completed as of "now",
      // which is Asana's way of expressing "still-open" on this endpoint.
      params.set('completed_since', 'now');
    }

    const response = await this.request<AsanaListResponse<AsanaTaskRaw>>(
      'GET',
      `${path}?${params.toString()}`,
    );

    let tasks = response.data ?? [];
    // `/projects/{gid}/tasks` doesn't accept a completed filter, so for
    // state=closed we fetched everything and filter client-side here.
    if (!searchQuery && stateFilter === 'closed') {
      tasks = tasks.filter((task) => task.completed === true);
    }

    const nextOffset = response.next_page?.offset ?? null;
    if (nextOffset) {
      let cursors = this.cursorCache.get(cacheKey);
      if (!cursors) {
        cursors = new Map();
        this.cursorCache.set(cacheKey, cursors);
      }
      cursors.set(options.page + 1, nextOffset);
    }

    return { tasks, hasNextPage: nextOffset !== null };
  }

  async listAttachments(taskGid: string): Promise<AsanaAttachmentRaw[]> {
    const params = new URLSearchParams();
    params.set('opt_fields', 'name,size,download_url,resource_subtype');
    const response = await this.request<AsanaListResponse<AsanaAttachmentRaw>>(
      'GET',
      `/tasks/${taskGid}/attachments?${params.toString()}`,
    );
    return response.data ?? [];
  }

  /**
   * List attachments for every task that reports `num_attachments > 0`, in
   * parallel with a small concurrency cap so a single page fetch doesn't
   * fan out unbounded requests. Tasks that fail to list degrade to an empty
   * array rather than failing the whole fetch.
   */
  async fetchAttachmentsForTasks(tasks: AsanaTaskRaw[]): Promise<Map<string, AsanaAttachmentRaw[]>> {
    const queue = tasks.filter((task) => (task.num_attachments ?? 0) > 0);
    const result = new Map<string, AsanaAttachmentRaw[]>();
    const concurrency = Math.min(5, queue.length);
    const index = { value: 0 };

    const worker = async (): Promise<void> => {
      while (true) {
        const currentIndex = index.value++;
        if (currentIndex >= queue.length) return;
        const task = queue[currentIndex];
        try {
          const attachments = await this.listAttachments(task.gid);
          result.set(task.gid, attachments);
        } catch (error) {
          console.warn(`[asana/client] failed to list attachments for task ${task.gid}:`, error);
          result.set(task.gid, []);
        }
      }
    };

    await Promise.all(Array.from({ length: concurrency }, () => worker()));
    return result;
  }

  async downloadInlineImages(
    markdownBody: string,
  ): Promise<{ attachments: DownloadedAttachment[]; skippedCount: number }> {
    const refs = extractInlineImageUrls(markdownBody);
    if (refs.length === 0) return { attachments: [], skippedCount: 0 };

    const credential = this.ensureCredential(false);
    const attachments: DownloadedAttachment[] = [];
    let skippedCount = 0;

    for (const ref of refs) {
      let host = '';
      try {
        host = new URL(ref.url).host;
      } catch {
        skippedCount++;
        continue;
      }
      const headers = credential && isAsanaAuthedDownloadHost(host)
        ? { Authorization: `Bearer ${credential.accessToken}` }
        : undefined;
      const result = await downloadFile(ref.url, ref.filename, headers ? { headers } : undefined);
      if (result) {
        attachments.push(result);
      } else {
        skippedCount++;
      }
    }

    return { attachments, skippedCount };
  }

  async downloadFileAttachments(
    attachments: Array<{ url: string; filename: string; sizeBytes: number }>,
  ): Promise<{ attachments: DownloadedAttachment[]; skippedCount: number }> {
    const results: DownloadedAttachment[] = [];
    let skippedCount = 0;
    for (const attachment of attachments) {
      const downloaded = await downloadFile(attachment.url, attachment.filename);
      if (downloaded) {
        results.push({ ...downloaded, mediaType: mediaTypeFromFilename(attachment.filename) });
      } else {
        skippedCount++;
      }
    }
    return { attachments: results, skippedCount };
  }

  private async buildSearchPath(projectGid: string): Promise<string> {
    const workspaceGid = await this.resolveWorkspaceGid(projectGid);
    return `/workspaces/${workspaceGid}/tasks/search`;
  }

  private async resolveWorkspaceGid(projectGid: string): Promise<string> {
    const project = await this.getProject(projectGid);
    const workspaceGid = project?.workspace?.gid;
    if (!workspaceGid) {
      throw new Error(`Unable to resolve Asana workspace for project ${projectGid}.`);
    }
    return workspaceGid;
  }

  private async request<T>(method: 'GET' | 'POST', pathAndQuery: string, body?: unknown): Promise<T> {
    return withBackoff(async () => this.requestOnce<T>(method, pathAndQuery, body), {
      maxAttempts: 3,
      shouldRetry: (error) => {
        if (!(error instanceof AsanaError)) return false;
        const { status } = error;
        return status === 429 || (status >= 500 && status < 600);
      },
    });
  }

  private async requestOnce<T>(method: 'GET' | 'POST', pathAndQuery: string, body?: unknown): Promise<T> {
    const credential = this.ensureCredential(true)!;

    if (shouldRefresh(credential)) {
      await this.refresh(credential);
    }

    const response = await this.fetchWithAuth(method, pathAndQuery, body);
    if (response.status !== 401) {
      return this.parseResponse<T>(response, method, pathAndQuery);
    }

    // Reactive refresh: access token may have been invalidated early.
    await this.refresh(this.credential!);
    const retry = await this.fetchWithAuth(method, pathAndQuery, body);
    return this.parseResponse<T>(retry, method, pathAndQuery);
  }

  private async fetchWithAuth(method: 'GET' | 'POST', pathAndQuery: string, body?: unknown): Promise<Response> {
    const credential = this.credential!;
    const headers: Record<string, string> = {
      Authorization: `Bearer ${credential.accessToken}`,
      accept: 'application/json',
    };
    let serialisedBody: BodyInit | undefined;
    if (body !== undefined) {
      headers['content-type'] = 'application/json';
      serialisedBody = JSON.stringify(body);
    }
    return fetch(`${ASANA_API_BASE}${pathAndQuery}`, {
      method,
      headers,
      body: serialisedBody,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  }

  private async parseResponse<T>(response: Response, method: string, pathAndQuery: string): Promise<T> {
    if (!response.ok) {
      const text = await response.text().catch(() => '');
      const friendly = friendlyAsanaError(response.status, text);
      const message = friendly ?? `Asana ${method} ${pathAndQuery} failed (${response.status}): ${text.slice(0, 500)}`;
      throw new AsanaError(message, response.status);
    }
    return (await response.json()) as T;
  }

  private async refresh(credential: AsanaCredential): Promise<void> {
    if (this.refreshInFlight) return this.refreshInFlight;

    this.refreshInFlight = (async () => {
      try {
        const refreshed = await refreshAsanaToken(credential.refreshToken);
        const next: AsanaCredential = { ...credential, ...refreshed };
        saveAsanaCredential(next);
        this.credential = next;
      } catch (error) {
        // Refresh failure means the user needs to re-authenticate. Clear the
        // stale credential so the next request surfaces the "not connected"
        // error instead of looping on a dead token.
        clearAsanaCredential();
        this.credential = null;
        throw error;
      } finally {
        this.refreshInFlight = null;
      }
    })();

    return this.refreshInFlight;
  }
}
