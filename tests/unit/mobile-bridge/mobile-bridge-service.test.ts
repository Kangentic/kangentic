/**
 * Unit tests for src/main/mobile-bridge/mobile-bridge-service.ts
 *
 * The load-bearing property covered here: merely checking status, listing
 * devices, or opening the settings tab must NEVER have the side effect of
 * generating and persisting a new device identity keypair. Only a
 * deliberate "Pair a device" (startPairing()) does that. This was caught
 * as a real bug during review - getStatus() originally called the
 * create-if-missing path, so opening Settings with the bridge globally
 * disabled would still silently write an identity file to disk.
 *
 * Mocking mirrors the other mobile-bridge tests: electron and node:fs are
 * mocked so no real file I/O occurs, PATHS is mocked to a stable fake
 * configDir, and transport-factory is mocked so startPairing() never opens
 * a real socket (the relay client itself is covered by
 * relay-pairing-integration.test.ts).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'node:events';
import {
  CAPABILITY_VERBS,
  createPairingInitiatorHandshake,
  generateX25519KeyPair,
  sealPairingConfirm,
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
  // Phase 2's capability handlers reach real src/main/ipc/handlers and
  // src/main/agent modules at import time (attachContext() wires them into
  // the router), so their module-scope `import { ipcMain } from 'electron'`
  // statements need this to exist even though nothing in this test suite
  // ever calls ipcMain.handle/.on.
  ipcMain: {
    handle: vi.fn(),
    on: vi.fn(),
    removeHandler: vi.fn(),
  },
}));

// Reached transitively via handlers/mcp-tool.ts -> mcp-project-context.ts ->
// task-move.ts, which imports the real analytics module (pulls in the
// aptabase-electron package and electron's `app`). Mocked the same way
// session-manager.test.ts does, since nothing here exercises analytics.
vi.mock('../../../src/main/analytics/analytics', () => ({
  trackEvent: vi.fn(),
  sanitizeErrorMessage: (message: string) => message,
}));

const existsSyncSpy = vi.hoisted(() => vi.fn<(filePath: string) => boolean>());
const readFileSyncSpy = vi.hoisted(() => vi.fn<(filePath: string, encoding: BufferEncoding) => string>());
const writeFileSyncSpy = vi.hoisted(() => vi.fn<(filePath: string, data: string) => void>());
const mkdirSyncSpy = vi.hoisted(() => vi.fn());
const unlinkSyncSpy = vi.hoisted(() => vi.fn());

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
    },
    existsSync: existsSyncSpy,
    readFileSync: readFileSyncSpy,
    writeFileSync: writeFileSyncSpy,
    mkdirSync: mkdirSyncSpy,
    unlinkSync: unlinkSyncSpy,
  };
});

vi.mock('../../../src/main/config/paths', () => ({
  PATHS: { configDir: '/mock/config' },
}));

// onFrame captures its listener (rather than discarding it, as a bare
// `vi.fn(() => () => undefined)` would) so a test can simulate a frame
// arriving from the "phone" by calling it directly - see deliverFrame()
// below. The unsubscribe function nulls it back out, mirroring how
// PairingService's teardown() actually behaves.
let currentFrameListener: ((frame: Uint8Array) => void) | null = null;
const fakeTransport = {
  state: 'connected' as const,
  connect: vi.fn(async () => undefined),
  send: vi.fn(),
  close: vi.fn(),
  onFrame: vi.fn((listener: (frame: Uint8Array) => void) => {
    currentFrameListener = listener;
    return () => {
      if (currentFrameListener === listener) currentFrameListener = null;
    };
  }),
  onStateChange: vi.fn(() => () => undefined),
};

function deliverFrame(frame: Uint8Array): void {
  if (!currentFrameListener) throw new Error('test setup: no frame listener is currently registered on fakeTransport');
  currentFrameListener(frame);
}

vi.mock('../../../src/main/mobile-bridge/transport/transport-factory', () => ({
  createTransport: vi.fn(() => fakeTransport),
}));

const { MobileBridgeService } = await import('../../../src/main/mobile-bridge/mobile-bridge-service');
// Not mocked in this file - identity.ts and roster-store.ts touch only the
// same mocked fs/electron surfaces already set up above, so the migration
// test below can read back a real identity the service persisted, and seed
// a real, correctly-signed "legacy" roster entry with it.
const { loadBridgeIdentity } = await import('../../../src/main/mobile-bridge/identity');
const { addOrReplaceDevice } = await import('../../../src/main/mobile-bridge/roster-store');
const { createTransport } = await import('../../../src/main/mobile-bridge/transport/transport-factory');

/**
 * Creates and persists a real identity via the actual startPairing()
 * trigger (immediately cancelled - a live ceremony is not needed), reads it
 * back through the mocked filesystem, then seeds one roster device directly
 * with addOrReplaceDevice, mirroring the "migrates pre-existing devices"
 * setup below. Leaves existsSync/readFileSync wired to serve BOTH the
 * identity and roster files so the caller's next service call
 * (renameDevice, listDevices, attachContext's migration, ...) reads the
 * seeded state. Returns identityJson so a caller that mutates the roster
 * further (e.g. renameDevice) can re-wire the read mocks onto the newest
 * write via rewireReadsToLatestRosterWrite() below.
 */
async function seedServiceWithOnePairedDevice(
  service: InstanceType<typeof MobileBridgeService>,
  overrides: { deviceId?: string; displayName?: string; capabilities?: CapabilityVerb[] } = {},
): Promise<{ identity: BridgeIdentity; identityJson: string; deviceId: string }> {
  await service.startPairing();
  service.cancelPairing();
  const identityWriteCall = writeFileSyncSpy.mock.calls.find(([filePath]) => (filePath as string).includes('mobile-bridge-identity.json'));
  if (!identityWriteCall) throw new Error('test setup: identity was not persisted');
  const identityJson = identityWriteCall[1] as string;
  existsSyncSpy.mockImplementation((filePath: string) => filePath.includes('mobile-bridge-identity.json'));
  readFileSyncSpy.mockReturnValue(identityJson);
  const identity = loadBridgeIdentity();
  if (!identity) throw new Error('test setup: could not read back the persisted identity');

  writeFileSyncSpy.mockClear();
  const deviceId = overrides.deviceId ?? 'seeded-device';
  addOrReplaceDevice(identity, {
    deviceId,
    staticPublicKey: generateX25519KeyPair().publicKey,
    displayName: overrides.displayName ?? 'Seeded Phone',
    capabilities: overrides.capabilities ?? [...CAPABILITY_VERBS],
    expiresAt: null,
  });
  const rosterWriteCall = writeFileSyncSpy.mock.calls.find(([filePath]) => (filePath as string).includes('mobile-bridge-roster.json'));
  if (!rosterWriteCall) throw new Error('test setup: the seeded roster entry was not persisted');
  const rosterJson = rosterWriteCall[1] as string;
  existsSyncSpy.mockImplementation((filePath: string) => filePath.includes('mobile-bridge-identity.json') || filePath.includes('mobile-bridge-roster.json'));
  readFileSyncSpy.mockImplementation((filePath: string) => (filePath.includes('mobile-bridge-roster.json') ? rosterJson : identityJson));

  return { identity, identityJson, deviceId };
}

/** Re-points readFileSync at whatever the most recent roster write produced, so a service call made AFTER the seed above (e.g. renameDevice) is visible to a subsequent listDevices() read. */
function rewireReadsToLatestRosterWrite(identityJson: string): void {
  const latestRosterWriteCall = writeFileSyncSpy.mock.calls
    .filter(([filePath]) => (filePath as string).includes('mobile-bridge-roster.json'))
    .at(-1);
  if (!latestRosterWriteCall) throw new Error('test setup: no roster write has been captured yet');
  const rosterJson = latestRosterWriteCall[1] as string;
  existsSyncSpy.mockImplementation((filePath: string) => filePath.includes('mobile-bridge-identity.json') || filePath.includes('mobile-bridge-roster.json'));
  readFileSyncSpy.mockImplementation((filePath: string) => (filePath.includes('mobile-bridge-roster.json') ? rosterJson : identityJson));
}

beforeEach(() => {
  existsSyncSpy.mockReset();
  readFileSyncSpy.mockReset();
  writeFileSyncSpy.mockReset();
  mkdirSyncSpy.mockReset();
  unlinkSyncSpy.mockReset();
  existsSyncSpy.mockReturnValue(false); // no identity/roster file exists yet, by default
  fakeTransport.connect.mockClear();
  fakeTransport.send.mockClear();
  fakeTransport.close.mockClear();
  fakeTransport.onFrame.mockClear();
  currentFrameListener = null;
});

describe('MobileBridgeService read paths never create an identity', () => {
  it('getStatus() does not persist an identity when none exists yet', () => {
    const service = new MobileBridgeService({ enabled: true, relayUrl: 'wss://relay.example.com' });
    const status = service.getStatus();

    expect(writeFileSyncSpy).not.toHaveBeenCalled();
    expect(status.identityFingerprint).toBeNull();
    expect(status.pairedDeviceCount).toBe(0);
    expect(status.enabled).toBe(true);
  });

  it('getStatus() reports the bridge as disabled without touching identity state', () => {
    const service = new MobileBridgeService({ enabled: false, relayUrl: '' });
    const status = service.getStatus();

    expect(writeFileSyncSpy).not.toHaveBeenCalled();
    expect(status.enabled).toBe(false);
  });

  it('getStatus() reports relayState "idle" when there are no roster devices to open a session for', () => {
    const service = new MobileBridgeService({ enabled: true, relayUrl: 'wss://relay.example.com' });
    expect(service.getStatus().relayState).toBe('idle');
  });

  it('listDevices() returns an empty array without persisting an identity when none exists', () => {
    const service = new MobileBridgeService({ enabled: true, relayUrl: 'wss://relay.example.com' });
    const devices = service.listDevices();

    expect(devices).toEqual([]);
    expect(writeFileSyncSpy).not.toHaveBeenCalled();
  });

  it('revokeDevice() is a no-op without persisting an identity when none exists', () => {
    const service = new MobileBridgeService({ enabled: true, relayUrl: 'wss://relay.example.com' });
    expect(() => service.revokeDevice('some-device')).not.toThrow();
    expect(writeFileSyncSpy).not.toHaveBeenCalled();
  });

  it('setDeviceCapabilities() throws rather than creating an identity when none exists', () => {
    const service = new MobileBridgeService({ enabled: true, relayUrl: 'wss://relay.example.com' });
    expect(() => service.setDeviceCapabilities('some-device', ['read-board'])).toThrow(/No such paired device/);
    expect(writeFileSyncSpy).not.toHaveBeenCalled();
  });

  it('renameDevice() throws rather than creating an identity when none exists', () => {
    const service = new MobileBridgeService({ enabled: true, relayUrl: 'wss://relay.example.com' });
    expect(() => service.renameDevice('some-device', 'New Name')).toThrow(/No such paired device/);
    expect(writeFileSyncSpy).not.toHaveBeenCalled();
  });
});

describe('MobileBridgeService.revokeDevice() clears the push registration', () => {
  it('removes the revoked device from the push registration store even when no identity exists', () => {
    const service = new MobileBridgeService({ enabled: true, relayUrl: 'wss://relay.example.com' });
    service.pushRegistrations.upsert('device-1', {
      expoPushToken: 'ExponentPushToken[abc]',
      pushKeyHex: 'ab'.repeat(32),
      platform: 'android',
      registeredAt: '2026-01-01T00:00:00.000Z',
    });
    expect(service.pushRegistrations.list()).toHaveLength(1);

    service.revokeDevice('device-1');

    expect(service.pushRegistrations.list()).toEqual([]);
  });
});

describe('MobileBridgeService.startPairing() is the deliberate identity-creation trigger', () => {
  it('creates and persists an identity on the first pairing attempt', async () => {
    const service = new MobileBridgeService({ enabled: true, relayUrl: 'wss://relay.example.com' });
    const { qrUri } = await service.startPairing();

    expect(writeFileSyncSpy).toHaveBeenCalledTimes(1);
    expect(qrUri.startsWith('kangentic-pair://')).toBe(true);
    expect(fakeTransport.connect).toHaveBeenCalledTimes(1);
  });

  it('throws without creating an identity when the bridge is disabled', async () => {
    const service = new MobileBridgeService({ enabled: false, relayUrl: '' });
    await expect(service.startPairing()).rejects.toThrow(/not enabled/);
    expect(writeFileSyncSpy).not.toHaveBeenCalled();
  });

  it('refuses to start pairing on an invalid relay URL rather than minting a QR the phone will reject', async () => {
    // This should be unreachable via the real reconcile() call sites (both
    // resolve through resolveRelayUrl() before it reaches config), but a
    // directly-constructed service with a bad URL still must not proceed.
    const service = new MobileBridgeService({ enabled: true, relayUrl: 'ws://not-loopback.example.com' });
    await expect(service.startPairing()).rejects.toThrow(/TLS/);
    expect(writeFileSyncSpy).not.toHaveBeenCalled();
    expect(fakeTransport.connect).not.toHaveBeenCalled();
  });
});

describe('MobileBridgeService.reconcile()', () => {
  it('cancels an in-progress pairing when the bridge is disabled', async () => {
    const service = new MobileBridgeService({ enabled: true, relayUrl: 'wss://relay.example.com' });
    await service.startPairing();
    expect(service.getStatus().pairingInProgress).toBe(true);

    service.reconcile({ enabled: false, relayUrl: '' });

    expect(service.getStatus().pairingInProgress).toBe(false);
    expect(fakeTransport.close).toHaveBeenCalled();
  });
});

describe('MobileBridgeService.startPairing() closes the transport on a failed connect', () => {
  it('closes the transport, clears activePairing, and rethrows when transport.connect() rejects', async () => {
    const service = new MobileBridgeService({ enabled: true, relayUrl: 'wss://relay.example.com' });
    fakeTransport.connect.mockRejectedValueOnce(new Error('relay unreachable'));

    await expect(service.startPairing()).rejects.toThrow(/relay unreachable/);

    expect(fakeTransport.close).toHaveBeenCalledTimes(1);
    expect(service.getStatus().pairingInProgress).toBe(false);
  });
});

describe('MobileBridgeService.startPairing() self-heals a stale in-progress ceremony', () => {
  it('supersedes an in-flight ceremony (closing its transport) instead of throwing, and starts a fresh one', async () => {
    const service = new MobileBridgeService({ enabled: true, relayUrl: 'wss://relay.example.com' });
    await service.startPairing();
    expect(service.getStatus().pairingInProgress).toBe(true);
    fakeTransport.close.mockClear();

    // Simulates "Pair a device" clicked again after the panel was closed
    // mid-ceremony (Part 4's reopen no-op): this must not throw.
    await expect(service.startPairing()).resolves.toBeDefined();

    expect(fakeTransport.close).toHaveBeenCalled();
    expect(service.getStatus().pairingInProgress).toBe(true);
  });
});

describe('MobileBridgeService.startPairing() overlapping-supersede race', () => {
  it('keeps activePairing pointing at the second ceremony when the first ceremony\'s connect() rejects AFTER being superseded', async () => {
    const service = new MobileBridgeService({ enabled: true, relayUrl: 'wss://relay.example.com' });

    // Transport A: connect() stays pending until manually rejected, mirroring
    // RelayClient.close() settling a still-in-flight dial (relay-client.ts,
    // pendingDialReject) when call B's cancelPairing() closes it out from
    // under call A.
    let rejectConnectA: ((error: Error) => void) | null = null;
    const transportA = {
      state: 'connecting' as const,
      connect: vi.fn(() => new Promise<void>((_resolve, reject) => { rejectConnectA = reject; })),
      send: vi.fn(),
      close: vi.fn(() => rejectConnectA?.(new Error('closed while dialing'))),
      onFrame: vi.fn(() => () => undefined),
      onStateChange: vi.fn(() => () => undefined),
    };
    // Transport B: connects immediately once call B installs it.
    const transportB = {
      state: 'connected' as const,
      connect: vi.fn(async () => undefined),
      send: vi.fn(),
      close: vi.fn(),
      onFrame: vi.fn(() => () => undefined),
      onStateChange: vi.fn(() => () => undefined),
    };
    vi.mocked(createTransport).mockImplementationOnce(() => transportA).mockImplementationOnce(() => transportB);

    // Call A installs activePairing and suspends inside `await
    // transport.connect()` on transportA (everything before that await is
    // synchronous, so this is guaranteed to have happened by the time
    // service.startPairing() returns a pending promise below).
    const callA = service.startPairing();
    // Call B arrives while A is still awaiting connect(): sees a non-null
    // activePairing, cancels A (closing transportA, which rejects A's
    // pending dial), installs its OWN PairingService as activePairing, then
    // its own connect() resolves.
    const callB = service.startPairing();

    await expect(callA).rejects.toThrow(/closed while dialing/);
    await expect(callB).resolves.toBeDefined();

    // The bug this guards: A's rejected-dial catch used to null
    // this.activePairing UNCONDITIONALLY (regardless of what it currently
    // pointed at), orphaning B's live ceremony even though B is the call
    // that actually won the race. getStatus().pairingInProgress reading
    // false here would mean cancelPairing() now no-ops against B and the
    // next startPairing() would leak a second live ceremony alongside it.
    expect(service.getStatus().pairingInProgress).toBe(true);
  });
});

describe('MobileBridgeService pairing ceremony wiring (real crypto over the mocked transport)', () => {
  it('closes the pairing transport once the phone confirm frame auto-enrolls the device, and the device is immediately listed', async () => {
    const service = new MobileBridgeService({ enabled: true, relayUrl: 'wss://relay.example.com' });
    const { qrPayload } = await service.startPairing();

    const phoneStaticKeyPair = generateX25519KeyPair();
    const phoneHandshake = createPairingInitiatorHandshake({
      localStatic: phoneStaticKeyPair,
      remoteStatic: qrPayload.desktopStaticPublicKey,
      pairingToken: qrPayload.pairingToken,
    });
    const message1 = phoneHandshake.writeMessage(new TextEncoder().encode('Test Phone')).message;
    deliverFrame(message1);

    // The desktop's message 2 reply went out via fakeTransport.send() -
    // read it to complete the phone's own side and derive the confirm cipher.
    const message2 = fakeTransport.send.mock.calls[0]?.[0] as Uint8Array;
    const phoneReadResult = phoneHandshake.readMessage(message2);
    if (!phoneReadResult.split) throw new Error('test setup: phone handshake did not complete');

    fakeTransport.close.mockClear();
    deliverFrame(sealPairingConfirm(phoneReadResult.split[0]));

    // Today's bug fix: the ephemeral pairing transport used to be closed
    // only on cancelled/failed, leaking a live RelayClient reconnecting
    // against a consumed-token slot for the rest of the process's lifetime
    // after every SUCCESSFUL pairing.
    expect(fakeTransport.close).toHaveBeenCalledTimes(1);
    expect(service.getStatus().pairingInProgress).toBe(false);

    // Re-point the mocked filesystem at what confirmSas() just persisted so
    // listDevices() reads it back (loadRoster() gates on existsSync).
    const rosterWriteCall = writeFileSyncSpy.mock.calls.find(([filePath]) => (filePath as string).includes('mobile-bridge-roster.json'));
    if (!rosterWriteCall) throw new Error('test setup: the roster was not persisted');
    existsSyncSpy.mockImplementation((filePath: string) => filePath.includes('mobile-bridge-roster.json'));
    readFileSyncSpy.mockReturnValue(rosterWriteCall[1] as string);

    const devices = service.listDevices();
    expect(devices).toHaveLength(1);
    expect(devices[0].displayName).toBe('Test Phone');
    expect(devices[0].capabilities).toEqual(CAPABILITY_VERBS);
  });
});

describe('MobileBridgeService.attachContext() migrates pre-existing devices to the full capability grant', () => {
  it('upgrades a device paired under the old read-only default, before the first reconcile() opens any session', async () => {
    const service = new MobileBridgeService({ enabled: true, relayUrl: 'wss://relay.example.com' });

    // Create + persist a real identity the same way a genuine "Pair a
    // device" click would (startPairing() is the only identity-creation
    // trigger), then read it back through the same mocked filesystem to get
    // a real BridgeIdentity this test can sign a legacy roster entry with.
    await service.startPairing();
    service.cancelPairing();
    const identityWriteCall = writeFileSyncSpy.mock.calls.find(([filePath]) => (filePath as string).includes('mobile-bridge-identity.json'));
    if (!identityWriteCall) throw new Error('test setup: identity was not persisted');
    const identityJson = identityWriteCall[1] as string;
    existsSyncSpy.mockImplementation((filePath: string) => filePath.includes('mobile-bridge-identity.json'));
    readFileSyncSpy.mockReturnValue(identityJson);
    const identity = loadBridgeIdentity();
    if (!identity) throw new Error('test setup: could not read back the persisted identity');

    // Seed a "legacy" roster entry: the pre-overhaul read-only default
    // grant, correctly signed with the real identity above.
    writeFileSyncSpy.mockClear();
    addOrReplaceDevice(identity, {
      deviceId: 'legacy-device',
      staticPublicKey: generateX25519KeyPair().publicKey,
      displayName: 'Legacy Phone',
      capabilities: ['read-stream', 'read-board', 'read-diff', 'board-tool-read', 'register-push'],
      expiresAt: null,
    });
    const rosterWriteCall = writeFileSyncSpy.mock.calls.find(([filePath]) => (filePath as string).includes('mobile-bridge-roster.json'));
    if (!rosterWriteCall) throw new Error('test setup: the legacy roster entry was not persisted');
    const rosterJson = rosterWriteCall[1] as string;
    existsSyncSpy.mockImplementation((filePath: string) => filePath.includes('mobile-bridge-identity.json') || filePath.includes('mobile-bridge-roster.json'));
    readFileSyncSpy.mockImplementation((filePath: string) => (filePath.includes('mobile-bridge-roster.json') ? rosterJson : identityJson));

    service.attachContext({ sessionManager: new EventEmitter(), boardEvents: { emitBoardChanged: vi.fn() } } as never);

    // Re-point the mock at whatever the migration itself just wrote -
    // otherwise listDevices() below would read back the STALE pre-migration
    // roster JSON captured above, defeating the assertion either way.
    const migratedRosterWriteCall = writeFileSyncSpy.mock.calls
      .filter(([filePath]) => (filePath as string).includes('mobile-bridge-roster.json'))
      .at(-1);
    if (!migratedRosterWriteCall) throw new Error('test setup: the migration did not persist a roster update');
    readFileSyncSpy.mockImplementation((filePath: string) =>
      filePath.includes('mobile-bridge-roster.json') ? (migratedRosterWriteCall[1] as string) : identityJson,
    );

    const devices = service.listDevices();
    expect(devices).toHaveLength(1);
    expect(devices[0].deviceId).toBe('legacy-device');
    expect(devices[0].capabilities).toEqual(CAPABILITY_VERBS);

    service.dispose();
  });

  it('does not re-sign a device that already holds the full ten-verb capability grant', async () => {
    const service = new MobileBridgeService({ enabled: true, relayUrl: 'wss://relay.example.com' });
    await seedServiceWithOnePairedDevice(service, {
      deviceId: 'already-full-grant-device',
      capabilities: [...CAPABILITY_VERBS],
    });

    writeFileSyncSpy.mockClear();
    service.attachContext({ sessionManager: new EventEmitter(), boardEvents: { emitBoardChanged: vi.fn() } } as never);

    // No roster write at all means migrateDevicesToFullCapabilityGrant()
    // correctly skipped this device instead of re-signing an entry that was
    // already fully granted.
    const rosterWriteCalls = writeFileSyncSpy.mock.calls.filter(([filePath]) => (filePath as string).includes('mobile-bridge-roster.json'));
    expect(rosterWriteCalls).toHaveLength(0);

    service.dispose();
  });
});

describe('MobileBridgeService.renameDevice()', () => {
  it('emits stateChanged after a successful rename', async () => {
    const service = new MobileBridgeService({ enabled: true, relayUrl: 'wss://relay.example.com' });
    const { deviceId } = await seedServiceWithOnePairedDevice(service);

    const stateChangedListener = vi.fn();
    service.on('stateChanged', stateChangedListener);
    service.renameDevice(deviceId, 'Renamed Phone');

    expect(stateChangedListener).toHaveBeenCalledTimes(1);
  });

  it('preserves pairedAt across a rename', async () => {
    const service = new MobileBridgeService({ enabled: true, relayUrl: 'wss://relay.example.com' });
    const { deviceId, identityJson } = await seedServiceWithOnePairedDevice(service);
    const originalPairedAt = service.listDevices().find((device) => device.deviceId === deviceId)?.pairedAt;
    if (!originalPairedAt) throw new Error('test setup: seeded device is missing pairedAt');

    service.renameDevice(deviceId, 'Renamed Phone');
    rewireReadsToLatestRosterWrite(identityJson);

    const renamedDevice = service.listDevices().find((device) => device.deviceId === deviceId);
    expect(renamedDevice?.displayName).toBe('Renamed Phone');
    expect(renamedDevice?.pairedAt).toBe(originalPairedAt);
  });
});

describe('MobileBridgeService.renameDevice() sanitizes the renderer-supplied name', () => {
  // Same clamp/filter pairing-service.test.ts pins for the phone-supplied
  // name at pairing time; a rename lands in the exact same signed roster
  // field, so it must not be an unguarded way in.
  it('clamps an overlong rename to 64 characters', async () => {
    const service = new MobileBridgeService({ enabled: true, relayUrl: 'wss://relay.example.com' });
    const { deviceId, identityJson } = await seedServiceWithOnePairedDevice(service);

    service.renameDevice(deviceId, 'a'.repeat(100));
    rewireReadsToLatestRosterWrite(identityJson);

    const renamedDevice = service.listDevices().find((device) => device.deviceId === deviceId);
    expect(renamedDevice?.displayName).toBe('a'.repeat(64));
  });

  it('strips control characters from a rename', async () => {
    const service = new MobileBridgeService({ enabled: true, relayUrl: 'wss://relay.example.com' });
    const { deviceId, identityJson } = await seedServiceWithOnePairedDevice(service);
    // Built via fromCharCode rather than a literal escape in source, so this
    // file's authored text stays free of literal control bytes.
    const bellCharacter = String.fromCharCode(7);

    service.renameDevice(deviceId, `  My${bellCharacter}Phone  `);
    rewireReadsToLatestRosterWrite(identityJson);

    const renamedDevice = service.listDevices().find((device) => device.deviceId === deviceId);
    expect(renamedDevice?.displayName).toBe('MyPhone');
  });

  it('falls back to "Paired Device" for a whitespace-only rename', async () => {
    const service = new MobileBridgeService({ enabled: true, relayUrl: 'wss://relay.example.com' });
    const { deviceId, identityJson } = await seedServiceWithOnePairedDevice(service);

    service.renameDevice(deviceId, '   ');
    rewireReadsToLatestRosterWrite(identityJson);

    const renamedDevice = service.listDevices().find((device) => device.deviceId === deviceId);
    expect(renamedDevice?.displayName).toBe('Paired Device');
  });
});
