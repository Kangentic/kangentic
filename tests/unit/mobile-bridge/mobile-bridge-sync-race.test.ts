/**
 * Reentrancy guard for MobileBridgeService.syncSessions(): reconcile() fires on
 * every config:set and pairing-confirmation calls in independently, both
 * fire-and-forget. Session insertion is synchronous now (openSessionForDevice
 * inserts before its fire-and-forget dial), which closes the historical
 * duplicate-session race on its own; this test keeps the coalescing guard
 * honest anyway - overlapping requests must serialize into one roster diff
 * plus at most one queued follow-up, opening exactly one session per device.
 *
 * Isolated in its own file (not mobile-bridge-service.test.ts) because it mocks
 * identity/roster/BridgeSession, which the identity-creation tests there need
 * to be real.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { CAPABILITY_VERBS } from '@kangentic/protocol';

vi.mock('electron', () => ({
  app: { isReady: () => true, whenReady: () => Promise.resolve() },
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (plaintext: string) => Buffer.from(`encrypted:${plaintext}`, 'utf8'),
    decryptString: (buffer: Buffer) => buffer.toString('utf8').replace(/^encrypted:/, ''),
    getSelectedStorageBackend: () => 'keychain',
  },
  ipcMain: { handle: vi.fn(), on: vi.fn(), removeHandler: vi.fn() },
}));

vi.mock('../../../src/main/analytics/analytics', () => ({
  trackEvent: vi.fn(),
  sanitizeErrorMessage: (message: string) => message,
}));

vi.mock('../../../src/main/config/paths', () => ({
  PATHS: { configDir: '/mock/config' },
}));

// A single fake identity + one-device roster: enough for syncSessions to want
// to open exactly one BridgeSession.
const fakeIdentity = {
  staticKeyPair: { publicKey: new Uint8Array(32).fill(1), secretKey: new Uint8Array(32).fill(2) },
};
const fakeDevice = {
  deviceId: 'device-A',
  displayName: 'Phone A',
  staticPublicKey: new Uint8Array(32).fill(3),
  // Full grant, not an arbitrary subset: attachContext() now runs a
  // one-shot migration that upgrades any under-provisioned device via the
  // REAL roster-store.setDeviceCapabilities (this file only stubs
  // loadRoster, not the sign/save write path), so a partial capability set
  // here would crash on the fake identity's missing masterSigningKeyPair.
  // What this file actually exercises (session-open reentrancy) does not
  // depend on the capability set.
  capabilities: [...CAPABILITY_VERBS],
};

vi.mock('../../../src/main/mobile-bridge/identity', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/main/mobile-bridge/identity')>()),
  loadBridgeIdentity: () => fakeIdentity,
  loadOrCreateBridgeIdentity: () => fakeIdentity,
}));

vi.mock('../../../src/main/mobile-bridge/roster-store', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/main/mobile-bridge/roster-store')>()),
  loadRoster: () => ({ devices: [fakeDevice] }),
}));

// Count BridgeSession instantiations - the whole point of the test.
let bridgeSessionInstances = 0;
const createdBridgeSessions: FakeBridgeSession[] = [];
class FakeBridgeSession extends EventEmitter {
  readonly deviceId: string;
  start = vi.fn();
  dispose = vi.fn();
  sendMessage = vi.fn();
  constructor(options: { deviceId: string }) {
    super();
    this.deviceId = options.deviceId;
    bridgeSessionInstances += 1;
    createdBridgeSessions.push(this);
  }
}
vi.mock('../../../src/main/mobile-bridge/session/bridge-session', () => ({
  BridgeSession: FakeBridgeSession,
}));

// A transport whose connect() stays pending until we release it, opening the
// race window between reconcile() #1 (suspended on the dial) and #2.
let releaseConnect: (() => void) | null = null;
const fakeTransport = {
  state: 'connecting' as const,
  connect: vi.fn(() => new Promise<void>((resolve) => { releaseConnect = resolve; })),
  send: vi.fn(),
  close: vi.fn(),
  onFrame: vi.fn(() => () => undefined),
  onStateChange: vi.fn(() => () => undefined),
};
vi.mock('../../../src/main/mobile-bridge/transport/transport-factory', () => ({
  createTransport: vi.fn(() => fakeTransport),
}));

const { MobileBridgeService } = await import('../../../src/main/mobile-bridge/mobile-bridge-service');
const { createTransport } = await import('../../../src/main/mobile-bridge/transport/transport-factory');

beforeEach(() => {
  bridgeSessionInstances = 0;
  createdBridgeSessions.length = 0;
  releaseConnect = null;
  fakeTransport.connect.mockClear();
  fakeTransport.connect.mockImplementation(() => new Promise<void>((resolve) => { releaseConnect = resolve; }));
  fakeTransport.close.mockClear();
  vi.mocked(createTransport).mockClear();
});

describe('MobileBridgeService.syncSessions() reentrancy', () => {
  it('two overlapping reconciles open exactly one BridgeSession per device', async () => {
    const service = new MobileBridgeService({ enabled: true, relayUrl: 'wss://relay.example.com' });
    // attachContext also starts the SessionLifecycleBoardFeed, which
    // subscribes to sessionManager and pushes onto boardEvents - a real
    // EventEmitter and a stub bus keep that wiring inert here.
    service.attachContext({ sessionManager: new EventEmitter(), boardEvents: { emitBoardChanged: vi.fn() } } as never);

    // Fire two reconciles with the SAME config while the first is still
    // suspended on transport.connect(). Without the guard, both would each
    // create a BridgeSession for the same device.
    service.reconcile({ enabled: true, relayUrl: 'wss://relay.example.com' });
    service.reconcile({ enabled: true, relayUrl: 'wss://relay.example.com' });

    // The dial is still pending: exactly one open attempt is in flight.
    expect(bridgeSessionInstances).toBe(1);

    // Release the dial and let the coalesced follow-up run settle.
    releaseConnect?.();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    // Still exactly one session; the second reconcile coalesced instead of
    // opening a duplicate, orphaned session.
    expect(bridgeSessionInstances).toBe(1);
    expect(service.getStatus().pairedDeviceCount).toBe(1);

    service.dispose();
  });

  it('a failed first dial keeps the roster session alive with its transport open', async () => {
    // The desktop-launched-before-relay case: RelayClient owns recovery via
    // its capped-backoff reconnect loop, so a rejecting connect() must NOT
    // tear the session down or close the transport (the old close-and-bail
    // behavior left the bridge dead until the user toggled it).
    fakeTransport.connect.mockImplementation(() => Promise.reject(new Error('relay is not up yet')));

    const service = new MobileBridgeService({ enabled: true, relayUrl: 'wss://relay.example.com' });
    service.attachContext({ sessionManager: new EventEmitter(), boardEvents: { emitBoardChanged: vi.fn() } } as never);
    service.reconcile({ enabled: true, relayUrl: 'wss://relay.example.com' });
    await Promise.resolve();
    await Promise.resolve();

    expect(bridgeSessionInstances).toBe(1);
    expect(createdBridgeSessions[0].dispose).not.toHaveBeenCalled();
    expect(fakeTransport.close).not.toHaveBeenCalled();

    // A later sync still sees the session in the map - no duplicate opens.
    service.reconcile({ enabled: true, relayUrl: 'wss://relay.example.com' });
    await Promise.resolve();
    await Promise.resolve();
    expect(bridgeSessionInstances).toBe(1);

    service.dispose();
  });
});
