import {
  LINEAR_OAUTH_CLIENT_ID,
  LINEAR_OAUTH_REVOKE_URL,
  LINEAR_OAUTH_TOKEN_URL,
} from './constants';
import { LinearError } from './linear-error';

/** HTTP timeout for every token endpoint call. */
const TOKEN_REQUEST_TIMEOUT_MS = 30_000;

/**
 * The access token lifetime Linear documents (24 hours), for a token response
 * with no usable `expires_in`. Without it the token would read as already
 * expired and every call would spend a refresh.
 */
const DOCUMENTED_ACCESS_TOKEN_LIFETIME_SECONDS = 24 * 60 * 60;

export interface LinearTokenSet {
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

async function postTokenForm(url: string, form: URLSearchParams): Promise<Response> {
  return fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
    body: form.toString(),
    signal: AbortSignal.timeout(TOKEN_REQUEST_TIMEOUT_MS),
  });
}

async function readTokenSet(response: Response): Promise<LinearTokenSet> {
  // report-ok: a non-JSON body is answered below as a failed token request with its status.
  const parsed: unknown = await response.json().catch(() => null);
  const body = (parsed !== null && typeof parsed === 'object' ? parsed : {}) as TokenResponseBody;
  if (!response.ok || typeof body.access_token !== 'string' || typeof body.refresh_token !== 'string') {
    const description = typeof body.error_description === 'string' ? body.error_description : '';
    const code = typeof body.error === 'string' ? body.error : undefined;
    throw new LinearError(
      description || code || `Linear token request failed (${response.status})`,
      response.status,
      code,
    );
  }
  const expiresInSeconds = typeof body.expires_in === 'number' && body.expires_in > 0
    ? body.expires_in
    : DOCUMENTED_ACCESS_TOKEN_LIFETIME_SECONDS;
  return {
    accessToken: body.access_token,
    refreshToken: body.refresh_token,
    expiresAt: new Date(Date.now() + expiresInSeconds * 1000).toISOString(),
  };
}

/** Trade the authorization code from the browser for the first token pair (PKCE, no secret). */
export async function exchangeAuthorizationCode(input: {
  code: string;
  codeVerifier: string;
  redirectUri: string;
}): Promise<LinearTokenSet> {
  const form = new URLSearchParams({
    grant_type: 'authorization_code',
    code: input.code,
    redirect_uri: input.redirectUri,
    client_id: LINEAR_OAUTH_CLIENT_ID,
    code_verifier: input.codeVerifier,
  });
  return readTokenSet(await postTokenForm(LINEAR_OAUTH_TOKEN_URL, form));
}

/**
 * Renew the pair. Linear rotates the refresh token on every refresh, so the
 * caller must save the returned pair and stop using the old refresh token.
 */
export async function refreshAccessToken(refreshToken: string): Promise<LinearTokenSet> {
  const form = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    client_id: LINEAR_OAUTH_CLIENT_ID,
  });
  return readTokenSet(await postTokenForm(LINEAR_OAUTH_TOKEN_URL, form));
}

/** Revoke a token at Linear. A token Linear already refuses counts as revoked. */
export async function revokeToken(token: string): Promise<void> {
  const response = await postTokenForm(LINEAR_OAUTH_REVOKE_URL, new URLSearchParams({ token }));
  if (!response.ok && response.status !== 400 && response.status !== 401) {
    throw new LinearError(`Linear token revoke failed (${response.status})`, response.status);
  }
}
