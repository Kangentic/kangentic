import crypto from 'node:crypto';
import { shell } from 'electron';
import {
  ASANA_OAUTH_AUTHORIZE,
  ASANA_OAUTH_REDIRECT_URI,
  ASANA_OAUTH_SCOPES,
  ASANA_OAUTH_TOKEN,
  TOKEN_REFRESH_MARGIN_SECONDS,
  getAsanaAppCredentials,
} from './constants';
import type { AsanaCredential } from './credential-store';

interface PendingAuth {
  verifier: string;
  state: string;
  createdAt: number;
}

const pending = new Map<string, PendingAuth>();
const PENDING_TTL_MS = 10 * 60 * 1000;

function pruneExpired(now: number = Date.now()): void {
  for (const [id, entry] of pending) {
    if (now - entry.createdAt > PENDING_TTL_MS) pending.delete(id);
  }
}

function generateVerifier(): string {
  return crypto.randomBytes(48).toString('base64url');
}

function challengeForVerifier(verifier: string): string {
  return crypto.createHash('sha256').update(verifier).digest('base64url');
}

export function isOAuthConfigured(): boolean {
  return getAsanaAppCredentials() !== null;
}

export interface OAuthStartResult {
  pendingId: string;
}

export async function startAsanaOAuth(): Promise<OAuthStartResult> {
  pruneExpired();
  const appCredentials = getAsanaAppCredentials();
  if (!appCredentials) {
    throw new Error(
      'Asana OAuth is not configured. Finish the Kangentic setup wizard first.',
    );
  }
  const { clientId } = appCredentials;

  const verifier = generateVerifier();
  // `state` is retained for spec compliance even though Asana's oob redirect
  // never round-trips it back to us (the user pastes the code directly, there
  // is no callback). CSRF protection for this flow comes from PKCE's
  // code_verifier + the short-lived server-side pendingId, not `state`.
  const state = crypto.randomBytes(16).toString('base64url');
  const pendingId = crypto.randomBytes(16).toString('base64url');
  pending.set(pendingId, { verifier, state, createdAt: Date.now() });

  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: ASANA_OAUTH_REDIRECT_URI,
    response_type: 'code',
    state,
    code_challenge_method: 'S256',
    code_challenge: challengeForVerifier(verifier),
    scope: ASANA_OAUTH_SCOPES,
  });

  const authUrl = `${ASANA_OAUTH_AUTHORIZE}?${params.toString()}`;
  await shell.openExternal(authUrl);
  return { pendingId };
}

interface AsanaTokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
  token_type?: string;
  data?: { email?: string; name?: string; gid?: string };
}

export async function completeAsanaOAuth(
  pendingId: string,
  code: string,
): Promise<AsanaCredential> {
  pruneExpired();
  const entry = pending.get(pendingId);
  if (!entry) {
    throw new Error('The Asana login session has expired. Please click Connect Asana again.');
  }
  pending.delete(pendingId);

  const appCredentials = getAsanaAppCredentials();
  if (!appCredentials) {
    throw new Error('Asana OAuth is not configured; cannot exchange authorization code.');
  }
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    client_id: appCredentials.clientId,
    client_secret: appCredentials.clientSecret,
    redirect_uri: ASANA_OAUTH_REDIRECT_URI,
    code: code.trim(),
    code_verifier: entry.verifier,
  });

  const response = await fetch(ASANA_OAUTH_TOKEN, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      accept: 'application/json',
    },
    body: body.toString(),
    signal: AbortSignal.timeout(30_000),
  });

  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(`Asana token exchange failed (${response.status}): ${text.slice(0, 500)}`);
  }

  const payload = (await response.json()) as AsanaTokenResponse;
  if (!payload.access_token || !payload.refresh_token) {
    throw new Error('Asana token exchange returned incomplete credentials.');
  }

  return {
    accessToken: payload.access_token,
    refreshToken: payload.refresh_token,
    expiresAt: new Date(Date.now() + payload.expires_in * 1000).toISOString(),
    userEmail: payload.data?.email ?? '',
    savedAt: new Date().toISOString(),
  };
}

export async function refreshAsanaToken(
  refreshToken: string,
): Promise<Pick<AsanaCredential, 'accessToken' | 'refreshToken' | 'expiresAt'>> {
  const appCredentials = getAsanaAppCredentials();
  if (!appCredentials) {
    throw new Error('Asana OAuth is not configured; cannot refresh.');
  }

  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    client_id: appCredentials.clientId,
    client_secret: appCredentials.clientSecret,
    refresh_token: refreshToken,
  });

  const response = await fetch(ASANA_OAUTH_TOKEN, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      accept: 'application/json',
    },
    body: body.toString(),
    signal: AbortSignal.timeout(30_000),
  });

  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(`Asana token refresh failed (${response.status}): ${text.slice(0, 500)}`);
  }

  const payload = (await response.json()) as AsanaTokenResponse;
  if (!payload.access_token) {
    throw new Error('Asana token refresh returned no access_token.');
  }

  return {
    accessToken: payload.access_token,
    refreshToken: payload.refresh_token ?? refreshToken,
    expiresAt: new Date(Date.now() + payload.expires_in * 1000).toISOString(),
  };
}

export function shouldRefresh(credential: AsanaCredential, now: number = Date.now()): boolean {
  const expiryMillis = new Date(credential.expiresAt).getTime();
  if (!Number.isFinite(expiryMillis)) return true;
  const marginMillis = TOKEN_REFRESH_MARGIN_SECONDS * 1000;
  return now >= expiryMillis - marginMillis;
}

export const __internal = { pending, pruneExpired, generateVerifier, challengeForVerifier };
