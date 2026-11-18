/**
 * LinearClient: how it talks to Linear's GraphQL API with the saved credential.
 *
 * What a user loses without each case: a GraphQL error hidden in a 200 imports
 * nothing and says nothing; a revoked key or sign-in that is not forgotten loops
 * on a dead credential instead of offering Connect; two refreshes racing spend
 * the rotating refresh token twice and sign the user out; a 429 retried at once
 * burns the hour's quota; and an API key sent to an image host leaks it.
 * Also: a refresh that spends a refresh token another refresh already rotated
 * signs the user out; a flaky 429/408/503 on refresh that clears the sign-in
 * forces a needless reconnect; a Connect that saves a new key mid-request and is
 * then wiped by the old request's failure loses the new key; a locked
 * credential file that masks the Linear message hides why the call failed; a
 * `null` body that throws a TypeError shows no message at all; a page-2 request
 * with no cursor that walks the wrong rows imports duplicates or skips issues;
 * and an unbounded cursor cache grows for the life of the app.
 *
 * `fetch` is stubbed with `vi.stubGlobal`, the credential store and the token
 * endpoint with `vi.mock`. The fixture `linear-issues-response.json` was written
 * from Linear's published GraphQL schema (the Issue type) because no live
 * capture was possible when it was added (no Linear login in that session). It
 * is the shape a real response has, with generic sample data.
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { LinearCredential, LinearOAuthCredential } from '../../src/main/boards/adapters/linear/credential-store';
import type { LinearTokenSet } from '../../src/main/boards/adapters/linear/oauth-tokens';

const downloadFileSpy = vi.hoisted(() =>
  vi.fn<(url: string, filename: string, options?: { headers?: Record<string, string> }) => Promise<unknown>>(),
);
const loadSpy = vi.hoisted(() => vi.fn<() => Promise<LinearCredential | null>>(async () => null));
const saveSpy = vi.hoisted(() => vi.fn<(credential: LinearCredential) => Promise<void>>(async () => {}));
const clearSpy = vi.hoisted(() => vi.fn<() => void>());
const refreshSpy = vi.hoisted(() => vi.fn<(refreshToken: string) => Promise<LinearTokenSet>>());

vi.mock('../../src/main/boards/adapters/linear/credential-store', () => ({
  loadLinearCredential: loadSpy,
  saveLinearCredential: saveSpy,
  clearLinearCredential: clearSpy,
}));

vi.mock('../../src/main/boards/adapters/linear/oauth-tokens', () => ({
  refreshAccessToken: refreshSpy,
}));

vi.mock('../../src/main/boards/shared/download-file', async () => {
  const actual = await vi.importActual<typeof import('../../src/main/boards/shared/download-file')>(
    '../../src/main/boards/shared/download-file',
  );
  return { ...actual, downloadFile: downloadFileSpy };
});

const { LinearClient, sortStatesInBoardOrder, resetLinearRefreshForTests } = await import(
  '../../src/main/boards/adapters/linear/client'
);
const { LinearError } = await import('../../src/main/boards/adapters/linear/linear-error');
const { RefusalError } = await import('../../src/shared/refusal');
const { mapLinearIssues, stateOrderByIdFrom } = await import('../../src/main/boards/adapters/linear/mapper');

const VIEWER = { id: 'user-1', name: 'Dana Park', displayName: 'dana', email: null, organization: { urlKey: 'acme' } };

function apiKeyCredential(): LinearCredential {
  return { kind: 'api_key', apiKey: 'lin_api_test', userName: 'dana', organizationUrlKey: 'acme', savedAt: '2026-11-17T00:00:00.000Z' };
}

function oauthCredential(overrides: Partial<LinearOAuthCredential> = {}): LinearOAuthCredential {
  return {
    kind: 'oauth',
    accessToken: 'access-old',
    refreshToken: 'refresh-old',
    expiresAt: new Date(Date.now() + 24 * 60 * 60_000).toISOString(),
    userName: 'dana',
    organizationUrlKey: 'acme',
    savedAt: '2026-11-17T00:00:00.000Z',
    ...overrides,
  };
}

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
}

const UNAUTHENTICATED = {
  errors: [{ message: 'Authentication required, not authenticated', extensions: { code: 'AUTHENTICATION_ERROR' } }],
};

let fetchSpy: ReturnType<typeof vi.fn>;

beforeEach(() => {
  loadSpy.mockReset();
  saveSpy.mockReset();
  clearSpy.mockReset();
  refreshSpy.mockReset();
  downloadFileSpy.mockReset();
  downloadFileSpy.mockImplementation(async (url: string, filename: string) => ({
    filename, data: 'AAAA', mediaType: 'image/png', sizeBytes: 4, sourceUrl: url,
  }));
  resetLinearRefreshForTests();
  fetchSpy = vi.fn();
  vi.stubGlobal('fetch', fetchSpy);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

function authorizationOf(callIndex: number): string {
  const init = fetchSpy.mock.calls[callIndex][1] as RequestInit;
  return (init.headers as Record<string, string>).Authorization;
}

describe('LinearClient: the request', () => {
  it('sends a personal API key bare and an OAuth token as Bearer', async () => {
    fetchSpy.mockImplementation(async () => jsonResponse(200, { data: { viewer: VIEWER } }));
    await new LinearClient(apiKeyCredential()).getViewer();
    await new LinearClient(oauthCredential()).getViewer();
    expect(authorizationOf(0)).toBe('lin_api_test');
    expect(authorizationOf(1)).toBe('Bearer access-old');
  });

  it('throws Linear\'s own message for a 200 that carries errors', async () => {
    fetchSpy.mockResolvedValue(jsonResponse(200, {
      data: null,
      errors: [{ message: 'Entity not found: Team', extensions: { code: 'INVALID_INPUT' } }],
    }));
    await expect(new LinearClient(apiKeyCredential()).getViewer()).rejects.toThrow('Entity not found: Team');
  });

  it('waits the 429 Retry-After before trying again', async () => {
    vi.useFakeTimers();
    fetchSpy
      .mockResolvedValueOnce(jsonResponse(429, { errors: [{ message: 'Rate limited', extensions: { code: 'RATELIMITED' } }] }, { 'retry-after': '2' }))
      .mockResolvedValueOnce(jsonResponse(200, { data: { viewer: VIEWER } }));
    const viewerPromise = new LinearClient(apiKeyCredential()).getViewer();
    await vi.advanceTimersByTimeAsync(1_900);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(200);
    await expect(viewerPromise).resolves.toEqual(VIEWER);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });
});

describe('LinearClient: a credential Linear refuses', () => {
  it('forgets a refused API key so the next call says not connected', async () => {
    fetchSpy.mockImplementation(async () => jsonResponse(401, UNAUTHENTICATED));
    const client = new LinearClient(apiKeyCredential());
    await expect(client.getViewer()).rejects.toThrow('Authentication required, not authenticated');
    expect(clearSpy).toHaveBeenCalledTimes(1);
    await expect(client.getViewer()).rejects.toThrow('Not connected to Linear.');
  });

  it('refreshes an OAuth token once on a 401, saves the new pair, and retries with it', async () => {
    refreshSpy.mockResolvedValue({ accessToken: 'access-new', refreshToken: 'refresh-new', expiresAt: new Date(Date.now() + 86_400_000).toISOString() });
    fetchSpy
      .mockResolvedValueOnce(jsonResponse(401, UNAUTHENTICATED))
      .mockResolvedValueOnce(jsonResponse(200, { data: { viewer: VIEWER } }));
    const viewer = await new LinearClient(oauthCredential()).getViewer();
    expect(viewer).toEqual(VIEWER);
    expect(refreshSpy).toHaveBeenCalledWith('refresh-old');
    expect(saveSpy).toHaveBeenCalledWith(expect.objectContaining({ accessToken: 'access-new', refreshToken: 'refresh-new' }));
    expect(authorizationOf(1)).toBe('Bearer access-new');
    expect(clearSpy).not.toHaveBeenCalled();
  });

  it('signs out when Linear refuses the refresh token', async () => {
    refreshSpy.mockRejectedValue(new LinearError('invalid_grant', 400, 'invalid_grant'));
    fetchSpy.mockImplementation(async () => jsonResponse(401, UNAUTHENTICATED));
    await expect(new LinearClient(oauthCredential()).getViewer()).rejects.toThrow('invalid_grant');
    expect(clearSpy).toHaveBeenCalledTimes(1);
  });

  it('renews a token about to expire before the call, and two callers share one refresh', async () => {
    let resolveRefresh: (tokens: LinearTokenSet) => void = () => {};
    refreshSpy.mockImplementation(() => new Promise((resolve) => { resolveRefresh = resolve; }));
    fetchSpy.mockImplementation(async () => jsonResponse(200, { data: { viewer: VIEWER } }));
    const expiring = oauthCredential({ expiresAt: new Date(Date.now() + 60_000).toISOString() });
    const first = new LinearClient(expiring).getViewer();
    const second = new LinearClient(expiring).getViewer();
    await vi.waitFor(() => expect(refreshSpy).toHaveBeenCalledTimes(1));
    resolveRefresh({ accessToken: 'access-new', refreshToken: 'refresh-new', expiresAt: new Date(Date.now() + 86_400_000).toISOString() });
    await Promise.all([first, second]);
    expect(refreshSpy).toHaveBeenCalledTimes(1);
    expect(authorizationOf(0)).toBe('Bearer access-new');
    expect(authorizationOf(1)).toBe('Bearer access-new');
  });
});

describe('LinearClient: issues and states', () => {
  it('filters by team key and the since watermark, and pages by cursor', async () => {
    fetchSpy
      .mockResolvedValueOnce(jsonResponse(200, { data: { issues: { nodes: [], pageInfo: { hasNextPage: true, endCursor: 'cursor-2' } } } }))
      .mockResolvedValueOnce(jsonResponse(200, { data: { issues: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } } } }));
    const client = new LinearClient(apiKeyCredential());
    const firstPage = await client.listIssues('ENG', { page: 1, perPage: 100, since: '2026-11-01T00:00:00.000Z' });
    await client.listIssues('ENG', { page: 2, perPage: 100, since: '2026-11-01T00:00:00.000Z' });
    const firstBody = JSON.parse((fetchSpy.mock.calls[0][1] as RequestInit).body as string);
    const secondBody = JSON.parse((fetchSpy.mock.calls[1][1] as RequestInit).body as string);
    expect(firstPage.hasNextPage).toBe(true);
    // Inclusive, as the watermark is "changed at or after": an issue updated at the
    // watermark's own instant must not be skipped.
    expect(firstBody.variables.filter).toEqual({ team: { key: { eq: 'ENG' } }, updatedAt: { gte: '2026-11-01T00:00:00.000Z' } });
    // The reconcile's 100 is clamped to the page size the complexity cap allows.
    expect(firstBody.variables.first).toBe(50);
    expect(firstBody.variables.after).toBeNull();
    expect(secondBody.variables.after).toBe('cursor-2');
  });

  it('sorts workflow states by type in board order, then by position', () => {
    const sorted = sortStatesInBoardOrder([
      { id: 'done', name: 'Done', type: 'completed', position: 0 },
      { id: 'review', name: 'In Review', type: 'started', position: 2 },
      { id: 'progress', name: 'In Progress', type: 'started', position: 1 },
      { id: 'todo', name: 'Todo', type: 'unstarted', position: 0 },
      { id: 'backlog', name: 'Backlog', type: 'backlog', position: 0 },
      { id: 'triage', name: 'Triage', type: 'triage', position: 0 },
    ]);
    expect(sorted.map((state) => state.name)).toEqual(['Triage', 'Backlog', 'Todo', 'In Progress', 'In Review', 'Done']);
  });
});

describe('LinearClient: inline images', () => {
  it('sends the credential to uploads.linear.app and to no other host', async () => {
    const client = new LinearClient(apiKeyCredential());
    await client.downloadInlineImages(
      '![shot](https://uploads.linear.app/abc/shot.png)\n![logo](https://example.com/logo.png)',
    );
    expect(downloadFileSpy).toHaveBeenCalledTimes(2);
    const linearCall = downloadFileSpy.mock.calls.find(([url]) => url.startsWith('https://uploads.linear.app'));
    const otherCall = downloadFileSpy.mock.calls.find(([url]) => url.startsWith('https://example.com'));
    expect(linearCall?.[2]?.headers?.Authorization).toBe('lin_api_test');
    expect(otherCall?.[2]).toBeUndefined();
  });

  async function expectBearerFromRefresh(client: InstanceType<typeof LinearClient>): Promise<void> {
    refreshSpy.mockResolvedValue({ accessToken: 'access-new', refreshToken: 'refresh-new', expiresAt: new Date(Date.now() + 86_400_000).toISOString() });
    await client.downloadInlineImages('![shot](https://uploads.linear.app/abc/shot.png)');
    expect(refreshSpy).toHaveBeenCalledTimes(1);
    expect(refreshSpy).toHaveBeenCalledWith('refresh-old');
    expect(downloadFileSpy).toHaveBeenCalledTimes(1);
    expect(downloadFileSpy.mock.calls[0][2]?.headers?.Authorization).toBe('Bearer access-new');
  }

  it('refreshes an OAuth token near expiry before an uploads.linear.app download and sends it as Bearer', async () => {
    await expectBearerFromRefresh(new LinearClient(oauthCredential({ expiresAt: new Date(Date.now() + 60_000).toISOString() })));
  });

  it('treats an unparseable expiresAt as expired and refreshes', async () => {
    await expectBearerFromRefresh(new LinearClient(oauthCredential({ expiresAt: 'not-a-date' })));
  });

  it('skips a malformed image URL and counts it', async () => {
    const result = await new LinearClient(apiKeyCredential()).downloadInlineImages(
      '![bad](https://)\n![ok](https://example.com/ok.png)',
    );
    expect(result.skippedCount).toBe(1);
    expect(result.attachments).toHaveLength(1);
    expect(downloadFileSpy).toHaveBeenCalledTimes(1);
    expect(downloadFileSpy.mock.calls[0][0]).toBe('https://example.com/ok.png');
  });
});

function expiringOauthCredential(): LinearOAuthCredential {
  return oauthCredential({ expiresAt: new Date(Date.now() + 60_000).toISOString() });
}

/** Run a client call under fake timers to its end and hand back what it rejected with (or null). */
async function rejectionOf(promise: Promise<unknown>): Promise<unknown> {
  const outcome = promise.then(() => null, (error: unknown) => error);
  await vi.advanceTimersByTimeAsync(30_000);
  return outcome;
}

describe('LinearClient: a refresh that races or fails', () => {
  it('uses the credential another refresh already stored instead of spending the stale refresh token', async () => {
    loadSpy.mockResolvedValue(oauthCredential({
      accessToken: 'access-new',
      refreshToken: 'refresh-new',
      expiresAt: new Date(Date.now() + 24 * 60 * 60_000).toISOString(),
    }));
    fetchSpy.mockImplementation(async () => jsonResponse(200, { data: { viewer: VIEWER } }));
    await new LinearClient(expiringOauthCredential()).getViewer();
    expect(refreshSpy).not.toHaveBeenCalled();
    expect(authorizationOf(0)).toBe('Bearer access-new');
  });

  it('uses the API key a Connect stored in place of the OAuth sign-in being refreshed', async () => {
    loadSpy.mockResolvedValue(apiKeyCredential());
    fetchSpy.mockImplementation(async () => jsonResponse(200, { data: { viewer: VIEWER } }));
    await new LinearClient(expiringOauthCredential()).getViewer();
    expect(refreshSpy).not.toHaveBeenCalled();
    expect(authorizationOf(0)).toBe('lin_api_test');
  });

  it.each([429, 408, 503])('keeps the sign-in and rethrows when the refresh fails with %i', async (status) => {
    vi.useFakeTimers();
    refreshSpy.mockRejectedValue(new LinearError('Linear is busy', status));
    const error = await rejectionOf(new LinearClient(expiringOauthCredential()).getViewer());
    expect(error).toBeInstanceOf(LinearError);
    expect((error as InstanceType<typeof LinearError>).status).toBe(status);
    expect((error as Error).message).toBe('Linear is busy');
    expect(clearSpy).not.toHaveBeenCalled();
  });

  it('signs out when the refresh is refused with a 401', async () => {
    refreshSpy.mockRejectedValue(new LinearError('Client revoked', 401));
    await expect(new LinearClient(expiringOauthCredential()).getViewer()).rejects.toThrow('Client revoked');
    expect(clearSpy).toHaveBeenCalledTimes(1);
  });

  it('clears the refreshed credential when the retry after a refresh is refused again', async () => {
    const original = oauthCredential();
    const refreshedTokens = { accessToken: 'access-new', refreshToken: 'refresh-new', expiresAt: new Date(Date.now() + 86_400_000).toISOString() };
    refreshSpy.mockResolvedValue(refreshedTokens);
    // The refresh reads the stored original, then the clear reads back what the refresh saved.
    loadSpy
      .mockResolvedValueOnce(original)
      .mockResolvedValue({ ...original, ...refreshedTokens });
    fetchSpy.mockImplementation(async () => jsonResponse(401, UNAUTHENTICATED));
    await expect(new LinearClient(original).getViewer()).rejects.toThrow('Authentication required, not authenticated');
    expect(refreshSpy).toHaveBeenCalledTimes(1);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(clearSpy).toHaveBeenCalledTimes(1);
  });
});

describe('LinearClient: clearing a refused credential', () => {
  it('leaves a newer key a Connect saved mid-request, and a client that reads the store then uses it', async () => {
    // First read: the key the client sent. Every later read: the key a Connect saved meanwhile.
    loadSpy
      .mockResolvedValueOnce({ ...apiKeyCredential(), apiKey: 'lin_api_old' })
      .mockResolvedValue({ ...apiKeyCredential(), apiKey: 'lin_api_new' });
    fetchSpy
      .mockResolvedValueOnce(jsonResponse(401, UNAUTHENTICATED))
      .mockResolvedValueOnce(jsonResponse(200, { data: { viewer: VIEWER } }));
    const client = new LinearClient();
    await expect(client.getViewer()).rejects.toThrow('Authentication required, not authenticated');
    expect(clearSpy).not.toHaveBeenCalled();
    await expect(client.getViewer()).resolves.toEqual(VIEWER);
    expect(authorizationOf(0)).toBe('lin_api_old');
    expect(authorizationOf(1)).toBe('lin_api_new');
  });

  it('does not clear a different key for a client that was handed its credential, and reports not connected after', async () => {
    loadSpy.mockResolvedValue({ ...apiKeyCredential(), apiKey: 'lin_api_new' });
    fetchSpy.mockImplementation(async () => jsonResponse(401, UNAUTHENTICATED));
    const client = new LinearClient(apiKeyCredential());
    await expect(client.getViewer()).rejects.toThrow('Authentication required, not authenticated');
    expect(clearSpy).not.toHaveBeenCalled();
    // An injected client never rereads the store, so it drops what it was handed.
    await expect(client.getViewer()).rejects.toThrow('Not connected to Linear.');
  });

  it('keeps the Linear error when the credential file is locked', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    clearSpy.mockImplementation(() => { throw Object.assign(new Error('busy'), { code: 'EBUSY' }); });
    fetchSpy.mockImplementation(async () => jsonResponse(401, UNAUTHENTICATED));
    const error = await new LinearClient(apiKeyCredential()).getViewer().then(() => null, (rejected: unknown) => rejected);
    expect(error).toBeInstanceOf(LinearError);
    expect((error as Error).message).toBe('Authentication required, not authenticated');
    expect(clearSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    warnSpy.mockRestore();
  });
});

describe('LinearClient: failures and retries', () => {
  it('throws a LinearError, not a TypeError, for a JSON null body on a 500', async () => {
    vi.useFakeTimers();
    fetchSpy.mockImplementation(async () => new Response('null', { status: 500, headers: { 'content-type': 'application/json' } }));
    const error = await rejectionOf(new LinearClient(apiKeyCredential()).getViewer());
    expect(error).toBeInstanceOf(LinearError);
    expect((error as Error).message).toBe('Linear request failed (500)');
  });

  it('retries a 503 once it clears', async () => {
    vi.useFakeTimers();
    fetchSpy
      .mockImplementationOnce(async () => jsonResponse(503, { errors: [{ message: 'Service unavailable' }] }))
      .mockImplementationOnce(async () => jsonResponse(200, { data: { viewer: VIEWER } }));
    const viewerPromise = new LinearClient(apiKeyCredential()).getViewer();
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(viewerPromise).resolves.toEqual(VIEWER);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it('does not retry a plain 400 GraphQL error', async () => {
    fetchSpy.mockImplementation(async () => jsonResponse(400, {
      errors: [{ message: 'Variable "$first" got invalid value', extensions: { code: 'INVALID_INPUT' } }],
    }));
    await expect(new LinearClient(apiKeyCredential()).getViewer()).rejects.toThrow('Variable "$first" got invalid value');
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });
});

function issuesPage(hasNextPage: boolean, endCursor: string | null): Response {
  return jsonResponse(200, { data: { issues: { nodes: [], pageInfo: { hasNextPage, endCursor } } } });
}

function variablesOf(callIndex: number): { after: string | null } {
  return JSON.parse((fetchSpy.mock.calls[callIndex][1] as RequestInit).body as string).variables;
}

describe('LinearClient: paging', () => {
  it('refuses page 2 requested before page 1 without calling Linear', async () => {
    const client = new LinearClient(apiKeyCredential());
    const error = await client.listIssues('ENG', { page: 2 }).then(() => null, (rejected: unknown) => rejected);
    expect(error).toBeInstanceOf(RefusalError);
    expect((error as Error).message).toContain('page 2 was requested before page 1');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('starts a new page-1 walk from its own cursors', async () => {
    fetchSpy
      .mockImplementationOnce(async () => issuesPage(true, 'cursor-a'))
      .mockImplementationOnce(async () => issuesPage(true, 'cursor-b'))
      .mockImplementationOnce(async () => issuesPage(false, null));
    const client = new LinearClient(apiKeyCredential());
    await client.listIssues('ENG', { page: 1 });
    await client.listIssues('ENG', { page: 1 });
    await client.listIssues('ENG', { page: 2 });
    expect(variablesOf(2).after).toBe('cursor-b');
  });

  it('drops the previous walk\'s cursors when a new walk has no next page', async () => {
    fetchSpy
      .mockImplementationOnce(async () => issuesPage(true, 'cursor-a'))
      .mockImplementationOnce(async () => issuesPage(false, null));
    const client = new LinearClient(apiKeyCredential());
    await client.listIssues('ENG', { page: 1 });
    await client.listIssues('ENG', { page: 1 });
    await expect(client.listIssues('ENG', { page: 2 })).rejects.toBeInstanceOf(RefusalError);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it('keeps cursors for the 16 newest walks and drops the oldest', async () => {
    // CURSOR_CACHE_MAX_WALKS is 16 in client.ts. Every page-1 call answers cursor-<call number>.
    let callNumber = 0;
    fetchSpy.mockImplementation(async () => issuesPage(true, `cursor-${callNumber++}`));
    const client = new LinearClient(apiKeyCredential());
    for (let walk = 0; walk < 17; walk++) {
      await client.listIssues('ENG', { page: 1, since: `2026-11-${String(walk + 1).padStart(2, '0')}T00:00:00.000Z` });
    }
    await expect(client.listIssues('ENG', { page: 2, since: '2026-11-01T00:00:00.000Z' })).rejects.toBeInstanceOf(RefusalError);
    await client.listIssues('ENG', { page: 2, since: '2026-11-02T00:00:00.000Z' });
    expect(variablesOf(17).after).toBe('cursor-1');
    await client.listIssues('ENG', { page: 2, since: '2026-11-17T00:00:00.000Z' });
    expect(variablesOf(18).after).toBe('cursor-16');
  });

  it('follows pageInfo across two pages of teams and sorts them by name', async () => {
    fetchSpy
      .mockImplementationOnce(async () => jsonResponse(200, { data: { teams: {
        nodes: [{ id: 't-3', key: 'OPS', name: 'Operations' }, { id: 't-1', key: 'DES', name: 'Design' }],
        pageInfo: { hasNextPage: true, endCursor: 'teams-cursor' },
      } } }))
      .mockImplementationOnce(async () => jsonResponse(200, { data: { teams: {
        nodes: [{ id: 't-2', key: 'ENG', name: 'Engineering' }],
        pageInfo: { hasNextPage: false, endCursor: null },
      } } }));
    const teams = await new LinearClient(apiKeyCredential()).listTeams();
    expect(teams.map((team) => team.name)).toEqual(['Design', 'Engineering', 'Operations']);
    expect(variablesOf(0).after).toBeNull();
    expect(variablesOf(1).after).toBe('teams-cursor');
  });

  it('returns null from getTeam when no team has the key', async () => {
    fetchSpy.mockImplementation(async () => jsonResponse(200, { data: { teams: { nodes: [] } } }));
    await expect(new LinearClient(apiKeyCredential()).getTeam('NOPE')).resolves.toBeNull();
  });
});

/**
 * What a user loses without these: Linear's refresh token lasts 30 days from
 * the last refresh, and only an import refreshes. Someone who opens Kangentic
 * daily and imports monthly was signed out. And a keep-alive that renewed a
 * recent sign-in, or touched an API key, would spend a token request a day for
 * nothing.
 */
describe('LinearClient: keeping a sign-in alive', () => {
  const SAVED_AT = '2026-11-01T00:00:00.000Z';
  const EIGHT_DAYS_ON = Date.parse('2026-11-09T00:00:00.000Z');
  const SIX_DAYS_ON = Date.parse('2026-11-07T00:00:00.000Z');
  const renewedTokens = { accessToken: 'access-new', refreshToken: 'refresh-new', expiresAt: '2026-11-10T00:00:00.000Z' };

  it('renews a sign-in saved more than seven days ago, saves the new pair, and asks Linear for nothing else', async () => {
    loadSpy.mockResolvedValue(oauthCredential({ savedAt: SAVED_AT }));
    refreshSpy.mockResolvedValue(renewedTokens);
    await new LinearClient().keepSignInAlive(EIGHT_DAYS_ON);
    expect(refreshSpy).toHaveBeenCalledTimes(1);
    expect(refreshSpy).toHaveBeenCalledWith('refresh-old');
    expect(saveSpy).toHaveBeenCalledTimes(1);
    expect(saveSpy.mock.calls[0][0]).toMatchObject({ kind: 'oauth', ...renewedTokens });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('renews a sign-in whose save time does not parse, since its age is unknown', async () => {
    loadSpy.mockResolvedValue(oauthCredential({ savedAt: '' }));
    refreshSpy.mockResolvedValue(renewedTokens);
    await new LinearClient().keepSignInAlive(EIGHT_DAYS_ON);
    expect(refreshSpy).toHaveBeenCalledTimes(1);
  });

  it('leaves a recent sign-in, an API key and no sign-in alone', async () => {
    loadSpy.mockResolvedValue(oauthCredential({ savedAt: SAVED_AT }));
    await new LinearClient().keepSignInAlive(SIX_DAYS_ON);
    loadSpy.mockResolvedValue({ ...apiKeyCredential(), savedAt: SAVED_AT });
    await new LinearClient().keepSignInAlive(EIGHT_DAYS_ON);
    loadSpy.mockResolvedValue(null);
    await new LinearClient().keepSignInAlive(EIGHT_DAYS_ON);
    expect(refreshSpy).not.toHaveBeenCalled();
    expect(saveSpy).not.toHaveBeenCalled();
    expect(clearSpy).not.toHaveBeenCalled();
  });

  it('forgets a sign-in whose refresh token Linear refuses, and does not throw', async () => {
    loadSpy.mockResolvedValue(oauthCredential({ savedAt: SAVED_AT }));
    refreshSpy.mockRejectedValue(new LinearError('Client revoked', 401));
    await expect(new LinearClient().keepSignInAlive(EIGHT_DAYS_ON)).resolves.toBeUndefined();
    expect(clearSpy).toHaveBeenCalledTimes(1);
  });

  it('keeps the sign-in and rethrows when Linear is busy, so the pass can report it', async () => {
    loadSpy.mockResolvedValue(oauthCredential({ savedAt: SAVED_AT }));
    refreshSpy.mockRejectedValue(new LinearError('Linear is busy', 503));
    const error = await new LinearClient().keepSignInAlive(EIGHT_DAYS_ON).then(() => null, (rejected: unknown) => rejected);
    expect(error).toBeInstanceOf(LinearError);
    expect(clearSpy).not.toHaveBeenCalled();
  });
});

describe('LinearClient: a real-shape issues response', () => {
  it('maps the fixture Linear\'s schema describes, nulls and all', async () => {
    const fixtureText = fs.readFileSync(path.join(__dirname, '..', 'fixtures', 'linear-issues-response.json'), 'utf8');
    fetchSpy.mockImplementation(async () => new Response(fixtureText, { status: 200, headers: { 'content-type': 'application/json' } }));
    const { issues, hasNextPage } = await new LinearClient(apiKeyCredential()).listIssues('ENG', { page: 1 });
    expect(hasNextPage).toBe(false);
    expect(issues).toHaveLength(3);

    const states = sortStatesInBoardOrder(issues.map((issue) => issue.state));
    const [inProgress, noPriority, closed] = mapLinearIssues(issues, stateOrderByIdFrom(states), new Set());

    expect(inProgress.displayId).toBe('ENG-101');
    expect(inProgress.externalSource).toBe('linear');
    expect(inProgress.assignee).toBe('dana');
    expect(inProgress.priority).toBe('High');
    expect(inProgress.labels).toEqual(['Bug', 'Backend']);
    expect(inProgress.stateCategory).toBe('open');
    expect(inProgress.attachmentCount).toBe(1);
    expect(inProgress.body).toContain('Deliveries that return a 5xx');
    expect(inProgress.body).toContain('- **Project**: Webhooks');
    expect(inProgress.body).toContain('- **Cycle**: Sprint 12');
    expect(inProgress.body).toContain('- **Estimate**: 3 points');
    expect(inProgress.body).toContain('- **Due**: 2026-12-01');

    expect(noPriority.displayId).toBe('ENG-102');
    expect(noPriority.assignee).toBeNull();
    expect('priority' in noPriority).toBe(false);
    expect(noPriority.labels).toEqual([]);
    expect(noPriority.body).toBe('');
    expect(noPriority.stateCategory).toBe('open');

    expect(closed.displayId).toBe('ENG-103');
    expect(closed.stateCategory).toBe('closed');
    expect(closed.assignee).toBe('sam');
    expect(closed.priority).toBe('Low');
    expect(closed.body).toContain('- **Cycle**: Cycle 11');
    expect(closed.body).toContain('- **Estimate**: 1 point');
    expect(closed.stateOrder).toBeGreaterThan(noPriority.stateOrder as number);
  });
});
