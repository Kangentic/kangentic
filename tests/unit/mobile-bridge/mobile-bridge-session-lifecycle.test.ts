/**
 * Session-lifecycle wiring added to MobileBridgeService in Phase 2:
 * wireSessionListeners(), openSessionForDevice(), disposeSession(), and the
 * roster-diff eviction loop in runSyncSessions(). None of these are new
 * *files* (they live in mobile-bridge-service.ts), so they are not caught by
 * "does this module have its own test file" - but they are new *code paths*
 * that neither existing suite drives end to end:
 *
 *  - mobile-bridge-service.test.ts covers the identity-creation invariant
 *    (getStatus/listDevices/etc never persist an identity; only
 *    startPairing() does) and reconcile()'s pairing-cancel-on-disable branch,
 *    but never opens a session, so it never reaches wireSessionListeners(),
 *    disposeSession(), or the roster-diff eviction loop.
 *  - mobile-bridge-sync-race.test.ts opens a session, but only to prove the
 *    syncInFlight reentrancy guard coalesces two overlapping opens into one
 *    BridgeSession; it never emits a message or a remoteClosed on the
 *    resulting session, and never revokes or disables afterward.
 *
 * This file closes that gap: message routing through capabilityRouter back
 * out via sendMessage(), remoteClosed's subscriptions-only teardown (session
 * stays alive for the relay's reconnect), revokeDevice()/reconcile(disable)
 * actually disposing a LIVE session (not just the "no identity yet" no-op
 * already covered), and the roster-diff eviction path that disposes a
 * session whose device fell out of the roster without going through
 * revokeDevice() at all.
 *
 * Mocking mirrors mobile-bridge-sync-race.test.ts's pattern (mock
 * electron/analytics/paths/identity/roster-store/bridge-session/transport),
 * with a mutable roster device list so the eviction test can drop a device
 * between two reconcile() calls, and a FakeBridgeSession that is a real
 * EventEmitter so tests can emit 'message' / 'remoteClosed' the same way the
 * real BridgeSession would.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'node:events';
import type { CapabilityRequestMessage, CapabilityResponseMessage, RosterDeviceEntry } from '@kangentic/protocol';

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

const fakeIdentity = {
  staticKeyPair: { publicKey: new Uint8Array(32).fill(1), secretKey: new Uint8Array(32).fill(2) },
};
const fakeDevice: RosterDeviceEntry = {
  deviceId: 'device-A',
  displayName: 'Phone A',
  staticPublicKey: new Uint8Array(32).fill(3),
  capabilities: ['read-board'],
  pairedAt: new Date(0).toISOString(),
  expiresAt: null,
};

// Mutable so the roster-diff eviction test can drop a device between two
// reconcile() calls without touching the module-level roster file at all.
let rosterDevices: RosterDeviceEntry[] = [fakeDevice];

const revokeDeviceSpy = vi.fn();
const setDeviceCapabilitiesSpy = vi.fn();

vi.mock('../../../src/main/mobile-bridge/identity', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/main/mobile-bridge/identity')>()),
  loadBridgeIdentity: () => fakeIdentity,
  loadOrCreateBridgeIdentity: () => fakeIdentity,
}));

vi.mock('../../../src/main/mobile-bridge/roster-store', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/main/mobile-bridge/roster-store')>()),
  loadRoster: () => ({ devices: rosterDevices }),
  revokeDevice: (...args: unknown[]) => revokeDeviceSpy(...args),
  setDeviceCapabilities: (...args: unknown[]) => setDeviceCapabilitiesSpy(...args),
}));

/** A real EventEmitter so tests can drive 'message' / 'remoteClosed' exactly like the real BridgeSession does. */
const createdSessions: FakeBridgeSession[] = [];
class FakeBridgeSession extends EventEmitter {
  readonly deviceId: string;
  capabilities: Set<string>;
  start = vi.fn();
  dispose = vi.fn();
  sendMessage = vi.fn();
  constructor(options: { deviceId: string; capabilities: Set<string> }) {
    super();
    this.deviceId = options.deviceId;
    this.capabilities = options.capabilities;
    createdSessions.push(this);
  }
}
vi.mock('../../../src/main/mobile-bridge/session/bridge-session', () => ({
  BridgeSession: FakeBridgeSession,
}));

const fakeTransport = {
  state: 'connected' as const,
  connect: vi.fn(async () => undefined),
  send: vi.fn(),
  close: vi.fn(),
  onFrame: vi.fn(() => () => undefined),
  onStateChange: vi.fn(() => () => undefined),
};
vi.mock('../../../src/main/mobile-bridge/transport/transport-factory', () => ({
  createTransport: vi.fn(() => fakeTransport),
}));

const { MobileBridgeService } = await import('../../../src/main/mobile-bridge/mobile-bridge-service');
type MobileBridgeServiceInstance = InstanceType<typeof MobileBridgeService>;

/** Settle every microtask queued by the fire-and-forget async chain reconcile() -> syncSessions() -> runSyncSessions() -> openSessionForDevice() kicks off. */
async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

/** Opens a session for the single-device roster and returns the FakeBridgeSession instance the service created for it. */
async function openSession(service: MobileBridgeServiceInstance): Promise<FakeBridgeSession> {
  const countBefore = createdSessions.length;
  service.attachContext({} as never);
  service.reconcile({ enabled: true, relayUrl: 'wss://relay.example.com' });
  await flushMicrotasks();
  expect(createdSessions.length).toBe(countBefore + 1);
  const session = createdSessions.at(-1);
  if (!session) throw new Error('openSession(): no FakeBridgeSession was created');
  return session;
}

beforeEach(() => {
  createdSessions.length = 0;
  rosterDevices = [fakeDevice];
  revokeDeviceSpy.mockClear();
  setDeviceCapabilitiesSpy.mockClear();
  fakeTransport.connect.mockClear();
  fakeTransport.close.mockClear();
});

describe('MobileBridgeService session-lifecycle wiring', () => {
  it('wireSessionListeners routes a capability-request message through the router and sends the response back', async () => {
    const service = new MobileBridgeService({ enabled: true, relayUrl: 'wss://relay.example.com' });
    const session = await openSession(service);

    const fakeResponse: CapabilityResponseMessage = { type: 'capability-response', requestId: 'req-1', ok: true, payload: { mocked: true } };
    // fakeDevice only grants read-board; override its real handler so this
    // test controls the response without wiring a real IpcContext.
    service.capabilityRouter.register('read-board', () => fakeResponse);

    const request: CapabilityRequestMessage = { type: 'capability-request', requestId: 'req-1', verb: 'read-board', payload: {} };
    session.emit('message', request);
    await flushMicrotasks();

    expect(session.sendMessage).toHaveBeenCalledTimes(1);
    expect(session.sendMessage).toHaveBeenCalledWith(fakeResponse);

    service.dispose();
  });

  it('ignores a non-capability-request message type (e.g. an inbound heartbeat) without dispatching or responding', async () => {
    const service = new MobileBridgeService({ enabled: true, relayUrl: 'wss://relay.example.com' });
    const session = await openSession(service);
    const dispatchSpy = vi.spyOn(service.capabilityRouter, 'dispatch');

    session.emit('message', { type: 'heartbeat' });
    await flushMicrotasks();

    expect(dispatchSpy).not.toHaveBeenCalled();
    expect(session.sendMessage).not.toHaveBeenCalled();

    service.dispose();
  });

  it('remoteClosed tears down the device live subscriptions but leaves the session itself alive for the relay reconnect', async () => {
    const service = new MobileBridgeService({ enabled: true, relayUrl: 'wss://relay.example.com' });
    const session = await openSession(service);

    // Register a live subscription the same way a real handler would (via
    // the getSubscriptions closure attachContext() wires into the router),
    // by reaching the same private accessor wireSessionListeners' teardown
    // path reads from.
    const subscriptionTeardown = vi.fn();
    (service as unknown as { getOrCreateSubscriptions(deviceId: string): { set(key: string, teardown: () => void): void } })
      .getOrCreateSubscriptions(session.deviceId)
      .set('board:proj-1', subscriptionTeardown);

    session.emit('remoteClosed');

    expect(subscriptionTeardown).toHaveBeenCalledTimes(1);
    expect(session.dispose).not.toHaveBeenCalled();
    // Session-count bookkeeping is untouched by a remote close (unlike an
    // actual revoke/eviction) - the device is still "paired".
    expect(service.getStatus().pairedDeviceCount).toBe(1);

    service.dispose();
  });

  it('revokeDevice() disposes a LIVE session, not just the no-identity no-op', async () => {
    const service = new MobileBridgeService({ enabled: true, relayUrl: 'wss://relay.example.com' });
    const session = await openSession(service);

    service.revokeDevice(session.deviceId);

    expect(revokeDeviceSpy).toHaveBeenCalledWith(fakeIdentity, session.deviceId);
    expect(session.dispose).toHaveBeenCalledTimes(1);

    service.dispose();
  });

  it('reconcile() disabling the bridge disposes a LIVE session, not just an in-progress pairing', async () => {
    const service = new MobileBridgeService({ enabled: true, relayUrl: 'wss://relay.example.com' });
    const session = await openSession(service);

    service.reconcile({ enabled: false, relayUrl: '' });

    expect(session.dispose).toHaveBeenCalledTimes(1);

    service.dispose();
  });

  it('a relay URL change while enabled disposes the old session before syncSessions reopens against the new relay', async () => {
    const service = new MobileBridgeService({ enabled: true, relayUrl: 'wss://relay.example.com' });
    const firstSession = await openSession(service);

    service.reconcile({ enabled: true, relayUrl: 'wss://relay2.example.com' });
    await flushMicrotasks();

    expect(firstSession.dispose).toHaveBeenCalledTimes(1);
    // A fresh session was opened against the new relay for the same device.
    expect(createdSessions.length).toBe(2);
    expect(createdSessions[1]).not.toBe(firstSession);
    expect(service.getStatus().pairedDeviceCount).toBe(1);

    service.dispose();
  });

  it('runSyncSessions evicts a session whose device fell out of the roster, without going through revokeDevice()', async () => {
    const service = new MobileBridgeService({ enabled: true, relayUrl: 'wss://relay.example.com' });
    const session = await openSession(service);

    // Device revoked out-of-band (e.g. from another process) - the roster
    // file itself now omits it, but nobody called service.revokeDevice().
    rosterDevices = [];
    service.reconcile({ enabled: true, relayUrl: 'wss://relay.example.com' });
    await flushMicrotasks();

    expect(session.dispose).toHaveBeenCalledTimes(1);
    expect(revokeDeviceSpy).not.toHaveBeenCalled();
    expect(service.getStatus().pairedDeviceCount).toBe(0);

    service.dispose();
  });
});
