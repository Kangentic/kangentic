/**
 * The "is this GitLab" probe. It decides which pasted links Connect GitLab
 * opens for: a probe that says yes to GitHub would ask for a GitLab token for
 * github.com, and one that misses a path prefix would never find an instance
 * served under one. The bodies are the ones gitlab.com and github.com sent.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import {
  clearGitLabProbeCache,
  probeGitLabBase,
  probeGitLabServer,
} from '../../src/main/boards/adapters/gitlab/instance';

interface Route {
  status: number;
  body?: unknown;
}

/** A fetch that answers each URL from `routes`, 404 for anything else, and records what was asked. */
function fakeFetch(routes: Record<string, Route | 'network'>) {
  const asked: string[] = [];
  const fetchImpl = (async (input: string | URL | Request) => {
    const url = String(input);
    asked.push(url);
    const route = routes[url];
    if (route === 'network') {
      throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ENOTFOUND' } });
    }
    const answer = route ?? { status: 404, body: 'Not Found' };
    const text = typeof answer.body === 'string' ? answer.body : JSON.stringify(answer.body ?? {});
    return new Response(text, { status: answer.status });
  }) as typeof fetch;
  return { fetchImpl, asked };
}

beforeEach(() => clearGitLabProbeCache());

describe('probeGitLabServer', () => {
  it('never asks gitlab.com', async () => {
    const { fetchImpl, asked } = fakeFetch({});
    expect(await probeGitLabServer('https://gitlab.com', ['acme', 'web'], fetchImpl)).toEqual({ kind: 'gitlab', base: 'https://gitlab.com' });
    expect(asked).toEqual([]);
  });

  it("knows a self-managed server by GitLab's unauthenticated 401 body", async () => {
    const { fetchImpl } = fakeFetch({
      'https://git.example.com/api/v4/version': { status: 401, body: { message: '401 Unauthorized' } },
    });
    expect(await probeGitLabServer('https://git.example.com', ['platform', 'api'], fetchImpl))
      .toEqual({ kind: 'gitlab', base: 'https://git.example.com' });
  });

  it('refuses a server that answers 404, as github.com does', async () => {
    const { fetchImpl } = fakeFetch({});
    expect(await probeGitLabServer('https://github.com', ['acme', 'web'], fetchImpl)).toEqual({ kind: 'not-gitlab' });
  });

  it('refuses a 401 whose body is not GitLab JSON', async () => {
    const { fetchImpl } = fakeFetch({
      'https://sso.example.com/api/v4/version': { status: 401, body: '<html>Sign in</html>' },
    });
    expect(await probeGitLabServer('https://sso.example.com', ['acme', 'web'], fetchImpl)).toEqual({ kind: 'not-gitlab' });
  });

  it('finds an instance served under a path prefix, never using the last segment as one', async () => {
    const { fetchImpl, asked } = fakeFetch({
      'https://example.com/gitlab/api/v4/version': { status: 200, body: { version: '17.6.0' } },
    });
    expect(await probeGitLabServer('https://example.com', ['gitlab', 'acme', 'web'], fetchImpl))
      .toEqual({ kind: 'gitlab', base: 'https://example.com/gitlab' });
    expect(asked).toEqual(['https://example.com/api/v4/version', 'https://example.com/gitlab/api/v4/version']);
  });

  it('reports a server that does not answer as unreachable, with its errno', async () => {
    const { fetchImpl } = fakeFetch({ 'https://down.example.com/api/v4/version': 'network' });
    expect(await probeGitLabServer('https://down.example.com', ['acme', 'web'], fetchImpl))
      .toEqual({ kind: 'unreachable', detail: 'ENOTFOUND' });
  });
});

describe('probe cache', () => {
  const GITLAB_401: Route = { status: 401, body: { message: '401 Unauthorized' } };
  const URL_VERSION = 'https://cache.example.com/api/v4/version';

  it('asks a GitLab server once', async () => {
    const { fetchImpl, asked } = fakeFetch({ [URL_VERSION]: GITLAB_401 });
    expect(await probeGitLabBase('https://cache.example.com', fetchImpl)).toEqual({ kind: 'gitlab', base: 'https://cache.example.com' });
    expect(await probeGitLabBase('https://cache.example.com', fetchImpl)).toEqual({ kind: 'gitlab', base: 'https://cache.example.com' });
    expect(asked).toHaveLength(1);
  });

  it('keeps a not-GitLab 404 answer too', async () => {
    const { fetchImpl, asked } = fakeFetch({});
    expect(await probeGitLabBase('https://cache.example.com', fetchImpl)).toEqual({ kind: 'not-gitlab' });
    expect(await probeGitLabBase('https://cache.example.com', fetchImpl)).toEqual({ kind: 'not-gitlab' });
    expect(asked).toHaveLength(1);
  });

  it('does not keep a 502, so a server that recovers is found', async () => {
    const routes: Record<string, Route> = { [URL_VERSION]: { status: 502, body: 'Bad Gateway' } };
    const { fetchImpl, asked } = fakeFetch(routes);
    expect(await probeGitLabBase('https://cache.example.com', fetchImpl)).toEqual({ kind: 'not-gitlab' });
    routes[URL_VERSION] = GITLAB_401;
    expect(await probeGitLabBase('https://cache.example.com', fetchImpl)).toEqual({ kind: 'gitlab', base: 'https://cache.example.com' });
    expect(asked).toHaveLength(2);
  });

  it('does not keep a network failure', async () => {
    const { fetchImpl, asked } = fakeFetch({ [URL_VERSION]: 'network' });
    expect(await probeGitLabBase('https://cache.example.com', fetchImpl)).toEqual({ kind: 'unreachable', detail: 'ENOTFOUND' });
    expect(await probeGitLabBase('https://cache.example.com', fetchImpl)).toEqual({ kind: 'unreachable', detail: 'ENOTFOUND' });
    expect(asked).toHaveLength(2);
  });
});

describe('probeGitLabServer prefix walk', () => {
  it('stops at a prefix that times out instead of trying longer ones', async () => {
    const asked: string[] = [];
    const fetchImpl = (async (input: string | URL | Request) => {
      const url = String(input);
      asked.push(url);
      if (url.startsWith('https://example.com/gitlab/')) {
        throw Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' });
      }
      return new Response('Not Found', { status: 404 });
    }) as typeof fetch;
    expect(await probeGitLabServer('https://example.com', ['gitlab', 'acme', 'web'], fetchImpl)).toEqual({ kind: 'not-gitlab' });
    expect(asked).toEqual(['https://example.com/api/v4/version', 'https://example.com/gitlab/api/v4/version']);
  });
});

describe('probeGitLabBase', () => {
  it('checks the whole address the Server field names, prefix included', async () => {
    const { fetchImpl } = fakeFetch({
      'https://example.com/gitlab/api/v4/version': { status: 401, body: { message: '401 Unauthorized' } },
    });
    expect(await probeGitLabBase('https://example.com/gitlab', fetchImpl)).toEqual({ kind: 'gitlab', base: 'https://example.com/gitlab' });
    expect(await probeGitLabBase('https://example.com', fetchImpl)).toEqual({ kind: 'not-gitlab' });
  });
});
