/**
 * Linear OAuth token calls: the code exchange, the refresh and the revoke.
 *
 * What a user loses without each case: a form field posted under the wrong name
 * is refused by Linear, so Sign in with Linear never completes; a token response
 * with no `expires_in` that reads as already expired spends a refresh on every
 * call and, because Linear rotates the refresh token each time, eventually signs
 * the user out; a refused refresh token whose Linear message is dropped leaves
 * the user with no reason to reconnect; a `null` body that throws a TypeError
 * shows no message; and a revoke that throws on a token Linear already refuses
 * blocks Disconnect from ever finishing.
 *
 * Every other Linear test mocks this module, so this file is the only place the
 * real request and response handling runs. `fetch` is stubbed. The success body
 * is the token response Linear documents at
 * https://linear.app/developers/oauth-2-0-authentication, verbatim in shape.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('../../src/main/boards/adapters/linear/constants', async () => {
  const actual = await vi.importActual<typeof import('../../src/main/boards/adapters/linear/constants')>(
    '../../src/main/boards/adapters/linear/constants',
  );
  // The shipped id is empty until the application is registered; pin the field's presence with a value.
  return { ...actual, LINEAR_OAUTH_CLIENT_ID: 'client-id-test' };
});

const { exchangeAuthorizationCode, refreshAccessToken, revokeToken } = await import(
  '../../src/main/boards/adapters/linear/oauth-tokens'
);
const { LinearError } = await import('../../src/main/boards/adapters/linear/linear-error');

const DOCUMENTED_TOKEN_RESPONSE = {
  access_token: '00a21d8b0c4e2375114e49c067dfb81eb0d2076f48354714cd5df984d87b67cc',
  token_type: 'Bearer',
  expires_in: 86399,
  scope: 'read write',
  refresh_token: 'sz0c8ffy95zj2ff6bh1hiausauw3dbfsu4gly1z4p49b5odqv8l7owunb654vg1f',
};

const FIXED_NOW = new Date('2026-11-17T12:00:00.000Z');

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

let fetchSpy: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(FIXED_NOW);
  fetchSpy = vi.fn();
  vi.stubGlobal('fetch', fetchSpy);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

function postedRequest(): { url: string; headers: Record<string, string>; form: URLSearchParams } {
  const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
  expect(init.method).toBe('POST');
  return { url, headers: init.headers as Record<string, string>, form: new URLSearchParams(init.body as string) };
}

describe('exchangeAuthorizationCode', () => {
  it('posts the PKCE form to the token endpoint and returns the pair', async () => {
    fetchSpy.mockResolvedValue(jsonResponse(200, DOCUMENTED_TOKEN_RESPONSE));
    const tokens = await exchangeAuthorizationCode({
      code: 'code-1',
      codeVerifier: 'verifier-1',
      redirectUri: 'http://127.0.0.1:37421/callback',
    });
    const { url, headers, form } = postedRequest();
    expect(url).toBe('https://api.linear.app/oauth/token');
    expect(headers['content-type']).toBe('application/x-www-form-urlencoded');
    expect(Object.fromEntries(form.entries())).toEqual({
      grant_type: 'authorization_code',
      code: 'code-1',
      redirect_uri: 'http://127.0.0.1:37421/callback',
      client_id: 'client-id-test',
      code_verifier: 'verifier-1',
    });
    expect(tokens.accessToken).toBe(DOCUMENTED_TOKEN_RESPONSE.access_token);
    expect(tokens.refreshToken).toBe(DOCUMENTED_TOKEN_RESPONSE.refresh_token);
  });

  it('accepts the older response whose scope is an array', async () => {
    fetchSpy.mockResolvedValue(jsonResponse(200, { ...DOCUMENTED_TOKEN_RESPONSE, scope: ['read', 'write'] }));
    const tokens = await exchangeAuthorizationCode({ code: 'c', codeVerifier: 'v', redirectUri: 'http://127.0.0.1:37421/callback' });
    expect(tokens.accessToken).toBe(DOCUMENTED_TOKEN_RESPONSE.access_token);
  });
});

describe('refreshAccessToken', () => {
  it('posts the refresh grant with the client id and no secret', async () => {
    fetchSpy.mockResolvedValue(jsonResponse(200, DOCUMENTED_TOKEN_RESPONSE));
    await refreshAccessToken('refresh-1');
    const { url, headers, form } = postedRequest();
    expect(url).toBe('https://api.linear.app/oauth/token');
    expect(headers['content-type']).toBe('application/x-www-form-urlencoded');
    expect(Object.fromEntries(form.entries())).toEqual({
      grant_type: 'refresh_token',
      refresh_token: 'refresh-1',
      client_id: 'client-id-test',
    });
  });

  it('expires the access token expires_in seconds from now', async () => {
    fetchSpy.mockResolvedValue(jsonResponse(200, DOCUMENTED_TOKEN_RESPONSE));
    const tokens = await refreshAccessToken('refresh-1');
    expect(tokens.expiresAt).toBe(new Date(FIXED_NOW.getTime() + 86399 * 1000).toISOString());
  });

  it.each([
    ['no expires_in', undefined],
    ['expires_in 0', 0],
  ])('gives a response with %s the documented 24-hour lifetime', async (_label, expiresIn) => {
    const { expires_in: _dropped, ...withoutExpiry } = DOCUMENTED_TOKEN_RESPONSE;
    fetchSpy.mockResolvedValue(jsonResponse(200, expiresIn === undefined ? withoutExpiry : { ...withoutExpiry, expires_in: expiresIn }));
    const tokens = await refreshAccessToken('refresh-1');
    expect(tokens.expiresAt).toBe(new Date(FIXED_NOW.getTime() + 24 * 60 * 60 * 1000).toISOString());
  });

  it('throws a LinearError carrying the status, the code and the description for a refused grant', async () => {
    fetchSpy.mockResolvedValue(jsonResponse(400, { error: 'invalid_grant', error_description: 'The refresh token is invalid or expired.' }));
    const error = await refreshAccessToken('refresh-1').then(() => null, (rejected: unknown) => rejected);
    expect(error).toBeInstanceOf(LinearError);
    const linearError = error as InstanceType<typeof LinearError>;
    expect(linearError.status).toBe(400);
    expect(linearError.code).toBe('invalid_grant');
    expect(linearError.message).toBe('The refresh token is invalid or expired.');
  });

  it('throws when a 200 carries no refresh token', async () => {
    const { refresh_token: _dropped, ...withoutRefreshToken } = DOCUMENTED_TOKEN_RESPONSE;
    fetchSpy.mockResolvedValue(jsonResponse(200, withoutRefreshToken));
    const error = await refreshAccessToken('refresh-1').then(() => null, (rejected: unknown) => rejected);
    expect(error).toBeInstanceOf(LinearError);
    expect((error as Error).message).toBe('Linear token request failed (200)');
  });

  it('throws a LinearError, not a TypeError, for a JSON null body', async () => {
    fetchSpy.mockResolvedValue(new Response('null', { status: 200, headers: { 'content-type': 'application/json' } }));
    const error = await refreshAccessToken('refresh-1').then(() => null, (rejected: unknown) => rejected);
    expect(error).toBeInstanceOf(LinearError);
    expect((error as Error).message).toBe('Linear token request failed (200)');
  });
});

describe('revokeToken', () => {
  it('posts the token to the revoke endpoint', async () => {
    fetchSpy.mockResolvedValue(new Response('{}', { status: 200 }));
    await revokeToken('token-1');
    const { url, form } = postedRequest();
    expect(url).toBe('https://api.linear.app/oauth/revoke');
    expect(Object.fromEntries(form.entries())).toEqual({ token: 'token-1' });
  });

  it.each([200, 400, 401])('resolves on a %i', async (status) => {
    fetchSpy.mockResolvedValue(new Response('{}', { status }));
    await expect(revokeToken('token-1')).resolves.toBeUndefined();
  });

  it('throws a LinearError on a 500', async () => {
    fetchSpy.mockResolvedValue(new Response('{}', { status: 500 }));
    const error = await revokeToken('token-1').then(() => null, (rejected: unknown) => rejected);
    expect(error).toBeInstanceOf(LinearError);
    expect((error as InstanceType<typeof LinearError>).status).toBe(500);
  });
});
