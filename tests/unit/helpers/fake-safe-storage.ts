/**
 * A fake of Electron's `safeStorage`, for suites that mock the `electron`
 * module. "Encryption" is a reversible `encrypted:` prefix, so a test can read
 * what was written. Decrypting anything without the prefix throws, as the real
 * API does for ciphertext it did not produce.
 *
 * It covers the async API the credential and identity stores read through
 * (`isAsyncEncryptionAvailable`, `encryptStringAsync`, `decryptStringAsync`,
 * which reports `shouldReEncrypt: false`). The synchronous trio is left out:
 * Electron 45 deprecates it, 46 removes it, and a call to it fails here as a
 * TypeError.
 *
 * This is the single place to change when safeStorage's contract changes.
 *
 * A `vi.mock` factory is hoisted above the imports, so a static import of this
 * file is not initialized yet when the factory runs. Load it from inside an
 * async factory instead, and keep the rest of the `electron` mock in the suite:
 *
 *   vi.mock('electron', async () => {
 *     const { createFakeSafeStorage } = await import('../helpers/fake-safe-storage');
 *     return { app: { ... }, safeStorage: createFakeSafeStorage() };
 *   });
 *
 * Each call returns a fresh object. Availability is read through getters on
 * every call, so a suite that flips it mid-run keeps its state in the suite
 * (a `vi.hoisted` object) and passes `() => state.flag`. A boolean copied at
 * construction would never see the flip.
 */

const CIPHERTEXT_PREFIX = 'encrypted:';

export interface FakeSafeStorage {
  isAsyncEncryptionAvailable: () => Promise<boolean>;
  encryptStringAsync: (plaintext: string) => Promise<Buffer>;
  decryptStringAsync: (ciphertext: Buffer) => Promise<{ result: string; shouldReEncrypt: boolean }>;
}

export interface FakeSafeStorageOptions {
  /** What `isAsyncEncryptionAvailable()` resolves to. Defaults to always true. */
  isAsyncEncryptionAvailable?: () => boolean;
}

function encrypt(plaintext: string): Buffer {
  return Buffer.from(`${CIPHERTEXT_PREFIX}${plaintext}`, 'utf8');
}

function decrypt(ciphertext: Buffer): string {
  const raw = ciphertext.toString('utf8');
  if (raw.startsWith(CIPHERTEXT_PREFIX)) return raw.slice(CIPHERTEXT_PREFIX.length);
  throw new Error('safeStorage.decryptStringAsync: invalid ciphertext');
}

export function createFakeSafeStorage(options: FakeSafeStorageOptions = {}): FakeSafeStorage {
  const isAsyncEncryptionAvailable = options.isAsyncEncryptionAvailable ?? (() => true);
  return {
    isAsyncEncryptionAvailable: async () => isAsyncEncryptionAvailable(),
    encryptStringAsync: async (plaintext) => encrypt(plaintext),
    decryptStringAsync: async (ciphertext) => ({
      result: decrypt(ciphertext),
      shouldReEncrypt: false,
    }),
  };
}
