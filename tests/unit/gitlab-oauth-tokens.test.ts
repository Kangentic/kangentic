/**
 * Unit tests for src/main/boards/adapters/gitlab/oauth-tokens.ts.
 *
 * The token endpoint is replaced by an injected fetch, so the request GitLab would
 * receive is captured and the response shapes are GitLab's own.
 */
import { describe, it, expect } from 'vitest';
import {
  exchangeGitLabAuthorizationCode,
  refreshGitLabAccessToken,
} from '../../src/main/boards/adapters/gitlab/oauth-tokens';
import { GitLabHttpError } from '../../src/main/boards/adapters/gitlab/gitlab-error';
import { GITLAB_COM_OAUTH_CLIENT_ID } from '../../src/main/boards/adapters/gitlab/constants';

interface CapturedRequest {
  url: string;
  method: string | undefined;
  contentType: string | undefined;
  form: URLSearchParams;
}

function fakeFetch(
  status: number,
  responseText: string,
): { fetchImpl: typeof fetch; requests: CapturedRequest[] } {
  const requests: CapturedRequest[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const headers = (init?.headers ?? {}) as Record<string, string>;
    requests.push({
      url: String(input),
      method: init?.method,
      contentType: headers['content-type'],
      form: new URLSearchParams(String(init?.body ?? '')),
    });
    return new Response(responseText, { status });
  }) as typeof fetch;
  return { fetchImpl, requests };
}

const TOKEN_RESPONSE = JSON.stringify({
  access_token: 'access-token-value',
  token_type: 'Bearer',
  expires_in: 7200,
  refresh_token: 'refresh-token-value',
  scope: 'read_api',
  created_at: 1700000000,
});

const TOKEN_RESPONSE_WITHOUT_EXPIRY = JSON.stringify({
  access_token: 'access-token-value',
  token_type: 'Bearer',
  refresh_token: 'refresh-token-value',
  scope: 'read_api',
  created_at: 1700000000,
});

const TWO_HOURS_MS = 2 * 60 * 60 * 1000;

async function catchError(action: Promise<unknown>): Promise<unknown> {
  try {
    await action;
  } catch (error) {
    return error;
  }
  throw new Error('expected the call to reject');
}

describe('exchangeGitLabAuthorizationCode', () => {
  it('posts the authorization_code form to the gitlab.com token endpoint', async () => {
    const { fetchImpl, requests } = fakeFetch(200, TOKEN_RESPONSE);

    const tokens = await exchangeGitLabAuthorizationCode(
      { code: 'the-code', codeVerifier: 'the-verifier', redirectUri: 'http://127.0.0.1:5555/callback' },
      fetchImpl,
    );

    expect(requests).toHaveLength(1);
    expect(requests[0].url).toBe('https://gitlab.com/oauth/token');
    expect(requests[0].method).toBe('POST');
    expect(requests[0].contentType).toBe('application/x-www-form-urlencoded');
    expect(Object.fromEntries(requests[0].form)).toEqual({
      grant_type: 'authorization_code',
      code: 'the-code',
      redirect_uri: 'http://127.0.0.1:5555/callback',
      client_id: GITLAB_COM_OAUTH_CLIENT_ID,
      code_verifier: 'the-verifier',
    });
    expect(tokens.accessToken).toBe('access-token-value');
    expect(tokens.refreshToken).toBe('refresh-token-value');
  });

  it('computes expiresAt from expires_in', async () => {
    const { fetchImpl } = fakeFetch(200, TOKEN_RESPONSE);
    const before = Date.now();

    const tokens = await exchangeGitLabAuthorizationCode(
      { code: 'c', codeVerifier: 'v', redirectUri: 'http://127.0.0.1:1/callback' },
      fetchImpl,
    );

    const expiresAtMs = new Date(tokens.expiresAt).getTime();
    expect(expiresAtMs).toBeGreaterThanOrEqual(before + 7200 * 1000);
    expect(expiresAtMs).toBeLessThanOrEqual(Date.now() + 7200 * 1000);
  });

  it('defaults expiresAt to about two hours out when the body has no expires_in', async () => {
    const { fetchImpl } = fakeFetch(200, TOKEN_RESPONSE_WITHOUT_EXPIRY);
    const before = Date.now();

    const tokens = await exchangeGitLabAuthorizationCode(
      { code: 'c', codeVerifier: 'v', redirectUri: 'http://127.0.0.1:1/callback' },
      fetchImpl,
    );

    const expiresAtMs = new Date(tokens.expiresAt).getTime();
    expect(expiresAtMs).toBeGreaterThanOrEqual(before + TWO_HOURS_MS);
    expect(expiresAtMs).toBeLessThanOrEqual(Date.now() + TWO_HOURS_MS);
  });

  it('throws GitLabHttpError with the provider description on a 400 invalid_grant', async () => {
    const description = 'The provided authorization grant is invalid, expired, revoked, does not match the redirection URI used in the authorization request, or was issued to another client.';
    const { fetchImpl } = fakeFetch(400, JSON.stringify({ error: 'invalid_grant', error_description: description }));

    const error = await catchError(exchangeGitLabAuthorizationCode(
      { code: 'c', codeVerifier: 'v', redirectUri: 'http://127.0.0.1:1/callback' },
      fetchImpl,
    ));

    expect(error).toBeInstanceOf(GitLabHttpError);
    expect((error as GitLabHttpError).status).toBe(400);
    expect((error as GitLabHttpError).providerMessage).toBe(description);
  });

  it('uses the error code when the body has no description', async () => {
    const { fetchImpl } = fakeFetch(400, JSON.stringify({ error: 'invalid_request' }));

    const error = await catchError(exchangeGitLabAuthorizationCode(
      { code: 'c', codeVerifier: 'v', redirectUri: 'http://127.0.0.1:1/callback' },
      fetchImpl,
    ));

    expect(error).toBeInstanceOf(GitLabHttpError);
    expect((error as GitLabHttpError).status).toBe(400);
    expect((error as GitLabHttpError).providerMessage).toBe('invalid_request');
  });

  it('throws GitLabHttpError with no provider message on a non-JSON 500', async () => {
    const { fetchImpl } = fakeFetch(500, '<html>Server Error</html>');

    const error = await catchError(exchangeGitLabAuthorizationCode(
      { code: 'c', codeVerifier: 'v', redirectUri: 'http://127.0.0.1:1/callback' },
      fetchImpl,
    ));

    expect(error).toBeInstanceOf(GitLabHttpError);
    expect((error as GitLabHttpError).status).toBe(500);
    expect((error as GitLabHttpError).providerMessage).toBeUndefined();
  });

  it('rejects a 200 body that lacks a refresh token', async () => {
    const { fetchImpl } = fakeFetch(200, JSON.stringify({ access_token: 'only-access', expires_in: 7200 }));

    const error = await catchError(exchangeGitLabAuthorizationCode(
      { code: 'c', codeVerifier: 'v', redirectUri: 'http://127.0.0.1:1/callback' },
      fetchImpl,
    ));

    expect(error).toBeInstanceOf(GitLabHttpError);
    expect((error as GitLabHttpError).status).toBe(200);
  });
});

describe('refreshGitLabAccessToken', () => {
  it('posts the refresh_token form and returns the replaced pair', async () => {
    const { fetchImpl, requests } = fakeFetch(200, TOKEN_RESPONSE);

    const tokens = await refreshGitLabAccessToken(
      { refreshToken: 'old-refresh-token', redirectUri: 'http://127.0.0.1:5555/callback' },
      fetchImpl,
    );

    expect(requests).toHaveLength(1);
    expect(requests[0].url).toBe('https://gitlab.com/oauth/token');
    expect(requests[0].method).toBe('POST');
    expect(requests[0].contentType).toBe('application/x-www-form-urlencoded');
    expect(Object.fromEntries(requests[0].form)).toEqual({
      grant_type: 'refresh_token',
      refresh_token: 'old-refresh-token',
      redirect_uri: 'http://127.0.0.1:5555/callback',
      client_id: GITLAB_COM_OAUTH_CLIENT_ID,
    });
    expect(tokens.accessToken).toBe('access-token-value');
    expect(tokens.refreshToken).toBe('refresh-token-value');
  });

  it('defaults expiresAt to about two hours out when the body has no expires_in', async () => {
    const { fetchImpl } = fakeFetch(200, TOKEN_RESPONSE_WITHOUT_EXPIRY);
    const before = Date.now();

    const tokens = await refreshGitLabAccessToken(
      { refreshToken: 'r', redirectUri: 'http://127.0.0.1:1/callback' },
      fetchImpl,
    );

    const expiresAtMs = new Date(tokens.expiresAt).getTime();
    expect(expiresAtMs).toBeGreaterThanOrEqual(before + TWO_HOURS_MS);
    expect(expiresAtMs).toBeLessThanOrEqual(Date.now() + TWO_HOURS_MS);
  });

  it('throws GitLabHttpError carrying the description when the refresh token was revoked', async () => {
    const description = 'The provided authorization grant is invalid, expired, revoked, does not match the redirection URI used in the authorization request, or was issued to another client.';
    const { fetchImpl } = fakeFetch(400, JSON.stringify({ error: 'invalid_grant', error_description: description }));

    const error = await catchError(refreshGitLabAccessToken(
      { refreshToken: 'revoked', redirectUri: 'http://127.0.0.1:1/callback' },
      fetchImpl,
    ));

    expect(error).toBeInstanceOf(GitLabHttpError);
    expect((error as GitLabHttpError).status).toBe(400);
    expect((error as GitLabHttpError).providerMessage).toBe(description);
  });
});
