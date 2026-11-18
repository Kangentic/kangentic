import { RefusalError } from '../../../../shared/refusal';
import { retryAfterMsFrom, withBackoff } from '../../shared/rate-limit';
import { GITLAB_REQUEST_TIMEOUT_MS } from './constants';
import type { GitLabCredential } from './credential-store';
import { GitLabHttpError, gitLabMessageFrom } from './gitlab-error';
import { hostOf } from './url-parser';

/**
 * A REST client for one GitLab server, signed in with one saved credential. It
 * reads only. The issue import uses it, and a later merge request connector can
 * too: `request` and `paginate` are generic, and nothing here knows about the
 * import.
 */

export interface GitLabUserRaw {
  id: number;
  username: string;
  name?: string;
}

/** A project or a group, as the board import needs it. */
export interface GitLabNamespace {
  kind: 'project' | 'group';
  id: number;
  /** `acme/web`, `acme/platform`: the path people paste and read. */
  fullPath: string;
}

export interface GitLabIssueRaw {
  id: number;
  iid: number;
  project_id: number;
  title: string;
  description?: string | null;
  state: string;
  labels?: string[];
  assignees?: Array<{ username?: string }> | null;
  assignee?: { username?: string } | null;
  milestone?: { title?: string | null } | null;
  iteration?: { title?: string | null; start_date?: string | null; due_date?: string | null } | null;
  weight?: number | null;
  due_date?: string | null;
  web_url: string;
  created_at: string;
  updated_at: string;
  /** `ISSUE`, `TASK`, `INCIDENT`, `TEST_CASE` on current servers. */
  type?: string | null;
  /** The older lowercase form (`issue`, `incident`, `test_case`, `task`). */
  issue_type?: string | null;
  references?: { short?: string; relative?: string; full?: string } | null;
}

export interface GitLabBoardListRaw {
  id: number;
  /** Null on an assignee, milestone, iteration or status list (paid tiers). */
  label?: { name?: string } | null;
  position?: number | null;
}

export interface GitLabBoardRaw {
  id: number;
  name?: string | null;
  lists?: GitLabBoardListRaw[] | null;
}

export interface GitLabIssuesPage {
  issues: GitLabIssueRaw[];
  hasNextPage: boolean;
}

/** How many attempts a call gets on a 429 or a 5xx, and the longest wait between them. */
const MAX_ATTEMPTS = 3;
const MAX_RETRY_DELAY_MS = 60_000;

function scopePath(namespace: Pick<GitLabNamespace, 'kind' | 'id'>): string {
  return `/${namespace.kind === 'project' ? 'projects' : 'groups'}/${namespace.id}`;
}

export class GitLabClient {
  constructor(
    private readonly credential: Pick<GitLabCredential, 'site' | 'secret'>,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  /** The server's base URL. */
  get base(): string {
    return this.credential.site;
  }

  /**
   * The header that signs a request in. GitLab takes a personal access token and
   * a sign-in's access token alike as `Authorization: Bearer`. That header, not
   * GitLab's own `PRIVATE-TOKEN`, is what a redirect to another host drops, both
   * in `fetch` and in the shared download, so a token never follows one.
   */
  authorizationHeaders(): Record<string, string> {
    return { Authorization: `Bearer ${this.credential.secret}` };
  }

  /**
   * One GET against `/api/v4<path>`. Retries a 429 (waiting out its
   * `Retry-After`) and a 5xx; any other error status throws `GitLabHttpError`
   * with GitLab's own message.
   */
  async request<T>(path: string, query?: Record<string, string | number | undefined>): Promise<{ data: T; headers: Headers }> {
    const url = new URL(`${this.base}/api/v4${path}`);
    for (const [key, value] of Object.entries(query ?? {})) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }
    return withBackoff(async () => {
      const response = await this.fetchImpl(url, {
        headers: { accept: 'application/json', ...this.authorizationHeaders() },
        signal: AbortSignal.timeout(GITLAB_REQUEST_TIMEOUT_MS),
      });
      if (!response.ok) {
        // report-ok: a body that is not JSON leaves the error with its status alone
        const body: unknown = await response.json().catch(() => null);
        throw new GitLabHttpError(response.status, gitLabMessageFrom(body), retryAfterMsFrom(response.headers.get('retry-after')));
      }
      let data: unknown;
      try {
        data = await response.json();
      } catch { // report-ok: a 2xx that is not JSON (a proxy's or captive portal's page) is the refusal below, not a defect
        throw new RefusalError(`${hostOf(this.base)} did not answer like GitLab.`);
      }
      return { data: data as T, headers: response.headers };
    }, {
      maxAttempts: MAX_ATTEMPTS,
      maxDelayMs: MAX_RETRY_DELAY_MS,
      shouldRetry: (error) => error instanceof GitLabHttpError && (error.status === 429 || error.status >= 500),
      retryAfterMs: (error) => (error instanceof GitLabHttpError ? error.retryAfterMs : undefined),
    });
  }

  /** Every item of an offset-paged list, `perPage` at a time, following `x-next-page`. */
  async paginate<T>(path: string, query: Record<string, string | number | undefined> = {}, perPage = 100): Promise<T[]> {
    const items: T[] = [];
    for (let page = 1; ; page++) {
      const { data, headers } = await this.request<T[]>(path, { ...query, per_page: perPage, page });
      if (!Array.isArray(data)) throw new RefusalError(`${hostOf(this.base)} did not answer like GitLab.`);
      items.push(...data);
      if (!hasNextPage(headers, data.length, perPage)) return items;
    }
  }

  async currentUser(): Promise<GitLabUserRaw> {
    return (await this.request<GitLabUserRaw>('/user')).data;
  }

  /**
   * A project or a group by its full path. GitLab route paths are unique across
   * projects and groups, so a project is asked for first and a group second.
   * Null when neither exists, or this account cannot see either.
   */
  async resolveNamespace(fullPath: string): Promise<GitLabNamespace | null> {
    const encoded = encodeURIComponent(fullPath);
    try {
      const { data } = await this.request<{ id: number; path_with_namespace?: string }>(`/projects/${encoded}`);
      return { kind: 'project', id: data.id, fullPath: data.path_with_namespace ?? fullPath };
    } catch (error) {
      if (!(error instanceof GitLabHttpError) || error.status !== 404) throw error;
    }
    try {
      const { data } = await this.request<{ id: number; full_path?: string }>(`/groups/${encoded}`);
      return { kind: 'group', id: data.id, fullPath: data.full_path ?? fullPath };
    } catch (error) {
      if (error instanceof GitLabHttpError && error.status === 404) return null;
      throw error;
    }
  }

  /** A project's id by its full path, for the uploads API. */
  async projectId(fullPath: string): Promise<number> {
    return (await this.request<{ id: number }>(`/projects/${encodeURIComponent(fullPath)}`)).data.id;
  }

  /** One page of a project's or group's issues, every state, newest change first. */
  async issuesPage(
    namespace: Pick<GitLabNamespace, 'kind' | 'id'>,
    options: { page: number; perPage: number; updatedAfter?: string },
  ): Promise<GitLabIssuesPage> {
    const { data, headers } = await this.request<GitLabIssueRaw[]>(`${scopePath(namespace)}/issues`, {
      state: 'all',
      scope: 'all',
      order_by: 'updated_at',
      sort: 'desc',
      per_page: options.perPage,
      page: options.page,
      updated_after: options.updatedAfter,
    });
    return { issues: data, hasNextPage: hasNextPage(headers, data.length, options.perPage) };
  }

  /** Every issue board of a project or group, lists included. */
  async boards(namespace: Pick<GitLabNamespace, 'kind' | 'id'>): Promise<GitLabBoardRaw[]> {
    return this.paginate<GitLabBoardRaw>(`${scopePath(namespace)}/boards`);
  }

  /** One issue board by id. Throws a 404 `GitLabHttpError` for a board the namespace does not have. */
  async board(namespace: Pick<GitLabNamespace, 'kind' | 'id'>, boardId: string): Promise<GitLabBoardRaw> {
    return (await this.request<GitLabBoardRaw>(`${scopePath(namespace)}/boards/${encodeURIComponent(boardId)}`)).data;
  }
}

/**
 * Whether an offset-paged list has more. GitLab sends `x-next-page`, empty on
 * the last page. A response without the header (some proxies strip it) has more
 * when the page came back full.
 */
export function hasNextPage(headers: Headers, itemCount: number, perPage: number): boolean {
  const next = headers.get('x-next-page');
  if (next !== null) return next.trim().length > 0;
  return itemCount >= perPage;
}
