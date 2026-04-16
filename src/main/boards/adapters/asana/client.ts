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
import type { AsanaTaskRaw } from './mapper';
import {
  downloadFile,
  extractInlineImageUrls,
  mediaTypeFromFilename,
  withBackoff,
  type DownloadedAttachment,
  type FileAttachmentRef,
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

export class AsanaClient {
  private credential: AsanaCredential | null = null;
  private readonly cursorCache = new Map<string, Map<number, string>>();
  private readonly projectCache = new Map<string, AsanaProjectRaw>();

  constructor(credential?: AsanaCredential | null) {
    this.credential = credential ?? null;
  }

  hasCredential(): boolean {
    return this.ensureCredential(false) !== null;
  }

  getCredentialEmail(): string | null {
    return this.ensureCredential(false)?.userEmail ?? null;
  }

  /**
   * Validate a Personal Access Token by hitting `/users/me` with it. Returns
   * the user object on success, throws on any failure. Does NOT touch the
   * stored credential - callers decide whether to persist after success.
   */
  async validateToken(token: string): Promise<AsanaUserRaw> {
    const response = await fetch(`${ASANA_API_BASE}/users/me`, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${token}`,
        accept: 'application/json',
      },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new AsanaError(
        `Asana token validation failed (${response.status}): ${text.slice(0, 500)}`,
        response.status,
      );
    }
    const payload = (await response.json()) as AsanaSingleResponse<AsanaUserRaw>;
    return payload.data;
  }

  private ensureCredential(required: boolean): AsanaCredential | null {
    if (!this.credential) {
      this.credential = loadAsanaCredential();
    }
    if (!this.credential && required) {
      throw new Error('Not connected to Asana. Click "Connect Asana" to paste a Personal Access Token.');
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
   * Fetch a single attachment's metadata, including a freshly-issued
   * `download_url`. Used at download time because Asana's `download_url`
   * expires roughly 2 minutes after it is returned (per Asana docs).
   */
  async getAttachment(attachmentGid: string): Promise<AsanaAttachmentRaw | null> {
    const params = new URLSearchParams();
    params.set('opt_fields', 'name,size,download_url,resource_subtype');
    try {
      const response = await this.request<AsanaSingleResponse<AsanaAttachmentRaw>>(
        'GET',
        `/attachments/${attachmentGid}?${params.toString()}`,
      );
      return response.data ?? null;
    } catch (error) {
      console.warn(`[asana/client] failed to fetch attachment ${attachmentGid}:`, error);
      return null;
    }
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

    const attachments: DownloadedAttachment[] = [];
    let skippedCount = 0;

    for (const ref of refs) {
      const result = await this.downloadOne(ref.url, ref.filename);
      if (result) {
        attachments.push(result);
      } else {
        skippedCount++;
      }
    }

    return { attachments, skippedCount };
  }

  async downloadFileAttachments(
    attachments: FileAttachmentRef[],
  ): Promise<{ attachments: DownloadedAttachment[]; skippedCount: number }> {
    const results: DownloadedAttachment[] = [];
    let skippedCount = 0;
    for (const attachment of attachments) {
      // Asana's `download_url` is only valid for ~2 minutes from the time
      // the attachments API returned it. The user can easily spend more than
      // that reviewing the import list before clicking Import, so refresh
      // the URL right before downloading whenever we have the gid.
      let downloadUrl = attachment.url;
      if (attachment.externalRef) {
        const fresh = await this.getAttachment(attachment.externalRef);
        if (fresh?.download_url) {
          downloadUrl = fresh.download_url;
        }
      }
      const downloaded = await this.downloadOne(downloadUrl, attachment.filename);
      if (downloaded) {
        results.push(downloaded);
      } else {
        skippedCount++;
      }
    }
    return { attachments: results, skippedCount };
  }

  /**
   * Single-attachment download with conditional Bearer-token auth. The
   * Asana attachment `download_url` for files uploaded directly to Asana is
   * a redirector at `app.asana.com/api/1.0/attachments/{gid}/...` that
   * returns 401 without a Bearer header. With the header it 302-redirects
   * to a pre-signed `asana-user-private-*.s3.amazonaws.com` URL. Cross-
   * domain redirects in `downloadFile` strip the auth header automatically,
   * so adding it here is safe even when the URL is already pre-signed.
   */
  private async downloadOne(url: string, filename: string): Promise<DownloadedAttachment | null> {
    const credential = this.ensureCredential(false);
    let host = '';
    try {
      host = new URL(url).host;
    } catch {
      return null;
    }
    const headers = credential && isAsanaAuthedDownloadHost(host)
      ? { Authorization: `Bearer ${credential.accessToken}` }
      : undefined;
    const result = await downloadFile(url, filename, headers ? { headers } : undefined);
    if (!result) return null;
    return { ...result, mediaType: mediaTypeFromFilename(filename) };
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
    const response = await this.fetchWithAuth(method, pathAndQuery, credential.accessToken, body);
    if (response.status === 401) {
      // The user revoked the PAT or it was deleted. Drop the stored credential
      // so the next call surfaces "not connected" instead of looping on a dead token.
      clearAsanaCredential();
      this.credential = null;
      const text = await response.text().catch(() => '');
      throw new AsanaError(
        `Asana authentication failed. Re-paste your Personal Access Token. (${text.slice(0, 200)})`,
        401,
      );
    }
    return this.parseResponse<T>(response, method, pathAndQuery);
  }

  private async fetchWithAuth(
    method: 'GET' | 'POST',
    pathAndQuery: string,
    accessToken: string,
    body?: unknown,
  ): Promise<Response> {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${accessToken}`,
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
      throw new AsanaError(
        `Asana ${method} ${pathAndQuery} failed (${response.status}): ${text.slice(0, 500)}`,
        response.status,
      );
    }
    return (await response.json()) as T;
  }

  /** Persist a validated PAT. Replaces any existing credential. */
  saveCredential(accessToken: string, userEmail: string): AsanaCredential {
    const credential: AsanaCredential = {
      accessToken,
      userEmail,
      savedAt: new Date().toISOString(),
    };
    saveAsanaCredential(credential);
    this.credential = credential;
    return credential;
  }
}
