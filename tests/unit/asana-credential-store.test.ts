/**
 * Unit tests for loadAsanaCredential in
 * src/main/boards/adapters/asana/credential-store.ts
 *
 * Verifies that the function validates accessToken is a non-empty string
 * after JSON.parse, rather than returning a malformed object whose
 * accessToken is undefined or empty - which would be sent as a Bearer token
 * to the Asana API and silently fail.
 *
 * The electron module is mocked at the top level (same pattern as boards-auth.test.ts).
 * fs and PATHS are mocked so we never touch disk during tests.
 * decryptSecret is mocked so we can inject arbitrary decrypted JSON payloads.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// --- Electron mock (required by auth.ts which credential-store.ts imports from) ---
vi.mock('electron', () => ({
  app: {
    isReady: () => true,
    whenReady: () => Promise.resolve(),
  },
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (plaintext: string) => Buffer.from(`encrypted:${plaintext}`, 'utf8'),
    decryptString: (buffer: Buffer) => {
      const raw = buffer.toString('utf8');
      if (raw.startsWith('encrypted:')) return raw.slice('encrypted:'.length);
      throw new Error('safeStorage.decryptString: invalid ciphertext');
    },
    getSelectedStorageBackend: () => 'keychain',
  },
}));

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

// --- Mock decryptSecret from the shared barrel so we control the decrypted payload ---
const decryptSecretSpy = vi.hoisted(() =>
  vi.fn<(ciphertext: string) => string>(),
);

vi.mock('../../src/main/boards/shared', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/main/boards/shared')>();
  return { ...actual, decryptSecret: decryptSecretSpy };
});

// Import AFTER all vi.mock declarations.
const { loadAsanaCredential } = await import(
  '../../src/main/boards/adapters/asana/credential-store'
);

// ---------------------------------------------------------------------------

beforeEach(() => {
  existsSyncSpy.mockReset();
  readFileSyncSpy.mockReset();
  decryptSecretSpy.mockReset();
});

describe('loadAsanaCredential', () => {
  describe('file not found', () => {
    it('returns null when the credential file does not exist', () => {
      existsSyncSpy.mockReturnValue(false);
      const result = loadAsanaCredential();
      expect(result).toBeNull();
    });
  });

  describe('valid PAT-era credential', () => {
    it('returns the credential when accessToken, userEmail, and savedAt are present', () => {
      const credential = {
        accessToken: '1/12345:abcdefghijklmnopqrstuvwxyz',
        userEmail: 'dev@example.com',
        savedAt: new Date().toISOString(),
      };
      existsSyncSpy.mockReturnValue(true);
      readFileSyncSpy.mockReturnValue(JSON.stringify({ encrypted: 'e_fake_blob' }));
      decryptSecretSpy.mockReturnValue(JSON.stringify(credential));

      const result = loadAsanaCredential();
      expect(result).not.toBeNull();
      expect(result!.accessToken).toBe(credential.accessToken);
      expect(result!.userEmail).toBe(credential.userEmail);
    });
  });

  describe('legacy OAuth-era credential (extra fields)', () => {
    it('returns a working credential when old refreshToken/expiresAt fields are present alongside accessToken', () => {
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
      decryptSecretSpy.mockReturnValue(JSON.stringify(legacyShape));

      const result = loadAsanaCredential();
      expect(result).not.toBeNull();
      expect(result!.accessToken).toBe(legacyShape.accessToken);
      expect(result!.userEmail).toBe(legacyShape.userEmail);
    });
  });

  describe('malformed credential - missing accessToken field', () => {
    it('returns null when the decrypted JSON has no accessToken field', () => {
      // This shape could exist in the wild if a future format migration partially
      // wrote the file, or if a test wrote a credential without the field. Without
      // the validation added in this change, the cast would return { token: 'abc' }
      // as an AsanaCredential with accessToken === undefined, causing a Bearer
      // of "undefined" to be sent to the Asana API.
      const malformedShape = { token: 'abc', userEmail: 'dev@example.com' };
      existsSyncSpy.mockReturnValue(true);
      readFileSyncSpy.mockReturnValue(JSON.stringify({ encrypted: 'e_fake_blob' }));
      decryptSecretSpy.mockReturnValue(JSON.stringify(malformedShape));

      const result = loadAsanaCredential();
      expect(result).toBeNull();
    });
  });

  describe('malformed credential - empty-string accessToken', () => {
    it('returns null when accessToken is an empty string', () => {
      const emptyTokenShape = {
        accessToken: '',
        userEmail: 'dev@example.com',
        savedAt: new Date().toISOString(),
      };
      existsSyncSpy.mockReturnValue(true);
      readFileSyncSpy.mockReturnValue(JSON.stringify({ encrypted: 'e_fake_blob' }));
      decryptSecretSpy.mockReturnValue(JSON.stringify(emptyTokenShape));

      const result = loadAsanaCredential();
      expect(result).toBeNull();
    });
  });

  describe('decryption throws', () => {
    it('returns null and does not rethrow when decryptSecret throws', () => {
      existsSyncSpy.mockReturnValue(true);
      readFileSyncSpy.mockReturnValue(JSON.stringify({ encrypted: 'e_fake_blob' }));
      decryptSecretSpy.mockImplementation(() => {
        throw new Error('safeStorage unavailable');
      });

      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      const result = loadAsanaCredential();
      warnSpy.mockRestore();

      expect(result).toBeNull();
    });

    it('logs a warning when the try block throws (e.g. JSON parse error)', () => {
      // readFileSync returns invalid JSON to force an error inside the try block.
      existsSyncSpy.mockReturnValue(true);
      readFileSyncSpy.mockReturnValue('not-valid-json');

      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      loadAsanaCredential();

      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('asana/credential-store'),
        expect.any(Error),
      );
      warnSpy.mockRestore();
    });
  });

  describe('missing encrypted field in stored file', () => {
    it('returns null when the JSON file has no encrypted field', () => {
      existsSyncSpy.mockReturnValue(true);
      readFileSyncSpy.mockReturnValue(JSON.stringify({ someOtherKey: 'value' }));

      const result = loadAsanaCredential();
      expect(result).toBeNull();
    });
  });
});
