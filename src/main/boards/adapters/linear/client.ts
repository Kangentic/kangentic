import { URL } from 'node:url';
import {
  ISSUES_QUERY,
  LINEAR_CLOSED_STATE_TYPES,
  LINEAR_GRAPHQL_URL,
  LINEAR_ISSUE_PAGE_SIZE,
  LINEAR_STATE_TYPE_ORDER,
  LINEAR_TOKEN_REFRESH_MARGIN_MS,
  TEAMS_QUERY,
  TEAM_QUERY,
  VIEWER_QUERY,
  isLinearAuthedDownloadHost,
} from './constants';
import {
  clearLinearCredential,
  loadLinearCredential,
  saveLinearCredential,
  type LinearCredential,
  type LinearOAuthCredential,
} from './credential-store';
import { LinearError } from './linear-error';
import { refreshAccessToken, type LinearTokenSet } from './oauth-tokens';
import {
  downloadFile,
  extractInlineImageUrls,
  mediaTypeFromFilename,
  retryAfterMsFrom,
  withBackoff,
  type DownloadedAttachment,
} from '../../shared';
import { RefusalError } from '../../../../shared/refusal';

/** HTTP timeout for one GraphQL request. Matches the downloadFile helper. */
const REQUEST_TIMEOUT_MS = 30_000;

/** Paging walks whose cursors the client keeps, one per team and watermark. */
const CURSOR_CACHE_MAX_WALKS = 16;

export const NOT_CONNECTED_MESSAGE = 'Not connected to Linear.';

export interface LinearViewer {
  id: string;
  name: string;
  displayName: string;
  email: string | null;
  organization: { urlKey: string };
}

export interface LinearTeam {
  id: string;
  key: string;
  name: string;
}

export interface LinearWorkflowState {
  id: string;
  name: string;
  type: string;
  position: number;
}

export interface LinearIssueRaw {
  id: string;
  identifier: string;
  title: string;
  description: string | null;
  url: string;
  priority: number;
  priorityLabel: string;
  estimate: number | null;
  dueDate: string | null;
  createdAt: string;
  updatedAt: string;
  state: LinearWorkflowState;
  assignee: { name: string; displayName: string } | null;
  labels: { nodes: Array<{ name: string }> };
  cycle: { number: number; name: string | null } | null;
  project: { name: string } | null;
}

interface PageInfo {
  hasNextPage: boolean;
  endCursor: string | null;
}

interface Connection<T> {
  nodes: T[];
  pageInfo: PageInfo;
}

interface GraphQLErrorEntry {
  message?: unknown;
  extensions?: { code?: unknown };
}

interface GraphQLResponseBody<T> {
  data?: T;
  errors?: GraphQLErrorEntry[];
}

export interface ListIssuesOptions {
  page: number;
  perPage?: number;
  /** ISO 8601 watermark: only issues updated after it. */
  since?: string;
}

export interface ListIssuesResult {
  issues: LinearIssueRaw[];
  hasNextPage: boolean;
}

export interface LinearTeamWithStates {
  team: LinearTeam;
  /** The team's workflow states in the order Linear's board shows them. */
  states: LinearWorkflowState[];
}

/** Sort workflow states into board order: by state type, then by position within a type. */
export function sortStatesInBoardOrder(states: LinearWorkflowState[]): LinearWorkflowState[] {
  const typeRank = (type: string): number => {
    const index = LINEAR_STATE_TYPE_ORDER.indexOf(type);
    return index === -1 ? LINEAR_STATE_TYPE_ORDER.length : index;
  };
  return states.slice().sort((stateA, stateB) =>
    typeRank(stateA.type) - typeRank(stateB.type) || stateA.position - stateB.position,
  );
}

export function isClosedStateType(type: string): boolean {
  return LINEAR_CLOSED_STATE_TYPES.has(type);
}

function authorizationHeaderFor(credential: { kind: 'api_key'; apiKey: string } | { kind: 'oauth'; accessToken: string }): string {
  // A personal API key goes in bare; an OAuth access token takes the Bearer scheme.
  return credential.kind === 'api_key' ? credential.apiKey : `Bearer ${credential.accessToken}`;
}

/**
 * POST one GraphQL request with the given Authorization header and return its
 * `data`. Throws `LinearError` carrying Linear's own message for a non-2xx
 * status and for a 200 whose body has `errors` (GraphQL reports partial
 * failures that way).
 */
async function postGraphQL<T>(authorization: string, query: string, variables: Record<string, unknown>): Promise<T> {
  const response = await fetch(LINEAR_GRAPHQL_URL, {
    method: 'POST',
    headers: {
      Authorization: authorization,
      'content-type': 'application/json',
      accept: 'application/json',
    },
    body: JSON.stringify({ query, variables }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  // report-ok: a body that is not JSON is answered below as a failed request with its status.
  const parsed: unknown = await response.json().catch(() => null);
  const body = (parsed !== null && typeof parsed === 'object' ? parsed : {}) as GraphQLResponseBody<T>;
  const firstError = body.errors?.[0];
  if (firstError || !response.ok) {
    const message = typeof firstError?.message === 'string' && firstError.message.length > 0
      ? firstError.message
      : `Linear request failed (${response.status})`;
    const code = typeof firstError?.extensions?.code === 'string' ? firstError.extensions.code : undefined;
    throw new LinearError(message, response.status, code, retryAfterMsFrom(response.headers.get('retry-after')));
  }
  if (body.data === undefined) {
    throw new LinearError(`Linear request returned no data (${response.status})`, response.status);
  }
  return body.data;
}

function isAuthenticationFailure(error: unknown): boolean {
  return error instanceof LinearError && (error.status === 401 || error.code === 'AUTHENTICATION_ERROR');
}

/**
 * True when Linear refused the refresh token itself (`invalid_grant` comes back
 * as a 400, a revoked client as a 401). A 408, a 429 or a 5xx says nothing about
 * the token, so the sign-in is kept for the next try.
 */
function isRefreshTokenRefused(error: unknown): boolean {
  return error instanceof LinearError && (error.status === 400 || error.status === 401);
}

/** The same saved credential: the same key, or the same refresh token (Linear rotates it on every refresh). */
function isSameCredential(credentialA: LinearCredential, credentialB: LinearCredential): boolean {
  if (credentialA.kind === 'api_key') return credentialB.kind === 'api_key' && credentialA.apiKey === credentialB.apiKey;
  return credentialB.kind === 'oauth' && credentialA.refreshToken === credentialB.refreshToken;
}

/**
 * One refresh at a time across every client instance: Linear rotates the
 * refresh token on each refresh, so two refreshes racing would spend the same
 * token and leave the loser holding a dead pair.
 */
let refreshInFlight: Promise<LinearCredential> | null = null;

async function refreshCredential(credential: LinearOAuthCredential): Promise<LinearCredential> {
  if (!refreshInFlight) {
    refreshInFlight = (async () => {
      // A refresh that finished after this caller read its credential already spent
      // this refresh token, and a Connect may have replaced the sign-in. Either way
      // the store holds the credential to use, and asking Linear would be refused.
      const stored = await loadLinearCredential();
      if (stored && !isSameCredential(stored, credential)) return stored;
      const tokens: LinearTokenSet = await refreshAccessToken(credential.refreshToken);
      const refreshed: LinearOAuthCredential = { ...credential, ...tokens, savedAt: new Date().toISOString() };
      await saveLinearCredential(refreshed);
      return refreshed;
    })().finally(() => {
      refreshInFlight = null;
    });
  }
  return refreshInFlight;
}

/** Exposed for tests: forget an in-flight refresh between cases. */
export function resetLinearRefreshForTests(): void {
  refreshInFlight = null;
}

export class LinearClient {
  private credential: LinearCredential | null;
  /**
   * True when a test handed the credential in. Otherwise every call reads the
   * store, because the adapter's client lives as long as the app while a Connect,
   * a refresh in another client, or a clear can replace what is on disk.
   */
  private readonly credentialInjected: boolean;
  /** Per team query: page number -> the cursor that page starts after. */
  private readonly cursorCache = new Map<string, Map<number, string>>();

  constructor(credential?: LinearCredential | null) {
    this.credential = credential ?? null;
    this.credentialInjected = credential !== undefined && credential !== null;
  }

  /** Check a pasted API key against Linear without saving it. */
  static async validateApiKey(apiKey: string): Promise<LinearViewer> {
    const data = await postGraphQL<{ viewer: LinearViewer }>(apiKey, VIEWER_QUERY, {});
    return data.viewer;
  }

  /** Check a fresh OAuth access token against Linear without saving it. */
  static async validateAccessToken(accessToken: string): Promise<LinearViewer> {
    const data = await postGraphQL<{ viewer: LinearViewer }>(`Bearer ${accessToken}`, VIEWER_QUERY, {});
    return data.viewer;
  }

  async getCredential(): Promise<LinearCredential | null> {
    if (!this.credentialInjected) this.credential = await loadLinearCredential();
    return this.credential;
  }

  async hasCredential(): Promise<boolean> {
    return (await this.getCredential()) !== null;
  }

  async saveCredential(credential: LinearCredential): Promise<void> {
    await saveLinearCredential(credential);
    this.credential = credential;
  }

  async getViewer(): Promise<LinearViewer> {
    const data = await this.graphql<{ viewer: LinearViewer }>(VIEWER_QUERY, {});
    return data.viewer;
  }

  /** Every team the credential can see, sorted by name. */
  async listTeams(): Promise<LinearTeam[]> {
    const teams: LinearTeam[] = [];
    let after: string | null = null;
    do {
      const data: { teams: Connection<LinearTeam> } = await this.graphql(TEAMS_QUERY, { after });
      teams.push(...data.teams.nodes);
      after = data.teams.pageInfo.hasNextPage ? data.teams.pageInfo.endCursor : null;
    } while (after);
    return teams.sort((teamA, teamB) => teamA.name.localeCompare(teamB.name));
  }

  /** The team with this key and its workflow states in board order, or null when none matches. */
  async getTeam(teamKey: string): Promise<LinearTeamWithStates | null> {
    const data = await this.graphql<{
      teams: { nodes: Array<LinearTeam & { states: { nodes: LinearWorkflowState[] } }> };
    }>(TEAM_QUERY, { key: teamKey });
    const node = data.teams.nodes[0];
    if (!node) return null;
    return {
      team: { id: node.id, key: node.key, name: node.name },
      states: sortStatesInBoardOrder(node.states.nodes),
    };
  }

  async listIssues(teamKey: string, options: ListIssuesOptions): Promise<ListIssuesResult> {
    const cacheKey = `${teamKey}|${options.since ?? ''}`;
    if (options.page <= 1) {
      // Every incremental reconcile brings a new watermark, so drop the oldest walk
      // once the cache holds a few: a walk that old has finished long ago.
      this.cursorCache.delete(cacheKey);
      if (this.cursorCache.size >= CURSOR_CACHE_MAX_WALKS) {
        const oldestKey = this.cursorCache.keys().next().value;
        if (oldestKey !== undefined) this.cursorCache.delete(oldestKey);
      }
      this.cursorCache.set(cacheKey, new Map());
    }
    const cursors = this.cursorCache.get(cacheKey) ?? new Map<number, string>();
    const after = options.page <= 1 ? null : cursors.get(options.page);
    if (options.page > 1 && after === undefined) {
      throw new RefusalError(`Linear page ${options.page} was requested before page ${options.page - 1}.`);
    }
    const filter: Record<string, unknown> = { team: { key: { eq: teamKey } } };
    // `gte`: the watermark is "changed at or after", so an issue updated at the
    // exact instant of the cache's newest row is fetched again rather than skipped.
    if (options.since) filter.updatedAt = { gte: options.since };
    const data = await this.graphql<{ issues: Connection<LinearIssueRaw> }>(ISSUES_QUERY, {
      filter,
      // The reconcile asks for 100; nested connections multiply query complexity,
      // so never go past the page size Linear's 10,000-point cap was sized for.
      first: Math.min(options.perPage ?? LINEAR_ISSUE_PAGE_SIZE, LINEAR_ISSUE_PAGE_SIZE),
      after,
    });
    const { hasNextPage, endCursor } = data.issues.pageInfo;
    if (hasNextPage && endCursor) cursors.set(options.page + 1, endCursor);
    this.cursorCache.set(cacheKey, cursors);
    return { issues: data.issues.nodes, hasNextPage: hasNextPage && endCursor !== null };
  }

  async downloadInlineImages(
    markdownBody: string,
  ): Promise<{ attachments: DownloadedAttachment[]; skippedCount: number }> {
    const refs = extractInlineImageUrls(markdownBody);
    if (refs.length === 0) return { attachments: [], skippedCount: 0 };
    const attachments: DownloadedAttachment[] = [];
    let skippedCount = 0;
    for (const ref of refs) {
      const downloaded = await this.downloadOne(ref.url, ref.filename);
      if (downloaded) attachments.push(downloaded);
      else skippedCount++;
    }
    return { attachments, skippedCount };
  }

  /**
   * Files uploaded to Linear need the API's Authorization header; any other host
   * gets none. `downloadFile` drops the header on a redirect to another host.
   */
  private async downloadOne(url: string, filename: string): Promise<DownloadedAttachment | null> {
    let host: string;
    try {
      host = new URL(url).host;
    } catch {
      // report-ok: a malformed image URL in an issue body is skipped and counted, like Asana's.
      return null;
    }
    let headers: Record<string, string> | undefined;
    if (isLinearAuthedDownloadHost(host)) {
      const credential = await this.freshCredential();
      headers = { Authorization: authorizationHeaderFor(credential) };
    }
    const result = await downloadFile(url, filename, headers ? { headers } : undefined);
    if (!result) return null;
    return { ...result, mediaType: mediaTypeFromFilename(filename) };
  }

  /** The stored credential, with an OAuth access token renewed when it is about to expire. */
  private async freshCredential(): Promise<LinearCredential> {
    const credential = await this.getCredential();
    if (!credential) throw new RefusalError(NOT_CONNECTED_MESSAGE);
    if (credential.kind !== 'oauth') return credential;
    const expiresAtMs = Date.parse(credential.expiresAt);
    if (Number.isFinite(expiresAtMs) && expiresAtMs - Date.now() >= LINEAR_TOKEN_REFRESH_MARGIN_MS) return credential;
    const refreshed = await this.refreshOrDisconnect(credential);
    this.credential = refreshed;
    return refreshed;
  }

  /** Refresh, and when Linear refuses the refresh token, forget the sign-in so Connect shows. */
  private async refreshOrDisconnect(credential: LinearOAuthCredential): Promise<LinearCredential> {
    try {
      return await refreshCredential(credential);
    } catch (error) {
      if (isRefreshTokenRefused(error)) await this.disconnect(credential);
      throw error;
    }
  }

  /**
   * Forget the credential Linear refused. The store is cleared only while it still
   * holds that credential: a Connect or a refresh that saved a newer one while the
   * refused request was in flight keeps it.
   */
  private async disconnect(refused: LinearCredential): Promise<void> {
    this.credential = null;
    const stored = await loadLinearCredential();
    if (stored && !isSameCredential(stored, refused)) return;
    try {
      clearLinearCredential();
    } catch (clearError) {
      // report-ok: a locked file (EBUSY on Windows) keeps the refused credential, so the next call is refused and clears it again; the caller's own Linear error is what the user sees.
      console.warn('[linear/client] could not clear the refused credential:', clearError instanceof Error ? clearError.name : 'unknown');
    }
  }

  private async graphql<T>(query: string, variables: Record<string, unknown>): Promise<T> {
    return withBackoff(() => this.graphqlOnce<T>(query, variables), {
      maxAttempts: 3,
      shouldRetry: (error) =>
        error instanceof LinearError && (error.status === 429 || (error.status >= 500 && error.status < 600)),
      retryAfterMs: (error) => (error instanceof LinearError ? error.retryAfterMs : undefined),
    });
  }

  private async graphqlOnce<T>(query: string, variables: Record<string, unknown>): Promise<T> {
    const credential = await this.freshCredential();
    try {
      return await postGraphQL<T>(authorizationHeaderFor(credential), query, variables);
    } catch (error) {
      if (!isAuthenticationFailure(error)) throw error;
      if (credential.kind === 'oauth') {
        // The access token was revoked or expired early. One refresh, one retry.
        const refreshed = await this.refreshOrDisconnect(credential);
        this.credential = refreshed;
        try {
          return await postGraphQL<T>(authorizationHeaderFor(refreshed), query, variables);
        } catch (retryError) {
          if (isAuthenticationFailure(retryError)) await this.disconnect(refreshed);
          throw retryError;
        }
      }
      // A revoked or deleted API key. Forget it so the next call says "not connected".
      await this.disconnect(credential);
      throw error;
    }
  }
}
