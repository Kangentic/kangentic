/**
 * Real-filesystem coverage for src/main/mobile-bridge/roster-store.ts's
 * saveRoster(), which this diff moved from a hand-rolled `mkdirSync` +
 * `writeFileSync` to `safeWriteJson` (.claude/rules/guarded-sync-writes.md).
 *
 * tests/unit/mobile-bridge/roster-store.test.ts mocks node:fs entirely
 * (writeFileSync/mkdirSync are vi.fn() spies that always "succeed"), and so
 * does every other mobile-bridge test file
 * (pairing-service.test.ts, relay-pairing-integration.test.ts,
 * mobile-bridge-service.test.ts, mobile-bridge-session-lifecycle.test.ts,
 * mobile-bridge-sync-race.test.ts, mobile-bridge-relay-state.test.ts,
 * push-registration-store.test.ts, dev-quick-pair-gate.test.ts). None of
 * them exercise a real directory creation or a real write, so the fold from
 * an explicit `mkdirSync` into `safeWriteJson` had no real-disk regression
 * coverage anywhere in the suite. This file closes that gap with two cases:
 * the happy path on a fresh, writable configDir, and the degrade path on an
 * unwritable one (mirroring
 * tests/unit/guarded-sync-write-call-sites.test.ts's technique for
 * saveAsanaCredential / loadOrCreateBridgeIdentity, extended to this third
 * safeWriteJson adopter).
 *
 * PATHS.configDir is re-derived per test from KANGENTIC_DATA_DIR via
 * vi.resetModules() + dynamic import, since paths.ts caches it at module
 * load time.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { bytesToHex, generateX25519KeyPair, verifyRosterEntry } from '@kangentic/protocol';
import type { BridgeIdentity } from '../../../src/main/mobile-bridge/identity';

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

describe('roster-store.saveRoster on a fresh, writable configDir', () => {
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kangentic-roster-real-disk-'));
    // configDir itself does not exist yet - saveRoster must create it.
    process.env.KANGENTIC_DATA_DIR = path.join(tmpDir, 'config-dir');
    vi.resetModules();
  });

  it('creates configDir and writes mobile-bridge-roster.json on the first addOrReplaceDevice', async () => {
    const { generateEd25519KeyPair } = await import('@kangentic/protocol');
    const { addOrReplaceDevice } = await import('../../../src/main/mobile-bridge/roster-store');
    const identity: BridgeIdentity = {
      staticKeyPair: generateX25519KeyPair(),
      masterSigningKeyPair: generateEd25519KeyPair(),
      createdAt: new Date().toISOString(),
    };

    addOrReplaceDevice(identity, {
      deviceId: 'device-1',
      staticPublicKey: generateX25519KeyPair().publicKey,
      displayName: 'My iPhone',
      capabilities: ['read-stream'],
      expiresAt: null,
    });

    const filePath = path.join(process.env.KANGENTIC_DATA_DIR as string, 'mobile-bridge-roster.json');
    expect(fs.existsSync(filePath)).toBe(true);
    const persisted = JSON.parse(fs.readFileSync(filePath, 'utf8')) as { devices: Array<{ deviceId: string }> };
    expect(persisted.devices).toHaveLength(1);
    expect(persisted.devices[0].deviceId).toBe('device-1');
  });

  it('round-trips through loadRoster from a real file, with a verifying signature', async () => {
    const { generateEd25519KeyPair } = await import('@kangentic/protocol');
    const { addOrReplaceDevice, loadRoster } = await import('../../../src/main/mobile-bridge/roster-store');
    const identity: BridgeIdentity = {
      staticKeyPair: generateX25519KeyPair(),
      masterSigningKeyPair: generateEd25519KeyPair(),
      createdAt: new Date().toISOString(),
    };
    const staticPublicKey = generateX25519KeyPair().publicKey;

    addOrReplaceDevice(identity, {
      deviceId: 'device-2',
      staticPublicKey,
      displayName: 'Pixel',
      capabilities: ['read-stream', 'read-board'],
      expiresAt: null,
    });

    const reloaded = loadRoster(identity);
    expect(reloaded.devices).toHaveLength(1);
    expect(bytesToHex(reloaded.devices[0].staticPublicKey)).toBe(bytesToHex(staticPublicKey));
    expect(verifyRosterEntry(identity.masterSigningKeyPair.publicKey, reloaded.devices[0])).toBe(true);
  });
});

describe('roster-store.saveRoster on an unwritable configDir', () => {
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kangentic-roster-blocked-'));
    const blockerPath = path.join(tmpDir, 'blocker');
    // A FILE where the config dir needs to live makes mkdirSync fail with
    // ENOTDIR/ENOENT on every OS - see config-manager.test.ts's identical setup.
    fs.writeFileSync(blockerPath, '');
    process.env.KANGENTIC_DATA_DIR = path.join(blockerPath, 'config-dir');
    vi.resetModules();
  });

  it('addOrReplaceDevice does not throw and still returns the in-memory roster with the new device', async () => {
    const { setSyncWriteFailureNotifier, __resetForTest } = await import(
      '../../../src/main/config/write-failure-notice'
    );
    __resetForTest();
    const notifications: string[] = [];
    setSyncWriteFailureNotifier((message) => notifications.push(message));

    const { generateEd25519KeyPair } = await import('@kangentic/protocol');
    const { addOrReplaceDevice } = await import('../../../src/main/mobile-bridge/roster-store');
    const identity: BridgeIdentity = {
      staticKeyPair: generateX25519KeyPair(),
      masterSigningKeyPair: generateEd25519KeyPair(),
      createdAt: new Date().toISOString(),
    };

    let roster: ReturnType<typeof addOrReplaceDevice> | undefined;
    expect(() => {
      roster = addOrReplaceDevice(identity, {
        deviceId: 'device-3',
        staticPublicKey: generateX25519KeyPair().publicKey,
        displayName: 'Degraded Pairing',
        capabilities: ['read-stream'],
        expiresAt: null,
      });
    }).not.toThrow();

    // The write failed silently on disk, but the pairing still completes for
    // THIS session - it is persistence across a restart that is lost, not the
    // pairing itself.
    expect(roster?.devices).toHaveLength(1);
    expect(notifications).toHaveLength(1);
  });
});
