/**
 * Unit tests for src/main/mobile-bridge/identity.ts
 *
 * Verifies that loadBridgeIdentity/loadOrCreateBridgeIdentity/clearBridgeIdentity
 * persist the desktop's mobile-bridge identity (an X25519 static keypair plus
 * an Ed25519 master signing keypair) correctly, and - the load-bearing safety
 * property of this module - that loadOrCreateBridgeIdentity() REFUSES to
 * generate and persist a brand-new private key when genuine encryption is
 * unavailable (Linux basic_text safeStorage backend, or safeStorage disabled
 * entirely), rather than silently writing an unprotected key to disk.
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
import { describe, it, expect, vi, beforeEach } from 'vitest';

// --- Electron mock: a reversible "encrypted:<plaintext>" scheme so encryptSecret/
// decryptSecret (which run for real) can genuinely round-trip through it. ---
const mockElectronState = {
  isEncryptionAvailable: true,
  storageBackend: 'keychain' as string,
};

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

beforeEach(() => {
  existsSyncSpy.mockReset();
  readFileSyncSpy.mockReset();
  writeFileSyncSpy.mockReset();
  mkdirSyncSpy.mockReset();
  unlinkSyncSpy.mockReset();
  rmSyncSpy.mockReset();
  mockElectronState.isEncryptionAvailable = true;
  mockElectronState.storageBackend = 'keychain';
});

describe('loadBridgeIdentity', () => {
  it('returns null when the identity file does not exist', () => {
    existsSyncSpy.mockReturnValue(false);
    expect(loadBridgeIdentity()).toBeNull();
  });

  it('returns null and logs a warning when the file contains invalid JSON', () => {
    existsSyncSpy.mockReturnValue(true);
    readFileSyncSpy.mockReturnValue('not-valid-json');
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    const result = loadBridgeIdentity();

    expect(result).toBeNull();
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('mobile-bridge/identity'),
      expect.any(Error),
    );
    warnSpy.mockRestore();
  });

  it('returns null when the JSON file has no encrypted field', () => {
    existsSyncSpy.mockReturnValue(true);
    readFileSyncSpy.mockReturnValue(JSON.stringify({ someOtherKey: 'value' }));

    expect(loadBridgeIdentity()).toBeNull();
  });

  it('returns null when the decrypted JSON is missing staticSecretKeyHex', () => {
    existsSyncSpy.mockReturnValue(true);
    const malformed = { masterSigningSecretKeyHex: 'ab', createdAt: new Date().toISOString() };
    // Build the stored envelope the way saveBridgeIdentity would: 'e' + base64(safeStorage output).
    const cipherBuffer = Buffer.from(`encrypted:${JSON.stringify(malformed)}`, 'utf8');
    readFileSyncSpy.mockReturnValue(
      JSON.stringify({ encrypted: 'e' + cipherBuffer.toString('base64') }),
    );

    expect(loadBridgeIdentity()).toBeNull();
  });

  it('returns null when the decrypted JSON has an empty staticSecretKeyHex', () => {
    existsSyncSpy.mockReturnValue(true);
    const malformed = {
      staticSecretKeyHex: '',
      staticPublicKeyHex: 'ab',
      masterSigningSecretKeyHex: 'ab',
      masterSigningPublicKeyHex: 'ab',
      createdAt: new Date().toISOString(),
    };
    const cipherBuffer = Buffer.from(`encrypted:${JSON.stringify(malformed)}`, 'utf8');
    readFileSyncSpy.mockReturnValue(
      JSON.stringify({ encrypted: 'e' + cipherBuffer.toString('base64') }),
    );

    expect(loadBridgeIdentity()).toBeNull();
  });
});

describe('loadOrCreateBridgeIdentity', () => {
  it('generates and persists a new identity when none exists', () => {
    existsSyncSpy.mockReturnValue(false);

    const identity = loadOrCreateBridgeIdentity();

    expect(writeFileSyncSpy).toHaveBeenCalledTimes(1);
    expect(identity.staticKeyPair.secretKey).toHaveLength(32);
    expect(identity.staticKeyPair.publicKey).toHaveLength(32);
    expect(identity.masterSigningKeyPair.secretKey).toHaveLength(32);
    expect(identity.masterSigningKeyPair.publicKey).toHaveLength(32);
    expect(identity.createdAt).toEqual(expect.any(String));
    expect(() => new Date(identity.createdAt).toISOString()).not.toThrow();
  });

  it('returns the existing identity without calling writeFileSync when one is already persisted', () => {
    existsSyncSpy.mockReturnValue(false);
    const created = loadOrCreateBridgeIdentity();
    const writtenPayload = writeFileSyncSpy.mock.calls[0][1] as string;

    // Simulate a fresh process: the file now "exists" and readFileSync returns
    // exactly what saveBridgeIdentity wrote.
    writeFileSyncSpy.mockClear();
    existsSyncSpy.mockReturnValue(true);
    readFileSyncSpy.mockReturnValue(writtenPayload);

    const loaded = loadOrCreateBridgeIdentity();

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

  it('throws and does not call writeFileSync when safeStorage.isEncryptionAvailable() is false', () => {
    existsSyncSpy.mockReturnValue(false);
    mockElectronState.isEncryptionAvailable = false;

    expect(() => loadOrCreateBridgeIdentity()).toThrow(/secure storage is unavailable/);
    expect(writeFileSyncSpy).not.toHaveBeenCalled();
  });

  it('throws and does not call writeFileSync on Linux with the basic_text storage backend', () => {
    existsSyncSpy.mockReturnValue(false);
    mockElectronState.storageBackend = 'basic_text';
    const originalPlatform = process.platform;
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });

    try {
      expect(() => loadOrCreateBridgeIdentity()).toThrow(/secure storage is unavailable/);
      expect(writeFileSyncSpy).not.toHaveBeenCalled();
    } finally {
      Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true });
    }
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
