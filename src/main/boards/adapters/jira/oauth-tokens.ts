import { JIRA_OAUTH_REFRESH_URL, JIRA_TOKEN_REFRESH_MARGIN_MS } from './constants';
import { loadJiraCredentials, saveJiraCredential, type JiraSiteCredential } from './credential-store';

const REFRESH_TIMEOUT_MS = 30_000;

export interface JiraTokenSet {
  accessToken: string;
  refreshToken: string;
  /** When the access token expires, UTC ISO 8601. */
  expiresAt: string;
}

/**
 * Atlassian's token answer, read loosely: it can carry more than these keys
 * (`scope`, `token_type`), and only the three a sign-in needs are kept. Null
 * when one is missing. A missing `refresh_token` means `offline_access` was not
 * granted, and a sign-in without one would die within the hour.
 */
export function parseAtlassianTokenAnswer(text: string, now: number = Date.now()): JiraTokenSet | null {
  let answer: unknown;
  try {
    answer = JSON.parse(text);
  } catch { // report-ok: a body that is not JSON is no token answer, which the caller says
    return null;
  }
  if (typeof answer !== 'object' || answer === null) return null;
  const { access_token: accessToken, refresh_token: refreshToken, expires_in: expiresIn } = answer as Record<string, unknown>;
  if (typeof accessToken !== 'string' || accessToken.length === 0) return null;
  if (typeof refreshToken !== 'string' || refreshToken.length === 0) return null;
  if (typeof expiresIn !== 'number' || !Number.isFinite(expiresIn) || expiresIn <= 0) return null;
  return { accessToken, refreshToken, expiresAt: new Date(now + expiresIn * 1000).toISOString() };
}

/**
 * Atlassian refused the refresh token: it was revoked, lapsed after 90 days
 * unused, or was already spent by a rotation. Only a new sign-in fixes it.
 */
export class JiraRefreshRejectedError extends Error {
  constructor(public readonly oauthError: string | null) {
    super('Atlassian refused the saved sign-in.');
    this.name = 'JiraRefreshRejectedError';
  }
}

/**
 * The refresh got no usable answer: the network, kangentic.com or Atlassian is
 * down (`temporarily_unavailable`, a 5xx, a 429). The sign-in may still be good,
 * so it is kept and the caller offers Retry.
 */
export class JiraRefreshUnavailableError extends Error {
  constructor(public readonly status: number | null, options?: { cause?: unknown }) {
    super("Couldn't renew the Atlassian sign-in.", options);
    this.name = 'JiraRefreshUnavailableError';
  }
}

function oauthErrorCode(text: string): string | null {
  try {
    const body = JSON.parse(text) as { error?: unknown };
    return typeof body.error === 'string' && /^[a-z_]{1,64}$/.test(body.error) ? body.error : null;
  } catch { // report-ok: an error body that is not JSON carries no OAuth code
    return null;
  }
}

/**
 * Trade a refresh token for a new pair through kangentic.com. Atlassian rotates
 * refresh tokens, so the answer carries a new one and the one sent is spent.
 * Throws `JiraRefreshRejectedError` for a refusal and `JiraRefreshUnavailableError`
 * for anything that says nothing about the token.
 */
export async function refreshJiraTokens(refreshToken: string, fetchImpl: typeof fetch = fetch): Promise<JiraTokenSet> {
  let response: Response;
  let text: string;
  try {
    response = await fetchImpl(JIRA_OAUTH_REFRESH_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ refresh_token: refreshToken }),
      signal: AbortSignal.timeout(REFRESH_TIMEOUT_MS),
    });
    text = await response.text();
  } catch (networkError) {
    throw new JiraRefreshUnavailableError(null, { cause: networkError });
  }
  if (response.ok) {
    const tokens = parseAtlassianTokenAnswer(text);
    if (!tokens) throw new JiraRefreshUnavailableError(response.status);
    return tokens;
  }
  // A rate limit or a timeout says nothing about the token; every other 4xx is a refusal.
  if (response.status >= 500 || response.status === 408 || response.status === 429) {
    throw new JiraRefreshUnavailableError(response.status);
  }
  throw new JiraRefreshRejectedError(oauthErrorCode(text));
}

export interface JiraOauthDependencies {
  fetchImpl: typeof fetch;
  loadCredentials: () => Promise<Record<string, JiraSiteCredential>>;
  saveCredential: (credential: JiraSiteCredential) => Promise<void>;
  now: () => number;
}

const defaultDependencies: JiraOauthDependencies = {
  fetchImpl: fetch,
  loadCredentials: loadJiraCredentials,
  saveCredential: saveJiraCredential,
  now: () => Date.now(),
};

/**
 * One refresh per site at a time, shared by every client. Several `JiraClient`s
 * live at once (a fetch, its comment loads, a prerequisite check), and two
 * refreshing with one rotating token would spend it twice and sign the user out.
 */
const refreshInFlight = new Map<string, Promise<JiraSiteCredential>>();

interface UnsavedRenewal {
  renewed: JiraSiteCredential;
  /** The refresh token the store still holds, which Atlassian already spent for `renewed`. */
  storedRefreshToken: string | undefined;
}

/**
 * Pairs a refresh rotated but could not save, by site. While the store still
 * holds the token that refresh spent, the pair here is the only one that renews.
 */
const unsavedRenewals = new Map<string, UnsavedRenewal>();

function holdsGrant(credential: JiraSiteCredential | undefined, refreshToken: string | undefined): boolean {
  return credential?.method === 'oauth' && credential.refreshToken === refreshToken;
}

function needsRefresh(credential: JiraSiteCredential, now: number): boolean {
  const expiresAt = credential.expiresAt ? Date.parse(credential.expiresAt) : Number.NaN;
  return !Number.isFinite(expiresAt) || expiresAt - now <= JIRA_TOKEN_REFRESH_MARGIN_MS;
}

/**
 * The credential to sign a request with. A token method passes through. A
 * browser sign-in is renewed when its access token is near expiry, or always
 * when `force` says Jira just refused it. The rotated pair is saved before the
 * new access token is used.
 */
export async function freshJiraCredential(
  credential: JiraSiteCredential,
  options: { force?: boolean } = {},
  overrides: Partial<JiraOauthDependencies> = {},
): Promise<JiraSiteCredential> {
  if (credential.method !== 'oauth') return credential;
  const dependencies = { ...defaultDependencies, ...overrides };
  if (!options.force && !needsRefresh(credential, dependencies.now())) return credential;

  const pending = refreshInFlight.get(credential.site);
  if (pending) return pending;
  const refresh = (async () => {
    const fromStore = (await dependencies.loadCredentials())[credential.site];
    const unsaved = unsavedRenewals.get(credential.site);
    const live = unsaved && holdsGrant(fromStore, unsaved.storedRefreshToken) ? unsaved.renewed : fromStore;
    // Another client may have refreshed already. Its rotated pair is the live one,
    // and the refresh token this client holds is spent.
    if (live && live.method === 'oauth' && live.refreshToken !== credential.refreshToken) {
      if (!needsRefresh(live, dependencies.now())) return live;
    }
    const current = live?.method === 'oauth' ? live : credential;
    const storedRefreshToken = fromStore?.method === 'oauth' ? fromStore.refreshToken : current.refreshToken;
    const tokens = await refreshJiraTokens(current.refreshToken ?? '', dependencies.fetchImpl);
    const renewed: JiraSiteCredential = {
      ...current,
      secret: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      expiresAt: tokens.expiresAt,
      savedAt: new Date(dependencies.now()).toISOString(),
    };
    // A Reconnect that saved a new sign-in while this refresh was out wins. The
    // old grant's pair serves the request in hand and is never written over it.
    const latest = (await dependencies.loadCredentials())[credential.site];
    if (latest && !holdsGrant(latest, storedRefreshToken)) {
      unsavedRenewals.delete(credential.site);
      return renewed;
    }
    try {
      await dependencies.saveCredential(renewed);
    } catch (saveError) {
      // Atlassian already spent the token the store holds, so the next refresh
      // starts from this pair until a save lands.
      unsavedRenewals.set(credential.site, { renewed, storedRefreshToken });
      throw saveError;
    }
    unsavedRenewals.delete(credential.site);
    return renewed;
  })();
  refreshInFlight.set(credential.site, refresh);
  try {
    return await refresh;
  } finally {
    if (refreshInFlight.get(credential.site) === refresh) refreshInFlight.delete(credential.site);
  }
}
