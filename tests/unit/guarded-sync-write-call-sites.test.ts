/**
 * Call-site coverage for two of the guarded-sync-writes adoptions
 * (.claude/rules/guarded-sync-writes.md):
 *   - saveAsanaCredential (src/main/boards/adapters/asana/credential-store.ts)
 *   - loadOrCreateBridgeIdentity's internal saveBridgeIdentity
 *     (src/main/mobile-bridge/identity.ts)
 *
 * Both were chosen because their failure is user-visible ("Connect Asana" /
 * mobile pairing). tests/unit/guarded-sync-writes.test.ts already pins that
 * both call sites route through safeWriteJson at the AST level; this file
 * pins the runtime behavior the AST scan cannot see: that neither function
 * throws when its target directory is unwritable, and that the source-keyed
 * write-failure-notice latch fires exactly once per real caller.
 *
 * Unlike tests/unit/asana-credential-store.test.ts and
 * tests/unit/mobile-bridge/identity.test.ts, node:fs is NOT mocked here.
 * This follows tests/unit/config-manager.test.ts's blocked-directory
 * technique instead: a FILE sitting where a directory needs to be created
 * makes mkdirSync fail with ENOTDIR/ENOENT reliably on every OS, giving a
 * real fs failure rather than a simulated one. PATHS.configDir is re-derived
 * per test from KANGENTIC_DATA_DIR via vi.resetModules() + dynamic import,
 * matching config-manager.test.ts's pattern for the same reason (PATHS
 * caches configDir at module load time).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// Minimal electron mock so mobile-bridge/identity.ts's isGenuineEncryptionAvailable()
// (via boards/shared/auth.ts) runs without a real Electron process. Mirrors the
// mocking pattern in tests/unit/mobile-bridge/identity.test.ts; encrypt/decrypt run
// for real against this reversible fake, so loadOrCreateBridgeIdentity's real
// encrypt-then-persist path is exercised, not a stub.
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

let tmpDir: string;

afterEach(() => {
  delete process.env.KANGENTIC_DATA_DIR;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('call sites on an unwritable config directory', () => {
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kangentic-guarded-writes-'));
    const blockerPath = path.join(tmpDir, 'blocker');
    fs.writeFileSync(blockerPath, '');
    // A FILE where the config dir needs to live makes mkdirSync fail with
    // ENOTDIR/ENOENT on every OS - see config-manager.test.ts's identical setup.
    process.env.KANGENTIC_DATA_DIR = path.join(blockerPath, 'config-dir');
    vi.resetModules();
  });

  it('saveAsanaCredential does not throw and notifies the "asana_credential" source once', async () => {
    const { setSyncWriteFailureNotifier, __resetForTest } = await import(
      '../../src/main/config/write-failure-notice'
    );
    __resetForTest();
    const notifications: string[] = [];
    setSyncWriteFailureNotifier((message) => notifications.push(message));

    const { saveAsanaCredential } = await import(
      '../../src/main/boards/adapters/asana/credential-store'
    );

    expect(() =>
      saveAsanaCredential({
        accessToken: 'token-value',
        userEmail: 'dev@example.com',
        savedAt: new Date().toISOString(),
      }),
    ).not.toThrow();

    expect(notifications).toHaveLength(1);
  });

  it('loadOrCreateBridgeIdentity does not throw generating a fresh identity and notifies the "mobile_bridge_identity" source once', async () => {
    const { setSyncWriteFailureNotifier, __resetForTest } = await import(
      '../../src/main/config/write-failure-notice'
    );
    __resetForTest();
    const notifications: string[] = [];
    setSyncWriteFailureNotifier((message) => notifications.push(message));

    const { loadOrCreateBridgeIdentity } = await import('../../src/main/mobile-bridge/identity');

    let identity: ReturnType<typeof loadOrCreateBridgeIdentity> | undefined;
    expect(() => {
      identity = loadOrCreateBridgeIdentity();
    }).not.toThrow();

    // A degraded disk write still returns the identity generated for THIS
    // session - it is the persistence to disk that fails, not generation.
    expect(identity?.staticKeyPair.secretKey).toHaveLength(32);
    expect(notifications).toHaveLength(1);
  });
});

describe('saveAsanaCredential file mode on a writable directory (POSIX only)', () => {
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kangentic-guarded-writes-mode-'));
    process.env.KANGENTIC_DATA_DIR = tmpDir;
    vi.resetModules();
  });

  // Windows does not honor the owner/group/other split the mode option
  // encodes (.claude/rules/cross-platform-parity.md), so this assertion is
  // POSIX-only rather than tolerance-adjusted.
  it.skipIf(process.platform === 'win32')('writes asana-credentials.json at mode 0o600', async () => {
    const { saveAsanaCredential } = await import(
      '../../src/main/boards/adapters/asana/credential-store'
    );

    saveAsanaCredential({
      accessToken: 'token-value',
      userEmail: 'dev@example.com',
      savedAt: new Date().toISOString(),
    });

    const filePath = path.join(tmpDir, 'asana-credentials.json');
    const mode = fs.statSync(filePath).mode & 0o777;
    expect(mode).toBe(0o600);
  });
});
