/**
 * Unit tests for loadAsanaCredential in
 * src/main/boards/adapters/asana/credential-store.ts
 *
 * Verifies that the function validates accessToken is a non-empty string
 * after JSON.parse, rather than returning a malformed object whose
 * accessToken is undefined or empty - which would be sent as a Bearer token
 * to the Asana API and silently fail. Also pins the safeStorage migration:
 * a credential decryptSecret flags with `shouldRewrite` (written by the old
 * sync API, re-encryption requested, or stored in plaintext before encryption
 * was available) is saved again in the current format, and a failed rewrite
 * never costs the caller the credential.
 *
 * The electron module is mocked at the top level (same pattern as boards-auth.test.ts).
 * fs, PATHS and safe-write are mocked so we never touch disk during tests.
 * decryptSecret and encryptSecret are mocked so we can inject arbitrary payloads.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// --- Electron mock (required by auth.ts, which the mocked module below wraps) ---
vi.mock('electron', async () => {
  const { createFakeSafeStorage } = await import('./helpers/fake-safe-storage');
  return {
    app: {
      isReady: () => true,
      whenReady: () => Promise.resolve(),
    },
    safeStorage: createFakeSafeStorage(),
  };
});

// --- Mock the fs module so no real file I/O occurs ---
// node:fs is imported as a default (CJS-style), so the mock must include both
// named exports (for named imports) AND a default that bundles all of them.
const existsSyncSpy = vi.hoisted(() => vi.fn<(filePath: string) => boolean>());
const readFileSyncSpy = vi.hoisted(() => vi.fn<(filePath: string, encoding: BufferEncoding) => string>());

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    default: {
      ...actual,
      existsSync: existsSyncSpy,
      readFileSync: readFileSyncSpy,
    },
    existsSync: existsSyncSpy,
    readFileSync: readFileSyncSpy,
  };
});

// --- Mock PATHS so storePath() produces a stable, fake path ---
vi.mock('../../src/main/config/paths', () => ({
  PATHS: { configDir: '/mock/config' },
}));

// --- Mock the guarded writer so a rewrite never reaches disk, and can be observed ---
const safeWriteJsonSpy = vi.hoisted(() =>
  vi.fn<(filePath: string, payload: unknown, source: string, options?: { mode?: number }) => boolean>(() => true),
);
vi.mock('../../src/main/safe-write', () => ({ safeWriteJson: safeWriteJsonSpy }));

// --- Mock decryptSecret / encryptSecret in auth.ts so we control the payloads ---
// auth.ts itself, not the boards/shared barrel: the store reads and writes through
// boards/shared/encrypted-secret-file.ts, which imports them from './auth'.
const decryptSecretSpy = vi.hoisted(() =>
  vi.fn<(ciphertext: string) => Promise<{ plaintext: string; shouldRewrite: boolean }>>(),
);
const encryptSecretSpy = vi.hoisted(() => vi.fn<(plaintext: string) => Promise<string>>());

vi.mock('../../src/main/boards/shared/auth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/main/boards/shared/auth')>();
  return { ...actual, decryptSecret: decryptSecretSpy, encryptSecret: encryptSecretSpy };
});

// Import AFTER all vi.mock declarations.
const { loadAsanaCredential } = await import(
  '../../src/main/boards/adapters/asana/credential-store'
);

/** decryptSecret's new shape, for a blob that needs no rewrite. */
function decrypted(payload: unknown, shouldRewrite = false) {
  return { plaintext: JSON.stringify(payload), shouldRewrite };
}

const VALID_CREDENTIAL = {
  accessToken: '1/12345:abcdefghijklmnopqrstuvwxyz',
  userEmail: 'dev@example.com',
  savedAt: '2026-01-01T00:00:00.000Z',
};

// ---------------------------------------------------------------------------

beforeEach(() => {
  existsSyncSpy.mockReset();
  readFileSyncSpy.mockReset();
  decryptSecretSpy.mockReset();
  encryptSecretSpy.mockReset();
  encryptSecretSpy.mockImplementation(async (plaintext: string) => `e-rewritten:${plaintext}`);
  safeWriteJsonSpy.mockReset();
  safeWriteJsonSpy.mockReturnValue(true);
});

describe('loadAsanaCredential', () => {
  describe('file not found', () => {
    it('returns null when the credential file does not exist', async () => {
      existsSyncSpy.mockReturnValue(false);
      const result = await loadAsanaCredential();
      expect(result).toBeNull();
    });
  });

  describe('valid PAT-era credential', () => {
    it('returns the credential when accessToken, userEmail, and savedAt are present', async () => {
      existsSyncSpy.mockReturnValue(true);
      readFileSyncSpy.mockReturnValue(JSON.stringify({ encrypted: 'e_fake_blob' }));
      decryptSecretSpy.mockResolvedValue(decrypted(VALID_CREDENTIAL));

      const result = await loadAsanaCredential();
      expect(result).not.toBeNull();
      expect(result!.accessToken).toBe(VALID_CREDENTIAL.accessToken);
      expect(result!.userEmail).toBe(VALID_CREDENTIAL.userEmail);
      // Current format: nothing to migrate, so nothing is written.
      expect(safeWriteJsonSpy).not.toHaveBeenCalled();
    });
  });

  describe('legacy OAuth-era credential (extra fields)', () => {
    it('returns a working credential when old refreshToken/expiresAt fields are present alongside accessToken', async () => {
      // Old shape from the OAuth flow. accessToken is still there, so it should
      // be returned successfully (extra fields are ignored by the type cast).
      const legacyShape = {
        accessToken: '1/99999:legacytokenwithsufficientlength',
        refreshToken: 'refresh-token-value',
        expiresAt: '2025-01-01T00:00:00.000Z',
        userEmail: 'legacy@example.com',
        savedAt: '2025-01-01T00:00:00.000Z',
      };
      existsSyncSpy.mockReturnValue(true);
      readFileSyncSpy.mockReturnValue(JSON.stringify({ encrypted: 'e_fake_blob' }));
      decryptSecretSpy.mockResolvedValue(decrypted(legacyShape));

      const result = await loadAsanaCredential();
      expect(result).not.toBeNull();
      expect(result!.accessToken).toBe(legacyShape.accessToken);
      expect(result!.userEmail).toBe(legacyShape.userEmail);
    });
  });

  describe('malformed credential - missing accessToken field', () => {
    it('returns null when the decrypted JSON has no accessToken field', async () => {
      // This shape could exist in the wild if a future format migration partially
      // wrote the file, or if a test wrote a credential without the field. Without
      // the validation, the cast would return { token: 'abc' } as an
      // AsanaCredential with accessToken === undefined, causing a Bearer of
      // "undefined" to be sent to the Asana API.
      const malformedShape = { token: 'abc', userEmail: 'dev@example.com' };
      existsSyncSpy.mockReturnValue(true);
      readFileSyncSpy.mockReturnValue(JSON.stringify({ encrypted: 'e_fake_blob' }));
      decryptSecretSpy.mockResolvedValue(decrypted(malformedShape, true));

      const result = await loadAsanaCredential();
      expect(result).toBeNull();
      // A malformed credential is never migrated into the new format.
      expect(safeWriteJsonSpy).not.toHaveBeenCalled();
    });
  });

  describe('malformed credential - empty-string accessToken', () => {
    it('returns null when accessToken is an empty string', async () => {
      const emptyTokenShape = {
        accessToken: '',
        userEmail: 'dev@example.com',
        savedAt: new Date().toISOString(),
      };
      existsSyncSpy.mockReturnValue(true);
      readFileSyncSpy.mockReturnValue(JSON.stringify({ encrypted: 'e_fake_blob' }));
      decryptSecretSpy.mockResolvedValue(decrypted(emptyTokenShape));

      const result = await loadAsanaCredential();
      expect(result).toBeNull();
    });
  });

  describe('decryption throws', () => {
    it('returns null and does not rethrow when decryptSecret rejects', async () => {
      existsSyncSpy.mockReturnValue(true);
      readFileSyncSpy.mockReturnValue(JSON.stringify({ encrypted: 'e_fake_blob' }));
      decryptSecretSpy.mockRejectedValue(new Error('safeStorage unavailable'));

      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      const result = await loadAsanaCredential();
      warnSpy.mockRestore();

      expect(result).toBeNull();
    });

    it('logs a warning when the try block throws (e.g. JSON parse error)', async () => {
      // readFileSync returns invalid JSON to force an error inside the try block.
      existsSyncSpy.mockReturnValue(true);
      readFileSyncSpy.mockReturnValue('not-valid-json');

      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      await loadAsanaCredential();

      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('asana/credential-store'),
        expect.any(Error),
      );
      warnSpy.mockRestore();
    });
  });

  describe('missing encrypted field in stored file', () => {
    it('returns null when the JSON file has no encrypted field', async () => {
      existsSyncSpy.mockReturnValue(true);
      readFileSyncSpy.mockReturnValue(JSON.stringify({ someOtherKey: 'value' }));

      const result = await loadAsanaCredential();
      expect(result).toBeNull();
    });
  });

  describe('migration to the current format', () => {
    it('rewrites a credential decryptSecret flags for a rewrite, and still returns it', async () => {
      existsSyncSpy.mockReturnValue(true);
      readFileSyncSpy.mockReturnValue(JSON.stringify({ encrypted: 'e_legacy_sync_blob' }));
      decryptSecretSpy.mockResolvedValue(decrypted(VALID_CREDENTIAL, true));

      const result = await loadAsanaCredential();

      expect(result).toEqual(VALID_CREDENTIAL);
      expect(encryptSecretSpy).toHaveBeenCalledWith(JSON.stringify(VALID_CREDENTIAL));
      expect(safeWriteJsonSpy).toHaveBeenCalledTimes(1);
      const [writtenPath, writtenPayload, writtenSource] = safeWriteJsonSpy.mock.calls[0];
      expect(writtenPath.replace(/\\/g, '/')).toBe('/mock/config/asana-credentials.json');
      expect(writtenPayload).toEqual({ encrypted: `e-rewritten:${JSON.stringify(VALID_CREDENTIAL)}` });
      expect(writtenSource).toBe('asana_credential');
    });

    it('still returns the credential when the rewrite fails', async () => {
      existsSyncSpy.mockReturnValue(true);
      readFileSyncSpy.mockReturnValue(JSON.stringify({ encrypted: 'e_legacy_sync_blob' }));
      decryptSecretSpy.mockResolvedValue(decrypted(VALID_CREDENTIAL, true));
      encryptSecretSpy.mockRejectedValue(new Error('safeStorage went away mid-rewrite'));

      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      const result = await loadAsanaCredential();

      expect(result).toEqual(VALID_CREDENTIAL);
      expect(safeWriteJsonSpy).not.toHaveBeenCalled();
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('could not rewrite the credential'),
        expect.any(Error),
      );
      warnSpy.mockRestore();
    });

    // The rewrite awaits decryptSecret and encryptSecret. A Disconnect, a 401 clear, or a newly
    // saved token can land in that window. The load must rewrite only the ciphertext it read, so
    // the stale credential in hand never comes back over what the user just did. Each test lands
    // the change inside the encryptSecret await, after the load has already read and decrypted.
    it('does not recreate the file when the credential is cleared during the rewrite', async () => {
      existsSyncSpy.mockReturnValue(true);
      readFileSyncSpy.mockReturnValue(JSON.stringify({ encrypted: 'e_legacy_sync_blob' }));
      decryptSecretSpy.mockResolvedValue(decrypted(VALID_CREDENTIAL, true));
      encryptSecretSpy.mockImplementation(async (plaintext: string) => {
        // A Disconnect lands here: clearAsanaCredential has unlinked the file while the load awaits.
        existsSyncSpy.mockReturnValue(false);
        return `e-rewritten:${plaintext}`;
      });

      const result = await loadAsanaCredential();

      expect(result).toEqual(VALID_CREDENTIAL);
      expect(encryptSecretSpy).toHaveBeenCalledTimes(1);
      expect(safeWriteJsonSpy).not.toHaveBeenCalled();
    });

    it('does not overwrite a newer credential saved during the rewrite', async () => {
      existsSyncSpy.mockReturnValue(true);
      readFileSyncSpy.mockReturnValue(JSON.stringify({ encrypted: 'e_legacy_sync_blob' }));
      decryptSecretSpy.mockResolvedValue(decrypted(VALID_CREDENTIAL, true));
      encryptSecretSpy.mockImplementation(async (plaintext: string) => {
        // A Connect with a new token lands here, so the file holds a different ciphertext than the load read.
        readFileSyncSpy.mockReturnValue(JSON.stringify({ encrypted: 'e_new_token_blob' }));
        return `e-rewritten:${plaintext}`;
      });

      const result = await loadAsanaCredential();

      // The load still hands back the credential it read; it just must not persist it.
      expect(result).toEqual(VALID_CREDENTIAL);
      expect(encryptSecretSpy).toHaveBeenCalledTimes(1);
      expect(safeWriteJsonSpy).not.toHaveBeenCalled();
    });
  });
});
