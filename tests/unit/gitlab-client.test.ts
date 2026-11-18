/**
 * The GitLab REST client: how it signs requests in, what it does with GitLab's
 * error bodies (shown to people as sent), how it waits out a 429, and how it
 * pages. Error bodies are GitLab's own, read from gitlab.com and GitLab's source.
 */
import { describe, expect, it } from 'vitest';
import { GitLabClient, hasNextPage } from '../../src/main/boards/adapters/gitlab/client';
import { GitLabHttpError, gitLabMessageFrom } from '../../src/main/boards/adapters/gitlab/gitlab-error';
import { RefusalError } from '../../src/shared/refusal';
import { retryAfterMsFrom } from '../../src/main/boards/shared/rate-limit';
import type { GitLabCredential } from '../../src/main/boards/adapters/gitlab/credential-store';

const TOKEN_CREDENTIAL: GitLabCredential = {
  site: 'https://git.example.com',
  method: 'token',
  secret: 'glpat-test',
  account: 'dev',
  savedAt: '2026-11-17T00:00:00.000Z',
};

interface Answer {
  status?: number;
  body?: unknown;
  headers?: Record<string, string>;
}

/** A fetch that answers in order from `answers`, recording each request's URL and headers. */
function sequenceFetch(answers: Answer[]) {
  const requests: Array<{ url: string; headers: Record<string, string> }> = [];
  let index = 0;
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    requests.push({ url: String(input), headers: (init?.headers ?? {}) as Record<string, string> });
    const answer = answers[Math.min(index, answers.length - 1)];
    index++;
    return new Response(JSON.stringify(answer.body ?? {}), { status: answer.status ?? 200, headers: answer.headers });
  }) as typeof fetch;
  return { fetchImpl, requests };
}

describe('GitLabClient.request', () => {
  it('signs in with Authorization: Bearer, the header a cross-host redirect drops', async () => {
    const { fetchImpl, requests } = sequenceFetch([{ body: { id: 1, username: 'dev' } }]);
    await new GitLabClient(TOKEN_CREDENTIAL, fetchImpl).currentUser();
    expect(requests[0].url).toBe('https://git.example.com/api/v4/user');
    expect(requests[0].headers.Authorization).toBe('Bearer glpat-test');
    expect(requests[0].headers['PRIVATE-TOKEN']).toBeUndefined();
  });

  it.each([
    [401, { message: '401 Unauthorized' }, '401 Unauthorized'],
    [401, { error: 'invalid_token', error_description: 'Token is expired. You can either do re-authorization or token refresh.' }, 'Token is expired. You can either do re-authorization or token refresh.'],
    [403, { error: 'insufficient_scope', error_description: 'The request requires higher privileges than provided by the access token.', scope: 'api read_api' }, 'The request requires higher privileges than provided by the access token.'],
  ])('keeps GitLab\'s own text for a %i', async (status, body, message) => {
    const { fetchImpl } = sequenceFetch([{ status, body }]);
    const error = await new GitLabClient(TOKEN_CREDENTIAL, fetchImpl).currentUser().catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(GitLabHttpError);
    expect((error as GitLabHttpError).status).toBe(status);
    expect((error as GitLabHttpError).providerMessage).toBe(message);
  });

  it('waits out a 429 and tries again', async () => {
    const { fetchImpl, requests } = sequenceFetch([
      { status: 429, body: { message: 'Retry later' }, headers: { 'retry-after': '0' } },
      { body: { id: 1, username: 'dev' } },
    ]);
    const user = await new GitLabClient(TOKEN_CREDENTIAL, fetchImpl).currentUser();
    expect(user.username).toBe('dev');
    expect(requests).toHaveLength(2);
  });

  it('retries a 503 and succeeds on the next answer', async () => {
    const { fetchImpl, requests } = sequenceFetch([
      { status: 503, body: { message: 'Service Unavailable' }, headers: { 'retry-after': '0' } },
      { body: { id: 1, username: 'dev' } },
    ]);
    const user = await new GitLabClient(TOKEN_CREDENTIAL, fetchImpl).currentUser();
    expect(user.username).toBe('dev');
    expect(requests).toHaveLength(2);
  });

  it('gives up after three 500s with the last GitLabHttpError', async () => {
    const { fetchImpl, requests } = sequenceFetch([
      { status: 500, body: { message: '500 Internal Server Error' }, headers: { 'retry-after': '0' } },
    ]);
    const error = await new GitLabClient(TOKEN_CREDENTIAL, fetchImpl).currentUser().catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(GitLabHttpError);
    expect((error as GitLabHttpError).status).toBe(500);
    expect(requests).toHaveLength(3);
  });

  it('refuses a 200 whose body is a web page, naming the host', async () => {
    const htmlFetch = (async () => new Response('<html><body>Sign in to continue</body></html>', { status: 200 })) as typeof fetch;
    const error = await new GitLabClient(TOKEN_CREDENTIAL, htmlFetch).currentUser().catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(RefusalError);
    expect((error as RefusalError).message).toBe('git.example.com did not answer like GitLab.');
  });

  it('does not retry a 404', async () => {
    const { fetchImpl, requests } = sequenceFetch([{ status: 404, body: { message: '404 Project Not Found' } }]);
    await expect(new GitLabClient(TOKEN_CREDENTIAL, fetchImpl).projectId('acme/web')).rejects.toBeInstanceOf(GitLabHttpError);
    expect(requests).toHaveLength(1);
  });
});

describe('GitLabClient.resolveNamespace', () => {
  it('reads a project first', async () => {
    const { fetchImpl, requests } = sequenceFetch([{ body: { id: 7, path_with_namespace: 'acme/web' } }]);
    expect(await new GitLabClient(TOKEN_CREDENTIAL, fetchImpl).resolveNamespace('acme/web'))
      .toEqual({ kind: 'project', id: 7, fullPath: 'acme/web' });
    expect(requests[0].url).toBe('https://git.example.com/api/v4/projects/acme%2Fweb');
  });

  it('falls back to a group when no project has the path', async () => {
    const { fetchImpl, requests } = sequenceFetch([
      { status: 404, body: { message: '404 Project Not Found' } },
      { body: { id: 3, full_path: 'acme' } },
    ]);
    expect(await new GitLabClient(TOKEN_CREDENTIAL, fetchImpl).resolveNamespace('acme'))
      .toEqual({ kind: 'group', id: 3, fullPath: 'acme' });
    expect(requests[1].url).toBe('https://git.example.com/api/v4/groups/acme');
  });

  it('answers null when neither exists', async () => {
    const { fetchImpl } = sequenceFetch([{ status: 404 }, { status: 404 }]);
    expect(await new GitLabClient(TOKEN_CREDENTIAL, fetchImpl).resolveNamespace('nobody/here')).toBeNull();
  });
});

describe('paging', () => {
  it('follows x-next-page, and an empty one ends the list', () => {
    expect(hasNextPage(new Headers({ 'x-next-page': '2' }), 100, 100)).toBe(true);
    expect(hasNextPage(new Headers({ 'x-next-page': '' }), 100, 100)).toBe(false);
  });

  it('reads a full page as more when a proxy stripped the header', () => {
    expect(hasNextPage(new Headers(), 100, 100)).toBe(true);
    expect(hasNextPage(new Headers(), 40, 100)).toBe(false);
  });

  it('refuses a 200 whose JSON is an object, not a list', async () => {
    const { fetchImpl } = sequenceFetch([{ body: { message: 'not a list' } }]);
    const error = await new GitLabClient(TOKEN_CREDENTIAL, fetchImpl).paginate('/projects/7/boards').catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(RefusalError);
    expect((error as RefusalError).message).toBe('git.example.com did not answer like GitLab.');
  });

  it('asks for every state, newest change first, and passes the incremental watermark', async () => {
    const { fetchImpl, requests } = sequenceFetch([{ body: [], headers: { 'x-next-page': '' } }]);
    await new GitLabClient(TOKEN_CREDENTIAL, fetchImpl).issuesPage(
      { kind: 'group', id: 3 },
      { page: 2, perPage: 50, updatedAfter: '2026-11-01T00:00:00.000Z' },
    );
    const url = new URL(requests[0].url);
    expect(url.pathname).toBe('/api/v4/groups/3/issues');
    expect(Object.fromEntries(url.searchParams)).toEqual({
      state: 'all',
      scope: 'all',
      order_by: 'updated_at',
      sort: 'desc',
      per_page: '50',
      page: '2',
      updated_after: '2026-11-01T00:00:00.000Z',
    });
  });
});

describe('error helpers', () => {
  it('reads a field-error body', () => {
    expect(gitLabMessageFrom({ message: { state: ['is invalid'] } })).toBe('state is invalid');
  });

  it('reads Retry-After in seconds and as a date', () => {
    expect(retryAfterMsFrom('30')).toBe(30_000);
    expect(retryAfterMsFrom('Tue, 17 Nov 2026 00:00:10 GMT', Date.parse('Tue, 17 Nov 2026 00:00:00 GMT'))).toBe(10_000);
    expect(retryAfterMsFrom(null)).toBeUndefined();
  });
});
