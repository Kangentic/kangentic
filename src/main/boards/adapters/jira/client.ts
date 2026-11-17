import { withBackoff } from '../../shared';
import type { JiraSiteCredential } from './credential-store';
import type { JiraIssueRaw } from './mapper';

/** HTTP request timeout in milliseconds. Matches the downloadFile helper. */
const REQUEST_TIMEOUT_MS = 30_000;
/** The longest wait a 429's Retry-After can ask for before the next attempt. */
const MAX_RETRY_AFTER_MS = 10_000;
/** Atlassian's API gateway, which scoped tokens must call through. */
const ATLASSIAN_GATEWAY = 'https://api.atlassian.com/ex/jira';

/**
 * Fields every search asks for. Cloud's `/search/jql` returns only the id unless
 * asked, and `renderedFields` carries the description as HTML on Cloud and Data
 * Center alike.
 */
const ISSUE_FIELDS = [
  'summary', 'status', 'issuetype', 'priority', 'labels', 'assignee',
  'duedate', 'created', 'updated', 'attachment', 'description',
].join(',');

/**
 * A non-2xx answer from Jira, or a 2xx whose body is not JSON (a sign-in page a
 * proxy served). `loginReason` is Data Center's `X-Seraph-LoginReason`, and
 * `retryAfterMs` a 429's Retry-After.
 */
export class JiraHttpError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly body: string,
    public readonly loginReason: string | null,
    public readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = 'JiraHttpError';
  }

  /** Jira's own first error message, when its error body has one. */
  get jiraMessage(): string | null {
    try {
      const parsed = JSON.parse(this.body) as { errorMessages?: unknown; errors?: Record<string, unknown> };
      if (Array.isArray(parsed.errorMessages) && typeof parsed.errorMessages[0] === 'string') return parsed.errorMessages[0];
      const first = parsed.errors ? Object.values(parsed.errors)[0] : undefined;
      return typeof first === 'string' ? first : null;
    } catch { // report-ok: a body that is not Jira's JSON error has no message to show
      return null;
    }
  }
}

export interface JiraMyself {
  accountId?: string;
  name?: string;
  emailAddress?: string;
  displayName?: string;
  timeZone?: string;
}

interface JiraBoardRaw {
  id: number;
  name?: string;
  type?: string;
}

export interface JiraBoardConfigurationRaw {
  columnConfig?: { columns?: Array<{ name?: string; statuses?: Array<{ id?: string }> }> };
}

export interface JiraCommentRaw {
  author?: { displayName?: string };
  created?: string;
  renderedBody?: string;
}

export interface JiraPage {
  issues: JiraIssueRaw[];
  /** Cloud `/search/jql`: the cursor for the next page, absent on the last. */
  nextPageToken?: string;
  isLast?: boolean;
  /** Data Center search and the agile API. */
  total?: number;
  startAt?: number;
}

type QueryValue = string | number | undefined;

/**
 * The fields and expand an issue listing asks for. A caller naming its own
 * fields (the ids-only listing) gets no rendered description with them.
 */
function issueFieldQuery(fields: string | undefined): { fields: string; expand: string | undefined } {
  return { fields: fields ?? ISSUE_FIELDS, expand: fields ? undefined : 'renderedFields' };
}

/**
 * One Jira site's REST client, for one saved sign-in. Cloud and Data Center
 * share every call; they differ in the sign-in header, the REST version (Cloud
 * v3, Data Center v2), and the search call (Cloud's cursor-paged `/search/jql`,
 * Data Center's offset-paged `/search`).
 */
export class JiraClient {
  constructor(
    private credential: JiraSiteCredential,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  get site(): string {
    return this.credential.site;
  }

  get isCloud(): boolean {
    return this.credential.deployment === 'cloud';
  }

  /** Where REST calls go: the site itself, or the gateway for a scoped token. */
  get apiBase(): string {
    if (this.credential.viaGateway && this.credential.cloudId) {
      return `${ATLASSIAN_GATEWAY}/${this.credential.cloudId}`;
    }
    return this.credential.site;
  }

  private get platformVersion(): '2' | '3' {
    return this.isCloud ? '3' : '2';
  }

  /** The Authorization header for this sign-in. */
  authorizationHeader(): string {
    const { method, secret } = this.credential;
    if (method === 'api-token') {
      return `Basic ${Buffer.from(`${this.credential.email ?? ''}:${secret}`).toString('base64')}`;
    }
    if (method === 'password') {
      return `Basic ${Buffer.from(`${this.credential.username ?? ''}:${secret}`).toString('base64')}`;
    }
    return `Bearer ${secret}`;
  }

  /**
   * True when a URL is on this site or its gateway, so it may carry the sign-in.
   * The scheme must match too: an issue description can name `http://` on the
   * site's own host, and the header would then cross the network in the clear.
   */
  ownsUrl(url: string): boolean {
    try {
      const target = new URL(url);
      const host = target.host.toLowerCase();
      const site = new URL(this.credential.site);
      if (target.protocol === site.protocol && host === site.host.toLowerCase()) return true;
      const gateway = new URL(ATLASSIAN_GATEWAY);
      return this.credential.viaGateway === true && target.protocol === gateway.protocol && host === gateway.host;
    } catch { // report-ok: a malformed URL is not this site's, so it gets no sign-in
      return false;
    }
  }

  async myself(): Promise<JiraMyself> {
    return this.get<JiraMyself>(`/rest/api/${this.platformVersion}/myself`);
  }

  async board(boardId: string): Promise<JiraBoardRaw> {
    return this.get<JiraBoardRaw>(`/rest/agile/1.0/board/${encodeURIComponent(boardId)}`);
  }

  async boardConfiguration(boardId: string): Promise<JiraBoardConfigurationRaw> {
    return this.get<JiraBoardConfigurationRaw>(`/rest/agile/1.0/board/${encodeURIComponent(boardId)}/configuration`);
  }

  async project(key: string): Promise<{ key?: string; name?: string }> {
    return this.get(`/rest/api/${this.platformVersion}/project/${encodeURIComponent(key)}`);
  }

  async filter(filterId: string): Promise<{ name?: string; jql?: string }> {
    return this.get(`/rest/api/${this.platformVersion}/filter/${encodeURIComponent(filterId)}`);
  }

  /** Every comment on an issue, oldest first, a page at a time. */
  async comments(issueId: string): Promise<JiraCommentRaw[]> {
    const all: JiraCommentRaw[] = [];
    for (;;) {
      const response = await this.get<{ comments?: JiraCommentRaw[]; total?: number }>(
        `/rest/api/${this.platformVersion}/issue/${encodeURIComponent(issueId)}/comment`,
        { expand: 'renderedBody', maxResults: 100, orderBy: 'created', startAt: all.length },
      );
      const page = response.comments ?? [];
      all.push(...page);
      if (page.length === 0 || typeof response.total !== 'number' || all.length >= response.total) return all;
    }
  }

  /** A board's issues, offset-paged (the agile API on Cloud and Data Center alike). */
  async boardIssues(
    boardId: string,
    options: { startAt: number; maxResults: number; jql?: string; fields?: string },
  ): Promise<JiraPage> {
    return this.get<JiraPage>(`/rest/agile/1.0/board/${encodeURIComponent(boardId)}/issue`, {
      startAt: options.startAt,
      maxResults: options.maxResults,
      jql: options.jql,
      ...issueFieldQuery(options.fields),
    });
  }

  /**
   * One page of a JQL search. Cloud pages with `nextPageToken` and gives no
   * total; Data Center pages with `startAt`. The caller passes whichever it has.
   */
  async search(
    jql: string,
    options: { maxResults: number; nextPageToken?: string; startAt?: number; fields?: string },
  ): Promise<JiraPage> {
    if (this.isCloud) {
      return this.get<JiraPage>('/rest/api/3/search/jql', {
        jql,
        ...issueFieldQuery(options.fields),
        maxResults: options.maxResults,
        nextPageToken: options.nextPageToken,
      });
    }
    return this.get<JiraPage>('/rest/api/2/search', {
      jql,
      ...issueFieldQuery(options.fields),
      maxResults: options.maxResults,
      startAt: options.startAt ?? 0,
    });
  }

  /**
   * The download URL for an attachment. Cloud's content endpoint redirects to a
   * media host unless asked not to, and a redirect would carry the sign-in to
   * another host, so it is asked for the bytes directly.
   */
  attachmentDownloadUrl(attachmentId: string, contentUrl: string): string {
    if (this.isCloud) {
      return `${this.apiBase}/rest/api/3/attachment/content/${encodeURIComponent(attachmentId)}?redirect=false`;
    }
    return contentUrl;
  }

  /** GET a path relative to the API base, retrying 429 (after its Retry-After) and 5xx. */
  async get<T>(path: string, query?: Record<string, QueryValue>): Promise<T> {
    return withBackoff(() => this.getOnce<T>(path, query), {
      maxAttempts: 3,
      maxDelayMs: MAX_RETRY_AFTER_MS,
      shouldRetry: (error) => error instanceof JiraHttpError && (error.status === 429 || error.status >= 500),
      retryAfterMs: (error) => (error instanceof JiraHttpError ? error.retryAfterMs : undefined),
    });
  }

  private async getOnce<T>(path: string, query?: Record<string, QueryValue>): Promise<T> {
    const url = new URL(`${this.apiBase}${path}`);
    for (const [key, value] of Object.entries(query ?? {})) {
      if (value !== undefined && value !== '') url.searchParams.set(key, String(value));
    }
    const response = await this.fetchImpl(url.toString(), {
      method: 'GET',
      headers: { Authorization: this.authorizationHeader(), accept: 'application/json' },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!response.ok) {
      const body = await response.text().catch(() => ''); // report-ok: an unreadable error body leaves only the status to report
      const retryAfterSeconds = Number(response.headers.get('retry-after'));
      throw new JiraHttpError(
        `Jira GET ${path} failed (${response.status})`,
        response.status,
        body.slice(0, 2000),
        response.headers.get('x-seraph-loginreason'),
        response.status === 429 && Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0
          ? retryAfterSeconds * 1000
          : undefined,
      );
    }
    const text = await response.text();
    try {
      return JSON.parse(text) as T;
    } catch {
      // A sign-in page a proxy or SSO served in place of Jira's answer.
      throw new JiraHttpError(
        `Jira GET ${path} answered with a page that is not JSON (${response.status})`,
        response.status,
        text.slice(0, 2000),
        response.headers.get('x-seraph-loginreason'),
      );
    }
  }
}

/** The cloud id for a Cloud site, read without a sign-in from the site's tenant info. */
export async function fetchCloudId(site: string, fetchImpl: typeof fetch = fetch): Promise<string | null> {
  const response = await fetchImpl(`${site}/_edge/tenant_info`, {
    headers: { accept: 'application/json' },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) return null;
  const info = (await response.json()) as { cloudId?: unknown };
  return typeof info.cloudId === 'string' && info.cloudId.length > 0 ? info.cloudId : null;
}
