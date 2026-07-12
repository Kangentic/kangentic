/**
 * Reentrancy guard for MobileBridgeService.syncSessions(): reconcile() fires on
 * every config:set and pairing-confirmation calls in independently, both
 * fire-and-forget. syncSessions() awaits a real network dial per device and
 * only inserts into its `sessions` map AFTER the dial resolves, so two
 * overlapping runs could each see "no session for this device" and both open a
 * full BridgeSession + transport + re-handshake timer - orphaning one that can
 * never be disposed or revoked. The guard coalesces overlapping runs so exactly
 * one session is opened per device.
 *
 * Isolated in its own file (not mobile-bridge-service.test.ts) because it mocks
 * identity/roster/BridgeSession, which the identity-creation tests there need
 * to be real.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'node:events';

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
  capabilities: ['read-board'],
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
class FakeBridgeSession extends EventEmitter {
  readonly deviceId: string;
  start = vi.fn();
  dispose = vi.fn();
  sendMessage = vi.fn();
  constructor(options: { deviceId: string }) {
    super();
    this.deviceId = options.deviceId;
    bridgeSessionInstances += 1;
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
  releaseConnect = null;
  fakeTransport.connect.mockClear();
  fakeTransport.close.mockClear();
  vi.mocked(createTransport).mockClear();
});

describe('MobileBridgeService.syncSessions() reentrancy', () => {
  it('two overlapping reconciles open exactly one BridgeSession per device', async () => {
    const service = new MobileBridgeService({ enabled: true, relayUrl: 'wss://relay.example.com' });
    service.attachContext({} as never);

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
});
