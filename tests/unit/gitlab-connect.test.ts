/**
 * Connect GitLab in main: a token or a browser sign-in is checked against the
 * server and saved only when GitLab accepts it, GitLab's refusal comes back with
 * its own text, and a browser sign-in is renewed and saved before it lapses.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn() },
  shell: { openExternal: vi.fn() },
}));

const constants = vi.hoisted(() => ({ clientId: '' }));
vi.mock('../../src/main/boards/adapters/gitlab/constants', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../src/main/boards/adapters/gitlab/constants')>();
  return {
    ...original,
    get GITLAB_COM_OAUTH_CLIENT_ID() {
      return constants.clientId;
    },
  };
});

const { connectGitLabToken, detectGitLabServer, signInToGitLab } = await import('../../src/main/boards/adapters/gitlab/ipc-handlers');
const { clearGitLabProbeCache } = await import('../../src/main/boards/adapters/gitlab/instance');
const { freshCredential, clearGitLabRenewals } = await import('../../src/main/boards/adapters/gitlab/fresh-credential');
const { GitLabHttpError } = await import('../../src/main/boards/adapters/gitlab/gitlab-error');
const { normalizeServerBase } = await import('../../src/main/boards/adapters/gitlab/ipc-handlers');
type GitLabCredential = import('../../src/main/boards/adapters/gitlab/credential-store').GitLabCredential;

function fakeServer(answers: Record<string, { status: number; body: unknown }>) {
  const asked: string[] = [];
  const fetchImpl = (async (input: string | URL | Request) => {
    const url = String(input);
    asked.push(url);
    const answer = answers[url] ?? { status: 404, body: { message: '404 Not found' } };
    return new Response(JSON.stringify(answer.body), { status: answer.status });
  }) as typeof fetch;
  return { fetchImpl, asked };
}

beforeEach(() => {
  clearGitLabProbeCache();
  clearGitLabRenewals();
  constants.clientId = '';
});

describe('normalizeServerBase', () => {
  it('lowercases the host, adds https and drops a trailing slash', () => {
    expect(normalizeServerBase('Git.Example.com/gitlab/')).toBe('https://git.example.com/gitlab');
  });

  it('upgrades http to https', () => {
    expect(normalizeServerBase('http://gitlab.com')).toBe('https://gitlab.com');
  });

  it('returns null for text that is no address', () => {
    expect(normalizeServerBase('')).toBeNull();
  });
});

describe('detectGitLabServer', () => {
  it('offers the browser sign-in on gitlab.com only in a build with the client id', async () => {
    const { fetchImpl } = fakeServer({});
    expect(await detectGitLabServer('gitlab.com', fetchImpl)).toEqual({ ok: true, site: 'https://gitlab.com', isGitLabCom: true, signInAvailable: false });
    constants.clientId = 'registered-client-id';
    expect(await detectGitLabServer('https://gitlab.com/', fetchImpl)).toMatchObject({ signInAvailable: true });
  });

  it('never offers it on a self-managed server', async () => {
    constants.clientId = 'registered-client-id';
    const { fetchImpl } = fakeServer({ 'https://git.example.com/api/v4/version': { status: 401, body: { message: '401 Unauthorized' } } });
    expect(await detectGitLabServer('git.example.com', fetchImpl)).toEqual({ ok: true, site: 'https://git.example.com', isGitLabCom: false, signInAvailable: false });
  });

  it('says when the server is not GitLab', async () => {
    const { fetchImpl } = fakeServer({});
    expect(await detectGitLabServer('github.com', fetchImpl)).toEqual({ ok: false, code: 'not-gitlab', site: 'github.com' });
  });
});

describe('connectGitLabToken', () => {
  it('saves a token GitLab accepts, under the server, with the username', async () => {
    const saved: GitLabCredential[] = [];
    const { fetchImpl } = fakeServer({ 'https://gitlab.com/api/v4/user': { status: 200, body: { id: 1, username: 'dev' } } });
    const result = await connectGitLabToken({ site: 'gitlab.com', token: ' glpat-good ' }, fetchImpl, async (credential) => { saved.push(credential); });
    expect(result).toEqual({ ok: true, site: 'gitlab.com', account: 'dev' });
    expect(saved).toHaveLength(1);
    expect(saved[0]).toMatchObject({ site: 'https://gitlab.com', method: 'token', secret: 'glpat-good', account: 'dev' });
  });

  it("returns GitLab's refusal as sent and saves nothing", async () => {
    const save = vi.fn();
    const { fetchImpl } = fakeServer({ 'https://gitlab.com/api/v4/user': { status: 401, body: { message: '401 Unauthorized' } } });
    expect(await connectGitLabToken({ site: 'gitlab.com', token: 'glpat-bad' }, fetchImpl, save))
      .toEqual({ ok: false, code: 'rejected', site: 'gitlab.com', message: '401 Unauthorized' });
    expect(save).not.toHaveBeenCalled();
  });

  it('returns GitLab\'s scope refusal (403) with its description', async () => {
    const save = vi.fn();
    const description = 'The request requires higher privileges than provided by the access token.';
    const { fetchImpl } = fakeServer({
      'https://gitlab.com/api/v4/user': { status: 403, body: { error: 'insufficient_scope', error_description: description } },
    });
    expect(await connectGitLabToken({ site: 'gitlab.com', token: 'glpat-narrow' }, fetchImpl, save))
      .toMatchObject({ ok: false, code: 'rejected', message: description });
    expect(save).not.toHaveBeenCalled();
  });

  it('reports a network failure on the user call as unreachable with its errno', async () => {
    const save = vi.fn();
    const asked: string[] = [];
    const fetchImpl = (async (input: string | URL | Request) => {
      asked.push(String(input));
      throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } });
    }) as typeof fetch;
    expect(await connectGitLabToken({ site: 'gitlab.com', token: 'glpat-x' }, fetchImpl, save))
      .toMatchObject({ ok: false, code: 'unreachable', detail: 'ECONNREFUSED' });
    expect(asked[0]).toBe('https://gitlab.com/api/v4/user');
    expect(save).not.toHaveBeenCalled();
  });

  it('reports a 502 on the user call as unreachable with the status', async () => {
    const save = vi.fn();
    const { fetchImpl } = fakeServer({ 'https://gitlab.com/api/v4/user': { status: 502, body: { message: 'Bad Gateway' } } });
    expect(await connectGitLabToken({ site: 'gitlab.com', token: 'glpat-x' }, fetchImpl, save))
      .toMatchObject({ ok: false, code: 'unreachable', detail: '502' });
    expect(save).not.toHaveBeenCalled();
  });

  it('refuses an empty token before asking anyone', async () => {
    const { fetchImpl, asked } = fakeServer({});
    expect(await connectGitLabToken({ site: 'gitlab.com', token: '  ' }, fetchImpl)).toEqual({ ok: false, code: 'invalid' });
    expect(asked).toEqual([]);
  });
});

describe('signInToGitLab', () => {
  it('refuses a self-managed server and a build without the client id', async () => {
    expect(await signInToGitLab('https://gitlab.com')).toMatchObject({ ok: false, code: 'invalid' });
    constants.clientId = 'registered-client-id';
    expect(await signInToGitLab('https://git.example.com')).toMatchObject({ ok: false, code: 'invalid' });
  });

  it('saves the sign-in as an OAuth credential once GitLab accepts its token', async () => {
    constants.clientId = 'registered-client-id';
    const saved: GitLabCredential[] = [];
    const { fetchImpl } = fakeServer({ 'https://gitlab.com/api/v4/user': { status: 200, body: { id: 1, username: 'dev' } } });
    const result = await signInToGitLab('gitlab.com', {
      signIn: async () => ({ ok: true, tokens: { accessToken: 'access', refreshToken: 'refresh', expiresAt: '2026-11-17T02:00:00.000Z' } }),
      fetchImpl,
      save: async (credential) => { saved.push(credential); },
    });
    expect(result).toEqual({ ok: true, site: 'gitlab.com', account: 'dev' });
    expect(saved[0]).toMatchObject({ site: 'https://gitlab.com', method: 'oauth', secret: 'access', refreshToken: 'refresh' });
  });

  it('reports a failed sign-in with its message', async () => {
    constants.clientId = 'registered-client-id';
    expect(await signInToGitLab('gitlab.com', { signIn: async () => ({ ok: false, cancelled: false, error: 'boom' }) }))
      .toEqual({ ok: false, code: 'sign-in-failed', message: 'boom' });
  });

  it('reports a cancel as cancelled, not as a failure', async () => {
    constants.clientId = 'registered-client-id';
    expect(await signInToGitLab('gitlab.com', { signIn: async () => ({ ok: false, cancelled: true }) }))
      .toEqual({ ok: false, code: 'cancelled' });
  });
});

describe('freshCredential', () => {
  const OAUTH: GitLabCredential = {
    site: 'https://gitlab.com',
    method: 'oauth',
    secret: 'old-access',
    refreshToken: 'old-refresh',
    expiresAt: '2026-11-17T00:02:00.000Z',
    account: 'dev',
    savedAt: '2026-11-16T22:00:00.000Z',
  };
  const now = () => Date.parse('2026-11-17T00:00:00.000Z');

  it('renews a sign-in about to lapse once for overlapping callers, and saves the new pair first', async () => {
    const saved: GitLabCredential[] = [];
    let refreshCalls = 0;
    const fetchImpl = (async () => {
      refreshCalls++;
      return new Response(JSON.stringify({ access_token: 'new-access', refresh_token: 'new-refresh', expires_in: 7200 }), { status: 200 });
    }) as typeof fetch;
    const dependencies = { fetchImpl, save: async (credential: GitLabCredential) => { saved.push(credential); }, now };
    const [first, second] = await Promise.all([freshCredential(OAUTH, dependencies), freshCredential(OAUTH, dependencies)]);
    expect(refreshCalls).toBe(1);
    expect(first.secret).toBe('new-access');
    expect(second.refreshToken).toBe('new-refresh');
    expect(saved).toHaveLength(1);
  });

  it('hands a caller holding the replaced pair the renewed one without renewing again', async () => {
    let refreshCalls = 0;
    const fetchImpl = (async () => {
      refreshCalls++;
      return new Response(JSON.stringify({ access_token: 'new-access', refresh_token: 'new-refresh', expires_in: 7200 }), { status: 200 });
    }) as typeof fetch;
    const dependencies = { fetchImpl, save: async () => {}, now };
    await freshCredential(OAUTH, dependencies);
    const second = await freshCredential(OAUTH, dependencies);
    expect(refreshCalls).toBe(1);
    expect(second.secret).toBe('new-access');
    expect(second.refreshToken).toBe('new-refresh');
  });

  it('throws a revoked sign-in as a 401 with GitLab\'s text and saves nothing', async () => {
    const save = vi.fn();
    const fetchImpl = (async () => new Response(
      JSON.stringify({ error: 'invalid_grant', error_description: 'The provided authorization grant is invalid, expired, or revoked.' }),
      { status: 400 },
    )) as typeof fetch;
    const failure = await freshCredential(OAUTH, { fetchImpl, save, now }).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(GitLabHttpError);
    expect((failure as InstanceType<typeof GitLabHttpError>).status).toBe(401);
    expect((failure as InstanceType<typeof GitLabHttpError>).providerMessage).toBe('The provided authorization grant is invalid, expired, or revoked.');
    expect(save).not.toHaveBeenCalled();
  });

  it('leaves a token, and a sign-in with time left, as they are', async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    const dependencies = { fetchImpl, save: vi.fn(), now };
    const token: GitLabCredential = { ...OAUTH, method: 'token', refreshToken: undefined, expiresAt: undefined };
    expect(await freshCredential(token, dependencies)).toBe(token);
    const later = { ...OAUTH, expiresAt: '2026-11-17T01:00:00.000Z' };
    expect(await freshCredential(later, dependencies)).toBe(later);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
