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
 * out via sendMessage(), remoteClosed's full device drop (a Final is only
 * ever the phone's deliberate unpair, so roster + push registration +
 * session all go, with no goodbye echo), revokeDevice()'s goodbye-then-drop
 * ordering, reconcile(disable) actually disposing a LIVE session (not just
 * the "no identity yet" no-op already covered), and the roster-diff
 * eviction path that disposes a session whose device fell out of the
 * roster without going through revokeDevice() at all.
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
import type { CapabilityRequestMessage, CapabilityResponseMessage, RosterDeviceEntry, TransportState } from '@kangentic/protocol';
import type { MobileDeviceConnectionState } from '../../../src/shared/types';

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
  /** Mutable so a test can set the next value and then `session.emit('connectionState')`, exactly as the real BridgeSession's 'connectionState' listener reads it. */
  connectionState: MobileDeviceConnectionState = 'idle';
  /** Mutable, same reasoning as connectionState above - read by the same listener for the "(transport <transportState>)" suffix. */
  transportState: TransportState = 'idle';
  start = vi.fn();
  dispose = vi.fn();
  sendMessage = vi.fn();
  sendGoodbye = vi.fn();
  resumeFromSleep = vi.fn(() => 'redialed' as const);
  probePresenceNow = vi.fn(() => true);
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

const { MobileBridgeService, resetForcedRedialTelemetryForTests } = await import('../../../src/main/mobile-bridge/mobile-bridge-service');
const { trackEvent } = await import('../../../src/main/analytics/analytics');
const { createTransport } = await import('../../../src/main/mobile-bridge/transport/transport-factory');
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
  // attachContext also starts the SessionLifecycleBoardFeed, which
  // subscribes to sessionManager and pushes onto boardEvents - a real
  // EventEmitter and a stub bus keep that wiring inert here. It also
  // registers the resting park's MobileTerminalProbe on the session manager,
  // so the fake needs the registration seam (the probe itself stays unused:
  // no test here spawns a PTY).
  const fakeSessionManager = Object.assign(new EventEmitter(), { setMobileTerminalProbe: vi.fn() });
  service.attachContext({ sessionManager: fakeSessionManager, boardEvents: { emitBoardChanged: vi.fn() } } as never);
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
  vi.mocked(createTransport).mockClear();
  // The forced-redial analytics gate is module state (once per reason per
  // app run), so a case that asserts the event must start from a clear gate
  // whatever ran before it.
  resetForcedRedialTelemetryForTests();
  vi.mocked(trackEvent).mockClear();
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

  it('logs a session\'s unsupportedVerb edge without routing it', async () => {
    const service = new MobileBridgeService({ enabled: true, relayUrl: 'wss://relay.example.com' });
    const session = await openSession(service);
    const dispatchSpy = vi.spyOn(service.capabilityRouter, 'dispatch');
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    // The refusal itself is sent by the real BridgeSession before it emits
    // this edge (pinned in bridge-session.test.ts); this fake never reaches
    // that path, so the only thing to assert on the service is that the router
    // stays out of it and the desktop log gets its trace.
    session.emit('unsupportedVerb', { requestId: 'r-1', verb: 'time-travel' });
    await flushMicrotasks();

    expect(dispatchSpy).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0][0]).toMatch(/"time-travel"/);

    warnSpy.mockRestore();
    service.dispose();
  });

  it('resumeAllSessions and probeAllPresence fan out to every open session and log what actually happened', async () => {
    const service = new MobileBridgeService({ enabled: true, relayUrl: 'wss://relay.example.com' });
    const session = await openSession(service);
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const logLines = (): string[] => logSpy.mock.calls.map((call) => String(call[0]));

    service.resumeAllSessions('system resumed from sleep');
    expect(session.resumeFromSleep).toHaveBeenCalledTimes(1);
    expect(session.resumeFromSleep).toHaveBeenCalledWith('system resumed from sleep');
    expect(logLines().some((line) => line.includes('system resumed from sleep: redialed 1, probed 0, skipped 0 of 1'))).toBe(true);

    service.probeAllPresence('screen unlocked');
    expect(session.probePresenceNow).toHaveBeenCalledTimes(1);
    expect(logLines().some((line) => line.includes('screen unlocked: probed 1 of 1'))).toBe(true);

    // A parked slot whose initiation is still buffered sends nothing, and a
    // quiet unlock must not write a line saying it probed.
    session.probePresenceNow.mockReturnValueOnce(false);
    logSpy.mockClear();
    service.probeAllPresence('screen unlocked');
    expect(logLines()).toEqual([]);

    logSpy.mockRestore();
    service.dispose();
  });

  it('logs the lifecycle edges the session emits, throttling a rejected-frame burst to one line per window', async () => {
    vi.useFakeTimers();
    try {
      const service = new MobileBridgeService({ enabled: true, relayUrl: 'wss://relay.example.com' });
      const session = await openSession(service);
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      const warnLines = (): string[] => warnSpy.mock.calls.map((call) => String(call[0]));

      session.emit('handshakeFailed', new Error('KK handshake did not complete'));
      expect(warnLines().filter((line) => line.includes('handshake failed: KK handshake did not complete'))).toHaveLength(1);

      // The reason arrives as a closed enum and is logged as prose; the
      // analytics count is gated to once per reason per app run, so the
      // second emission logs again but counts nothing.
      session.emit('forcedRedial', 'paired-silent');
      session.emit('forcedRedial', 'paired-silent');
      expect(warnLines().filter((line) => line.includes('forcing a redial: peer went silent on a paired socket'))).toHaveLength(2);
      const forcedRedialEvents = vi.mocked(trackEvent).mock.calls.filter(([name]) => name === 'mobile_bridge_forced_redial');
      expect(forcedRedialEvents).toEqual([['mobile_bridge_forced_redial', { reason: 'paired-silent' }]]);

      // A garbage burst from the blind relay: three frames, one line.
      session.emit('frameRejected', new Error('bad tag'));
      session.emit('frameRejected', new Error('bad tag'));
      session.emit('frameRejected', new Error('bad tag'));
      expect(warnLines().filter((line) => line.includes('rejected a frame: bad tag'))).toHaveLength(1);

      // The next line carries what the last one swallowed, however long the
      // quiet gap after the window was: the count is "since the previous
      // line", never "in the last 10 s".
      vi.advanceTimersByTime(300_000);
      session.emit('frameRejected', new Error('bad tag'));
      const rejectedLines = warnLines().filter((line) => line.includes('rejected a frame: bad tag'));
      expect(rejectedLines).toHaveLength(2);
      expect(rejectedLines[1]).toContain('(2 more since the previous line)');

      warnSpy.mockRestore();
      service.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it('an inbound Final drops the device outright - roster, session, subscriptions - with no goodbye echo', async () => {
    const service = new MobileBridgeService({ enabled: true, relayUrl: 'wss://relay.example.com' });
    const session = await openSession(service);
    // The mocked roster reads from rosterDevices, so the mocked revoke has
    // to mutate it for pairedDeviceCount to reflect the drop.
    revokeDeviceSpy.mockImplementation(() => {
      rosterDevices = [];
    });
    const stateChanged = vi.fn();
    service.on('stateChanged', stateChanged);

    // Register a live subscription the same way a real handler would (via
    // the getSubscriptions closure attachContext() wires into the router),
    // by reaching the same private accessor wireSessionListeners' teardown
    // path reads from.
    const subscriptionTeardown = vi.fn();
    (service as unknown as { getOrCreateSubscriptions(deviceId: string): { set(key: string, teardown: () => void): void } })
      .getOrCreateSubscriptions(session.deviceId)
      .set('board:proj-1', subscriptionTeardown);

    session.emit('remoteClosed');
    await flushMicrotasks();

    // A Final is only ever the phone's deliberate unpair, so the device is
    // gone entirely, not merely quiet until the next reconnect.
    expect(subscriptionTeardown).toHaveBeenCalledTimes(1);
    expect(revokeDeviceSpy).toHaveBeenCalledWith(fakeIdentity, session.deviceId);
    expect(session.dispose).toHaveBeenCalledTimes(1);
    expect(service.getStatus().pairedDeviceCount).toBe(0);
    expect(stateChanged).toHaveBeenCalled();
    // No goodbye echo at a peer that already left.
    expect(session.sendGoodbye).not.toHaveBeenCalled();

    service.dispose();
  });

  it('a second remoteClosed for the same device is a no-op', async () => {
    const service = new MobileBridgeService({ enabled: true, relayUrl: 'wss://relay.example.com' });
    const session = await openSession(service);

    session.emit('remoteClosed');
    session.emit('remoteClosed');
    await flushMicrotasks();

    expect(revokeDeviceSpy).toHaveBeenCalledTimes(1);
    expect(session.dispose).toHaveBeenCalledTimes(1);

    service.dispose();
  });

  it('a stale remoteClosed from a replaced session does not drop the new session', async () => {
    const service = new MobileBridgeService({ enabled: true, relayUrl: 'wss://relay.example.com' });
    const firstSession = await openSession(service);

    // A relay URL change replaces the device's session with a fresh one.
    service.reconcile({ enabled: true, relayUrl: 'wss://relay2.example.com' });
    await flushMicrotasks();
    const secondSession = createdSessions.at(-1);
    if (!secondSession || secondSession === firstSession) throw new Error('expected a replacement session');

    // The sessions-map guard is what stops a Final from the superseded
    // session tearing down the freshly opened one.
    firstSession.emit('remoteClosed');
    await flushMicrotasks();

    expect(revokeDeviceSpy).not.toHaveBeenCalled();
    expect(secondSession.dispose).not.toHaveBeenCalled();

    service.dispose();
  });

  it('revokeDevice() on an offline (session-less) device drops it without throwing', () => {
    const service = new MobileBridgeService({ enabled: true, relayUrl: 'wss://relay.example.com' });

    expect(() => service.revokeDevice('device-A')).not.toThrow();

    expect(revokeDeviceSpy).toHaveBeenCalledWith(fakeIdentity, 'device-A');

    service.dispose();
  });

  /**
   * The SILENT departure: backgrounding, a lost network, or an OS kill sends
   * no Final frame, so 'remoteClosed' never fires - the bridge session
   * concludes absence from its spent probe budget and emits 'peerAbsent'
   * instead. The subscriptions are just as dead, and before this teardown
   * existed they outlived the phone: the terminal-stream marker kept the
   * resting park armed and the bottom panel's tab dropped for a device the
   * desktop itself showed as offline.
   */
  it('peerAbsent (silent departure) tears down the device subscriptions like remoteClosed', async () => {
    const service = new MobileBridgeService({ enabled: true, relayUrl: 'wss://relay.example.com' });
    const session = await openSession(service);

    const subscriptionTeardown = vi.fn();
    (service as unknown as { getOrCreateSubscriptions(deviceId: string): { set(key: string, teardown: () => void): void } })
      .getOrCreateSubscriptions(session.deviceId)
      .set('stream-terminal:sess-1', subscriptionTeardown);

    session.emit('peerAbsent');

    expect(subscriptionTeardown).toHaveBeenCalledTimes(1);
    expect(session.dispose).not.toHaveBeenCalled();
    expect(service.getStatus().pairedDeviceCount).toBe(1);

    service.dispose();
  });

  it('revokeDevice() says the goodbye exactly once, BEFORE disposing the live session', async () => {
    const service = new MobileBridgeService({ enabled: true, relayUrl: 'wss://relay.example.com' });
    const session = await openSession(service);

    service.revokeDevice(session.deviceId);

    // Ordering is the feature: dispose() closes the transport, after which
    // no frame can leave, so the goodbye must have gone out first.
    expect(session.sendGoodbye).toHaveBeenCalledTimes(1);
    expect(session.dispose).toHaveBeenCalledTimes(1);
    expect(session.sendGoodbye.mock.invocationCallOrder[0]).toBeLessThan(session.dispose.mock.invocationCallOrder[0]);
    expect(revokeDeviceSpy).toHaveBeenCalledWith(fakeIdentity, session.deviceId);

    service.dispose();
  });

  it('service dispose() (the quit path) never sends a goodbye', async () => {
    const service = new MobileBridgeService({ enabled: true, relayUrl: 'wss://relay.example.com' });
    const session = await openSession(service);

    service.dispose();

    expect(session.dispose).toHaveBeenCalledTimes(1);
    // Quit, disable, and shutdown all stay silent by contract: a Final only
    // ever means deliberate unpair, so an ordinary desktop quit must never
    // read as one on the phone.
    expect(session.sendGoodbye).not.toHaveBeenCalled();
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

  it('logs a connectionState transition once per actual change, splits warn versus log by the target state, and formats the line as documented', async () => {
    const service = new MobileBridgeService({ enabled: true, relayUrl: 'wss://relay.example.com' });
    const session = await openSession(service);
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const label = session.deviceId.slice(0, 8);

    // A change into 'connecting' (log-level), then a REPEAT emission with no
    // state change: only the first emission may write a line.
    session.connectionState = 'connecting';
    session.transportState = 'connecting';
    session.emit('connectionState');
    session.emit('connectionState');
    expect(logSpy.mock.calls).toHaveLength(1);
    expect(logSpy.mock.calls[0][0]).toBe(`[mobile-bridge] device ${label} idle -> connecting (transport connecting)`);

    // connected: also log-level.
    session.connectionState = 'connected';
    session.transportState = 'connected';
    session.emit('connectionState');
    expect(logSpy.mock.calls).toHaveLength(2);
    expect(logSpy.mock.calls[1][0]).toBe(`[mobile-bridge] device ${label} connecting -> connected (transport connected)`);

    // reconnecting, offline, closed: all warn-level, never log-level.
    session.connectionState = 'reconnecting';
    session.transportState = 'reconnecting';
    session.emit('connectionState');
    session.connectionState = 'offline';
    session.emit('connectionState');
    session.connectionState = 'closed';
    session.transportState = 'closed';
    session.emit('connectionState');

    expect(warnSpy.mock.calls.map((call) => String(call[0]))).toEqual([
      `[mobile-bridge] device ${label} connected -> reconnecting (transport reconnecting)`,
      `[mobile-bridge] device ${label} reconnecting -> offline (transport reconnecting)`,
      `[mobile-bridge] device ${label} offline -> closed (transport closed)`,
    ]);
    // The three warn-level transitions above never also wrote a log-level line.
    expect(logSpy.mock.calls).toHaveLength(2);

    warnSpy.mockRestore();
    logSpy.mockRestore();
    service.dispose();
  });

  it('connectionStateSince is null before a session opens, set at wiring time, bumped only on an actual state change, and cleared when the session is dropped', async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
      const service = new MobileBridgeService({ enabled: true, relayUrl: 'wss://relay.example.com' });

      // No session has opened yet for the roster device.
      expect(service.listDevices()[0]).toMatchObject({
        deviceId: fakeDevice.deviceId,
        connectionState: 'idle',
        connectionStateSince: null,
      });

      const session = await openSession(service);
      const openedAt = service.listDevices()[0].connectionStateSince;
      expect(openedAt).toBe('2026-01-01T00:00:00.000Z');

      // An emission that does not change the reported state leaves the
      // timestamp untouched, however much time has passed.
      vi.setSystemTime(new Date('2026-01-01T00:00:05.000Z'));
      session.emit('connectionState');
      expect(service.listDevices()[0].connectionStateSince).toBe(openedAt);

      // A real change bumps it to the newer timestamp.
      vi.setSystemTime(new Date('2026-01-01T00:00:10.000Z'));
      session.connectionState = 'connected';
      session.transportState = 'connected';
      session.emit('connectionState');
      const changedAt = service.listDevices()[0].connectionStateSince;
      expect(changedAt).toBe('2026-01-01T00:00:10.000Z');
      expect(changedAt).not.toBe(openedAt);

      // Dropping the live session clears the per-device timestamp while the
      // roster entry survives - revokeDevice() reaches disposeSession()
      // (which deletes the connectionStateSinceByDevice entry) through
      // dropDevice(). Pin the mocked revokeDeviceInRoster to a no-op
      // explicitly (rather than relying on beforeEach's mockClear(), which
      // does not reset an implementation an earlier test installed via
      // mockImplementation) so rosterDevices keeps the device regardless of
      // run order.
      revokeDeviceSpy.mockImplementation(() => undefined);
      service.revokeDevice(session.deviceId);
      expect(rosterDevices).toEqual([fakeDevice]);
      expect(service.listDevices()[0]).toMatchObject({
        deviceId: fakeDevice.deviceId,
        connectionState: 'idle',
        connectionStateSince: null,
      });

      service.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it('resumeAllSessions() is a no-op that writes nothing when there is no open session', () => {
    const service = new MobileBridgeService({ enabled: true, relayUrl: 'wss://relay.example.com' });
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    service.resumeAllSessions('x');

    expect(logSpy).not.toHaveBeenCalled();
    expect(logSpy.mock.calls.some((call) => String(call[0]).includes('redialed'))).toBe(false);

    logSpy.mockRestore();
    service.dispose();
  });

  it('opens a roster session with logLabel truncated to the first 8 characters of the device id', async () => {
    const service = new MobileBridgeService({ enabled: true, relayUrl: 'wss://relay.example.com' });
    await openSession(service);

    expect(vi.mocked(createTransport)).toHaveBeenCalledWith(expect.objectContaining({ logLabel: fakeDevice.deviceId.slice(0, 8) }));

    service.dispose();
  });
});
