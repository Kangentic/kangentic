/**
 * Sign in with Atlassian for Jira Cloud, through the kangentic.com token service.
 *
 * What a user loses without each case: a consent URL missing `audience` or
 * `offline_access` gets a token Jira refuses or one that dies within the hour; a
 * forged `error=access_denied` that ends the attempt lets any page cancel a
 * sign-in; a sign-in saved for a site it cannot open fails every import with a
 * 401; a rotated refresh token that is not saved signs the user out on the next
 * refresh; an Atlassian outage read as a refusal puts Reconnect on a sign-in that
 * still works; and two clients refreshing at once spend the rotating token twice.
 *
 * The token service is the WebCrypto port in `helpers/kangentic-token-service.ts`;
 * Atlassian and Jira are a fetch stub.
 */
import http from 'node:http';
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import type { JiraSiteCredential } from '../../src/main/boards/adapters/jira/credential-store';

vi.mock('../../src/main/boards/adapters/jira/constants', async () => {
  const actual = await vi.importActual<typeof import('../../src/main/boards/adapters/jira/constants')>(
    '../../src/main/boards/adapters/jira/constants',
  );
  return { ...actual, JIRA_OAUTH_CLIENT_ID: 'test-client-id', isJiraSignInAvailable: () => true };
});

const storedCredentials = vi.hoisted(() => ({ sites: {} as Record<string, JiraSiteCredential> }));
const saveSpy = vi.hoisted(() => vi.fn(async (credential: JiraSiteCredential) => {
  storedCredentials.sites[credential.site] = credential;
}));
vi.mock('../../src/main/boards/adapters/jira/credential-store', () => ({
  loadJiraCredentials: async () => ({ ...storedCredentials.sites }),
  saveJiraCredential: saveSpy,
}));

vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn() },
  shell: { openExternal: vi.fn() },
}));

const { buildJiraAuthorizeUrl, signInWithAtlassian, cancelJiraSignIn, describeSignInError } = await import('../../src/main/boards/adapters/jira/oauth');
const { signInJiraSite } = await import('../../src/main/boards/adapters/jira/ipc-handlers');
const { freshJiraCredential, JiraRefreshRejectedError, JiraRefreshUnavailableError, parseAtlassianTokenAnswer } = await import(
  '../../src/main/boards/adapters/jira/oauth-tokens'
);
const { JiraClient, JiraHttpError } = await import('../../src/main/boards/adapters/jira/client');
const { JIRA_SEAL_INFO } = await import('../../src/main/boards/shared/sealed-token');
const { serviceRedirect } = await import('./helpers/kangentic-token-service');

const SITE = 'https://acme.atlassian.net';
const CLOUD_ID = 'cloud-123';
const REFRESH_URL = 'https://kangentic.com/oauth/jira/refresh';
const NOW = Date.parse('2026-11-17T12:00:00.000Z');

const ATLASSIAN_ANSWER = JSON.stringify({
  access_token: 'access-1',
  refresh_token: 'refresh-1',
  expires_in: 3600,
  scope: 'read:jira-work offline_access',
  token_type: 'Bearer',
});

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

interface Routes {
  resources?: Array<{ id: string; url: string }>;
  tenantId?: string | null;
  refresh?: () => Response | Promise<Response>;
  myself?: (authorization: string) => Response;
  /** Make accessible-resources answer with this status and no body. */
  resourcesStatus?: number;
}

/** Atlassian, the site and kangentic.com's refresh route, by URL. */
function fakeFetch(routes: Routes) {
  return vi.fn(async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    const headers = new Headers(init?.headers);
    if (url === 'https://api.atlassian.com/oauth/token/accessible-resources') {
      if (routes.resourcesStatus !== undefined) return json(routes.resourcesStatus, {});
      return json(200, routes.resources ?? [{ id: CLOUD_ID, url: SITE, name: 'acme' }]);
    }
    if (url === `${SITE}/_edge/tenant_info`) {
      return routes.tenantId === null ? json(404, {}) : json(200, { cloudId: routes.tenantId ?? CLOUD_ID });
    }
    if (url === REFRESH_URL) return routes.refresh ? routes.refresh() : json(500, { error: 'server_error' });
    if (url.startsWith(`https://api.atlassian.com/ex/jira/${CLOUD_ID}/rest/api/3/myself`)) {
      return routes.myself ? routes.myself(headers.get('authorization') ?? '') : json(200, { emailAddress: 'dana@acme.example' });
    }
    throw new Error(`unexpected fetch ${url}`);
  });
}

function get(url: string): Promise<number> {
  return new Promise((resolve, reject) => {
    http.get(url, { agent: false }, (response) => {
      response.resume();
      resolve(response.statusCode ?? 0);
    }).on('error', reject);
  });
}

/**
 * Start a sign-in and resolve with the consent URL the "browser" was sent to. It
 * runs on the real clock: the token it mints must read as fresh to the client
 * that checks it, which renews against the real clock.
 */
function startSignIn(fetchImpl: typeof fetch) {
  let resolveUrl: (url: URL) => void = () => {};
  const consentUrl = new Promise<URL>((resolve) => { resolveUrl = resolve; });
  const result = signInWithAtlassian({
    site: SITE,
    openExternal: async (url) => resolveUrl(new URL(url)),
    fetchImpl,
    timeoutMs: 10_000,
  });
  return { consentUrl, result };
}

function oauthCredential(overrides: Partial<JiraSiteCredential> = {}): JiraSiteCredential {
  return {
    site: SITE,
    deployment: 'cloud',
    method: 'oauth',
    secret: 'access-old',
    refreshToken: 'refresh-old',
    expiresAt: new Date(NOW + 60 * 60_000).toISOString(),
    cloudId: CLOUD_ID,
    viaGateway: true,
    account: 'dana@acme.example',
    savedAt: new Date(NOW).toISOString(),
    ...overrides,
  };
}

beforeEach(() => {
  storedCredentials.sites = {};
  saveSpy.mockClear();
});

afterEach(() => {
  cancelJiraSignIn();
});

describe('the consent URL', () => {
  it('asks api.atlassian.com for read-only Jira and offline access, returning to kangentic.com', () => {
    const url = new URL(buildJiraAuthorizeUrl('the-state'));
    expect(url.origin + url.pathname).toBe('https://auth.atlassian.com/authorize');
    expect(url.searchParams.get('audience')).toBe('api.atlassian.com');
    expect(url.searchParams.get('client_id')).toBe('test-client-id');
    expect(url.searchParams.get('redirect_uri')).toBe('https://kangentic.com/oauth/jira/callback');
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('prompt')).toBe('consent');
    expect(url.searchParams.get('state')).toBe('the-state');
    expect(url.searchParams.get('scope')?.split(' ')).toEqual(expect.arrayContaining([
      'read:jira-work', 'read:jira-user', 'offline_access', 'read:board-scope:jira-software',
    ]));
  });
});

describe('signInWithAtlassian', () => {
  it("opens the sealed tokens, maps the site to its cloud id, and names the account", async () => {
    const { consentUrl, result } = startSignIn(fakeFetch({}));
    const state = (await consentUrl).searchParams.get('state') ?? '';
    const redirect = await serviceRedirect(state, '/jira/callback', { plaintext: ATLASSIAN_ANSWER, info: JIRA_SEAL_INFO });
    const before = Date.now();
    expect(await get(redirect)).toBe(200);

    const signedIn = await result;
    expect(signedIn).toMatchObject({
      ok: true,
      value: {
        site: SITE,
        deployment: 'cloud',
        method: 'oauth',
        secret: 'access-1',
        refreshToken: 'refresh-1',
        cloudId: CLOUD_ID,
        viaGateway: true,
        account: 'dana@acme.example',
      },
    });
    const expiresAt = Date.parse((signedIn as { value: JiraSiteCredential }).value.expiresAt ?? '');
    expect(expiresAt - before).toBeGreaterThan(3500 * 1000);
    expect(expiresAt - before).toBeLessThanOrEqual(3600 * 1000 + 5000);
    // The sign-in itself never spends the refresh token.
    expect(saveSpy).not.toHaveBeenCalled();
  });

  it('keeps waiting through a forged error with the wrong nonce', async () => {
    const { consentUrl, result } = startSignIn(fakeFetch({}));
    const state = (await consentUrl).searchParams.get('state') ?? '';
    const real = new URL(await serviceRedirect(state, '/jira/callback', { plaintext: ATLASSIAN_ANSWER, info: JIRA_SEAL_INFO }));
    const forged = new URL(`http://127.0.0.1:${real.port}/jira/callback?error=access_denied&nonce=forged`);
    expect(await get(forged.toString())).toBe(400);
    const noNonce = new URL(`http://127.0.0.1:${real.port}/jira/callback?error=access_denied`);
    expect(await get(noNonce.toString())).toBe(400);

    expect(await get(real.toString())).toBe(200);
    expect((await result).ok).toBe(true);
  });

  it("ends a declined approval with Atlassian's own description", async () => {
    const { consentUrl, result } = startSignIn(fakeFetch({}));
    const state = (await consentUrl).searchParams.get('state') ?? '';
    await get(await serviceRedirect(state, '/jira/callback', { error: 'access_denied', description: 'User did not authorize the request' }));
    await expect(result).resolves.toEqual({ ok: false, cancelled: false, error: 'User did not authorize the request' });
  });

  it('ends a service error with a line for its code', async () => {
    const { consentUrl, result } = startSignIn(fakeFetch({}));
    const state = (await consentUrl).searchParams.get('state') ?? '';
    await get(await serviceRedirect(state, '/jira/callback', { error: 'server_error' }));
    const answer = await result;
    expect(answer).toMatchObject({ ok: false, cancelled: false });
    expect((answer as { error: string }).error).not.toBe('server_error');
  });

  it('fails an answer with no refresh token', async () => {
    const { consentUrl, result } = startSignIn(fakeFetch({}));
    const state = (await consentUrl).searchParams.get('state') ?? '';
    const noRefresh = JSON.stringify({ access_token: 'access-1', expires_in: 3600 });
    await get(await serviceRedirect(state, '/jira/callback', { plaintext: noRefresh, info: JIRA_SEAL_INFO }));
    expect(await result).toMatchObject({ ok: false, cancelled: false });
  });

  it("says the sign-in can't open a site it was not granted", async () => {
    const { consentUrl, result } = startSignIn(fakeFetch({ resources: [{ id: 'other-cloud', url: 'https://other.atlassian.net' }] }));
    const state = (await consentUrl).searchParams.get('state') ?? '';
    await get(await serviceRedirect(state, '/jira/callback', { plaintext: ATLASSIAN_ANSWER, info: JIRA_SEAL_INFO }));
    await expect(result).resolves.toEqual({ ok: false, cancelled: false, error: "This sign-in can't open acme.atlassian.net." });
  });

  it('matches the site by host when its tenant info does not answer', async () => {
    const { consentUrl, result } = startSignIn(fakeFetch({ tenantId: null }));
    const state = (await consentUrl).searchParams.get('state') ?? '';
    await get(await serviceRedirect(state, '/jira/callback', { plaintext: ATLASSIAN_ANSWER, info: JIRA_SEAL_INFO }));
    expect(await result).toMatchObject({ ok: true, value: { cloudId: CLOUD_ID } });
  });

  /** Run a sign-in whose sealed answer is fine, against the given Atlassian and Jira stub. */
  async function signInAgainst(fetchImpl: typeof fetch) {
    const { consentUrl, result } = startSignIn(fetchImpl);
    const state = (await consentUrl).searchParams.get('state') ?? '';
    await get(await serviceRedirect(state, '/jira/callback', { plaintext: ATLASSIAN_ANSWER, info: JIRA_SEAL_INFO }));
    return result;
  }

  const CANT_OPEN = { ok: false, cancelled: false, error: "This sign-in can't open acme.atlassian.net." };
  const NO_ANSWER = { ok: false, cancelled: false, error: "Atlassian didn't answer the sign-in." };

  it.each([503, 500, 429])('says Atlassian did not answer when accessible-resources answers %i', async (status) => {
    expect(await signInAgainst(fakeFetch({ resourcesStatus: status }))).toEqual(NO_ANSWER);
  });

  it.each([401, 403])("says the sign-in can't open the site when accessible-resources refuses it with %i", async (status) => {
    expect(await signInAgainst(fakeFetch({ resourcesStatus: status }))).toEqual(CANT_OPEN);
  });

  it('never renews the probe of an unsaved sign-in, which would spend the site\'s previous grant', async () => {
    // A Reconnect: the store still holds the old grant, lapsed. A renewing probe
    // would read it and spend its refresh token on Atlassian.
    storedCredentials.sites[SITE] = oauthCredential({ expiresAt: '2000-01-01T00:00:00.000Z' });
    const fetchImpl = fakeFetch({
      refresh: () => json(200, { access_token: 'access-new', refresh_token: 'refresh-new', expires_in: 3600 }),
      myself: () => json(401, {}),
    });
    expect(await signInAgainst(fetchImpl)).toEqual(CANT_OPEN);
    expect(fetchImpl.mock.calls.filter(([url]) => String(url) === REFRESH_URL)).toHaveLength(0);
    expect(saveSpy).not.toHaveBeenCalled();
  });

  it("fails a callback with no payload as the service failing", async () => {
    const { consentUrl, result } = startSignIn(fakeFetch({}));
    const state = (await consentUrl).searchParams.get('state') ?? '';
    const redirect = new URL(await serviceRedirect(state, '/jira/callback', { plaintext: ATLASSIAN_ANSWER, info: JIRA_SEAL_INFO }));
    redirect.searchParams.delete('payload');
    await get(redirect.toString());
    expect(await result).toEqual({ ok: false, cancelled: false, error: "Kangentic's sign-in service failed." });
  });

  it('fails a payload that does not open as the service failing', async () => {
    const { consentUrl, result } = startSignIn(fakeFetch({}));
    const state = (await consentUrl).searchParams.get('state') ?? '';
    await get(await serviceRedirect(state, '/jira/callback', { plaintext: ATLASSIAN_ANSWER, info: 'some-other-purpose' }));
    expect(await result).toEqual({ ok: false, cancelled: false, error: "Kangentic's sign-in service failed." });
  });
});

describe('describeSignInError', () => {
  it('names an Atlassian outage and a declined approval by their codes', () => {
    expect(describeSignInError('temporarily_unavailable', null)).toBe("Atlassian didn't answer the sign-in.");
    expect(describeSignInError('access_denied', null)).toBe('Atlassian sign-in was declined.');
  });

  it("prefers Atlassian's description over the code, and ignores a blank one", () => {
    expect(describeSignInError('access_denied', '  User did not authorize the request ')).toBe('User did not authorize the request');
    expect(describeSignInError('temporarily_unavailable', 'Try later')).toBe('Try later');
    expect(describeSignInError('access_denied', '   ')).toBe('Atlassian sign-in was declined.');
  });
});

describe('signInJiraSite', () => {
  const credential = oauthCredential({ account: 'dana@acme.example' });
  const openExternal = async () => {};

  it('saves the sign-in once and reports the site and account, for a normalized site', async () => {
    const signIn = vi.fn<typeof signInWithAtlassian>(async () => ({ ok: true, value: credential }));
    const save = vi.fn(async () => {});
    const result = await signInJiraSite({ site: 'acme.atlassian.net/jira/some/path' }, openExternal, { signIn, save });
    expect(result).toEqual({ ok: true, site: 'acme.atlassian.net', account: 'dana@acme.example' });
    expect(save).toHaveBeenCalledTimes(1);
    expect(save).toHaveBeenCalledWith(credential);
    expect(signIn).toHaveBeenCalledWith(expect.objectContaining({ site: 'https://acme.atlassian.net', openExternal }));
  });

  it('saves nothing for a cancel or a failure, and passes the result through', async () => {
    const save = vi.fn(async () => {});
    const cancelled = { ok: false as const, cancelled: true as const };
    const failed = { ok: false as const, cancelled: false as const, error: 'Atlassian sign-in timed out.' };
    for (const outcome of [cancelled, failed]) {
      const signIn = vi.fn<typeof signInWithAtlassian>(async () => outcome);
      expect(await signInJiraSite({ site: 'acme.atlassian.net' }, openExternal, { signIn, save })).toEqual(outcome);
    }
    expect(save).not.toHaveBeenCalled();
  });
});

describe('parseAtlassianTokenAnswer', () => {
  it('keeps the three keys a sign-in needs and ignores the rest', () => {
    expect(parseAtlassianTokenAnswer(ATLASSIAN_ANSWER, NOW)).toEqual({
      accessToken: 'access-1',
      refreshToken: 'refresh-1',
      expiresAt: new Date(NOW + 3600 * 1000).toISOString(),
    });
    expect(parseAtlassianTokenAnswer('not json', NOW)).toBeNull();
    expect(parseAtlassianTokenAnswer(JSON.stringify({ access_token: 'a', refresh_token: 'r' }), NOW)).toBeNull();
  });
});

describe('freshJiraCredential', () => {
  const rotated = { access_token: 'access-new', refresh_token: 'refresh-new', expires_in: 3600 };

  it('leaves a token method and a fresh sign-in alone', async () => {
    const fetchImpl = fakeFetch({});
    const token = { ...oauthCredential(), method: 'api-token' as const };
    expect(await freshJiraCredential(token, { force: true }, { fetchImpl, now: () => NOW })).toBe(token);
    const fresh = oauthCredential();
    expect(await freshJiraCredential(fresh, {}, { fetchImpl, now: () => NOW })).toBe(fresh);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('renews near expiry and saves the rotated pair before using it', async () => {
    const stale = oauthCredential({ expiresAt: new Date(NOW + 60_000).toISOString() });
    storedCredentials.sites[SITE] = stale;
    const fetchImpl = fakeFetch({ refresh: () => json(200, rotated) });
    const renewed = await freshJiraCredential(stale, {}, { fetchImpl, now: () => NOW });
    expect(renewed).toMatchObject({ secret: 'access-new', refreshToken: 'refresh-new' });
    expect(saveSpy).toHaveBeenCalledWith(renewed);
    const refreshCall = fetchImpl.mock.calls.find(([url]) => String(url) === REFRESH_URL);
    expect(JSON.parse(String(refreshCall?.[1]?.body))).toEqual({ refresh_token: 'refresh-old' });
  });

  it('reads a 4xx with an OAuth error as a refusal, and an outage or rate limit as unavailable', async () => {
    const stale = oauthCredential({ expiresAt: new Date(NOW - 1).toISOString() });
    storedCredentials.sites[SITE] = stale;
    await expect(freshJiraCredential(stale, {}, {
      fetchImpl: fakeFetch({ refresh: () => json(403, { error: 'invalid_grant', error_description: 'Unknown or invalid refresh token.' }) }),
      now: () => NOW,
    })).rejects.toBeInstanceOf(JiraRefreshRejectedError);
    for (const refresh of [
      () => json(502, { error: 'temporarily_unavailable' }),
      () => json(500, { error: 'server_error' }),
      () => json(429, { error: 'rate_limited' }),
      () => { throw new TypeError('fetch failed'); },
    ]) {
      await expect(freshJiraCredential(stale, {}, { fetchImpl: fakeFetch({ refresh }), now: () => NOW }))
        .rejects.toBeInstanceOf(JiraRefreshUnavailableError);
    }
    expect(saveSpy).not.toHaveBeenCalled();
  });

  it('shares one refresh between clients, and takes a pair another client already rotated', async () => {
    const stale = oauthCredential({ expiresAt: new Date(NOW - 1).toISOString() });
    storedCredentials.sites[SITE] = stale;
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const fetchImpl = fakeFetch({ refresh: async () => { await gate; return json(200, rotated); } });
    const first = freshJiraCredential(stale, {}, { fetchImpl, now: () => NOW });
    const second = freshJiraCredential(stale, {}, { fetchImpl, now: () => NOW });
    release();
    const [firstResult, secondResult] = await Promise.all([first, second]);
    expect(firstResult).toBe(secondResult);
    expect(fetchImpl.mock.calls.filter(([url]) => String(url) === REFRESH_URL)).toHaveLength(1);

    // A client still holding the spent pair takes the stored one, with no second refresh.
    const later = await freshJiraCredential(stale, {}, { fetchImpl, now: () => NOW });
    expect(later.refreshToken).toBe('refresh-new');
    expect(fetchImpl.mock.calls.filter(([url]) => String(url) === REFRESH_URL)).toHaveLength(1);
  });

  it.each([
    ['an api-token sign-in', { method: 'api-token' as const }],
    ['a different refresh token', { refreshToken: 'refresh-reconnected' }],
  ])('returns the renewed pair without saving it when a Reconnect to %s lands mid-refresh', async (_name, replacement) => {
    const stale = oauthCredential({ expiresAt: new Date(NOW - 1).toISOString() });
    storedCredentials.sites[SITE] = stale;
    let started: () => void = () => {};
    const refreshStarted = new Promise<void>((resolve) => { started = resolve; });
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const fetchImpl = fakeFetch({ refresh: async () => { started(); await gate; return json(200, rotated); } });
    const pending = freshJiraCredential(stale, {}, { fetchImpl, now: () => NOW });
    await refreshStarted;
    storedCredentials.sites[SITE] = { ...stale, ...replacement };
    release();
    expect(await pending).toMatchObject({ secret: 'access-new', refreshToken: 'refresh-new' });
    expect(saveSpy).not.toHaveBeenCalled();
    expect(storedCredentials.sites[SITE]).toMatchObject(replacement);
  });

  it('keeps a rotated pair the store would not take, and renews from it instead of spending the stored token again', async () => {
    // The refresh tokens are module state (`unsavedRenewals`), so this runs on its own copy of the module.
    vi.resetModules();
    const isolated = await import('../../src/main/boards/adapters/jira/oauth-tokens');
    const stale = oauthCredential({ expiresAt: new Date(NOW - 1).toISOString() });
    storedCredentials.sites[SITE] = stale;
    saveSpy.mockRejectedValueOnce(new Error('disk full'));
    const fetchImpl = fakeFetch({ refresh: () => json(200, rotated) });
    const refreshCalls = () => fetchImpl.mock.calls.filter(([url]) => String(url) === REFRESH_URL).length;

    await expect(isolated.freshJiraCredential(stale, {}, { fetchImpl, now: () => NOW })).rejects.toThrow('disk full');
    expect(refreshCalls()).toBe(1);
    expect(storedCredentials.sites[SITE]?.refreshToken).toBe('refresh-old');

    // Atlassian spent 'refresh-old'. A client still holding it must take the unsaved pair, not refresh again.
    const adopted = await isolated.freshJiraCredential(stale, { force: true }, { fetchImpl, now: () => NOW });
    expect(adopted.refreshToken).toBe('refresh-new');
    expect(refreshCalls()).toBe(1);
  });
});

describe('JiraClient with a browser sign-in', () => {
  // JiraClient reads the real clock, so a credential built around NOW would read
  // as stale once the real time passes it. Only Date is faked: the loopback
  // server, backoff and AbortSignal.timeout need the real timers.
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const rotatedAnswer = () => json(200, { access_token: 'access-new', refresh_token: 'refresh-new', expires_in: 3600 });
  const myselfAuthorizations = (fetchImpl: ReturnType<typeof fakeFetch>) => fetchImpl.mock.calls
    .filter(([url]) => String(url).includes('/rest/api/3/myself'))
    .map(([, init]) => new Headers(init?.headers).get('authorization'));
  const refreshCalls = (fetchImpl: ReturnType<typeof fakeFetch>) =>
    fetchImpl.mock.calls.filter(([url]) => String(url) === REFRESH_URL).length;

  it('renews once and retries when Jira refuses the access token', async () => {
    const credential = oauthCredential();
    storedCredentials.sites[SITE] = credential;
    const fetchImpl = fakeFetch({
      refresh: rotatedAnswer,
      myself: (authorization) => (authorization === 'Bearer access-new' ? json(200, { emailAddress: 'dana@acme.example' }) : json(401, {})),
    });
    const myself = await new JiraClient(credential, fetchImpl).myself();
    expect(myself.emailAddress).toBe('dana@acme.example');
    expect(saveSpy).toHaveBeenCalledTimes(1);
    // The stale token went out first (it was not near expiry, so no proactive renewal), then the renewed one.
    expect(myselfAuthorizations(fetchImpl)).toEqual(['Bearer access-old', 'Bearer access-new']);
    expect(refreshCalls(fetchImpl)).toBe(1);
  });

  it('does not renew again when another request on the client already renewed after its own 401', async () => {
    const credential = oauthCredential();
    storedCredentials.sites[SITE] = credential;
    let releaseSecond: () => void = () => {};
    const secondMayAnswer = new Promise<void>((resolve) => { releaseSecond = resolve; });
    let staleRequests = 0;
    const base = fakeFetch({
      refresh: rotatedAnswer,
      myself: (authorization) => (authorization === 'Bearer access-new' ? json(200, { emailAddress: 'dana@acme.example' }) : json(401, {})),
    });
    // Hold the second stale request's 401 until the first request's retry went out with the new token.
    const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const authorization = new Headers(init?.headers).get('authorization');
      if (String(input).includes('/rest/api/3/myself')) {
        if (authorization === 'Bearer access-new') releaseSecond();
        if (authorization === 'Bearer access-old' && ++staleRequests === 2) await secondMayAnswer;
      }
      return base(input, init);
    });
    const client = new JiraClient(credential, fetchImpl);
    const [first, second] = await Promise.all([client.myself(), client.myself()]);
    expect(first.emailAddress).toBe('dana@acme.example');
    expect(second.emailAddress).toBe('dana@acme.example');
    expect(staleRequests).toBe(2);
    expect(refreshCalls(base)).toBe(1);
  });

  it.each([
    ['answers 502', () => json(502, { error: 'temporarily_unavailable' })],
    ['cannot be reached', () => { throw new TypeError('fetch failed'); }],
  ])('keeps the sign-in and passes a refresh that %s through as unavailable, not as an HTTP error', async (_name, refresh) => {
    const credential = oauthCredential({ expiresAt: new Date(NOW - 1).toISOString() });
    storedCredentials.sites[SITE] = credential;
    const error = await new JiraClient(credential, fakeFetch({ refresh })).myself().catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(JiraRefreshUnavailableError);
    expect(error).not.toBeInstanceOf(JiraHttpError);
    expect(saveSpy).not.toHaveBeenCalled();
  });

  it('a lapsed sign-in on a board source reads as a rejected sign-in, not missing board scopes', async () => {
    const { JiraAdapter } = await import('../../src/main/boards/adapters/jira/adapter');
    const credential = oauthCredential();
    storedCredentials.sites[SITE] = credential;
    // Jira refuses the access token and Atlassian refuses the refresh: the 90-day lapse.
    const fetchImpl = vi.fn(async (input: string | URL | Request): Promise<Response> =>
      (String(input) === REFRESH_URL ? json(400, { error: 'invalid_grant' }) : json(401, {})));
    const adapter = new JiraAdapter({ loadCredentials: async () => ({ [SITE]: credential }), fetchImpl });
    await expect(adapter.prepareSource(`${SITE}::board::12`)).rejects.toThrow('Jira rejected the saved token.');
  });

  it('turns a refused refresh into the 401 every caller reads as a rejected sign-in', async () => {
    const credential = oauthCredential({ expiresAt: new Date(NOW - 1).toISOString() });
    storedCredentials.sites[SITE] = credential;
    const fetchImpl = fakeFetch({ refresh: () => json(400, { error: 'invalid_grant' }) });
    const error = await new JiraClient(credential, fetchImpl).myself().catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(JiraHttpError);
    expect((error as InstanceType<typeof JiraHttpError>).status).toBe(401);
  });
});
