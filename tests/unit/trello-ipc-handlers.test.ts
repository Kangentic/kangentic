/**
 * Trello IPC handlers: the Connect Trello flow and board list the Import dialog drives.
 *
 * What a user loses without each case: a blank or spaced key or token that reaches Trello shows a
 * raw API error instead of a plain message under the right field; a refused key or token that
 * throws instead of returning leaves the dialog without Trello's own text; a credential saved
 * before Trello accepts it leaves a dead token behind; a sign-in that sends the renderer's key in
 * place of Kangentic's own approves the wrong app; a refusal of Kangentic's own key blamed on a key
 * field the user never sees; a board list whose refusal throws never reaches the Connect button;
 * and a code defect swallowed as an answer never reaches the error report.
 *
 * `electron`, the client, the constants and the credential store are mocked, so the handlers run
 * exactly as registered and nothing touches the network.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { TrelloBoardSummary } from '../../src/shared/types';
import { IPC } from '../../src/shared/ipc-channels';

const capturedHandlers = new Map<string, (...args: unknown[]) => unknown>();
const openExternalSpy = vi.hoisted(() => vi.fn<(url: string) => Promise<void>>());
const validateSpy = vi.hoisted(() => vi.fn<(apiKey: string, token: string) => Promise<void>>());
const saveCredentialSpy = vi.hoisted(() => vi.fn<(kind: string, apiKey: string, token: string) => Promise<unknown>>());
const getCredentialSpy = vi.hoisted(() => vi.fn<() => Promise<{ kind: string } | null>>());
const listBoardsSpy = vi.hoisted(() => vi.fn<() => Promise<TrelloBoardSummary[]>>());
const clearSpy = vi.hoisted(() => vi.fn<() => void>());
const shippedKey = vi.hoisted(() => ({ value: 'kangentic-shipped-key' }));

vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => {
      capturedHandlers.set(channel, handler);
    }),
  },
  shell: { openExternal: openExternalSpy },
}));

vi.mock('../../src/main/boards/adapters/trello/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/main/boards/adapters/trello/client')>();
  return {
    TrelloError: actual.TrelloError,
    TrelloClient: class {
      validate = validateSpy;
      saveCredential = saveCredentialSpy;
      getCredential = getCredentialSpy;
      listBoards = listBoardsSpy;
    },
  };
});

vi.mock('../../src/main/boards/adapters/trello/constants', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/main/boards/adapters/trello/constants')>();
  return {
    ...actual,
    get TRELLO_API_KEY() {
      return shippedKey.value;
    },
    isTrelloSignInAvailable: () => shippedKey.value.length > 0,
  };
});

vi.mock('../../src/main/boards/adapters/trello/credential-store', () => ({
  clearTrelloCredential: clearSpy,
}));

const { registerTrelloIpcHandlers } = await import('../../src/main/boards/adapters/trello/ipc-handlers');
const { TrelloError } = await import('../../src/main/boards/adapters/trello/client');
const { RefusalError } = await import('../../src/shared/refusal');

function invoke(channel: string, ...args: unknown[]): Promise<unknown> {
  const handler = capturedHandlers.get(channel);
  if (!handler) throw new Error(`No handler registered for ${channel}`);
  return Promise.resolve(handler({}, ...args));
}

beforeEach(() => {
  capturedHandlers.clear();
  vi.clearAllMocks();
  shippedKey.value = 'kangentic-shipped-key';
  validateSpy.mockResolvedValue(undefined);
  saveCredentialSpy.mockResolvedValue(undefined);
  getCredentialSpy.mockResolvedValue(null);
  listBoardsSpy.mockResolvedValue([]);
  openExternalSpy.mockResolvedValue(undefined);
  registerTrelloIpcHandlers();
});

describe('BOARDS_TRELLO_AUTH_STATUS', () => {
  it('reports not connected, and sign-in only when the build carries a Kangentic key', async () => {
    expect(await invoke(IPC.BOARDS_TRELLO_AUTH_STATUS)).toEqual({ connected: false, kind: undefined, signInAvailable: true });
    shippedKey.value = '';
    expect(await invoke(IPC.BOARDS_TRELLO_AUTH_STATUS)).toEqual({ connected: false, kind: undefined, signInAvailable: false });
  });

  it('reports the kind of a saved credential', async () => {
    getCredentialSpy.mockResolvedValue({ kind: 'own-key' });
    expect(await invoke(IPC.BOARDS_TRELLO_AUTH_STATUS)).toMatchObject({ connected: true, kind: 'own-key' });
  });
});

describe('BOARDS_TRELLO_CONNECT with the user\'s own key', () => {
  it.each([
    ['a missing key', undefined],
    ['a blank key', '   '],
  ])('answers under the key field for %s without calling Trello', async (_label, apiKey) => {
    const result = await invoke(IPC.BOARDS_TRELLO_CONNECT, { kind: 'own-key', apiKey, token: 'ATTAtoken' });
    expect(result).toEqual({ ok: false, field: 'apiKey', error: 'Paste your API key.' });
    expect(validateSpy).not.toHaveBeenCalled();
  });

  it('answers under the token field for a blank or spaced token', async () => {
    expect(await invoke(IPC.BOARDS_TRELLO_CONNECT, { kind: 'own-key', apiKey: 'key-1', token: '' }))
      .toEqual({ ok: false, field: 'token', error: 'Paste the token Trello shows.' });
    expect(await invoke(IPC.BOARDS_TRELLO_CONNECT, { kind: 'own-key', apiKey: 'key-1', token: 'ATTA one' }))
      .toEqual({ ok: false, field: 'token', error: 'A key or token has no spaces. Copy it again from Trello.' });
    expect(validateSpy).not.toHaveBeenCalled();
  });

  it('checks the trimmed key and token with Trello, then saves them', async () => {
    const result = await invoke(IPC.BOARDS_TRELLO_CONNECT, { kind: 'own-key', apiKey: ' key-1 ', token: ' ATTAtoken ' });
    expect(result).toEqual({ ok: true });
    expect(validateSpy).toHaveBeenCalledWith('key-1', 'ATTAtoken');
    expect(saveCredentialSpy).toHaveBeenCalledWith('own-key', 'key-1', 'ATTAtoken');
    expect(validateSpy.mock.invocationCallOrder[0]).toBeLessThan(saveCredentialSpy.mock.invocationCallOrder[0]);
  });

  it('returns Trello\'s own text under the field it blames, and saves nothing', async () => {
    validateSpy.mockRejectedValue(new TrelloError('invalid key', 401, 'apiKey'));
    const result = await invoke(IPC.BOARDS_TRELLO_CONNECT, { kind: 'own-key', apiKey: 'made-up', token: 'ATTAtoken' });
    expect(result).toEqual({ ok: false, field: 'apiKey', error: 'invalid key' });
    expect(saveCredentialSpy).not.toHaveBeenCalled();
  });

  it.each([
    ['a refused token', new TrelloError('invalid token', 401, 'token'), 'invalid token'],
    ['a failure that names no field', new TrelloError('boom', 500), 'boom'],
    ['a refusal', new RefusalError('x'), 'x'],
  ])('blames the token field for %s, and saves nothing', async (_label, failure, message) => {
    validateSpy.mockRejectedValue(failure);
    const result = await invoke(IPC.BOARDS_TRELLO_CONNECT, { kind: 'own-key', apiKey: 'key-1', token: 'ATTAtoken' });
    expect(result).toEqual({ ok: false, field: 'token', error: message });
    expect(saveCredentialSpy).not.toHaveBeenCalled();
  });

  it('rethrows a failure that is not Trello\'s answer, so the IPC wrap reports it', async () => {
    validateSpy.mockRejectedValue(new TypeError('fetch failed'));
    await expect(invoke(IPC.BOARDS_TRELLO_CONNECT, { kind: 'own-key', apiKey: 'key-1', token: 'ATTAtoken' }))
      .rejects.toThrow('fetch failed');
  });
});

describe('BOARDS_TRELLO_CONNECT with Kangentic\'s key', () => {
  it('checks the token against the shipped key, never one the renderer sent', async () => {
    const result = await invoke(IPC.BOARDS_TRELLO_CONNECT, { kind: 'kangentic-key', apiKey: 'renderer-key', token: 'ATTAtoken' });
    expect(result).toEqual({ ok: true });
    expect(validateSpy).toHaveBeenCalledWith('kangentic-shipped-key', 'ATTAtoken');
    expect(saveCredentialSpy).toHaveBeenCalledWith('kangentic-key', 'kangentic-shipped-key', 'ATTAtoken');
  });

  it('blames the token for a refusal, since the shipped key is not the user\'s to fix', async () => {
    validateSpy.mockRejectedValue(new TrelloError('invalid key', 401, 'apiKey'));
    const result = await invoke(IPC.BOARDS_TRELLO_CONNECT, { kind: 'kangentic-key', token: 'ATTAtoken' });
    expect(result).toEqual({ ok: false, field: 'token', error: 'invalid key' });
  });

  it('refuses without calling Trello when the build has no Kangentic key', async () => {
    shippedKey.value = '';
    const result = await invoke(IPC.BOARDS_TRELLO_CONNECT, { kind: 'kangentic-key', token: 'ATTAtoken' });
    expect(result).toEqual({ ok: false, error: 'This build has no Kangentic Trello key. Use your own API key.' });
    expect(validateSpy).not.toHaveBeenCalled();
  });
});

describe('BOARDS_TRELLO_OPEN_APPROVAL', () => {
  it('opens Trello\'s read-only approval page for the user\'s own key', async () => {
    await invoke(IPC.BOARDS_TRELLO_OPEN_APPROVAL, { kind: 'own-key', apiKey: ' key-1 ' });
    const url = new URL(openExternalSpy.mock.calls[0][0]);
    expect(url.origin + url.pathname).toBe('https://trello.com/1/authorize');
    expect(url.searchParams.get('key')).toBe('key-1');
    expect(url.searchParams.get('scope')).toBe('read');
  });

  it('opens it for the shipped key on a sign-in', async () => {
    await invoke(IPC.BOARDS_TRELLO_OPEN_APPROVAL, { kind: 'kangentic-key' });
    expect(new URL(openExternalSpy.mock.calls[0][0]).searchParams.get('key')).toBe('kangentic-shipped-key');
  });

  it('refuses a sign-in when the build has no Kangentic key, and opens nothing', async () => {
    shippedKey.value = '';
    await expect(invoke(IPC.BOARDS_TRELLO_OPEN_APPROVAL, { kind: 'kangentic-key' }))
      .rejects.toThrow('This build has no Kangentic Trello key. Use your own API key.');
    expect(openExternalSpy).not.toHaveBeenCalled();
  });

  it('refuses a key with whitespace inside it, and opens nothing', async () => {
    await expect(invoke(IPC.BOARDS_TRELLO_OPEN_APPROVAL, { kind: 'own-key', apiKey: 'key 1' }))
      .rejects.toThrow('A key or token has no spaces.');
    expect(openExternalSpy).not.toHaveBeenCalled();
  });

  it('throws a RefusalError, so the report filter treats it as an expected answer', async () => {
    const failure = await invoke(IPC.BOARDS_TRELLO_OPEN_APPROVAL, { kind: 'own-key', apiKey: '' }).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(RefusalError);
  });

  it('uses the shipped key on a sign-in, never the one the renderer sent', async () => {
    await invoke(IPC.BOARDS_TRELLO_OPEN_APPROVAL, { kind: 'kangentic-key', apiKey: 'renderer-key' });
    expect(new URL(openExternalSpy.mock.calls[0][0]).searchParams.get('key')).toBe('kangentic-shipped-key');
  });

  it('refuses with no key to approve, and opens nothing', async () => {
    await expect(invoke(IPC.BOARDS_TRELLO_OPEN_APPROVAL, { kind: 'own-key', apiKey: '' })).rejects.toThrow('Paste your API key.');
    expect(openExternalSpy).not.toHaveBeenCalled();
  });
});

describe('BOARDS_TRELLO_LIST_BOARDS', () => {
  it('passes the boards through', async () => {
    const boards: TrelloBoardSummary[] = [
      { id: 'b1', shortLink: 'AbC123xy', name: 'Sprint board', url: 'https://trello.com/b/AbC123xy/sprint-board', workspaceName: 'Acme' },
    ];
    listBoardsSpy.mockResolvedValue(boards);
    expect(await invoke(IPC.BOARDS_TRELLO_LIST_BOARDS)).toEqual({ boards });
  });

  it('returns Trello\'s refusal as an answer, so the picker can reopen Connect', async () => {
    listBoardsSpy.mockRejectedValue(new TrelloError('invalid token', 401, 'token'));
    expect(await invoke(IPC.BOARDS_TRELLO_LIST_BOARDS)).toEqual({ boards: [], error: 'invalid token' });
  });

  it('rethrows a failure that is not Trello\'s answer', async () => {
    listBoardsSpy.mockRejectedValue(new TypeError('fetch failed'));
    await expect(invoke(IPC.BOARDS_TRELLO_LIST_BOARDS)).rejects.toThrow('fetch failed');
  });

  it('answers a not-connected refusal as an answer too', async () => {
    listBoardsSpy.mockRejectedValue(new RefusalError('x'));
    expect(await invoke(IPC.BOARDS_TRELLO_LIST_BOARDS)).toEqual({ boards: [], error: 'x' });
  });

  it.each([
    ['a 503', 503],
    ['a 429', 429],
  ])('rethrows %s instead of sending the user to Connect', async (_label, status) => {
    listBoardsSpy.mockRejectedValue(new TrelloError('Trello is busy', status));
    await expect(invoke(IPC.BOARDS_TRELLO_LIST_BOARDS)).rejects.toThrow('Trello is busy');
  });
});

describe('BOARDS_TRELLO_CLEAR_CREDENTIAL', () => {
  it('deletes the saved credential', async () => {
    await invoke(IPC.BOARDS_TRELLO_CLEAR_CREDENTIAL);
    expect(clearSpy).toHaveBeenCalledTimes(1);
  });
});
