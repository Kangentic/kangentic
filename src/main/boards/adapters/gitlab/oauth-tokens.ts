import { GITLAB_COM_BASE, GITLAB_COM_OAUTH_CLIENT_ID, GITLAB_REQUEST_TIMEOUT_MS } from './constants';
import { GitLabHttpError } from './gitlab-error';

/**
 * The access token lifetime GitLab uses by default (2 hours), for a token
 * response with no usable `expires_in`.
 */
const DEFAULT_ACCESS_TOKEN_LIFETIME_SECONDS = 2 * 60 * 60;

export interface GitLabTokenSet {
  accessToken: string;
  refreshToken: string;
  /** ISO 8601 UTC time the access token stops working. */
  expiresAt: string;
}

interface TokenResponseBody {
  access_token?: unknown;
  refresh_token?: unknown;
  expires_in?: unknown;
  error?: unknown;
  error_description?: unknown;
}

async function postTokenForm(form: URLSearchParams, fetchImpl: typeof fetch): Promise<GitLabTokenSet> {
  const response = await fetchImpl(`${GITLAB_COM_BASE}/oauth/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
    body: form.toString(),
    signal: AbortSignal.timeout(GITLAB_REQUEST_TIMEOUT_MS),
  });
  // report-ok: a body that is not JSON is answered below as a failed token request with its status
  const parsed: unknown = await response.json().catch(() => null);
  const body = (parsed !== null && typeof parsed === 'object' ? parsed : {}) as TokenResponseBody;
  if (!response.ok || typeof body.access_token !== 'string' || typeof body.refresh_token !== 'string') {
    const description = typeof body.error_description === 'string' ? body.error_description : undefined;
    const code = typeof body.error === 'string' ? body.error : undefined;
    throw new GitLabHttpError(response.status, description ?? code, undefined);
  }
  const expiresInSeconds = typeof body.expires_in === 'number' && body.expires_in > 0
    ? body.expires_in
    : DEFAULT_ACCESS_TOKEN_LIFETIME_SECONDS;
  return {
    accessToken: body.access_token,
    refreshToken: body.refresh_token,
    expiresAt: new Date(Date.now() + expiresInSeconds * 1000).toISOString(),
  };
}

/** Trade the authorization code from the browser for the first token pair (PKCE, no secret). */
export async function exchangeGitLabAuthorizationCode(
  input: { code: string; codeVerifier: string; redirectUri: string },
  fetchImpl: typeof fetch = fetch,
): Promise<GitLabTokenSet> {
  return postTokenForm(new URLSearchParams({
    grant_type: 'authorization_code',
    code: input.code,
    redirect_uri: input.redirectUri,
    client_id: GITLAB_COM_OAUTH_CLIENT_ID,
    code_verifier: input.codeVerifier,
  }), fetchImpl);
}

/**
 * Renew the pair. GitLab replaces the refresh token on every refresh and
 * revokes the old one, so the caller must save the returned pair at once.
 */
export async function refreshGitLabAccessToken(
  input: { refreshToken: string; redirectUri: string },
  fetchImpl: typeof fetch = fetch,
): Promise<GitLabTokenSet> {
  return postTokenForm(new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: input.refreshToken,
    redirect_uri: input.redirectUri,
    client_id: GITLAB_COM_OAUTH_CLIENT_ID,
  }), fetchImpl);
}
