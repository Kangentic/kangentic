/**
 * Sign in with Trello on Kangentic's key, with nothing to paste: Trello returns
 * to kangentic.com's page, which seals the token to the loopback listener.
 *
 * What a user loses without each case: a `return_url` on the user's own key is
 * refused by Trello (its allowed origins are not kangentic.com), so their paste
 * path breaks; a state encoded twice is one the return page cannot read; a token
 * Trello refuses that is saved anyway fails every board list; and a forged
 * `error=` that ends the attempt lets any page cancel a sign-in.
 *
 * The return page is the WebCrypto port in `helpers/kangentic-token-service.ts`.
 */
import http from 'node:http';
import { describe, it, expect, vi, afterEach } from 'vitest';

const keyState = vi.hoisted(() => ({ available: true }));

vi.mock('../../src/main/boards/adapters/trello/constants', async () => {
  const actual = await vi.importActual<typeof import('../../src/main/boards/adapters/trello/constants')>(
    '../../src/main/boards/adapters/trello/constants',
  );
  return { ...actual, TRELLO_API_KEY: 'kangentic-key', isTrelloSignInAvailable: () => keyState.available };
});

const { buildAuthorizeUrl, buildTrelloReturnUrl } = await import('../../src/main/boards/adapters/trello/constants');
const { signInWithTrello, cancelTrelloSignIn } = await import('../../src/main/boards/adapters/trello/oauth');
const { TrelloError } = await import('../../src/main/boards/adapters/trello/client');
const { TRELLO_SEAL_INFO } = await import('../../src/main/boards/shared/sealed-token');
const { serviceRedirect } = await import('./helpers/kangentic-token-service');

function get(url: string): Promise<number> {
  return new Promise((resolve, reject) => {
    http.get(url, { agent: false }, (response) => {
      response.resume();
      resolve(response.statusCode ?? 0);
    }).on('error', reject);
  });
}

/** Start a sign-in and resolve with the `state` the approval page carries to the return page. */
function startSignIn(validate: (token: string) => Promise<void> = async () => {}) {
  let resolveState: (state: string) => void = () => {};
  const state = new Promise<string>((resolve) => { resolveState = resolve; });
  const result = signInWithTrello({
    openExternal: async (url) => {
      const returnUrl = new URL(new URL(url).searchParams.get('return_url') ?? '');
      resolveState(returnUrl.searchParams.get('state') ?? '');
    },
    validate,
    timeoutMs: 10_000,
  });
  return { state, result };
}

afterEach(() => {
  keyState.available = true;
  cancelTrelloSignIn();
});

const RETURN_PAGE_FAILED = "Kangentic's sign-in page failed.";

describe('the approval page address', () => {
  it("returns to kangentic.com, token in the fragment, only for Kangentic's key", () => {
    const withReturn = new URL(buildAuthorizeUrl('kangentic-key', { returnState: 'abc_-123' }));
    expect(withReturn.searchParams.get('callback_method')).toBe('fragment');
    expect(withReturn.searchParams.get('return_url')).toBe('https://kangentic.com/oauth/trello/return?state=abc_-123');
    expect(withReturn.searchParams.get('scope')).toBe('read');
    expect(withReturn.searchParams.get('response_type')).toBe('token');

    // The user's own key stays paste-only: Trello would refuse a return_url its origins do not list.
    const ownKey = new URL(buildAuthorizeUrl('their-key'));
    expect(ownKey.searchParams.has('return_url')).toBe(false);
    expect(ownKey.searchParams.has('callback_method')).toBe(false);
  });

  it('encodes the state once', () => {
    const returnUrl = new URL(buildTrelloReturnUrl('a+b/c='));
    expect(returnUrl.searchParams.get('state')).toBe('a+b/c=');
  });
});

describe('signInWithTrello', () => {
  it('opens the token the return page sealed, after Trello accepts it', async () => {
    const validate = vi.fn(async () => {});
    const { state, result } = startSignIn(validate);
    const redirect = await serviceRedirect(await state, '/trello/callback', {
      plaintext: JSON.stringify({ token: 'ATTAtoken123' }),
      info: TRELLO_SEAL_INFO,
    });
    expect(await get(redirect)).toBe(200);
    await expect(result).resolves.toEqual({ ok: true, value: 'ATTAtoken123' });
    expect(validate).toHaveBeenCalledWith('ATTAtoken123');
  });

  it("shows Trello's own text for a token Trello refuses", async () => {
    const { state, result } = startSignIn(async () => { throw new TrelloError('invalid token', 401); });
    await get(await serviceRedirect(await state, '/trello/callback', {
      plaintext: JSON.stringify({ token: 'ATTArevoked' }),
      info: TRELLO_SEAL_INFO,
    }));
    await expect(result).resolves.toEqual({ ok: false, cancelled: false, error: 'invalid token' });
  });

  it('keeps waiting through a forged error, then ends a declined approval', async () => {
    const { state, result } = startSignIn();
    const declined = new URL(await serviceRedirect(await state, '/trello/callback', { error: 'access_denied' }));
    const forged = `http://127.0.0.1:${declined.port}/trello/callback?error=access_denied&nonce=forged`;
    expect(await get(forged)).toBe(400);
    expect(await get(declined.toString())).toBe(200);
    expect(await result).toMatchObject({ ok: false, cancelled: false });
  });

  it("shows a line for each failure the return page sends, Trello's own message first", async () => {
    // The pins in kangentic.com functions/oauth/trello/return.ts: Deny carries Trello's
    // message, and the page's own failures are invalid_request and server_error.
    const cases = [
      { outcome: { error: 'access_denied', description: 'Token request rejected' }, line: 'Token request rejected' },
      { outcome: { error: 'access_denied' }, line: 'Trello sign-in was declined.' },
      { outcome: { error: 'invalid_request' }, line: "Kangentic's sign-in page failed." },
      { outcome: { error: 'server_error' }, line: "Kangentic's sign-in page failed." },
    ];
    for (const { outcome, line } of cases) {
      const { state, result } = startSignIn();
      await get(await serviceRedirect(await state, '/trello/callback', outcome));
      await expect(result).resolves.toEqual({ ok: false, cancelled: false, error: line });
    }
  });

  it('refuses a token sealed under the Jira info string', async () => {
    const { state, result } = startSignIn();
    await get(await serviceRedirect(await state, '/trello/callback', {
      plaintext: JSON.stringify({ token: 'ATTAtoken123' }),
      info: 'kangentic-jira-oauth-v1',
    }));
    expect(await result).toMatchObject({ ok: false, cancelled: false });
  });
});

describe('signInWithTrello, a return page that goes wrong', () => {
  it('answers without opening the browser when the build has no Kangentic key', async () => {
    keyState.available = false;
    const openExternal = vi.fn(async () => {});
    const validate = vi.fn(async () => {});
    const result = await signInWithTrello({ openExternal, validate, timeoutMs: 10_000 });
    expect(result).toEqual({
      ok: false,
      cancelled: false,
      error: 'This build has no Kangentic Trello key. Use your own API key.',
    });
    expect(openExternal).not.toHaveBeenCalled();
    expect(validate).not.toHaveBeenCalled();
  });

  it("ends with the return page failing when the callback has the nonce but no payload", async () => {
    const validate = vi.fn(async () => {});
    const { state, result } = startSignIn(validate);
    const withError = new URL(await serviceRedirect(await state, '/trello/callback', { error: 'placeholder' }));
    withError.searchParams.delete('error');
    expect(withError.searchParams.has('payload')).toBe(false);
    expect(withError.searchParams.has('nonce')).toBe(true);
    await get(withError.toString());
    await expect(result).resolves.toEqual({ ok: false, cancelled: false, error: RETURN_PAGE_FAILED });
    expect(validate).not.toHaveBeenCalled();
  });

  it.each([
    ['text that is not JSON', 'not json at all'],
    ['JSON null', 'null'],
    ['an object with no token', '{}'],
    ['a token with whitespace in it', JSON.stringify({ token: 'has space' })],
  ])('ends with the return page failing for a sealed plaintext of %s, and validates nothing', async (_label, plaintext) => {
    const validate = vi.fn(async () => {});
    const { state, result } = startSignIn(validate);
    await get(await serviceRedirect(await state, '/trello/callback', { plaintext, info: TRELLO_SEAL_INFO }));
    await expect(result).resolves.toEqual({ ok: false, cancelled: false, error: RETURN_PAGE_FAILED });
    expect(validate).not.toHaveBeenCalled();
  });

  it('rejects with a validate failure that is not a TrelloError instead of showing it', async () => {
    const boom = new Error('socket hang up');
    const { state, result } = startSignIn(async () => { throw boom; });
    // Attach the handler first so the rejection is never seen as unhandled.
    const settled = expect(result).rejects.toBe(boom);
    await get(await serviceRedirect(await state, '/trello/callback', {
      plaintext: JSON.stringify({ token: 'ATTAtoken123' }),
      info: TRELLO_SEAL_INFO,
    }));
    await settled;
  });

  it('answers 400 to a wrong nonce on a good payload and keeps waiting for the real one', async () => {
    const { state, result } = startSignIn();
    const real = new URL(await serviceRedirect(await state, '/trello/callback', {
      plaintext: JSON.stringify({ token: 'ATTAtoken123' }),
      info: TRELLO_SEAL_INFO,
    }));
    const forged = new URL(real.toString());
    forged.searchParams.set('nonce', 'forged');
    const missing = new URL(real.toString());
    missing.searchParams.delete('nonce');
    expect(await get(forged.toString())).toBe(400);
    expect(await get(missing.toString())).toBe(400);
    expect(await get(real.toString())).toBe(200);
    await expect(result).resolves.toEqual({ ok: true, value: 'ATTAtoken123' });
  });
});

describe('signInTrello (the IPC handler)', () => {
  it("saves the token under Kangentic's key only once the sign-in succeeds", async () => {
    vi.doMock('electron', () => ({ ipcMain: { handle: vi.fn() }, shell: { openExternal: vi.fn() } }));
    const { signInTrello } = await import('../../src/main/boards/adapters/trello/ipc-handlers');
    const client = { validate: vi.fn(async () => {}), saveCredential: vi.fn(async () => {}) };

    const saved = await signInTrello(async () => {}, async () => ({ ok: true, value: 'ATTAtoken123' }), client);
    expect(saved).toEqual({ ok: true });
    expect(client.saveCredential).toHaveBeenCalledWith('kangentic-key', 'kangentic-key', 'ATTAtoken123');

    client.saveCredential.mockClear();
    const declined = await signInTrello(async () => {}, async () => ({ ok: false, cancelled: false, error: 'declined' }), client);
    expect(declined).toEqual({ ok: false, cancelled: false, error: 'declined' });
    expect(client.saveCredential).not.toHaveBeenCalled();
  });
});
