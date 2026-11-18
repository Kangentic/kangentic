/**
 * The GitLab adapter end to end over a fake server: which pasted links open
 * Connect and which are refused, how a source is checked and named before it is
 * saved, a fetch page with the board's statuses, and where a sign-in is sent
 * when images download. The last is the one a regression would leak a token in.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DownloadedAttachment } from '../../src/main/boards/shared/types';

const downloadFileSpy = vi.hoisted(() => vi.fn<(url: string, filename: string, options?: { headers?: Record<string, string> }) => Promise<DownloadedAttachment | null>>());
vi.mock('../../src/main/boards/shared/download-file', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../src/main/boards/shared/download-file')>();
  return { ...original, downloadFile: downloadFileSpy };
});

const { GitLabAdapter } = await import('../../src/main/boards/adapters/gitlab/adapter');
const { clearGitLabProbeCache } = await import('../../src/main/boards/adapters/gitlab/instance');
const { clearGitLabRenewals } = await import('../../src/main/boards/adapters/gitlab/fresh-credential');
const { encodeGitLabRepository } = await import('../../src/main/boards/adapters/gitlab/url-parser');
const { RefusalError, SignInRefusedError } = await import('../../src/shared/refusal');
type GitLabCredential = import('../../src/main/boards/adapters/gitlab/credential-store').GitLabCredential;

const GITLAB_COM: GitLabCredential = { site: 'https://gitlab.com', method: 'token', secret: 'glpat-com', account: 'dev', savedAt: '2026-11-17T00:00:00.000Z' };
const SELF_MANAGED: GitLabCredential = { site: 'https://example.com/gitlab', method: 'token', secret: 'glpat-self', account: 'dev', savedAt: '2026-11-17T00:00:00.000Z' };

type Handler = (url: URL) => { status?: number; body?: unknown; headers?: Record<string, string> } | undefined;

function fakeServer(handler: Handler) {
  const requests: Array<{ url: string; authorization?: string }> = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const headers = (init?.headers ?? {}) as Record<string, string>;
    requests.push({ url: url.toString(), authorization: headers.Authorization });
    const answer = handler(url) ?? { status: 404, body: { message: '404 Not found' } };
    return new Response(JSON.stringify(answer.body ?? {}), { status: answer.status ?? 200, headers: answer.headers });
  }) as typeof fetch;
  return { fetchImpl, requests };
}

function adapterWith(credentials: Record<string, GitLabCredential>, handler: Handler) {
  const server = fakeServer(handler);
  const adapter = new GitLabAdapter({
    loadCredentials: async () => credentials,
    saveCredential: async () => {},
    fetchImpl: server.fetchImpl,
  });
  return { adapter, requests: server.requests };
}

beforeEach(() => {
  clearGitLabProbeCache();
  clearGitLabRenewals();
  downloadFileSpy.mockReset();
});

describe('getAuthStatus', () => {
  it('is connected for a link on a server with a saved sign-in', async () => {
    const { adapter } = adapterWith({ [GITLAB_COM.site]: GITLAB_COM }, () => undefined);
    expect(await adapter.getAuthStatus('https://gitlab.com/acme/web/-/issues')).toMatchObject({ connected: true, site: 'https://gitlab.com', account: 'dev' });
  });

  it('opens Connect with the server a GitLab link names', async () => {
    const { adapter } = adapterWith({}, (url) =>
      url.pathname === '/api/v4/version' ? { status: 401, body: { message: '401 Unauthorized' } } : undefined);
    expect(await adapter.getAuthStatus('https://git.example.com/platform/api')).toEqual({
      connected: false,
      reason: 'none',
      site: 'https://git.example.com',
      prefill: { site: 'git.example.com' },
    });
  });

  it('refuses a link whose server is not GitLab', async () => {
    const { adapter } = adapterWith({}, () => undefined);
    await expect(adapter.getAuthStatus('https://github.com/acme/web')).rejects.toThrow('github.com is not a GitLab instance.');
  });
});

describe('prepareSource', () => {
  it('names a project source and keeps the board a link named', async () => {
    const { adapter } = adapterWith({ [GITLAB_COM.site]: GITLAB_COM }, (url) => {
      if (url.pathname === '/api/v4/projects/acme%2Fweb') return { body: { id: 7, path_with_namespace: 'acme/web' } };
      if (url.pathname === '/api/v4/projects/7/boards/12') return { body: { id: 12, name: 'Development' } };
      return undefined;
    });
    const prepared = await adapter.prepareSource(encodeGitLabRepository({ base: 'https://gitlab.com', path: 'acme/web', board: '12' }));
    expect(prepared).toEqual({
      label: 'acme/web',
      repository: 'https://gitlab.com|acme/web|board=12',
      scopeKind: 'project',
      host: undefined,
    });
  });

  it("reads a self-managed link's path relative to the instance's prefix and names a group", async () => {
    const { adapter } = adapterWith({ [SELF_MANAGED.site]: SELF_MANAGED }, (url) => {
      if (url.pathname === '/gitlab/api/v4/groups/acme') return { body: { id: 3, full_path: 'acme' } };
      return undefined;
    });
    const prepared = await adapter.prepareSource(encodeGitLabRepository({ base: 'https://example.com', path: 'gitlab/acme' }));
    expect(prepared).toEqual({
      label: 'acme',
      repository: 'https://example.com/gitlab|acme',
      scopeKind: 'group',
      host: 'example.com/gitlab',
    });
  });

  it('refuses a board the project does not have', async () => {
    const { adapter } = adapterWith({ [GITLAB_COM.site]: GITLAB_COM }, (url) =>
      url.pathname === '/api/v4/projects/acme%2Fweb' ? { body: { id: 7, path_with_namespace: 'acme/web' } } : undefined);
    await expect(adapter.prepareSource('https://gitlab.com|acme/web|board=99')).rejects.toThrow('No board 99 in acme/web.');
  });

  it("refuses with GitLab's own text when the saved token is refused", async () => {
    const { adapter } = adapterWith({ [GITLAB_COM.site]: GITLAB_COM }, () => ({ status: 401, body: { message: '401 Unauthorized' } }));
    await expect(adapter.prepareSource('https://gitlab.com|acme/web')).rejects.toThrow('401 Unauthorized');
  });
});

describe('fetch', () => {
  it("maps a page with the default board's statuses", async () => {
    const { adapter } = adapterWith({ [GITLAB_COM.site]: GITLAB_COM }, (url) => {
      if (url.pathname === '/api/v4/projects/acme%2Fweb') return { body: { id: 7, path_with_namespace: 'acme/web' } };
      if (url.pathname === '/api/v4/projects/7/boards') {
        return { body: [{ id: 4, name: 'Development', lists: [{ id: 1, label: { name: 'workflow::doing' }, position: 0 }] }], headers: { 'x-next-page': '' } };
      }
      if (url.pathname === '/api/v4/projects/7/issues') {
        return {
          body: [{
            id: 155001, iid: 214, project_id: 7, title: 'Retry', state: 'opened', labels: ['workflow::doing'],
            web_url: 'https://gitlab.com/acme/web/-/work_items/214', created_at: '2026-11-10T00:00:00.000Z', updated_at: '2026-11-15T00:00:00.000Z',
            type: 'ISSUE', references: { full: 'acme/web#214', relative: '#214' },
          }],
          headers: { 'x-next-page': '' },
        };
      }
      return undefined;
    });
    const result = await adapter.fetch(
      { source: 'gitlab', repository: 'https://gitlab.com|acme/web', page: 1, perPage: 100, state: 'all' },
      () => new Set(['gitlab.com:155001']),
    );
    expect(result.hasNextPage).toBe(false);
    expect(result.issues).toHaveLength(1);
    expect(result.issues[0]).toMatchObject({ displayId: '#214', state: 'workflow::doing', stateOrder: 1, alreadyImported: true });
  });
});

/** A fake server that also logs each request's method and body, and records every save. */
function recordingAdapter(credentials: Record<string, GitLabCredential>, handler: (url: URL, method: string, body: string | undefined) => ReturnType<Handler>) {
  const requests: Array<{ url: URL; method: string; body?: string; authorization?: string }> = [];
  const saved: GitLabCredential[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const method = init?.method ?? 'GET';
    const body = typeof init?.body === 'string' ? init.body : undefined;
    requests.push({ url, method, body, authorization: headers.Authorization });
    const answer = handler(url, method, body) ?? { status: 404, body: { message: '404 Not found' } };
    return new Response(JSON.stringify(answer.body ?? {}), { status: answer.status ?? 200, headers: answer.headers });
  }) as typeof fetch;
  const adapter = new GitLabAdapter({
    loadCredentials: async () => credentials,
    saveCredential: async (credential) => { saved.push(credential); },
    fetchImpl,
  });
  return { adapter, requests, saved };
}

function expiringOauthCredential(): GitLabCredential {
  return {
    site: 'https://gitlab.com',
    method: 'oauth',
    secret: 'old-access',
    refreshToken: 'old-refresh',
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    account: 'dev',
    savedAt: '2026-11-17T00:00:00.000Z',
  };
}

const RENEWED_TOKENS = { access_token: 'new-access', refresh_token: 'new-refresh', expires_in: 7200, token_type: 'Bearer' };

describe('sign-in renewal', () => {
  it('renews a lapsing browser sign-in, saves the new pair, and signs the next request with it', async () => {
    const { adapter, requests, saved } = recordingAdapter({ 'https://gitlab.com': expiringOauthCredential() }, (url) => {
      if (url.pathname === '/oauth/token') return { body: RENEWED_TOKENS };
      if (url.pathname === '/api/v4/user') return { body: { id: 1, username: 'dev' } };
      return undefined;
    });
    expect(await adapter.checkPrerequisites('https://gitlab.com|acme/web')).toEqual({ cliOk: true, authOk: true });

    const tokenRequest = requests.find((request) => request.url.pathname === '/oauth/token');
    expect(tokenRequest?.method).toBe('POST');
    expect(tokenRequest?.url.origin).toBe('https://gitlab.com');
    const form = new URLSearchParams(tokenRequest?.body);
    expect(form.get('grant_type')).toBe('refresh_token');
    expect(form.get('refresh_token')).toBe('old-refresh');
    expect(saved).toHaveLength(1);
    expect(saved[0]).toMatchObject({ secret: 'new-access', refreshToken: 'new-refresh', site: 'https://gitlab.com' });
    expect(requests.find((request) => request.url.pathname === '/api/v4/user')?.authorization).toBe('Bearer new-access');
  });

  it('renews on a fetch too, so the issues request carries the new access token', async () => {
    const { adapter, requests, saved } = recordingAdapter({ 'https://gitlab.com': expiringOauthCredential() }, (url) => {
      if (url.pathname === '/oauth/token') return { body: RENEWED_TOKENS };
      if (url.pathname === '/api/v4/projects/acme%2Fweb') return { body: { id: 7, path_with_namespace: 'acme/web' } };
      if (url.pathname === '/api/v4/projects/7/boards') return { body: [], headers: { 'x-next-page': '' } };
      if (url.pathname === '/api/v4/projects/7/issues') return { body: [], headers: { 'x-next-page': '' } };
      return undefined;
    });
    await adapter.fetch({ source: 'gitlab', repository: 'https://gitlab.com|acme/web', page: 1, perPage: 50, state: 'all' }, () => new Set());
    expect(saved.map((credential) => credential.refreshToken)).toEqual(['new-refresh']);
    const apiRequests = requests.filter((request) => request.url.pathname.startsWith('/api/v4/'));
    expect(apiRequests.length).toBeGreaterThan(0);
    for (const request of apiRequests) expect(request.authorization).toBe('Bearer new-access');
  });

  it('reports a refused renewal as a refused sign-in with GitLab\'s text, and saves nothing', async () => {
    const description = 'The provided authorization grant is invalid, expired, revoked, does not match the redirection URI used in the authorization request, or was issued to another client.';
    const { adapter, saved } = recordingAdapter({ 'https://gitlab.com': expiringOauthCredential() }, (url) =>
      url.pathname === '/oauth/token' ? { status: 400, body: { error: 'invalid_grant', error_description: description } } : undefined);
    expect(await adapter.checkPrerequisites('https://gitlab.com|acme/web')).toEqual({ cliOk: true, authOk: false, message: description });
    expect(saved).toEqual([]);
  });
});

/**
 * What a user loses without these: a browser sign-in nobody imports from is
 * renewed only when its two-hour access token is asked for, so nothing kept it
 * fresh between imports. And a keep-alive that renewed a personal access token,
 * or a sign-in renewed yesterday, would ask gitlab.com for a token pair for nothing.
 */
describe('keepSignInAlive', () => {
  const SAVED_AT = '2026-11-01T00:00:00.000Z';
  const EIGHT_DAYS_ON = Date.parse('2026-11-09T00:00:00.000Z');
  const SIX_DAYS_ON = Date.parse('2026-11-07T00:00:00.000Z');

  /** A sign-in whose access token is hours from lapsing, so only its age makes it due. */
  function idleOauthCredential(): GitLabCredential {
    return { ...expiringOauthCredential(), expiresAt: new Date(EIGHT_DAYS_ON + 90 * 60_000).toISOString(), savedAt: SAVED_AT };
  }

  it('renews a sign-in saved more than seven days ago and saves the new pair, with no API call', async () => {
    const { adapter, requests, saved } = recordingAdapter({ 'https://gitlab.com': idleOauthCredential() }, (url) =>
      url.pathname === '/oauth/token' ? { body: RENEWED_TOKENS } : undefined);
    await adapter.keepSignInAlive(EIGHT_DAYS_ON);
    expect(requests.map((request) => request.url.pathname)).toEqual(['/oauth/token']);
    expect(new URLSearchParams(requests[0].body).get('refresh_token')).toBe('old-refresh');
    expect(saved).toHaveLength(1);
    expect(saved[0]).toMatchObject({ secret: 'new-access', refreshToken: 'new-refresh' });
  });

  it('leaves a recent sign-in and a personal access token alone', async () => {
    const recent = recordingAdapter({ 'https://gitlab.com': idleOauthCredential() }, () => undefined);
    await recent.adapter.keepSignInAlive(SIX_DAYS_ON);
    const token = recordingAdapter({ 'https://gitlab.com': { ...GITLAB_COM, savedAt: SAVED_AT } }, () => undefined);
    await token.adapter.keepSignInAlive(EIGHT_DAYS_ON);
    expect(recent.requests).toEqual([]);
    expect(token.requests).toEqual([]);
  });

  it('resolves when GitLab refuses the renewal, and saves nothing', async () => {
    const { adapter, saved } = recordingAdapter({ 'https://gitlab.com': idleOauthCredential() }, (url) =>
      url.pathname === '/oauth/token' ? { status: 400, body: { error: 'invalid_grant' } } : undefined);
    await expect(adapter.keepSignInAlive(EIGHT_DAYS_ON)).resolves.toBeUndefined();
    expect(saved).toEqual([]);
  });

  it('throws a failure nobody expected, so the pass can report it', async () => {
    const { adapter } = recordingAdapter({ 'https://gitlab.com': idleOauthCredential() }, (url) =>
      url.pathname === '/oauth/token' ? { status: 503, body: {} } : undefined);
    await expect(adapter.keepSignInAlive(EIGHT_DAYS_ON)).rejects.toMatchObject({ status: 503 });
  });
});

describe('checkPrerequisites', () => {
  it('reads a 401 from the user endpoint as a refused token, with GitLab\'s text', async () => {
    const { adapter } = adapterWith({ [GITLAB_COM.site]: GITLAB_COM }, (url) =>
      url.pathname === '/api/v4/user' ? { status: 401, body: { message: '401 Unauthorized' } } : undefined);
    expect(await adapter.checkPrerequisites('https://gitlab.com|acme/web')).toEqual({ cliOk: true, authOk: false, message: '401 Unauthorized' });
  });

  it('does not call a server error a sign-in problem', async () => {
    const { adapter } = adapterWith({ [GITLAB_COM.site]: GITLAB_COM }, (url) =>
      url.pathname === '/api/v4/user' ? { status: 500, body: { message: '500 Internal Server Error' }, headers: { 'retry-after': '0' } } : undefined);
    expect(await adapter.checkPrerequisites('https://gitlab.com|acme/web')).toEqual({ cliOk: true, authOk: true });
  });
});

describe('refusals', () => {
  it('refuses a fetch with no saved sign-in for the server', async () => {
    const { adapter } = adapterWith({}, () => undefined);
    await expect(adapter.fetch(
      { source: 'gitlab', repository: 'https://gitlab.com|acme/web', page: 1, perPage: 100, state: 'all' },
      () => new Set(),
    )).rejects.toThrow('Not connected to gitlab.com.');
  });

  it('says a self-managed server could not be reached when it does not answer', async () => {
    const unreachable = (async () => {
      throw Object.assign(new Error('fetch failed'), { cause: { code: 'ENOTFOUND' } });
    }) as typeof fetch;
    const adapter = new GitLabAdapter({ loadCredentials: async () => ({}), saveCredential: async () => {}, fetchImpl: unreachable });
    await expect(adapter.getAuthStatus('https://git.example.com/platform/api')).rejects.toThrow("Couldn't reach git.example.com.");
  });

  // Add Source acts on the class: a refused sign-in reopens Connect, in GitLab's own words,
  // and a source GitLab cannot find must not.
  it('marks a 401 on a source check as the saved sign-in being refused, and a 404 as a plain refusal', async () => {
    const refused = adapterWith({ 'https://gitlab.com': GITLAB_COM }, () => ({ status: 401, body: { message: '401 Unauthorized' } }));
    const signInError = await refused.adapter.prepareSource(encodeGitLabRepository({ base: 'https://gitlab.com', path: 'acme/web' }))
      .then(() => null, (error: unknown) => error);
    expect(signInError).toBeInstanceOf(SignInRefusedError);
    expect((signInError as Error).message).toBe('401 Unauthorized');

    const missing = adapterWith({ 'https://gitlab.com': GITLAB_COM }, () => ({ status: 404, body: { message: '404 Project Not Found' } }));
    const sourceError = await missing.adapter.prepareSource(encodeGitLabRepository({ base: 'https://gitlab.com', path: 'acme/web' }))
      .then(() => null, (error: unknown) => error);
    expect(sourceError).toBeInstanceOf(RefusalError);
    expect(sourceError).not.toBeInstanceOf(SignInRefusedError);
  });
});

describe('fetch paging', () => {
  const projectHandler = (url: URL): ReturnType<Handler> => {
    if (url.pathname === '/api/v4/projects/acme%2Fweb') return { body: { id: 7, path_with_namespace: 'acme/web' } };
    if (url.pathname === '/api/v4/projects/7/boards') {
      return { body: [{ id: 4, name: 'Development', lists: [{ id: 1, label: { name: 'workflow::doing' }, position: 0 }] }], headers: { 'x-next-page': '' } };
    }
    if (url.pathname === '/api/v4/projects/7/issues') return { body: [], headers: { 'x-next-page': url.searchParams.get('page') === '1' ? '2' : '' } };
    return undefined;
  };
  const pageInput = (page: number) => ({ source: 'gitlab' as const, repository: 'https://gitlab.com|acme/web', page, perPage: 100, state: 'all' as const });

  it('looks up the project and the boards on the first page only', async () => {
    const { adapter, requests } = adapterWith({ [GITLAB_COM.site]: GITLAB_COM }, projectHandler);
    const firstPage = await adapter.fetch(pageInput(1), () => new Set());
    expect(firstPage.hasNextPage).toBe(true);
    const countOf = (suffix: string) => requests.filter((request) => new URL(request.url).pathname === suffix).length;
    expect(countOf('/api/v4/projects/acme%2Fweb')).toBe(1);
    expect(countOf('/api/v4/projects/7/boards')).toBe(1);

    const secondPage = await adapter.fetch(pageInput(2), () => new Set());
    expect(secondPage.hasNextPage).toBe(false);
    expect(countOf('/api/v4/projects/acme%2Fweb')).toBe(1);
    expect(countOf('/api/v4/projects/7/boards')).toBe(1);
    expect(countOf('/api/v4/projects/7/issues')).toBe(2);
  });

  it('shows Open and Closed only when the account cannot read boards', async () => {
    const { adapter } = adapterWith({ [GITLAB_COM.site]: GITLAB_COM }, (url) => {
      if (url.pathname === '/api/v4/projects/7/boards') return { status: 403, body: { message: '403 Forbidden' } };
      if (url.pathname === '/api/v4/projects/7/issues') {
        return {
          body: [{
            id: 155002, iid: 215, project_id: 7, title: 'Scoped', state: 'opened', labels: ['workflow::doing'],
            web_url: 'https://gitlab.com/acme/web/-/work_items/215', created_at: '2026-11-10T00:00:00.000Z', updated_at: '2026-11-15T00:00:00.000Z',
            type: 'ISSUE', references: { full: 'acme/web#215', relative: '#215' },
          }],
          headers: { 'x-next-page': '' },
        };
      }
      return projectHandler(url);
    });
    const result = await adapter.fetch(pageInput(1), () => new Set());
    expect(result.issues).toHaveLength(1);
    expect(result.issues[0].state).not.toBe('workflow::doing');
  });

  it('clamps the page size to GitLab\'s 100 and sends since as updated_after', async () => {
    const { adapter, requests } = adapterWith({ [GITLAB_COM.site]: GITLAB_COM }, projectHandler);
    await adapter.fetch({ ...pageInput(1), perPage: 500, since: '2026-11-01T00:00:00.000Z' }, () => new Set());
    const issuesRequest = requests.map((request) => new URL(request.url)).find((url) => url.pathname === '/api/v4/projects/7/issues');
    expect(issuesRequest?.searchParams.get('per_page')).toBe('100');
    expect(issuesRequest?.searchParams.get('updated_after')).toBe('2026-11-01T00:00:00.000Z');
  });

  it('asks for already imported issues by gitlab.com:<issue id> and flags the ones it returns', async () => {
    const issue = (id: number, iid: number) => ({
      id, iid, project_id: 7, title: `Issue ${iid}`, state: 'opened', labels: [],
      web_url: `https://gitlab.com/acme/web/-/work_items/${iid}`, created_at: '2026-11-10T00:00:00.000Z', updated_at: '2026-11-15T00:00:00.000Z',
      type: 'ISSUE', references: { full: `acme/web#${iid}`, relative: `#${iid}` },
    });
    const { adapter } = adapterWith({ [GITLAB_COM.site]: GITLAB_COM }, (url) =>
      url.pathname === '/api/v4/projects/7/issues'
        ? { body: [issue(155001, 214), issue(155002, 215)], headers: { 'x-next-page': '' } }
        : projectHandler(url));
    const asked: string[][] = [];
    const result = await adapter.fetch(pageInput(1), (source, externalIds) => {
      expect(source).toBe('gitlab');
      asked.push(externalIds);
      return new Set(['gitlab.com:155002']);
    });
    expect(asked).toEqual([['gitlab.com:155001', 'gitlab.com:155002']]);
    expect(result.issues.map((entry) => entry.alreadyImported)).toEqual([false, true]);
  });
});

describe('downloadImages', () => {
  const downloaded: DownloadedAttachment = { filename: 'image.png', data: 'AAAA', mediaType: 'application/octet-stream', sizeBytes: 3, sourceUrl: 'x' };

  it('renews a lapsing sign-in once across every batch of uploads, never re-sending the revoked refresh token', async () => {
    downloadFileSpy.mockResolvedValue(downloaded);
    const { adapter, requests, saved } = recordingAdapter({ 'https://gitlab.com': expiringOauthCredential() }, (url) => {
      if (url.pathname === '/oauth/token') return { body: RENEWED_TOKENS };
      if (url.pathname === '/api/v4/projects/acme%2Fweb') return { body: { id: 7 } };
      return undefined;
    });
    // Seven images is three batches at DOWNLOAD_CONCURRENCY 3, all off one read of the credentials.
    const markdown = Array.from({ length: 7 }, (_unused, index) =>
      `![shot](https://gitlab.com/acme/web/uploads/6c4e4afce4d7683cf08f0434e15444e${index}/shot-${index}.png)`).join(' ');
    const result = await adapter.downloadImages(markdown);

    expect(result.attachments).toHaveLength(7);
    expect(requests.filter((request) => request.url.pathname === '/oauth/token')).toHaveLength(1);
    expect(saved).toHaveLength(1);
    expect(downloadFileSpy).toHaveBeenCalledTimes(7);
    for (const call of downloadFileSpy.mock.calls) {
      expect(call[2]).toEqual({ headers: { Authorization: 'Bearer new-access' } });
    }
  });

  it('downloads an upload through the uploads API with its own server\'s sign-in only', async () => {
    downloadFileSpy.mockResolvedValue(downloaded);
    const { adapter } = adapterWith({ [GITLAB_COM.site]: GITLAB_COM, [SELF_MANAGED.site]: SELF_MANAGED }, (url) =>
      url.pathname === '/gitlab/api/v4/projects/platform%2Fapi' ? { body: { id: 42 } } : undefined);
    const uploadUrl = 'https://example.com/gitlab/platform/api/uploads/6c4e4afce4d7683cf08f0434e15444e4/image.png';
    const result = await adapter.downloadImages(`![image](${uploadUrl}) ![other](https://cdn.example.org/shot.png)`);

    expect(downloadFileSpy).toHaveBeenCalledTimes(2);
    expect(downloadFileSpy).toHaveBeenCalledWith(
      'https://example.com/gitlab/api/v4/projects/42/uploads/6c4e4afce4d7683cf08f0434e15444e4/image.png',
      'image.png',
      { headers: { Authorization: 'Bearer glpat-self' } },
    );
    // An image on any other host goes with no sign-in at all.
    expect(downloadFileSpy).toHaveBeenCalledWith('https://cdn.example.org/shot.png', 'shot.png');
    expect(result.attachments[0]).toMatchObject({ sourceUrl: uploadUrl, mediaType: 'image/png' });
  });

  it('counts an upload an older server will not serve as skipped, leaving its link', async () => {
    downloadFileSpy.mockResolvedValue(null);
    const { adapter } = adapterWith({ [GITLAB_COM.site]: GITLAB_COM }, (url) =>
      url.pathname === '/api/v4/projects/acme%2Fweb' ? { body: { id: 7 } } : undefined);
    const result = await adapter.downloadImages('![image](https://gitlab.com/acme/web/uploads/6c4e4afce4d7683cf08f0434e15444e4/image.png)');
    expect(result).toEqual({ attachments: [], skippedCount: 1 });
  });
});
