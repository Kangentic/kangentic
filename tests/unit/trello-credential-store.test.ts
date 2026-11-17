/**
 * loadTrelloCredential in src/main/boards/adapters/trello/credential-store.ts.
 *
 * A stored credential with an empty key or token would be sent to Trello and refused with a
 * message about the other half, so it must read as "not connected". The safeStorage rewrite must
 * keep the credential in hand and land in this store's own file. Same mocks as the Asana store's
 * test: electron, fs, PATHS, safe-write and the encrypt/decrypt pair.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', async () => {
  const { createFakeSafeStorage } = await import('./helpers/fake-safe-storage');
  return {
    app: { isReady: () => true, whenReady: () => Promise.resolve() },
    safeStorage: createFakeSafeStorage(),
  };
});

const existsSyncSpy = vi.hoisted(() => vi.fn<(filePath: string) => boolean>());
const readFileSyncSpy = vi.hoisted(() => vi.fn<(filePath: string, encoding: BufferEncoding) => string>());
const rmSyncSpy = vi.hoisted(() => vi.fn<(filePath: string, options?: { force?: boolean }) => void>());

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    default: { ...actual, existsSync: existsSyncSpy, readFileSync: readFileSyncSpy, rmSync: rmSyncSpy },
    existsSync: existsSyncSpy,
    readFileSync: readFileSyncSpy,
    rmSync: rmSyncSpy,
  };
});

vi.mock('../../src/main/config/paths', () => ({ PATHS: { configDir: '/mock/config' } }));

const safeWriteJsonSpy = vi.hoisted(() =>
  vi.fn<(filePath: string, payload: unknown, source: string, options?: { mode?: number }) => boolean>(() => true),
);
vi.mock('../../src/main/safe-write', () => ({ safeWriteJson: safeWriteJsonSpy }));

const decryptSecretSpy = vi.hoisted(() =>
  vi.fn<(ciphertext: string) => Promise<{ plaintext: string; shouldRewrite: boolean }>>(),
);
const encryptSecretSpy = vi.hoisted(() => vi.fn<(plaintext: string) => Promise<string>>());

vi.mock('../../src/main/boards/shared/auth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/main/boards/shared/auth')>();
  return { ...actual, decryptSecret: decryptSecretSpy, encryptSecret: encryptSecretSpy };
});

const { loadTrelloCredential, saveTrelloCredential, clearTrelloCredential } = await import('../../src/main/boards/adapters/trello/credential-store');

const VALID_CREDENTIAL = {
  kind: 'own-key',
  apiKey: '3f9a0c2e71b84d55a6e0c1d9b7f24e18',
  token: 'ATTA0123456789abcdef',
  savedAt: '2026-11-17T00:00:00.000Z',
};

function storedAs(payload: unknown, shouldRewrite = false): void {
  existsSyncSpy.mockReturnValue(true);
  readFileSyncSpy.mockReturnValue(JSON.stringify({ encrypted: 'e_fake_blob' }));
  decryptSecretSpy.mockResolvedValue({ plaintext: JSON.stringify(payload), shouldRewrite });
}

beforeEach(() => {
  existsSyncSpy.mockReset();
  readFileSyncSpy.mockReset();
  rmSyncSpy.mockReset();
  decryptSecretSpy.mockReset();
  encryptSecretSpy.mockReset();
  encryptSecretSpy.mockImplementation(async (plaintext: string) => `e-rewritten:${plaintext}`);
  safeWriteJsonSpy.mockReset();
  safeWriteJsonSpy.mockReturnValue(true);
});

describe('loadTrelloCredential', () => {
  it('returns null when nothing is stored', async () => {
    existsSyncSpy.mockReturnValue(false);
    expect(await loadTrelloCredential()).toBeNull();
  });

  it('returns a stored key and token', async () => {
    storedAs(VALID_CREDENTIAL);
    expect(await loadTrelloCredential()).toEqual(VALID_CREDENTIAL);
    expect(safeWriteJsonSpy).not.toHaveBeenCalled();
  });

  it.each([
    ['no key', { ...VALID_CREDENTIAL, apiKey: undefined }],
    ['an empty key', { ...VALID_CREDENTIAL, apiKey: '' }],
    ['no token', { ...VALID_CREDENTIAL, token: undefined }],
    ['an empty token', { ...VALID_CREDENTIAL, token: '' }],
  ])('reads a credential with %s as not connected', async (_label, payload) => {
    storedAs(payload, true);
    expect(await loadTrelloCredential()).toBeNull();
    expect(safeWriteJsonSpy).not.toHaveBeenCalled();
  });

  it('treats an unknown kind as the user\'s own key', async () => {
    storedAs({ ...VALID_CREDENTIAL, kind: 'something-else' });
    expect((await loadTrelloCredential())?.kind).toBe('own-key');
  });

  it('keeps the kangentic-key kind', async () => {
    storedAs({ ...VALID_CREDENTIAL, kind: 'kangentic-key' });
    expect((await loadTrelloCredential())?.kind).toBe('kangentic-key');
  });

  it('reads a stored JSON null as not connected', async () => {
    storedAs(null);
    expect(await loadTrelloCredential()).toBeNull();
  });

  it('reads a credential with no savedAt as an empty savedAt', async () => {
    storedAs({ ...VALID_CREDENTIAL, savedAt: undefined });
    expect((await loadTrelloCredential())?.savedAt).toBe('');
  });

  it('rewrites a credential flagged for re-encryption into its own file, and still returns it', async () => {
    storedAs(VALID_CREDENTIAL, true);
    expect(await loadTrelloCredential()).toEqual(VALID_CREDENTIAL);
    expect(safeWriteJsonSpy).toHaveBeenCalledTimes(1);
    const [writtenPath, , writtenSource] = safeWriteJsonSpy.mock.calls[0];
    expect(writtenPath.replace(/\\/g, '/')).toBe('/mock/config/trello-credentials.json');
    expect(writtenSource).toBe('trello_credential');
  });
});

describe('saveTrelloCredential', () => {
  it('encrypts the credential and writes it to the store file', async () => {
    await saveTrelloCredential({ ...VALID_CREDENTIAL, kind: 'own-key' });

    expect(encryptSecretSpy).toHaveBeenCalledTimes(1);
    expect(JSON.parse(encryptSecretSpy.mock.calls[0][0])).toEqual(VALID_CREDENTIAL);
    expect(safeWriteJsonSpy).toHaveBeenCalledTimes(1);
    const [writtenPath, payload, writtenSource] = safeWriteJsonSpy.mock.calls[0];
    expect(writtenPath.replace(/\\/g, '/')).toBe('/mock/config/trello-credentials.json');
    expect(writtenSource).toBe('trello_credential');
    const { encrypted } = payload as { encrypted: string };
    expect(JSON.parse(encrypted.replace('e-rewritten:', ''))).toEqual(VALID_CREDENTIAL);
  });
});

describe('clearTrelloCredential', () => {
  it('removes the store file with force so a missing file is fine', () => {
    clearTrelloCredential();
    expect(rmSyncSpy).toHaveBeenCalledTimes(1);
    const [removedPath, options] = rmSyncSpy.mock.calls[0];
    expect(removedPath.replace(/\\/g, '/')).toBe('/mock/config/trello-credentials.json');
    expect(options).toEqual({ force: true });
  });
});
