/**
 * Unit tests for src/main/boards/shared/encrypted-secret-file.ts
 *
 * The helper behind the two small `{ "encrypted": <ciphertext> }` JSON files
 * (the Asana token and the mobile bridge identity). Pins its contract
 * directly, so each caller's own test file only has to cover what is theirs:
 *
 * - read: null (never a throw) for an absent file, an envelope with no
 *   ciphertext, invalid JSON, a decrypt failure, and a parse that returns null
 *   or throws. The failures log under the file's logPrefix and noun; the
 *   absent, empty and parse-null cases are silent. A success reports the
 *   value, the plaintext, the ciphertext as read and decryptSecret's
 *   shouldRewrite verdict.
 * - write: encrypts, then writes `{ encrypted }` through the guarded writer
 *   with the file's writeSource at mode 0o600.
 * - rewrite: re-encrypts the plaintext it was handed and writes it back ONLY
 *   if the file still holds the ciphertext the read returned, so a clear or a
 *   new save landing during the awaits is never overwritten. It never rejects.
 *
 * node:fs, the guarded writer and decryptSecret / encryptSecret are mocked, so
 * nothing touches disk or Electron. Pattern from
 * tests/unit/asana-credential-store.test.ts.
 */
import { describe, it, expect, vi, beforeEach, afterEach, type MockInstance } from 'vitest';
import type { EncryptedSecretFile, ReadSecret } from '../../src/main/boards/shared/encrypted-secret-file';

// --- Mock the fs module so no real file I/O occurs. node:fs is imported as a
// default (CJS-style), so the mock bundles named exports AND a default. ---
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

// --- Mock the guarded writer so a write never reaches disk, and can be observed ---
const safeWriteJsonSpy = vi.hoisted(() =>
  vi.fn<(filePath: string, payload: unknown, source: string, options?: { mode?: number }) => boolean>(() => true),
);
vi.mock('../../src/main/safe-write', () => ({ safeWriteJson: safeWriteJsonSpy }));

// --- Mock decryptSecret / encryptSecret (the helper imports them from './auth') ---
const decryptSecretSpy = vi.hoisted(() =>
  vi.fn<(ciphertext: string) => Promise<{ plaintext: string; shouldRewrite: boolean }>>(),
);
const encryptSecretSpy = vi.hoisted(() => vi.fn<(plaintext: string) => Promise<string>>());
vi.mock('../../src/main/boards/shared/auth', () => ({
  decryptSecret: decryptSecretSpy,
  encryptSecret: encryptSecretSpy,
}));

// Import AFTER all vi.mock declarations.
const { readEncryptedSecretFile, writeEncryptedSecretFile, rewriteEncryptedSecretFile } = await import(
  '../../src/main/boards/shared/encrypted-secret-file'
);

const FILE: EncryptedSecretFile = {
  filePath: '/mock/config/widget-secret.json',
  writeSource: 'widget_secret',
  logPrefix: '[test/widget-secret]',
  noun: 'widget',
};

const LOAD_WARNING = '[test/widget-secret] failed to load widget:';
const REWRITE_WARNING = '[test/widget-secret] could not rewrite the widget in the current format:';

/** The file's content: the one-field envelope around a ciphertext. */
function envelopeOf(ciphertext: string): string {
  return JSON.stringify({ encrypted: ciphertext });
}

/** What a read hands a rewrite, for a file that holds `e_old_blob`. */
const READ_SECRET: ReadSecret<string> = {
  value: 'parsed:plain-secret',
  plaintext: 'plain-secret',
  ciphertext: 'e_old_blob',
  shouldRewrite: true,
};

const parseSpy = vi.fn<(plaintext: string) => string | null>();
let warnSpy: MockInstance<typeof console.warn>;

beforeEach(() => {
  existsSyncSpy.mockReset();
  readFileSyncSpy.mockReset();
  decryptSecretSpy.mockReset();
  encryptSecretSpy.mockReset();
  encryptSecretSpy.mockImplementation(async (plaintext: string) => `e-rewritten:${plaintext}`);
  safeWriteJsonSpy.mockReset();
  safeWriteJsonSpy.mockReturnValue(true);
  parseSpy.mockReset();
  parseSpy.mockImplementation((plaintext: string) => `parsed:${plaintext}`);
  warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});

afterEach(() => {
  warnSpy.mockRestore();
});

describe('readEncryptedSecretFile', () => {
  it('returns null without reading or decrypting when the file does not exist', async () => {
    existsSyncSpy.mockReturnValue(false);

    const result = await readEncryptedSecretFile(FILE, parseSpy);

    expect(result).toBeNull();
    expect(existsSyncSpy).toHaveBeenCalledWith(FILE.filePath);
    expect(readFileSyncSpy).not.toHaveBeenCalled();
    expect(decryptSecretSpy).not.toHaveBeenCalled();
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('returns null without decrypting when the JSON has no encrypted field', async () => {
    existsSyncSpy.mockReturnValue(true);
    readFileSyncSpy.mockReturnValue(JSON.stringify({ someOtherKey: 'value' }));

    const result = await readEncryptedSecretFile(FILE, parseSpy);

    expect(result).toBeNull();
    expect(decryptSecretSpy).not.toHaveBeenCalled();
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('returns null without decrypting when the encrypted field is an empty string', async () => {
    existsSyncSpy.mockReturnValue(true);
    readFileSyncSpy.mockReturnValue(envelopeOf(''));

    const result = await readEncryptedSecretFile(FILE, parseSpy);

    expect(result).toBeNull();
    expect(decryptSecretSpy).not.toHaveBeenCalled();
  });

  it('returns null and warns under the file prefix and noun when the file is not valid JSON', async () => {
    existsSyncSpy.mockReturnValue(true);
    readFileSyncSpy.mockReturnValue('not-valid-json');

    const result = await readEncryptedSecretFile(FILE, parseSpy);

    expect(result).toBeNull();
    expect(decryptSecretSpy).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy).toHaveBeenCalledWith(LOAD_WARNING, expect.any(SyntaxError));
  });

  it('returns null and warns when decryptSecret rejects', async () => {
    existsSyncSpy.mockReturnValue(true);
    readFileSyncSpy.mockReturnValue(envelopeOf('e_blob'));
    const decryptFailure = new Error('safeStorage unavailable');
    decryptSecretSpy.mockRejectedValue(decryptFailure);

    const result = await readEncryptedSecretFile(FILE, parseSpy);

    expect(result).toBeNull();
    expect(parseSpy).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy).toHaveBeenCalledWith(LOAD_WARNING, decryptFailure);
  });

  it('returns null without a warning when parse returns null (a rejected value, not a failure)', async () => {
    existsSyncSpy.mockReturnValue(true);
    readFileSyncSpy.mockReturnValue(envelopeOf('e_blob'));
    decryptSecretSpy.mockResolvedValue({ plaintext: 'plain-secret', shouldRewrite: true });
    parseSpy.mockReturnValue(null);

    const result = await readEncryptedSecretFile(FILE, parseSpy);

    expect(result).toBeNull();
    expect(parseSpy).toHaveBeenCalledWith('plain-secret');
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('returns null and warns when parse throws', async () => {
    existsSyncSpy.mockReturnValue(true);
    readFileSyncSpy.mockReturnValue(envelopeOf('e_blob'));
    decryptSecretSpy.mockResolvedValue({ plaintext: 'not-json-at-all', shouldRewrite: false });
    const parseFailure = new SyntaxError('Unexpected token in plaintext');
    parseSpy.mockImplementation(() => {
      throw parseFailure;
    });

    const result = await readEncryptedSecretFile(FILE, parseSpy);

    expect(result).toBeNull();
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy).toHaveBeenCalledWith(LOAD_WARNING, parseFailure);
  });

  it.each([true, false])(
    'returns the value, plaintext, ciphertext as read and shouldRewrite=%s on success',
    async (shouldRewrite) => {
      existsSyncSpy.mockReturnValue(true);
      readFileSyncSpy.mockReturnValue(envelopeOf('e_stored_blob'));
      decryptSecretSpy.mockResolvedValue({ plaintext: 'plain-secret', shouldRewrite });

      const result = await readEncryptedSecretFile(FILE, parseSpy);

      expect(result).toEqual({
        value: 'parsed:plain-secret',
        plaintext: 'plain-secret',
        ciphertext: 'e_stored_blob',
        shouldRewrite,
      });
      expect(readFileSyncSpy).toHaveBeenCalledWith(FILE.filePath, 'utf8');
      expect(decryptSecretSpy).toHaveBeenCalledWith('e_stored_blob');
      expect(parseSpy).toHaveBeenCalledWith('plain-secret');
      expect(safeWriteJsonSpy).not.toHaveBeenCalled();
      expect(warnSpy).not.toHaveBeenCalled();
    },
  );
});

describe('writeEncryptedSecretFile', () => {
  it('encrypts the plaintext and writes { encrypted } through the guarded writer at mode 0o600', async () => {
    await writeEncryptedSecretFile(FILE, 'plain-secret');

    expect(encryptSecretSpy).toHaveBeenCalledTimes(1);
    expect(encryptSecretSpy).toHaveBeenCalledWith('plain-secret');
    expect(safeWriteJsonSpy).toHaveBeenCalledTimes(1);
    expect(safeWriteJsonSpy).toHaveBeenCalledWith(
      '/mock/config/widget-secret.json',
      { encrypted: 'e-rewritten:plain-secret' },
      'widget_secret',
      { mode: 0o600 },
    );
  });

  it('resolves when the guarded writer reports a failed write (it degrades, never throws)', async () => {
    safeWriteJsonSpy.mockReturnValue(false);

    await expect(writeEncryptedSecretFile(FILE, 'plain-secret')).resolves.toBeUndefined();
    expect(safeWriteJsonSpy).toHaveBeenCalledTimes(1);
  });
});

describe('rewriteEncryptedSecretFile', () => {
  it('re-encrypts the plaintext it was handed and writes it back when the file is unchanged', async () => {
    existsSyncSpy.mockReturnValue(true);
    readFileSyncSpy.mockReturnValue(envelopeOf('e_old_blob'));

    await rewriteEncryptedSecretFile(FILE, READ_SECRET);

    expect(encryptSecretSpy).toHaveBeenCalledTimes(1);
    expect(encryptSecretSpy).toHaveBeenCalledWith('plain-secret');
    // The plaintext comes from the read; a rewrite never decrypts again.
    expect(decryptSecretSpy).not.toHaveBeenCalled();
    expect(safeWriteJsonSpy).toHaveBeenCalledTimes(1);
    expect(safeWriteJsonSpy).toHaveBeenCalledWith(
      '/mock/config/widget-secret.json',
      { encrypted: 'e-rewritten:plain-secret' },
      'widget_secret',
      { mode: 0o600 },
    );
    expect(warnSpy).not.toHaveBeenCalled();
  });

  // Each of the next cases lands the change inside the encryptSecret await, after the read has
  // already returned, which is the window a Disconnect or a new save can hit in production.
  it('does not write when the file is deleted while the rewrite encrypts', async () => {
    existsSyncSpy.mockReturnValue(true);
    readFileSyncSpy.mockReturnValue(envelopeOf('e_old_blob'));
    encryptSecretSpy.mockImplementation(async (plaintext: string) => {
      // A clear lands here: the file is gone before the guard looks at it.
      existsSyncSpy.mockReturnValue(false);
      return `e-rewritten:${plaintext}`;
    });

    await rewriteEncryptedSecretFile(FILE, READ_SECRET);

    expect(encryptSecretSpy).toHaveBeenCalledTimes(1);
    expect(safeWriteJsonSpy).not.toHaveBeenCalled();
  });

  it('does not write when the file is replaced with a different ciphertext while the rewrite encrypts', async () => {
    existsSyncSpy.mockReturnValue(true);
    readFileSyncSpy.mockReturnValue(envelopeOf('e_old_blob'));
    encryptSecretSpy.mockImplementation(async (plaintext: string) => {
      // A new save lands here: the file now holds a newer secret than the one the read returned.
      readFileSyncSpy.mockReturnValue(envelopeOf('e_new_save_blob'));
      return `e-rewritten:${plaintext}`;
    });

    await rewriteEncryptedSecretFile(FILE, READ_SECRET);

    expect(encryptSecretSpy).toHaveBeenCalledTimes(1);
    expect(safeWriteJsonSpy).not.toHaveBeenCalled();
  });

  it('does not write when the file no longer has a ciphertext (the envelope was emptied)', async () => {
    existsSyncSpy.mockReturnValue(true);
    readFileSyncSpy.mockReturnValue(envelopeOf('e_old_blob'));
    encryptSecretSpy.mockImplementation(async (plaintext: string) => {
      readFileSyncSpy.mockReturnValue(JSON.stringify({}));
      return `e-rewritten:${plaintext}`;
    });

    await rewriteEncryptedSecretFile(FILE, READ_SECRET);

    expect(safeWriteJsonSpy).not.toHaveBeenCalled();
  });

  it('does not write, and stays silent, when the file becomes unreadable while the rewrite encrypts', async () => {
    existsSyncSpy.mockReturnValue(true);
    readFileSyncSpy.mockReturnValue(envelopeOf('e_old_blob'));
    encryptSecretSpy.mockImplementation(async (plaintext: string) => {
      readFileSyncSpy.mockReturnValue('not-valid-json');
      return `e-rewritten:${plaintext}`;
    });

    await rewriteEncryptedSecretFile(FILE, READ_SECRET);

    expect(safeWriteJsonSpy).not.toHaveBeenCalled();
    // Not a rewrite failure: the guard simply found nothing it recognizes, so it leaves the file alone.
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('resolves, warns under the file prefix and noun, and writes nothing when encryptSecret rejects', async () => {
    existsSyncSpy.mockReturnValue(true);
    readFileSyncSpy.mockReturnValue(envelopeOf('e_old_blob'));
    const encryptFailure = new Error('safeStorage went away mid-rewrite');
    encryptSecretSpy.mockRejectedValue(encryptFailure);

    await expect(rewriteEncryptedSecretFile(FILE, READ_SECRET)).resolves.toBeUndefined();

    expect(safeWriteJsonSpy).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy).toHaveBeenCalledWith(REWRITE_WARNING, encryptFailure);
  });
});
