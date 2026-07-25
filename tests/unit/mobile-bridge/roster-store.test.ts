/**
 * Unit tests for src/main/mobile-bridge/roster-store.ts
 *
 * Verifies the signed-device-roster persistence: signing/upserting a device,
 * capability changes re-signing an entry, revocation, and - the load-bearing
 * safety property of this module - that loadRoster() re-verifies EVERY
 * stored entry's signature against the roster's own master signing key and
 * silently drops any entry that fails verification, so a corrupted or
 * hand-edited roster file degrades to "that device drops out" instead of
 * trusting tampered data.
 *
 * Mocking mirrors tests/unit/asana-credential-store.test.ts: electron and
 * node:fs are mocked so no real file I/O occurs (fs is bundled as both named
 * exports and a `default`, since roster-store.ts imports it CJS-style), and
 * PATHS is mocked to a stable fake configDir. Ed25519 signing/verification
 * comes from the real @kangentic/protocol package (fast, already proven
 * correct) rather than being mocked, so these tests exercise the real
 * signature round trip.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  bytesToHex,
  generateEd25519KeyPair,
  generateX25519KeyPair,
  hexToBytes,
  verifyRosterEntry,
  type CapabilityVerb,
} from '@kangentic/protocol';
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

vi.mock('../../../src/main/config/paths', () => ({
  PATHS: { configDir: '/mock/config' },
}));

// Import AFTER all vi.mock declarations.
const { loadRoster, addOrReplaceDevice, setDeviceCapabilities, setDeviceDisplayName, revokeDevice, clearRoster } = await import(
  '../../../src/main/mobile-bridge/roster-store'
);

function testIdentity(): BridgeIdentity {
  return {
    staticKeyPair: generateX25519KeyPair(),
    masterSigningKeyPair: generateEd25519KeyPair(),
    createdAt: new Date().toISOString(),
  };
}

interface FakeDeviceInput {
  deviceId: string;
  displayName: string;
  capabilities: CapabilityVerb[];
}

function fakeDeviceInput(overrides: Partial<FakeDeviceInput> = {}) {
  return {
    deviceId: overrides.deviceId ?? 'device-1',
    staticPublicKey: generateX25519KeyPair().publicKey,
    displayName: overrides.displayName ?? 'My iPhone',
    capabilities: overrides.capabilities ?? (['read-stream'] as CapabilityVerb[]),
    expiresAt: null,
  };
}

beforeEach(() => {
  existsSyncSpy.mockReset();
  readFileSyncSpy.mockReset();
  writeFileSyncSpy.mockReset();
  mkdirSyncSpy.mockReset();
  unlinkSyncSpy.mockReset();
  rmSyncSpy.mockReset();
});

describe('loadRoster', () => {
  it('returns an empty roster carrying the identity master signing key when the file does not exist', () => {
    existsSyncSpy.mockReturnValue(false);
    const identity = testIdentity();

    const roster = loadRoster(identity);

    expect(roster.devices).toEqual([]);
    expect(bytesToHex(roster.masterSigningPublicKey)).toBe(bytesToHex(identity.masterSigningKeyPair.publicKey));
  });

  it('drops an entry whose signature fails verification against the roster master key', () => {
    const identity = testIdentity();
    existsSyncSpy.mockReturnValue(false);
    const input = fakeDeviceInput();
    const roster = addOrReplaceDevice(identity, input);
    const persistedJson = writeFileSyncSpy.mock.calls[0][1] as string;
    const persisted = JSON.parse(persistedJson) as {
      masterSigningPublicKeyHex: string;
      devices: Array<{ signatureHex: string }>;
    };

    // Tamper: flip one hex nibble in the signature.
    const originalSignatureHex = persisted.devices[0].signatureHex;
    const tamperedNibble = originalSignatureHex[0] === '0' ? '1' : '0';
    persisted.devices[0].signatureHex = tamperedNibble + originalSignatureHex.slice(1);

    existsSyncSpy.mockReturnValue(true);
    readFileSyncSpy.mockReturnValue(JSON.stringify(persisted));
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    const reloaded = loadRoster(identity);

    warnSpy.mockRestore();
    expect(reloaded.devices).toEqual([]);
    expect(roster.devices).toHaveLength(1);
  });

  it('logs a warning and returns an empty roster when the file contains invalid JSON', () => {
    existsSyncSpy.mockReturnValue(true);
    readFileSyncSpy.mockReturnValue('not-valid-json');
    const identity = testIdentity();
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    const roster = loadRoster(identity);

    expect(roster.devices).toEqual([]);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('mobile-bridge/roster-store'),
      expect.any(Error),
    );
    warnSpy.mockRestore();
  });
});

describe('addOrReplaceDevice', () => {
  it('signs an entry and persists it via writeFileSync', () => {
    existsSyncSpy.mockReturnValue(false);
    const identity = testIdentity();
    const input = fakeDeviceInput();

    addOrReplaceDevice(identity, input);

    expect(writeFileSyncSpy).toHaveBeenCalledTimes(1);
    const persistedJson = writeFileSyncSpy.mock.calls[0][1] as string;
    expect(persistedJson).toContain(input.deviceId);
    expect(persistedJson).toContain(input.displayName);
  });

  it('round-trips through loadRoster with matching capabilities/displayName and a valid signature', () => {
    existsSyncSpy.mockReturnValue(false);
    const identity = testIdentity();
    const input = fakeDeviceInput({ capabilities: ['read-stream', 'read-board'] });
    addOrReplaceDevice(identity, input);
    const persistedJson = writeFileSyncSpy.mock.calls[0][1] as string;

    existsSyncSpy.mockReturnValue(true);
    readFileSyncSpy.mockReturnValue(persistedJson);

    const reloaded = loadRoster(identity);

    expect(reloaded.devices).toHaveLength(1);
    const entry = reloaded.devices[0];
    expect(entry.deviceId).toBe(input.deviceId);
    expect(entry.displayName).toBe(input.displayName);
    expect(entry.capabilities).toEqual(input.capabilities);
    expect(bytesToHex(entry.staticPublicKey)).toBe(bytesToHex(input.staticPublicKey));
    expect(verifyRosterEntry(identity.masterSigningKeyPair.publicKey, entry)).toBe(true);
  });

  it('replaces (not duplicates) an entry when called twice with the same deviceId', () => {
    existsSyncSpy.mockReturnValue(false);
    const identity = testIdentity();
    addOrReplaceDevice(identity, fakeDeviceInput({ deviceId: 'device-1', displayName: 'First Name' }));
    const firstPersistedJson = writeFileSyncSpy.mock.calls[0][1] as string;

    existsSyncSpy.mockReturnValue(true);
    readFileSyncSpy.mockReturnValue(firstPersistedJson);
    writeFileSyncSpy.mockClear();

    addOrReplaceDevice(identity, fakeDeviceInput({ deviceId: 'device-1', displayName: 'Second Name' }));

    const secondPersistedJson = writeFileSyncSpy.mock.calls[0][1] as string;
    const secondPersisted = JSON.parse(secondPersistedJson) as { devices: Array<{ deviceId: string; displayName: string }> };
    expect(secondPersisted.devices).toHaveLength(1);
    expect(secondPersisted.devices[0].displayName).toBe('Second Name');
  });
});

describe('setDeviceCapabilities', () => {
  it('throws for an unknown deviceId', () => {
    existsSyncSpy.mockReturnValue(false);
    const identity = testIdentity();

    expect(() => setDeviceCapabilities(identity, 'unknown-device', ['read-board'])).toThrow(/No such paired device/);
  });

  it('re-signs and changes capabilities for a known device, invalidating the old signature, without restamping pairedAt', () => {
    existsSyncSpy.mockReturnValue(false);
    const identity = testIdentity();
    addOrReplaceDevice(identity, fakeDeviceInput({ deviceId: 'device-1', capabilities: ['read-stream'] }));
    const firstPersistedJson = writeFileSyncSpy.mock.calls[0][1] as string;
    const firstPersisted = JSON.parse(firstPersistedJson) as { devices: Array<{ signatureHex: string; pairedAt: string }> };
    const oldSignatureHex = firstPersisted.devices[0].signatureHex;
    const originalPairedAt = firstPersisted.devices[0].pairedAt;

    existsSyncSpy.mockReturnValue(true);
    readFileSyncSpy.mockReturnValue(firstPersistedJson);
    writeFileSyncSpy.mockClear();

    setDeviceCapabilities(identity, 'device-1', ['read-stream', 'read-board', 'read-diff']);

    const secondPersistedJson = writeFileSyncSpy.mock.calls[0][1] as string;
    const secondPersisted = JSON.parse(secondPersistedJson) as {
      devices: Array<{ deviceId: string; capabilities: string[]; signatureHex: string; pairedAt: string }>;
    };
    expect(secondPersisted.devices).toHaveLength(1);
    const updatedEntry = secondPersisted.devices[0];
    expect(updatedEntry.capabilities).toEqual(['read-stream', 'read-board', 'read-diff']);
    expect(updatedEntry.signatureHex).not.toBe(oldSignatureHex);
    // A capability change (including the pairing-overhaul migration that
    // upgrades every pre-existing device to the full grant) is not a
    // re-pairing - the original pairedAt must survive.
    expect(updatedEntry.pairedAt).toBe(originalPairedAt);

    existsSyncSpy.mockReturnValue(true);
    readFileSyncSpy.mockReturnValue(secondPersistedJson);
    const reloaded = loadRoster(identity);
    expect(reloaded.devices).toHaveLength(1);
    expect(verifyRosterEntry(identity.masterSigningKeyPair.publicKey, reloaded.devices[0])).toBe(true);

    // The OLD signature no longer verifies against the NEW capability set.
    const tamperedBackToOldSignature = {
      ...reloaded.devices[0],
      signature: hexToBytes(oldSignatureHex),
    };
    expect(verifyRosterEntry(identity.masterSigningKeyPair.publicKey, tamperedBackToOldSignature)).toBe(false);
  });
});

describe('setDeviceDisplayName', () => {
  it('throws for an unknown deviceId', () => {
    existsSyncSpy.mockReturnValue(false);
    const identity = testIdentity();

    expect(() => setDeviceDisplayName(identity, 'unknown-device', 'New Name')).toThrow(/No such paired device/);
  });

  it('re-signs and changes the display name for a known device, preserving pairedAt', () => {
    existsSyncSpy.mockReturnValue(false);
    const identity = testIdentity();
    addOrReplaceDevice(identity, fakeDeviceInput({ deviceId: 'device-1', displayName: 'Old Name' }));
    const firstPersistedJson = writeFileSyncSpy.mock.calls[0][1] as string;
    const firstPersisted = JSON.parse(firstPersistedJson) as { devices: Array<{ signatureHex: string; pairedAt: string }> };
    const oldSignatureHex = firstPersisted.devices[0].signatureHex;
    const originalPairedAt = firstPersisted.devices[0].pairedAt;

    existsSyncSpy.mockReturnValue(true);
    readFileSyncSpy.mockReturnValue(firstPersistedJson);
    writeFileSyncSpy.mockClear();

    setDeviceDisplayName(identity, 'device-1', 'New Name');

    const secondPersistedJson = writeFileSyncSpy.mock.calls[0][1] as string;
    const secondPersisted = JSON.parse(secondPersistedJson) as {
      devices: Array<{ deviceId: string; displayName: string; signatureHex: string; pairedAt: string }>;
    };
    expect(secondPersisted.devices).toHaveLength(1);
    const updatedEntry = secondPersisted.devices[0];
    expect(updatedEntry.displayName).toBe('New Name');
    expect(updatedEntry.signatureHex).not.toBe(oldSignatureHex);
    expect(updatedEntry.pairedAt).toBe(originalPairedAt);

    existsSyncSpy.mockReturnValue(true);
    readFileSyncSpy.mockReturnValue(secondPersistedJson);
    const reloaded = loadRoster(identity);
    expect(reloaded.devices).toHaveLength(1);
    expect(reloaded.devices[0].displayName).toBe('New Name');
    expect(verifyRosterEntry(identity.masterSigningKeyPair.publicKey, reloaded.devices[0])).toBe(true);
  });
});

describe('roster round-trip after the pairing-overhaul mutations (silent-drop regression)', () => {
  it('a renamed device and a capability-upgraded device both still verify after a loadRoster round-trip', () => {
    existsSyncSpy.mockReturnValue(false);
    const identity = testIdentity();

    // Each mutation re-loads the roster from "disk" first, so the mock's
    // readFileSyncSpy must be re-chained to the PREVIOUS write before every
    // subsequent call - otherwise a later addOrReplaceDevice/setDevice* call
    // would read an empty/stale roster and silently lose an earlier device,
    // mirroring the "replaces (not duplicates)" test's chaining above.
    addOrReplaceDevice(identity, fakeDeviceInput({ deviceId: 'device-renamed', displayName: 'Old Name', capabilities: ['read-stream'] }));
    let latestJson = writeFileSyncSpy.mock.calls[0][1] as string;
    existsSyncSpy.mockReturnValue(true);
    readFileSyncSpy.mockReturnValue(latestJson);
    writeFileSyncSpy.mockClear();

    addOrReplaceDevice(identity, fakeDeviceInput({ deviceId: 'device-upgraded', displayName: 'Pixel', capabilities: ['read-stream'] }));
    latestJson = writeFileSyncSpy.mock.calls[0][1] as string;
    readFileSyncSpy.mockReturnValue(latestJson);
    writeFileSyncSpy.mockClear();

    setDeviceDisplayName(identity, 'device-renamed', 'New Name');
    latestJson = writeFileSyncSpy.mock.calls[0][1] as string;
    readFileSyncSpy.mockReturnValue(latestJson);
    writeFileSyncSpy.mockClear();

    setDeviceCapabilities(identity, 'device-upgraded', ['read-stream', 'read-board', 'read-diff', 'board-tool-read', 'register-push']);
    latestJson = writeFileSyncSpy.mock.calls[0][1] as string;

    readFileSyncSpy.mockReturnValue(latestJson);
    const reloaded = loadRoster(identity);

    expect(reloaded.devices).toHaveLength(2);
    for (const device of reloaded.devices) {
      expect(verifyRosterEntry(identity.masterSigningKeyPair.publicKey, device)).toBe(true);
    }
    expect(reloaded.devices.find((device) => device.deviceId === 'device-renamed')?.displayName).toBe('New Name');
    expect(reloaded.devices.find((device) => device.deviceId === 'device-upgraded')?.capabilities).toEqual([
      'read-stream',
      'read-board',
      'read-diff',
      'board-tool-read',
      'register-push',
    ]);
  });
});

describe('revokeDevice', () => {
  it('removes the device from the persisted roster', () => {
    existsSyncSpy.mockReturnValue(false);
    const identity = testIdentity();
    addOrReplaceDevice(identity, fakeDeviceInput({ deviceId: 'device-1' }));
    const firstPersistedJson = writeFileSyncSpy.mock.calls[0][1] as string;

    existsSyncSpy.mockReturnValue(true);
    readFileSyncSpy.mockReturnValue(firstPersistedJson);
    writeFileSyncSpy.mockClear();

    revokeDevice(identity, 'device-1');

    const secondPersistedJson = writeFileSyncSpy.mock.calls[0][1] as string;
    const secondPersisted = JSON.parse(secondPersistedJson) as { devices: unknown[] };
    expect(secondPersisted.devices).toEqual([]);
  });
});

describe('clearRoster', () => {
  it('removes the roster file via rmSync with force (no existsSync gate, Windows-lock safe)', () => {
    clearRoster();
    expect(rmSyncSpy).toHaveBeenCalledTimes(1);
    expect(rmSyncSpy).toHaveBeenCalledWith(expect.stringContaining('mobile-bridge-roster.json'), { force: true });
  });

  it('swallows a transient filesystem error (e.g. a Windows file lock) rather than throwing', () => {
    rmSyncSpy.mockImplementation(() => {
      throw new Error('EBUSY: resource busy or locked');
    });
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    expect(() => clearRoster()).not.toThrow();
    warnSpy.mockRestore();
  });
});
