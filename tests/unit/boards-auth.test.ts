/**
 * Unit tests for src/main/boards/shared/auth.ts
 *
 * Covers the sentinel round-trip through safeStorage's ASYNC API, that a blob
 * the old sync API wrote still reads through it, that nothing calls the sync
 * API at all, in auth.ts or anywhere else under src/ (deprecated in Electron
 * 45, removed in 46), the migration signal
 * (`shouldRewrite`), the assertAppReady guard, and the Linux "genuine
 * encryption" probe, which reads the async ciphertext's key tag (`v10` is
 * Chromium's hardcoded-password fallback; `v11` the Secret Service or KWallet;
 * `v12` the Secret portal). The electron module is fully mocked so these tests
 * never touch real safeStorage or the app lifecycle.
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// --- Mutable mock state ---
// Each test controls these to simulate different safeStorage conditions.
const mockElectronState = {
  isReady: true,
  /** The async API's availability. */
  isAsyncEncryptionAvailable: true,
  /** The key tag the async encryptor prefixes its ciphertext with. */
  asyncTag: 'v11',
  /** What decryptStringAsync reports for shouldReEncrypt. */
  shouldReEncrypt: false,
  /** Make decryptStringAsync reject, as when the async provider lacks the key that wrote a blob. */
  asyncDecryptThrows: false,
  /** Make the NEXT encryptStringAsync reject, then behave normally (a transient provider failure). */
  asyncEncryptRejectsOnce: false,
};

/** What the old sync API's mock ciphertext looked like, for blobs older builds wrote. */
const SYNC_PREFIX = 'encrypted:';

const asyncEncryptCalls: string[] = [];
/** Every sync safeStorage method the code under test reached. Must stay empty. */
const syncCalls: string[] = [];

/** Parses either a sync-written (`encrypted:`) or an async-written (`vNN:`) mock blob. */
function parseMockCiphertext(buffer: Buffer): string | null {
  const raw = buffer.toString('utf8');
  if (raw.startsWith(SYNC_PREFIX)) return raw.slice(SYNC_PREFIX.length);
  const asyncMatch = /^v\d\d:/.exec(raw);
  if (asyncMatch) return raw.slice(asyncMatch[0].length);
  return null;
}

function removedSyncMethod(name: string): () => never {
  return () => {
    syncCalls.push(name);
    throw new Error(`safeStorage.${name} is deprecated in Electron 45 and removed in 46`);
  };
}

vi.mock('electron', () => ({
  app: {
    isReady: () => mockElectronState.isReady,
    whenReady: () => Promise.resolve(),
  },
  safeStorage: {
    isEncryptionAvailable: removedSyncMethod('isEncryptionAvailable'),
    encryptString: removedSyncMethod('encryptString'),
    decryptString: removedSyncMethod('decryptString'),
    getSelectedStorageBackend: removedSyncMethod('getSelectedStorageBackend'),
    isAsyncEncryptionAvailable: async () => mockElectronState.isAsyncEncryptionAvailable,
    encryptStringAsync: async (plaintext: string) => {
      asyncEncryptCalls.push(plaintext);
      if (mockElectronState.asyncEncryptRejectsOnce) {
        mockElectronState.asyncEncryptRejectsOnce = false;
        throw new Error('safeStorage.encryptStringAsync: the secret store is not reachable');
      }
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
  },
}));

// Import AFTER vi.mock so the hoisted mock is in place.
import {
  encryptSecret,
  decryptSecret,
  isGenuineEncryptionAvailable,
  resetSecureStorageProbeForTests,
} from '../../src/main/boards/shared/auth';

const originalPlatform = process.platform;

function setPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', { value: platform, configurable: true });
}

function plaintextBlob(plaintext: string): string {
  return 'p' + Buffer.from(plaintext, 'utf8').toString('base64');
}

function syncWrittenBlob(plaintext: string): string {
  return 'e' + Buffer.from(`${SYNC_PREFIX}${plaintext}`, 'utf8').toString('base64');
}

beforeEach(() => {
  mockElectronState.isReady = true;
  mockElectronState.isAsyncEncryptionAvailable = true;
  mockElectronState.asyncTag = 'v11';
  mockElectronState.shouldReEncrypt = false;
  mockElectronState.asyncDecryptThrows = false;
  mockElectronState.asyncEncryptRejectsOnce = false;
  asyncEncryptCalls.length = 0;
  syncCalls.length = 0;
  resetSecureStorageProbeForTests();
  // Pinned so a Linux CI runner does not take the Linux probe path in the
  // platform-agnostic cases below; the Linux cases set it themselves.
  setPlatform('win32');
});

afterEach(() => {
  setPlatform(originalPlatform);
});

describe('assertAppReady guard', () => {
  it('encryptSecret rejects when app is not ready', async () => {
    mockElectronState.isReady = false;
    await expect(encryptSecret('secret')).rejects.toThrow(/app\.whenReady/);
  });

  it('decryptSecret rejects when app is not ready', async () => {
    mockElectronState.isReady = false;
    await expect(decryptSecret(plaintextBlob('x'))).rejects.toThrow(/app\.whenReady/);
  });

  it('isGenuineEncryptionAvailable rejects when app is not ready', async () => {
    mockElectronState.isReady = false;
    await expect(isGenuineEncryptionAvailable()).rejects.toThrow(/app\.whenReady/);
  });
});

describe('encryptSecret', () => {
  it('writes through encryptStringAsync with the e sentinel', async () => {
    const result = await encryptSecret('my-token');
    expect(result[0]).toBe('e');
    expect(Buffer.from(result.slice(1), 'base64').toString('utf8')).toBe('v11:my-token');
    expect(asyncEncryptCalls).toEqual(['my-token']);
  });

  it('round-trips through decryptSecret', async () => {
    const original = 'ghp_abc123';
    const encrypted = await encryptSecret(original);
    expect(encrypted[0]).toBe('e');
    expect(await decryptSecret(encrypted)).toEqual({ plaintext: original, shouldRewrite: false });
  });

  it('falls back to a p-sentinel base64 blob when encryption is unavailable', async () => {
    mockElectronState.isAsyncEncryptionAvailable = false;
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const result = await encryptSecret('fallback-secret');
    expect(result[0]).toBe('p');
    expect(Buffer.from(result.slice(1), 'base64').toString('utf8')).toBe('fallback-secret');
    expect(asyncEncryptCalls).toEqual([]);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('unencrypted'));
    warnSpy.mockRestore();
  });

  it('warns, but still encrypts, under the Linux hardcoded fallback key', async () => {
    setPlatform('linux');
    mockElectronState.asyncTag = 'v10';
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const result = await encryptSecret('token');
    expect(result[0]).toBe('e');
    expect(Buffer.from(result.slice(1), 'base64').toString('utf8')).toBe('v10:token');
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('hardcoded fallback key'));
    warnSpy.mockRestore();
  });
});

describe('decryptSecret', () => {
  it('reads an e blob through decryptStringAsync, with no rewrite when the key is current', async () => {
    const encrypted = await encryptSecret('super-secret');
    expect(await decryptSecret(encrypted)).toEqual({ plaintext: 'super-secret', shouldRewrite: false });
  });

  it('asks for a rewrite when Electron says the blob should be re-encrypted', async () => {
    const encrypted = await encryptSecret('rotated-key-secret');
    mockElectronState.shouldReEncrypt = true;
    expect(await decryptSecret(encrypted)).toEqual({ plaintext: 'rotated-key-secret', shouldRewrite: true });
  });

  it('reads a blob the old sync API wrote through the async API', async () => {
    expect(await decryptSecret(syncWrittenBlob('legacy-token'))).toEqual({
      plaintext: 'legacy-token',
      shouldRewrite: false,
    });
  });

  it('rejects with the async error when the async provider cannot read the blob', async () => {
    mockElectronState.asyncDecryptThrows = true;
    await expect(decryptSecret(syncWrittenBlob('token'))).rejects.toThrow(/not available/);
  });

  it('rejects when an e blob is presented but encryption is unavailable', async () => {
    mockElectronState.isAsyncEncryptionAvailable = false;
    await expect(decryptSecret(syncWrittenBlob('token'))).rejects.toThrow(/safeStorage is unavailable/);
  });

  it('decodes a p blob and asks for a rewrite once genuine encryption is available', async () => {
    expect(await decryptSecret(plaintextBlob('hello-world'))).toEqual({
      plaintext: 'hello-world',
      shouldRewrite: true,
    });
  });

  it('decodes a p blob and asks for a rewrite on Linux with a real keyring key (v11, v12)', async () => {
    setPlatform('linux');
    for (const tag of ['v11', 'v12']) {
      resetSecureStorageProbeForTests();
      mockElectronState.asyncTag = tag;
      expect(await decryptSecret(plaintextBlob('hello-world')), tag).toEqual({
        plaintext: 'hello-world',
        shouldRewrite: true,
      });
    }
  });

  it('decodes a p blob without asking for a rewrite while encryption is still unavailable', async () => {
    mockElectronState.isAsyncEncryptionAvailable = false;
    expect(await decryptSecret(plaintextBlob('hello-world'))).toEqual({
      plaintext: 'hello-world',
      shouldRewrite: false,
    });
  });

  it('decodes a p blob without asking for a rewrite on Linux with only the hardcoded fallback key (v10)', async () => {
    // Re-wrapping it under a key derived from a hardcoded password would protect
    // nothing and only change the file.
    setPlatform('linux');
    mockElectronState.asyncTag = 'v10';
    expect(await decryptSecret(plaintextBlob('hello-world'))).toEqual({
      plaintext: 'hello-world',
      shouldRewrite: false,
    });
  });

  it('rejects on empty ciphertext', async () => {
    await expect(decryptSecret('')).rejects.toThrow(/empty ciphertext/);
  });

  it('rejects on unknown sentinel character', async () => {
    const badBlob = 'x' + Buffer.from('garbage', 'utf8').toString('base64');
    await expect(decryptSecret(badBlob)).rejects.toThrow(/Unknown credential format sentinel/);
  });

  it('propagates decryption errors without returning garbage', async () => {
    const corruptedBlob = 'e' + Buffer.from('not-encrypted:garbage', 'utf8').toString('base64');
    await expect(decryptSecret(corruptedBlob)).rejects.toThrow();
  });
});

describe('isGenuineEncryptionAvailable', () => {
  it('is true on Windows and macOS when async encryption is available, without probing', async () => {
    for (const platform of ['win32', 'darwin'] as const) {
      setPlatform(platform);
      resetSecureStorageProbeForTests();
      expect(await isGenuineEncryptionAvailable(), platform).toBe(true);
    }
    expect(asyncEncryptCalls).toEqual([]);
  });

  it('is false when async encryption is unavailable', async () => {
    mockElectronState.isAsyncEncryptionAvailable = false;
    for (const platform of ['win32', 'darwin', 'linux'] as const) {
      setPlatform(platform);
      expect(await isGenuineEncryptionAvailable(), platform).toBe(false);
    }
  });

  it('is false on Linux when the async key is the hardcoded fallback (v10)', async () => {
    setPlatform('linux');
    mockElectronState.asyncTag = 'v10';
    expect(await isGenuineEncryptionAvailable()).toBe(false);
  });

  it('is true on Linux with a Secret Service or KWallet key (v11) or a Secret portal key (v12)', async () => {
    setPlatform('linux');
    for (const tag of ['v11', 'v12']) {
      resetSecureStorageProbeForTests();
      mockElectronState.asyncTag = tag;
      expect(await isGenuineEncryptionAvailable(), tag).toBe(true);
    }
  });

  it('probes the Linux key once per run, sharing one probe between concurrent callers', async () => {
    setPlatform('linux');
    mockElectronState.asyncTag = 'v11';
    const [first, second] = await Promise.all([isGenuineEncryptionAvailable(), isGenuineEncryptionAvailable()]);
    expect([first, second]).toEqual([true, true]);
    expect(await isGenuineEncryptionAvailable()).toBe(true);
    expect(asyncEncryptCalls).toHaveLength(1);
  });

  // A probe that throws (the secret store is briefly unreachable) must degrade to "not genuine",
  // log why, and NOT stick: the cached promise is cleared so the next call probes again and can
  // report the real key once the store is back.
  it('treats a failed Linux probe as unavailable, warns, and probes again on the next call', async () => {
    setPlatform('linux');
    mockElectronState.asyncTag = 'v11';
    mockElectronState.asyncEncryptRejectsOnce = true;
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    expect(await isGenuineEncryptionAvailable()).toBe(false);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('could not probe the Linux secret store'),
      expect.objectContaining({ message: expect.stringContaining('not reachable') }),
    );
    expect(asyncEncryptCalls).toHaveLength(1);

    // The failure was not cached: this call runs a second probe, which succeeds.
    expect(await isGenuineEncryptionAvailable()).toBe(true);
    expect(asyncEncryptCalls).toHaveLength(2);

    // And the successful probe IS cached, so a third call does not probe again.
    expect(await isGenuineEncryptionAvailable()).toBe(true);
    expect(asyncEncryptCalls).toHaveLength(2);
    warnSpy.mockRestore();
  });
});

describe('the synchronous safeStorage API', () => {
  // Electron 45 deprecates it and 46 removes it. Every path above runs against a mock whose sync
  // methods throw, but a caller could swallow that throw, so the calls are counted too.
  it('is never called, on any platform, whether encryption is genuine, a fallback key, or absent', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const cases: Array<{ platform: NodeJS.Platform; tag: string; available: boolean }> = [
      { platform: 'win32', tag: 'v10', available: true },
      { platform: 'darwin', tag: 'v10', available: true },
      { platform: 'linux', tag: 'v11', available: true },
      { platform: 'linux', tag: 'v10', available: true },
      { platform: 'linux', tag: 'v11', available: false },
      { platform: 'darwin', tag: 'v10', available: false },
    ];
    for (const { platform, tag, available } of cases) {
      setPlatform(platform);
      resetSecureStorageProbeForTests();
      mockElectronState.asyncTag = tag;
      mockElectronState.isAsyncEncryptionAvailable = available;

      await isGenuineEncryptionAvailable();
      const written = await encryptSecret('token');
      await decryptSecret(written);
      await decryptSecret(plaintextBlob('token'));
      if (available) {
        await decryptSecret(syncWrittenBlob('legacy-token'));
      } else {
        await expect(decryptSecret(syncWrittenBlob('legacy-token'))).rejects.toThrow(/safeStorage is unavailable/);
      }
    }
    expect(syncCalls).toEqual([]);
    warnSpy.mockRestore();
  });

  // The case above sees only the paths auth.ts takes. This sees every source file, so a new
  // direct call anywhere under src/ fails here before Electron 46 removes the method under it.
  it('is called by no source file under src/', () => {
    const sourceRoot = path.resolve(__dirname, '../../src');
    const syncMethodCall = /safeStorage\s*\.\s*(isEncryptionAvailable|encryptString|decryptString|getSelectedStorageBackend)\b/;
    const offenders = collectSourceFiles(sourceRoot)
      .filter((filePath) => syncMethodCall.test(fs.readFileSync(filePath, 'utf8')))
      .map((filePath) => path.relative(sourceRoot, filePath));
    expect(offenders).toEqual([]);
  });
});

function collectSourceFiles(directory: string): string[] {
  const files: string[] = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...collectSourceFiles(fullPath));
    } else if (/\.(ts|tsx|js|cjs|mjs)$/.test(entry.name)) {
      files.push(fullPath);
    }
  }
  return files;
}
