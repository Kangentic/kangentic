/**
 * Unit tests for src/main/mobile-bridge/identity.ts
 *
 * Verifies that loadBridgeIdentity/loadOrCreateBridgeIdentity/clearBridgeIdentity
 * persist the desktop's mobile-bridge identity (an X25519 static keypair plus
 * an Ed25519 master signing keypair) correctly, and - the load-bearing safety
 * property of this module - that loadOrCreateBridgeIdentity() REFUSES to
 * generate and persist a brand-new private key when genuine encryption is
 * unavailable (no Linux secret store, so only safeStorage's hardcoded fallback
 * key, or safeStorage disabled entirely), rather than silently writing an
 * unprotected key to disk. Also pins the safeStorage migration: an identity
 * decryptSecret flags for a rewrite is saved again, but ONLY under genuine
 * encryption, the same bar creating one has to clear, and never over a
 * clear or a different identity that lands while the rewrite is encrypting.
 *
 * Mirrors the mocking pattern from tests/unit/asana-credential-store.test.ts
 * and tests/unit/boards-auth.test.ts: the electron module is mocked so
 * safeStorage never touches a real OS keychain, node:fs is mocked (both
 * named exports and a bundled `default`, since fs is imported CJS-style) so
 * no real file I/O occurs, and PATHS is mocked to a stable fake configDir.
 * Unlike the asana test, encryptSecret/decryptSecret from
 * src/main/boards/shared/auth.ts are NOT mocked - they run for real against
 * the mocked safeStorage, so an encrypt-then-decrypt round trip through this
 * test exercises the real sentinel + JSON envelope logic end to end.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// --- Electron mock: reversible schemes so encryptSecret/decryptSecret (which run
// for real) can genuinely round-trip. The sync API writes "encrypted:<plaintext>"
// (the legacy format); the async API writes "<tag>:<plaintext>", where the tag
// stands in for Chromium's key tag (v10 = Linux hardcoded fallback key). ---
const mockElectronState = {
  isEncryptionAvailable: true,
  isAsyncEncryptionAvailable: true,
  asyncTag: 'v11',
  shouldReEncrypt: false,
  asyncDecryptThrows: false,
  storageBackend: 'keychain' as string,
  // Runs inside encryptStringAsync, i.e. inside the await a rewrite spends encrypting, so a
  // case can land a clear or a new save in exactly the window the rewrite's guard covers.
  onEncryptStringAsync: null as (() => void) | null,
};

function parseMockCiphertext(buffer: Buffer): string | null {
  const raw = buffer.toString('utf8');
  if (raw.startsWith('encrypted:')) return raw.slice('encrypted:'.length);
  const asyncMatch = /^v\d\d:/.exec(raw);
  return asyncMatch ? raw.slice(asyncMatch[0].length) : null;
}

vi.mock('electron', () => ({
  app: {
    isReady: () => true,
    whenReady: () => Promise.resolve(),
  },
  safeStorage: {
    isEncryptionAvailable: () => mockElectronState.isEncryptionAvailable,
    encryptString: (plaintext: string) => Buffer.from(`encrypted:${plaintext}`, 'utf8'),
    decryptString: (buffer: Buffer) => {
      const raw = buffer.toString('utf8');
      if (raw.startsWith('encrypted:')) return raw.slice('encrypted:'.length);
      throw new Error('safeStorage.decryptString: invalid ciphertext');
    },
    isAsyncEncryptionAvailable: async () => mockElectronState.isAsyncEncryptionAvailable,
    encryptStringAsync: async (plaintext: string) => {
      mockElectronState.onEncryptStringAsync?.();
      return Buffer.from(`${mockElectronState.asyncTag}:${plaintext}`, 'utf8');
    },
    decryptStringAsync: async (buffer: Buffer) => {
      if (mockElectronState.asyncDecryptThrows) {
        throw new Error('safeStorage.decryptStringAsync: the key that encrypted this data is not available');
      }
      const result = parseMockCiphertext(buffer);
      if (result === null) throw new Error('safeStorage.decryptStringAsync: invalid ciphertext');
      return { result, shouldReEncrypt: mockElectronState.shouldReEncrypt };
    },
    getSelectedStorageBackend: () => mockElectronState.storageBackend,
  },
}));

// --- Mock node:fs so no real file I/O occurs. Bundle both named exports and a
// `default` object, since identity.ts imports fs as a CJS-style default. ---
const existsSyncSpy = vi.hoisted(() => vi.fn<(filePath: string) => boolean>());
const readFileSyncSpy = vi.hoisted(() => vi.fn<(filePath: string, encoding: BufferEncoding) => string>());
const writeFileSyncSpy = vi.hoisted(() => vi.fn<(filePath: string, data: string) => void>());
const mkdirSyncSpy = vi.hoisted(() => vi.fn());
const unlinkSyncSpy = vi.hoisted(() => vi.fn());
const rmSyncSpy = vi.hoisted(() => vi.fn());

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    default: {
      ...actual,
      existsSync: existsSyncSpy,
      readFileSync: readFileSyncSpy,
      writeFileSync: writeFileSyncSpy,
      mkdirSync: mkdirSyncSpy,
      unlinkSync: unlinkSyncSpy,
      rmSync: rmSyncSpy,
    },
    existsSync: existsSyncSpy,
    readFileSync: readFileSyncSpy,
    writeFileSync: writeFileSyncSpy,
    mkdirSync: mkdirSyncSpy,
    unlinkSync: unlinkSyncSpy,
    rmSync: rmSyncSpy,
  };
});

// --- Mock PATHS so identityPath() produces a stable, fake path. ---
vi.mock('../../../src/main/config/paths', () => ({
  PATHS: { configDir: '/mock/config' },
}));

// Import AFTER all vi.mock declarations.
const { loadBridgeIdentity, loadOrCreateBridgeIdentity, clearBridgeIdentity } = await import(
  '../../../src/main/mobile-bridge/identity'
);
const { resetSecureStorageProbeForTests } = await import('../../../src/main/boards/shared/auth');

const originalPlatform = process.platform;

function setPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', { value: platform, configurable: true });
}

/** An identity envelope exactly as the OLD sync API wrote it: 'e' + base64("encrypted:<json>"). */
function legacyEnvelopeFor(storedIdentity: Record<string, string>): string {
  const cipherBuffer = Buffer.from(`encrypted:${JSON.stringify(storedIdentity)}`, 'utf8');
  return JSON.stringify({ encrypted: 'e' + cipherBuffer.toString('base64') });
}

const VALID_STORED_IDENTITY = {
  staticSecretKeyHex: '11'.repeat(32),
  staticPublicKeyHex: '22'.repeat(32),
  masterSigningSecretKeyHex: '33'.repeat(32),
  masterSigningPublicKeyHex: '44'.repeat(32),
  createdAt: '2026-01-01T00:00:00.000Z',
};

beforeEach(() => {
  existsSyncSpy.mockReset();
  readFileSyncSpy.mockReset();
  writeFileSyncSpy.mockReset();
  mkdirSyncSpy.mockReset();
  unlinkSyncSpy.mockReset();
  rmSyncSpy.mockReset();
  mockElectronState.isEncryptionAvailable = true;
  mockElectronState.isAsyncEncryptionAvailable = true;
  mockElectronState.asyncTag = 'v11';
  mockElectronState.shouldReEncrypt = false;
  mockElectronState.asyncDecryptThrows = false;
  mockElectronState.storageBackend = 'keychain';
  mockElectronState.onEncryptStringAsync = null;
  resetSecureStorageProbeForTests();
  // Pinned so a Linux CI runner does not take the Linux probe path in the
  // platform-agnostic cases; the Linux cases set it themselves.
  setPlatform('win32');
});

afterEach(() => {
  setPlatform(originalPlatform);
});

describe('loadBridgeIdentity', () => {
  it('returns null when the identity file does not exist', async () => {
    existsSyncSpy.mockReturnValue(false);
    expect(await loadBridgeIdentity()).toBeNull();
  });

  it('returns null and logs a warning when the file contains invalid JSON', async () => {
    existsSyncSpy.mockReturnValue(true);
    readFileSyncSpy.mockReturnValue('not-valid-json');
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    const result = await loadBridgeIdentity();

    expect(result).toBeNull();
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('mobile-bridge/identity'),
      expect.any(Error),
    );
    warnSpy.mockRestore();
  });

  it('returns null when the JSON file has no encrypted field', async () => {
    existsSyncSpy.mockReturnValue(true);
    readFileSyncSpy.mockReturnValue(JSON.stringify({ someOtherKey: 'value' }));

    expect(await loadBridgeIdentity()).toBeNull();
  });

  it('returns null when the decrypted JSON is missing staticSecretKeyHex', async () => {
    existsSyncSpy.mockReturnValue(true);
    readFileSyncSpy.mockReturnValue(
      legacyEnvelopeFor({ masterSigningSecretKeyHex: 'ab', createdAt: new Date().toISOString() }),
    );

    expect(await loadBridgeIdentity()).toBeNull();
  });

  it('returns null when the decrypted JSON has an empty staticSecretKeyHex', async () => {
    existsSyncSpy.mockReturnValue(true);
    readFileSyncSpy.mockReturnValue(legacyEnvelopeFor({ ...VALID_STORED_IDENTITY, staticSecretKeyHex: '' }));

    expect(await loadBridgeIdentity()).toBeNull();
  });

  it('reads an identity the old sync API wrote, without rewriting it when the key is current', async () => {
    existsSyncSpy.mockReturnValue(true);
    readFileSyncSpy.mockReturnValue(legacyEnvelopeFor(VALID_STORED_IDENTITY));

    const identity = await loadBridgeIdentity();

    expect(identity).not.toBeNull();
    expect(Buffer.from(identity!.staticKeyPair.secretKey).toString('hex')).toBe(VALID_STORED_IDENTITY.staticSecretKeyHex);
    expect(writeFileSyncSpy).not.toHaveBeenCalled();
  });
});

describe('loadBridgeIdentity migration', () => {
  it('rewrites an identity flagged for re-encryption under genuine encryption, and still returns it', async () => {
    existsSyncSpy.mockReturnValue(true);
    readFileSyncSpy.mockReturnValue(legacyEnvelopeFor(VALID_STORED_IDENTITY));
    mockElectronState.shouldReEncrypt = true;

    const identity = await loadBridgeIdentity();

    expect(identity).not.toBeNull();
    expect(writeFileSyncSpy).toHaveBeenCalledTimes(1);
    const written = JSON.parse(writeFileSyncSpy.mock.calls[0][1]) as { encrypted: string };
    // Re-encrypted through the async API (the mock's v11 tag), not the legacy sync format.
    expect(Buffer.from(written.encrypted.slice(1), 'base64').toString('utf8').startsWith('v11:')).toBe(true);
  });

  it('rewrites a legacy blob only the sync API can still read', async () => {
    existsSyncSpy.mockReturnValue(true);
    readFileSyncSpy.mockReturnValue(legacyEnvelopeFor(VALID_STORED_IDENTITY));
    mockElectronState.asyncDecryptThrows = true;

    const identity = await loadBridgeIdentity();

    expect(identity).not.toBeNull();
    expect(writeFileSyncSpy).toHaveBeenCalledTimes(1);
  });

  it('never rewrites without genuine encryption (Linux hardcoded fallback key), but still loads', async () => {
    setPlatform('linux');
    mockElectronState.asyncTag = 'v10';
    // No keyring: the sync API sits on basic_text and refuses to encrypt too.
    mockElectronState.storageBackend = 'basic_text';
    mockElectronState.isEncryptionAvailable = false;
    existsSyncSpy.mockReturnValue(true);
    readFileSyncSpy.mockReturnValue(legacyEnvelopeFor(VALID_STORED_IDENTITY));
    mockElectronState.shouldReEncrypt = true;

    const identity = await loadBridgeIdentity();

    expect(identity).not.toBeNull();
    expect(writeFileSyncSpy).not.toHaveBeenCalled();
  });

  // The rewrite awaits encryptSecret after the identity was read and decrypted. Unplugging the
  // phone (clearBridgeIdentity) or pairing again can land in that window, and the identity in hand
  // is then stale: writing it back would resurrect a key the user just removed or replaced. Each
  // case lands the change inside the encrypt await. The load still returns what it read.
  it('does not recreate the identity file when it is cleared while the rewrite encrypts', async () => {
    existsSyncSpy.mockReturnValue(true);
    readFileSyncSpy.mockReturnValue(legacyEnvelopeFor(VALID_STORED_IDENTITY));
    mockElectronState.shouldReEncrypt = true;
    mockElectronState.onEncryptStringAsync = () => {
      // clearBridgeIdentity has removed the file while the load awaits.
      existsSyncSpy.mockReturnValue(false);
    };

    const identity = await loadBridgeIdentity();

    expect(identity).not.toBeNull();
    expect(writeFileSyncSpy).not.toHaveBeenCalled();
  });

  it('does not overwrite a different identity saved while the rewrite encrypts', async () => {
    existsSyncSpy.mockReturnValue(true);
    readFileSyncSpy.mockReturnValue(legacyEnvelopeFor(VALID_STORED_IDENTITY));
    mockElectronState.shouldReEncrypt = true;
    mockElectronState.onEncryptStringAsync = () => {
      // A new identity was saved here, so the file holds a different ciphertext than the load read.
      readFileSyncSpy.mockReturnValue(legacyEnvelopeFor({ ...VALID_STORED_IDENTITY, staticSecretKeyHex: '55'.repeat(32) }));
    };

    const identity = await loadBridgeIdentity();

    expect(identity).not.toBeNull();
    expect(Buffer.from(identity!.staticKeyPair.secretKey).toString('hex')).toBe(VALID_STORED_IDENTITY.staticSecretKeyHex);
    expect(writeFileSyncSpy).not.toHaveBeenCalled();
  });
});

describe('loadOrCreateBridgeIdentity', () => {
  it('generates and persists a new identity when none exists', async () => {
    existsSyncSpy.mockReturnValue(false);

    const identity = await loadOrCreateBridgeIdentity();

    expect(writeFileSyncSpy).toHaveBeenCalledTimes(1);
    expect(identity.staticKeyPair.secretKey).toHaveLength(32);
    expect(identity.staticKeyPair.publicKey).toHaveLength(32);
    expect(identity.masterSigningKeyPair.secretKey).toHaveLength(32);
    expect(identity.masterSigningKeyPair.publicKey).toHaveLength(32);
    expect(identity.createdAt).toEqual(expect.any(String));
    expect(() => new Date(identity.createdAt).toISOString()).not.toThrow();
  });

  it('returns the existing identity without calling writeFileSync when one is already persisted', async () => {
    existsSyncSpy.mockReturnValue(false);
    const created = await loadOrCreateBridgeIdentity();
    const writtenPayload = writeFileSyncSpy.mock.calls[0][1] as string;

    // Simulate a fresh process: the file now "exists" and readFileSync returns
    // exactly what saveBridgeIdentity wrote.
    writeFileSyncSpy.mockClear();
    existsSyncSpy.mockReturnValue(true);
    readFileSyncSpy.mockReturnValue(writtenPayload);

    const loaded = await loadOrCreateBridgeIdentity();

    expect(writeFileSyncSpy).not.toHaveBeenCalled();
    expect(Buffer.from(loaded.staticKeyPair.secretKey).toString('hex')).toBe(
      Buffer.from(created.staticKeyPair.secretKey).toString('hex'),
    );
    expect(Buffer.from(loaded.staticKeyPair.publicKey).toString('hex')).toBe(
      Buffer.from(created.staticKeyPair.publicKey).toString('hex'),
    );
    expect(Buffer.from(loaded.masterSigningKeyPair.secretKey).toString('hex')).toBe(
      Buffer.from(created.masterSigningKeyPair.secretKey).toString('hex'),
    );
    expect(Buffer.from(loaded.masterSigningKeyPair.publicKey).toString('hex')).toBe(
      Buffer.from(created.masterSigningKeyPair.publicKey).toString('hex'),
    );
    expect(loaded.createdAt).toBe(created.createdAt);
  });

  it('throws and does not call writeFileSync when neither safeStorage API can encrypt', async () => {
    existsSyncSpy.mockReturnValue(false);
    mockElectronState.isAsyncEncryptionAvailable = false;
    mockElectronState.isEncryptionAvailable = false;

    await expect(loadOrCreateBridgeIdentity()).rejects.toThrow(/secure storage is unavailable/);
    expect(writeFileSyncSpy).not.toHaveBeenCalled();
  });

  // The floor in auth.ts: where only the sync API works, the identity is created (and protected)
  // exactly as 0.43 would have, rather than pairing being refused.
  it('creates the identity through the sync API when the async API is unavailable but the sync one works', async () => {
    existsSyncSpy.mockReturnValue(false);
    mockElectronState.isAsyncEncryptionAvailable = false;
    mockElectronState.isEncryptionAvailable = true;

    const identity = await loadOrCreateBridgeIdentity();

    expect(identity.staticKeyPair.secretKey).toHaveLength(32);
    expect(writeFileSyncSpy).toHaveBeenCalledTimes(1);
  });

  it('throws and does not call writeFileSync on Linux when only the hardcoded fallback key (v10) exists', async () => {
    existsSyncSpy.mockReturnValue(false);
    setPlatform('linux');
    mockElectronState.asyncTag = 'v10';
    mockElectronState.storageBackend = 'basic_text';
    mockElectronState.isEncryptionAvailable = false;

    await expect(loadOrCreateBridgeIdentity()).rejects.toThrow(/secure storage is unavailable/);
    expect(writeFileSyncSpy).not.toHaveBeenCalled();
  });

  it('creates the identity on Linux with a real Secret Service key (v11), whatever the sync backend says', async () => {
    existsSyncSpy.mockReturnValue(false);
    setPlatform('linux');
    mockElectronState.asyncTag = 'v11';
    mockElectronState.storageBackend = 'basic_text';
    mockElectronState.isEncryptionAvailable = false;

    const identity = await loadOrCreateBridgeIdentity();

    expect(identity.staticKeyPair.secretKey).toHaveLength(32);
    expect(writeFileSyncSpy).toHaveBeenCalledTimes(1);
  });
});

describe('clearBridgeIdentity', () => {
  it('removes the identity file via rmSync with force (no existsSync gate, Windows-lock safe)', () => {
    clearBridgeIdentity();
    expect(rmSyncSpy).toHaveBeenCalledTimes(1);
    expect(rmSyncSpy).toHaveBeenCalledWith(expect.stringContaining('mobile-bridge-identity.json'), { force: true });
  });

  it('swallows a transient filesystem error (e.g. a Windows file lock) rather than throwing', () => {
    rmSyncSpy.mockImplementation(() => {
      throw new Error('EBUSY: resource busy or locked');
    });
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    expect(() => clearBridgeIdentity()).not.toThrow();
    warnSpy.mockRestore();
  });
});
