/**
 * Linear IPC handlers: the Connect Linear flow the Import dialog drives.
 *
 * What a user loses without each case: a blank or spaced key that reaches Linear
 * shows a raw API error instead of "Paste your API key."; a refused key that
 * throws instead of returning leaves the dialog without its message; a saved key
 * stored without its viewer name or organization key breaks the team links; a
 * sign-in whose token fails validation but is not revoked leaves a live grant at
 * Linear that no saved credential can use; a cancelled sign-in reported as an
 * error flashes a failure for a choice the user made; a code defect swallowed as
 * an answer never reaches the error report; and a team list that builds the
 * wrong URL opens the wrong page.
 *
 * `electron`, the client, the OAuth flow and the token endpoint are mocked, so
 * the handlers run exactly as registered and nothing touches the network.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { LinearCredential } from '../../src/main/boards/adapters/linear/credential-store';
import type { LinearViewer } from '../../src/main/boards/adapters/linear/client';
import type { SignInResult } from '../../src/main/boards/adapters/linear/oauth';
import { IPC } from '../../src/shared/ipc-channels';

const capturedHandlers = new Map<string, (...args: unknown[]) => unknown>();
const openExternalSpy = vi.hoisted(() => vi.fn());

const validateApiKeySpy = vi.hoisted(() => vi.fn<(apiKey: string) => Promise<LinearViewer>>());
const validateAccessTokenSpy = vi.hoisted(() => vi.fn<(accessToken: string) => Promise<LinearViewer>>());
const getCredentialSpy = vi.hoisted(() => vi.fn<() => Promise<LinearCredential | null>>());
const saveCredentialSpy = vi.hoisted(() => vi.fn<(credential: LinearCredential) => Promise<void>>());
const listTeamsSpy = vi.hoisted(() => vi.fn<() => Promise<Array<{ id: string; key: string; name: string }>>>());
const signInWithBrowserSpy = vi.hoisted(() => vi.fn<(dependencies: { openExternal: (url: string) => unknown }) => Promise<SignInResult>>());
const isSignInAvailableSpy = vi.hoisted(() => vi.fn<() => boolean>());
const revokeTokenSpy = vi.hoisted(() => vi.fn<(token: string) => Promise<void>>());

vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => {
      capturedHandlers.set(channel, handler);
    }),
  },
  shell: { openExternal: openExternalSpy },
}));

vi.mock('../../src/main/boards/adapters/linear/client', () => ({
  LinearClient: class {
    static validateApiKey = validateApiKeySpy;
    static validateAccessToken = validateAccessTokenSpy;
    getCredential = getCredentialSpy;
    saveCredential = saveCredentialSpy;
    listTeams = listTeamsSpy;
  },
}));

vi.mock('../../src/main/boards/adapters/linear/oauth', () => ({
  signInWithBrowser: signInWithBrowserSpy,
  cancelLinearSignIn: vi.fn(),
  reopenLinearSignIn: vi.fn(),
  isLinearSignInAvailable: isSignInAvailableSpy,
}));

vi.mock('../../src/main/boards/adapters/linear/oauth-tokens', () => ({
  revokeToken: revokeTokenSpy,
}));

const { registerLinearIpcHandlers } = await import('../../src/main/boards/adapters/linear/ipc-handlers');
const { LinearError } = await import('../../src/main/boards/adapters/linear/linear-error');

const VIEWER: LinearViewer = {
  id: 'user-1',
  name: 'Dana Park',
  displayName: 'dana',
  email: null,
  organization: { urlKey: 'acme' },
};

const TOKENS = { accessToken: 'access-1', refreshToken: 'refresh-1', expiresAt: '2026-11-18T00:00:00.000Z' };

function invoke(channel: string, ...args: unknown[]): Promise<unknown> {
  const handler = capturedHandlers.get(channel);
  if (!handler) throw new Error(`No handler registered for ${channel}`);
  return Promise.resolve(handler({}, ...args));
}

beforeEach(() => {
  capturedHandlers.clear();
  vi.clearAllMocks();
  validateApiKeySpy.mockResolvedValue(VIEWER);
  validateAccessTokenSpy.mockResolvedValue(VIEWER);
  saveCredentialSpy.mockResolvedValue(undefined);
  revokeTokenSpy.mockResolvedValue(undefined);
  getCredentialSpy.mockResolvedValue(null);
  isSignInAvailableSpy.mockReturnValue(true);
  registerLinearIpcHandlers();
});

describe('BOARDS_LINEAR_SET_API_KEY', () => {
  it.each([
    ['a missing key', undefined],
    ['a non-string key', 42],
    ['an empty key', ''],
    ['a blank key', '   '],
  ])('answers "Paste your API key." for %s without calling Linear', async (_label, apiKey) => {
    const result = await invoke(IPC.BOARDS_LINEAR_SET_API_KEY, { apiKey });

    expect(result).toEqual({ ok: false, error: 'Paste your API key.' });
    expect(validateApiKeySpy).not.toHaveBeenCalled();
    expect(saveCredentialSpy).not.toHaveBeenCalled();
  });

  it('answers with the no-spaces message for a key with an inner space', async () => {
    const result = await invoke(IPC.BOARDS_LINEAR_SET_API_KEY, { apiKey: 'lin_api abc' });

    expect(result).toEqual({ ok: false, error: 'An API key has no spaces. Copy it again from Linear.' });
    expect(validateApiKeySpy).not.toHaveBeenCalled();
  });

  it('saves a valid key trimmed, with the viewer name and organization key', async () => {
    const result = await invoke(IPC.BOARDS_LINEAR_SET_API_KEY, { apiKey: '  lin_api_good  ' });

    expect(result).toEqual({ ok: true });
    expect(validateApiKeySpy).toHaveBeenCalledWith('lin_api_good');
    expect(saveCredentialSpy).toHaveBeenCalledTimes(1);
    expect(saveCredentialSpy.mock.calls[0][0]).toMatchObject({
      kind: 'api_key',
      apiKey: 'lin_api_good',
      userName: 'dana',
      organizationUrlKey: 'acme',
    });
  });

  it('falls back to the viewer name when there is no display name', async () => {
    validateApiKeySpy.mockResolvedValue({ ...VIEWER, displayName: '' });

    await invoke(IPC.BOARDS_LINEAR_SET_API_KEY, { apiKey: 'lin_api_good' });

    expect(saveCredentialSpy.mock.calls[0][0]).toMatchObject({ userName: 'Dana Park' });
  });

  it('returns Linear\'s message for a refused key and saves nothing', async () => {
    validateApiKeySpy.mockRejectedValue(new LinearError('Authentication required', 401, 'AUTHENTICATION_ERROR'));

    const result = await invoke(IPC.BOARDS_LINEAR_SET_API_KEY, { apiKey: 'lin_api_bad' });

    expect(result).toEqual({ ok: false, error: 'Authentication required' });
    expect(saveCredentialSpy).not.toHaveBeenCalled();
  });

  it('rethrows a code defect so the IPC wrap reports it', async () => {
    validateApiKeySpy.mockRejectedValue(new TypeError('Cannot read properties of undefined'));

    await expect(invoke(IPC.BOARDS_LINEAR_SET_API_KEY, { apiKey: 'lin_api_good' })).rejects.toBeInstanceOf(TypeError);
  });
});

describe('BOARDS_LINEAR_SIGN_IN', () => {
  it('maps a cancelled sign-in to cancelled, not an error', async () => {
    signInWithBrowserSpy.mockResolvedValue({ ok: false, cancelled: true });

    expect(await invoke(IPC.BOARDS_LINEAR_SIGN_IN)).toEqual({ ok: false, cancelled: true });
    expect(validateAccessTokenSpy).not.toHaveBeenCalled();
  });

  it('maps a failed sign-in to its error', async () => {
    signInWithBrowserSpy.mockResolvedValue({ ok: false, cancelled: false, error: 'access_denied' });

    expect(await invoke(IPC.BOARDS_LINEAR_SIGN_IN)).toEqual({ ok: false, error: 'access_denied' });
  });

  it('opens the sign-in page through the shell', async () => {
    signInWithBrowserSpy.mockImplementation(async (dependencies) => {
      dependencies.openExternal('https://linear.app/oauth/authorize');
      return { ok: false, cancelled: true };
    });

    await invoke(IPC.BOARDS_LINEAR_SIGN_IN);

    expect(openExternalSpy).toHaveBeenCalledWith('https://linear.app/oauth/authorize');
  });

  it('validates the access token and saves an oauth credential with the tokens', async () => {
    signInWithBrowserSpy.mockResolvedValue({ ok: true, tokens: TOKENS });

    expect(await invoke(IPC.BOARDS_LINEAR_SIGN_IN)).toEqual({ ok: true });
    expect(validateAccessTokenSpy).toHaveBeenCalledWith('access-1');
    expect(saveCredentialSpy.mock.calls[0][0]).toMatchObject({
      kind: 'oauth',
      ...TOKENS,
      userName: 'dana',
      organizationUrlKey: 'acme',
    });
    expect(revokeTokenSpy).not.toHaveBeenCalled();
  });

  it('revokes the grant, saves nothing and returns the error when the token fails validation', async () => {
    signInWithBrowserSpy.mockResolvedValue({ ok: true, tokens: TOKENS });
    validateAccessTokenSpy.mockRejectedValue(new LinearError('Token rejected', 401));

    expect(await invoke(IPC.BOARDS_LINEAR_SIGN_IN)).toEqual({ ok: false, error: 'Token rejected' });
    expect(revokeTokenSpy).toHaveBeenCalledWith('refresh-1');
    expect(saveCredentialSpy).not.toHaveBeenCalled();
  });

  it('still surfaces the validation error when the revoke itself fails', async () => {
    signInWithBrowserSpy.mockResolvedValue({ ok: true, tokens: TOKENS });
    validateAccessTokenSpy.mockRejectedValue(new LinearError('Token rejected', 401));
    revokeTokenSpy.mockRejectedValue(new LinearError('Linear token revoke failed (500)', 500));
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    try {
      expect(await invoke(IPC.BOARDS_LINEAR_SIGN_IN)).toEqual({ ok: false, error: 'Token rejected' });
    } finally {
      warnSpy.mockRestore();
    }
    expect(saveCredentialSpy).not.toHaveBeenCalled();
  });
});

describe('BOARDS_LINEAR_LIST_TEAMS', () => {
  it('builds each team url from the saved organization key', async () => {
    getCredentialSpy.mockResolvedValue({
      kind: 'api_key',
      apiKey: 'lin_api_good',
      userName: 'dana',
      organizationUrlKey: 'acme',
      savedAt: '2026-11-17T00:00:00.000Z',
    });
    listTeamsSpy.mockResolvedValue([
      { id: 'team-1', key: 'PLT', name: 'Platform' },
      { id: 'team-2', key: 'WEB', name: 'Web' },
    ]);

    expect(await invoke(IPC.BOARDS_LINEAR_LIST_TEAMS)).toEqual({
      teams: [
        { id: 'team-1', key: 'PLT', name: 'Platform', url: 'https://linear.app/acme/team/PLT/all' },
        { id: 'team-2', key: 'WEB', name: 'Web', url: 'https://linear.app/acme/team/WEB/all' },
      ],
    });
  });

  it('returns no teams and the message for a LinearError', async () => {
    listTeamsSpy.mockRejectedValue(new LinearError('Authentication required', 401, 'AUTHENTICATION_ERROR'));

    expect(await invoke(IPC.BOARDS_LINEAR_LIST_TEAMS)).toEqual({ teams: [], error: 'Authentication required' });
  });

  it('rethrows a code defect', async () => {
    listTeamsSpy.mockRejectedValue(new TypeError('boom'));

    await expect(invoke(IPC.BOARDS_LINEAR_LIST_TEAMS)).rejects.toBeInstanceOf(TypeError);
  });
});

describe('BOARDS_LINEAR_AUTH_STATUS', () => {
  it('reports a connected sign-in with its kind, user and whether browser sign-in is available', async () => {
    getCredentialSpy.mockResolvedValue({
      kind: 'api_key',
      apiKey: 'lin_api_good',
      userName: 'dana',
      organizationUrlKey: 'acme',
      savedAt: '2026-11-17T00:00:00.000Z',
    });
    isSignInAvailableSpy.mockReturnValue(false);

    expect(await invoke(IPC.BOARDS_LINEAR_AUTH_STATUS)).toEqual({
      connected: true,
      kind: 'api_key',
      userName: 'dana',
      signInAvailable: false,
    });
  });

  it('reports not connected with no kind or user', async () => {
    expect(await invoke(IPC.BOARDS_LINEAR_AUTH_STATUS)).toEqual({
      connected: false,
      kind: undefined,
      userName: undefined,
      signInAvailable: true,
    });
  });
});
