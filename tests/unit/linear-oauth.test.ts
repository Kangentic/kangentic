/**
 * Linear browser sign-in: PKCE, the loopback callback, and its outcomes.
 *
 * What a user loses without each case: a challenge that is not S256 of the
 * verifier makes every sign-in fail at the token step; a callback that accepts
 * a wrong `state` lets another page finish someone's sign-in; a declined
 * approval left waiting holds the dialog for five minutes; a busy first port
 * makes sign-in impossible while another program holds it; and a Cancel that
 * leaves the server up keeps the port taken.
 *
 * Runs a real loopback server on high test ports; the browser is a stub that
 * records the authorize URL, and the token exchange is injected.
 */
import crypto from 'node:crypto';
import http from 'node:http';
import { describe, it, expect, vi, afterEach } from 'vitest';

vi.mock('../../src/main/boards/adapters/linear/constants', async () => {
  const actual = await vi.importActual<typeof import('../../src/main/boards/adapters/linear/constants')>(
    '../../src/main/boards/adapters/linear/constants',
  );
  return { ...actual, LINEAR_OAUTH_CLIENT_ID: 'test-client-id' };
});

const { createPkcePair, signInWithBrowser, cancelLinearSignIn, reopenLinearSignIn } = await import(
  '../../src/main/boards/adapters/linear/oauth'
);

/** Two ports the OS reports free right now, so the test never depends on a fixed port being open. */
async function freePorts(count: number): Promise<number[]> {
  const ports: number[] = [];
  for (let index = 0; index < count; index++) {
    const probe = http.createServer();
    await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
    ports.push((probe.address() as { port: number }).port);
    await new Promise<void>((resolve) => probe.close(() => resolve()));
  }
  return ports;
}

const TEST_PORTS = await freePorts(2);

const TOKENS = { accessToken: 'access', refreshToken: 'refresh', expiresAt: '2026-11-18T00:00:00.000Z' };

function get(url: string): Promise<number> {
  return new Promise((resolve, reject) => {
    http.get(url, { agent: false }, (response) => {
      response.resume();
      resolve(response.statusCode ?? 0);
    }).on('error', reject);
  });
}

/** Start a sign-in and resolve with the authorize URL the "browser" was sent to. */
function startSignIn(exchangeCode = vi.fn(async () => TOKENS), ports = TEST_PORTS) {
  let resolveUrl: (url: URL) => void = () => {};
  const authorizeUrl = new Promise<URL>((resolve) => { resolveUrl = resolve; });
  const result = signInWithBrowser({
    openExternal: async (url: string) => resolveUrl(new URL(url)),
    exchangeCode,
    ports,
    timeoutMs: 10_000,
  });
  return { authorizeUrl, result, exchangeCode };
}

afterEach(() => {
  cancelLinearSignIn();
});

describe('createPkcePair', () => {
  it('derives the challenge as base64url SHA-256 of the verifier', () => {
    const { verifier, challenge } = createPkcePair();
    expect(verifier).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(challenge).toBe(crypto.createHash('sha256').update(verifier).digest('base64url'));
  });
});

describe('signInWithBrowser', () => {
  it('asks for read only with S256 PKCE, and trades the code with the verifier', async () => {
    const { authorizeUrl, result, exchangeCode } = startSignIn();
    const url = await authorizeUrl;
    expect(url.searchParams.get('client_id')).toBe('test-client-id');
    expect(url.searchParams.get('scope')).toBe('read');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    const redirectUri = url.searchParams.get('redirect_uri')!;
    expect(redirectUri).toBe(`http://127.0.0.1:${TEST_PORTS[0]}/callback`);

    const status = await get(`${redirectUri}?code=the-code&state=${url.searchParams.get('state')}`);
    expect(status).toBe(200);
    await expect(result).resolves.toEqual({ ok: true, tokens: TOKENS });
    const exchange = exchangeCode.mock.calls[0][0] as { code: string; codeVerifier: string; redirectUri: string };
    expect(exchange.code).toBe('the-code');
    expect(exchange.redirectUri).toBe(redirectUri);
    expect(crypto.createHash('sha256').update(exchange.codeVerifier).digest('base64url'))
      .toBe(url.searchParams.get('code_challenge'));
  });

  it('refuses a callback with the wrong state and keeps waiting for the real one', async () => {
    const { authorizeUrl, result, exchangeCode } = startSignIn();
    const url = await authorizeUrl;
    const redirectUri = url.searchParams.get('redirect_uri')!;
    expect(await get(`${redirectUri}?code=forged&state=wrong`)).toBe(400);
    expect(exchangeCode).not.toHaveBeenCalled();
    await get(`${redirectUri}?code=real&state=${url.searchParams.get('state')}`);
    await expect(result).resolves.toMatchObject({ ok: true });
    expect(exchangeCode).toHaveBeenCalledTimes(1);
  });

  it('ends at once with Linear\'s reason when the user declines', async () => {
    const { authorizeUrl, result } = startSignIn();
    const url = await authorizeUrl;
    await get(`${url.searchParams.get('redirect_uri')}?error=access_denied&error_description=The+user+denied+access&state=${url.searchParams.get('state')}`);
    await expect(result).resolves.toEqual({ ok: false, cancelled: false, error: 'The user denied access' });
  });

  it('falls back to the next registered port when the first is taken', async () => {
    const blocker = http.createServer();
    await new Promise<void>((resolve) => blocker.listen(TEST_PORTS[0], '127.0.0.1', resolve));
    try {
      const { authorizeUrl, result } = startSignIn();
      const url = await authorizeUrl;
      expect(url.searchParams.get('redirect_uri')).toBe(`http://127.0.0.1:${TEST_PORTS[1]}/callback`);
      cancelLinearSignIn();
      await expect(result).resolves.toEqual({ ok: false, cancelled: true });
    } finally {
      await new Promise<void>((resolve) => blocker.close(() => resolve()));
    }
  });

  it('closes the callback server on cancel', async () => {
    const { authorizeUrl, result } = startSignIn();
    const url = await authorizeUrl;
    cancelLinearSignIn();
    await expect(result).resolves.toEqual({ ok: false, cancelled: true });
    await expect(get(`${url.searchParams.get('redirect_uri')}?code=late`)).rejects.toThrow();
  });

  it('resolves as cancelled when Cancel lands while the code is being traded', async () => {
    let resolveExchange: (tokens: typeof TOKENS) => void = () => {};
    const exchangeCode = vi.fn(() => new Promise<typeof TOKENS>((resolve) => { resolveExchange = resolve; }));
    const { authorizeUrl, result } = startSignIn(exchangeCode);
    const url = await authorizeUrl;
    await get(`${url.searchParams.get('redirect_uri')}?code=the-code&state=${url.searchParams.get('state')}`);
    await vi.waitFor(() => expect(exchangeCode).toHaveBeenCalledTimes(1));
    cancelLinearSignIn();
    resolveExchange(TOKENS);
    await expect(result).resolves.toEqual({ ok: false, cancelled: true });
  });

  it('resolves an error result, and frees the port, when the browser cannot be opened', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const result = await signInWithBrowser({
        openExternal: async () => { throw new Error('no browser'); },
        exchangeCode: vi.fn(async () => TOKENS),
        ports: TEST_PORTS,
        timeoutMs: 10_000,
      });
      expect(result).toMatchObject({ ok: false, cancelled: false });
      const error = (result as { error: string }).error;
      expect(typeof error).toBe('string');
      expect(error.length).toBeGreaterThan(0);
      await expect(get(`http://127.0.0.1:${TEST_PORTS[0]}/callback?code=late`)).rejects.toThrow();
    } finally {
      warn.mockRestore();
    }
  });

  it('resolves an error result, without throwing, when every registered port is taken', async () => {
    const blockers = TEST_PORTS.map(() => http.createServer());
    await Promise.all(blockers.map((blocker, index) => new Promise<void>((resolve) => {
      blocker.listen(TEST_PORTS[index], '127.0.0.1', resolve);
    })));
    try {
      const openExternal = vi.fn(async () => {});
      const result = await signInWithBrowser({ openExternal, ports: TEST_PORTS, timeoutMs: 10_000 });
      expect(result).toMatchObject({ ok: false, cancelled: false });
      expect((result as { error: string }).error.length).toBeGreaterThan(0);
      expect(openExternal).not.toHaveBeenCalled();
    } finally {
      await Promise.all(blockers.map((blocker) => new Promise<void>((resolve) => blocker.close(() => resolve()))));
    }
  });

  it('resolves an error result and frees the port when the timeout passes with no callback', async () => {
    const result = await signInWithBrowser({
      openExternal: async () => {},
      exchangeCode: vi.fn(async () => TOKENS),
      ports: TEST_PORTS,
      timeoutMs: 50,
    });
    expect(result).toMatchObject({ ok: false, cancelled: false });
    expect((result as { error: string }).error.length).toBeGreaterThan(0);
    await expect(get(`http://127.0.0.1:${TEST_PORTS[0]}/callback?code=late`)).rejects.toThrow();
  });

  it('answers a path other than /callback with 404 and keeps waiting', async () => {
    const { authorizeUrl, result } = startSignIn();
    const url = await authorizeUrl;
    const redirectUri = url.searchParams.get('redirect_uri')!;
    expect(await get(redirectUri.replace('/callback', '/elsewhere'))).toBe(404);
    expect(await get(`${redirectUri}?code=real&state=${url.searchParams.get('state')}`)).toBe(200);
    await expect(result).resolves.toMatchObject({ ok: true });
  });

  it('answers a callback with the right state but no code with 400 and keeps waiting', async () => {
    const { authorizeUrl, result, exchangeCode } = startSignIn();
    const url = await authorizeUrl;
    const redirectUri = url.searchParams.get('redirect_uri')!;
    const state = url.searchParams.get('state');
    expect(await get(`${redirectUri}?state=${state}`)).toBe(400);
    expect(exchangeCode).not.toHaveBeenCalled();
    expect(await get(`${redirectUri}?code=real&state=${state}`)).toBe(200);
    await expect(result).resolves.toMatchObject({ ok: true });
  });
});

describe('reopenLinearSignIn', () => {
  it('returns false with nothing pending', async () => {
    expect(await reopenLinearSignIn()).toBe(false);
  });

  it('opens the same authorize URL again while a sign-in is pending', async () => {
    const openedUrls: string[] = [];
    const result = signInWithBrowser({
      openExternal: async (url: string) => { openedUrls.push(url); },
      exchangeCode: vi.fn(async () => TOKENS),
      ports: TEST_PORTS,
      timeoutMs: 10_000,
    });
    await vi.waitFor(() => expect(openedUrls).toHaveLength(1));
    expect(await reopenLinearSignIn()).toBe(true);
    expect(openedUrls).toHaveLength(2);
    expect(openedUrls[1]).toBe(openedUrls[0]);
    cancelLinearSignIn();
    await expect(result).resolves.toEqual({ ok: false, cancelled: true });
  });
});

describe('signInWithBrowser without a registered client id', () => {
  it('returns an error result and binds no port', async () => {
    vi.resetModules();
    vi.doMock('../../src/main/boards/adapters/linear/constants', async () => {
      const actual = await vi.importActual<typeof import('../../src/main/boards/adapters/linear/constants')>(
        '../../src/main/boards/adapters/linear/constants',
      );
      return { ...actual, LINEAR_OAUTH_CLIENT_ID: '' };
    });
    try {
      const unconfigured = await import('../../src/main/boards/adapters/linear/oauth');
      const openExternal = vi.fn(async () => {});
      const result = await unconfigured.signInWithBrowser({ openExternal, ports: TEST_PORTS, timeoutMs: 10_000 });
      expect(result).toMatchObject({ ok: false, cancelled: false });
      expect((result as { error: string }).error.length).toBeGreaterThan(0);
      expect(openExternal).not.toHaveBeenCalled();
      // The port was never bound, so a fresh server can take it.
      const probe = http.createServer();
      await new Promise<void>((resolve) => probe.listen(TEST_PORTS[0], '127.0.0.1', resolve));
      await new Promise<void>((resolve) => probe.close(() => resolve()));
    } finally {
      vi.doUnmock('../../src/main/boards/adapters/linear/constants');
      vi.resetModules();
    }
  });
});
