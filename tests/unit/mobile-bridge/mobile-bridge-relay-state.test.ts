/**
 * Unit tests for MobileBridgeService's relay-state aggregation, added by the
 * configurable-relay-URL diff:
 *
 *  - aggregateRelayState()'s precedence (connected > connecting > reconnecting
 *    > closed, 'idle' only when there are no sessions at all), and its
 *    documented exclusion of the ephemeral pairing transport.
 *  - scheduleRelayStateEmit()'s THROTTLE semantics for the 'stateChanged'
 *    notification: a burst of changes within one window coalesces to one
 *    emission, an unchanged aggregate never re-emits, and a mid-window flap
 *    does not push the emission further out (which would make it a debounce).
 *
 * Neither path is reached by mobile-bridge-service.test.ts (which never opens
 * a session) nor mobile-bridge-session-lifecycle.test.ts (whose FakeBridgeSession
 * has no transportState and never emits 'transportState'). BridgeSession is
 * faked here as a real EventEmitter with a settable `transportState` and a
 * `setTransportState()` helper that updates the property THEN emits, mirroring
 * the "emit before the branch" ordering pinned separately in
 * bridge-session.test.ts. This test exercises the SERVICE's aggregation and
 * throttle only; the session's own emit-ordering guarantee is out of scope
 * here.
 *
 * Mocking mirrors mobile-bridge-session-lifecycle.test.ts's pattern (mock
 * electron/analytics/paths/identity/roster-store/bridge-session/transport),
 * with a two-device roster so the precedence chain can be driven directly by
 * setting each session's transportState independently.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import type { RosterDeviceEntry, TransportState } from '@kangentic/protocol';

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
  masterSigningKeyPair: { publicKey: new Uint8Array(32).fill(9), secretKey: new Uint8Array(32).fill(8) },
  createdAt: new Date(0).toISOString(),
};

function rosterDevice(deviceId: string, fillByte: number): RosterDeviceEntry {
  return {
    deviceId,
    displayName: deviceId,
    staticPublicKey: new Uint8Array(32).fill(fillByte),
    capabilities: ['read-board'],
    pairedAt: new Date(0).toISOString(),
    expiresAt: null,
    signature: new Uint8Array(64),
  };
}

const deviceA = rosterDevice('device-A', 3);
const deviceB = rosterDevice('device-B', 4);

// Mutable so individual tests can run with either a two-device roster
// (precedence tests) or a one-device roster (throttle tests).
let rosterDevices: RosterDeviceEntry[] = [deviceA, deviceB];

vi.mock('../../../src/main/mobile-bridge/identity', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/main/mobile-bridge/identity')>()),
  loadBridgeIdentity: () => fakeIdentity,
  loadOrCreateBridgeIdentity: () => fakeIdentity,
}));

// revokeDevice/setDeviceCapabilities are mocked as no-op spies (not passed
// through to the real implementation, which touches real fs) because the
// Fix C regression test below calls service.revokeDevice() directly.
const revokeDeviceInRosterSpy = vi.fn();
const setDeviceCapabilitiesInRosterSpy = vi.fn();
vi.mock('../../../src/main/mobile-bridge/roster-store', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/main/mobile-bridge/roster-store')>()),
  loadRoster: () => ({ devices: rosterDevices }),
  revokeDevice: (...args: unknown[]) => revokeDeviceInRosterSpy(...args),
  setDeviceCapabilities: (...args: unknown[]) => setDeviceCapabilitiesInRosterSpy(...args),
}));

const createdSessions: FakeBridgeSession[] = [];
class FakeBridgeSession extends EventEmitter {
  readonly deviceId: string;
  transportState: TransportState = 'connecting';
  start = vi.fn();
  dispose = vi.fn();
  sendMessage = vi.fn();
  constructor(options: { deviceId: string }) {
    super();
    this.deviceId = options.deviceId;
    createdSessions.push(this);
  }
  /**
   * Mirrors bridge-session.ts's onTransportState(): updates the value the
   * transportState getter reads, then emits 'transportState' - the same
   * order the real session uses so the service's aggregate always reflects
   * the newly-set value by the time its listener runs.
   */
  setTransportState(state: TransportState): void {
    this.transportState = state;
    this.emit('transportState', state);
  }
}
vi.mock('../../../src/main/mobile-bridge/session/bridge-session', () => ({
  BridgeSession: FakeBridgeSession,
}));

vi.mock('../../../src/main/mobile-bridge/transport/transport-factory', () => ({
  // A fresh object per call: openSessionForDevice() and startPairing() must
  // never observe each other's transport, since the pairing-exclusion test
  // needs the pairing ceremony's transport to be provably distinct from any
  // roster session's transport.
  createTransport: vi.fn(() => ({
    state: 'connected' as TransportState,
    connect: vi.fn(async () => undefined),
    send: vi.fn(),
    close: vi.fn(),
    onFrame: vi.fn(() => () => undefined),
    onStateChange: vi.fn(() => () => undefined),
  })),
}));

const { MobileBridgeService } = await import('../../../src/main/mobile-bridge/mobile-bridge-service');
type MobileBridgeServiceInstance = InstanceType<typeof MobileBridgeService>;

/** Settle the microtask chain reconcile() -> syncSessions() -> runSyncSessions() -> openSessionForDevice() kicks off. */
async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

/** Opens one BridgeSession per roster device and returns them keyed by deviceId. */
async function openSessions(service: MobileBridgeServiceInstance): Promise<Map<string, FakeBridgeSession>> {
  service.attachContext({ sessionManager: new EventEmitter(), boardEvents: { emitBoardChanged: vi.fn() } } as never);
  service.reconcile({ enabled: true, relayUrl: 'wss://relay.example.com' });
  await flushMicrotasks();
  const byDeviceId = new Map<string, FakeBridgeSession>();
  for (const session of createdSessions) byDeviceId.set(session.deviceId, session);
  return byDeviceId;
}

beforeEach(() => {
  createdSessions.length = 0;
  rosterDevices = [deviceA, deviceB];
});

describe('MobileBridgeService.getStatus().relayState precedence', () => {
  it('reports "connected" when at least one session is connected, regardless of the others', async () => {
    const service = new MobileBridgeService({ enabled: true, relayUrl: 'wss://relay.example.com' });
    const sessions = await openSessions(service);
    sessions.get('device-A')?.setTransportState('connecting');
    sessions.get('device-B')?.setTransportState('connected');

    expect(service.getStatus().relayState).toBe('connected');

    service.dispose();
  });

  it('reports "connecting" when nothing is connected but something is connecting', async () => {
    const service = new MobileBridgeService({ enabled: true, relayUrl: 'wss://relay.example.com' });
    const sessions = await openSessions(service);
    sessions.get('device-A')?.setTransportState('reconnecting');
    sessions.get('device-B')?.setTransportState('connecting');

    expect(service.getStatus().relayState).toBe('connecting');

    service.dispose();
  });

  it('reports "reconnecting" when nothing is connected or connecting but something is reconnecting', async () => {
    const service = new MobileBridgeService({ enabled: true, relayUrl: 'wss://relay.example.com' });
    const sessions = await openSessions(service);
    sessions.get('device-A')?.setTransportState('closed');
    sessions.get('device-B')?.setTransportState('reconnecting');

    expect(service.getStatus().relayState).toBe('reconnecting');

    service.dispose();
  });

  it('reports "closed" only once every session is closed', async () => {
    const service = new MobileBridgeService({ enabled: true, relayUrl: 'wss://relay.example.com' });
    const sessions = await openSessions(service);
    sessions.get('device-A')?.setTransportState('closed');
    sessions.get('device-B')?.setTransportState('closed');

    expect(service.getStatus().relayState).toBe('closed');

    service.dispose();
  });

  it('excludes the ephemeral pairing transport: an active pairing ceremony does not move the aggregate off the roster sessions state', async () => {
    const service = new MobileBridgeService({ enabled: true, relayUrl: 'wss://relay.example.com' });
    const sessions = await openSessions(service);
    sessions.get('device-A')?.setTransportState('closed');
    sessions.get('device-B')?.setTransportState('closed');
    expect(service.getStatus().relayState).toBe('closed');

    // startPairing() dials a brand-new, distinct 'connected' transport for
    // the ceremony (see the transport-factory mock above) - it is never
    // inserted into `this.sessions`, so the aggregate must stay 'closed'
    // rather than flip to 'connected' for the duration of the pairing.
    await service.startPairing();

    expect(service.getStatus().relayState).toBe('closed');

    service.dispose();
  });
});

describe('MobileBridgeService.scheduleRelayStateEmit() throttle', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('coalesces a burst of transport-state changes within one window into a single stateChanged emission', async () => {
    rosterDevices = [deviceA];
    const service = new MobileBridgeService({ enabled: true, relayUrl: 'wss://relay.example.com' });
    const sessions = await openSessions(service);
    const session = sessions.get('device-A');
    if (!session) throw new Error('device-A session was not opened');
    const stateChanged = vi.fn();
    service.on('stateChanged', stateChanged);

    session.setTransportState('connecting');
    session.setTransportState('reconnecting');
    session.setTransportState('connecting');
    // All three flaps land inside one window: not even the first check has
    // run yet, so no emission has fired.
    expect(stateChanged).not.toHaveBeenCalled();

    // RELAY_STATE_EMIT_WINDOW_MS mirrors the private constant of the same
    // name in mobile-bridge-service.ts (not exported, so re-stated here).
    await vi.advanceTimersByTimeAsync(500);

    expect(stateChanged).toHaveBeenCalledTimes(1);
    expect(service.getStatus().relayState).toBe('connecting');

    service.dispose();
  });

  it('does not emit again when the aggregate has not actually changed', async () => {
    rosterDevices = [deviceA];
    const service = new MobileBridgeService({ enabled: true, relayUrl: 'wss://relay.example.com' });
    const sessions = await openSessions(service);
    const session = sessions.get('device-A');
    if (!session) throw new Error('device-A session was not opened');

    session.setTransportState('connecting');
    await vi.advanceTimersByTimeAsync(500);

    const stateChanged = vi.fn();
    service.on('stateChanged', stateChanged);
    session.setTransportState('connecting'); // Same value: no real change.
    await vi.advanceTimersByTimeAsync(500);

    expect(stateChanged).not.toHaveBeenCalled();

    service.dispose();
  });

  it('throttles rather than debounces: a flap partway through the window does not push the emission further out', async () => {
    rosterDevices = [deviceA];
    const service = new MobileBridgeService({ enabled: true, relayUrl: 'wss://relay.example.com' });
    const sessions = await openSessions(service);
    const session = sessions.get('device-A');
    if (!session) throw new Error('device-A session was not opened');
    const stateChanged = vi.fn();
    service.on('stateChanged', stateChanged);

    session.setTransportState('connecting');
    await vi.advanceTimersByTimeAsync(300);
    expect(stateChanged).not.toHaveBeenCalled();

    // A debounce implementation would reset the window here, pushing the
    // emission out to t=800ms from the FIRST change; the throttle must not,
    // so it still fires within 200ms more (t=500ms from the first change).
    session.setTransportState('reconnecting');
    await vi.advanceTimersByTimeAsync(200);

    expect(stateChanged).toHaveBeenCalledTimes(1);

    service.dispose();
  });
});

describe('MobileBridgeService.emitStateChanged() rebaselines the throttle on every direct emission', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('a later real transition still emits after revokeDevice()\'s direct emit changed the aggregate outside the throttle', async () => {
    // Pins the concrete failure emitStateChanged() fixes: revokeDevice(),
    // setDeviceCapabilities(), the pairing 'confirmed' handler, and
    // dev-quick-pair's onRosterChanged all emit 'stateChanged' directly,
    // bypassing scheduleRelayStateEmit()'s timer entirely. If any of those
    // paths does not ALSO rebaseline lastEmittedRelayState (the bug this
    // guards), the throttle's next real transition gets compared against a
    // stale baseline and is silently swallowed.
    rosterDevices = [deviceA];
    const service = new MobileBridgeService({ enabled: true, relayUrl: 'wss://relay.example.com' });
    const sessions = await openSessions(service);
    const sessionA = sessions.get('device-A');
    if (!sessionA) throw new Error('device-A session was not opened');

    // Baseline: A connects, the throttle's window elapses, and 'connected'
    // is emitted (and captured as lastEmittedRelayState) through the normal
    // scheduleRelayStateEmit() path.
    sessionA.setTransportState('connected');
    await vi.advanceTimersByTimeAsync(500);
    expect(service.getStatus().relayState).toBe('connected');

    // Direct-emit path: revokeDevice() disposes A's session (no sessions
    // remain, so the aggregate is now 'idle') and emits 'stateChanged'
    // WITHOUT ever going through scheduleRelayStateEmit()'s timer.
    service.revokeDevice('device-A');
    expect(service.getStatus().relayState).toBe('idle');

    // Pair device B: add it to the roster and let syncSessions() open its
    // session, mirroring what a completed pairing ceremony's 'confirmed'
    // handler does to the roster/sessions map. The ceremony's own Noise
    // handshake is out of scope here; only the emitStateChanged()
    // rebaseline is under test.
    rosterDevices = [deviceB];
    service.reconcile({ enabled: true, relayUrl: 'wss://relay.example.com' });
    await flushMicrotasks();
    const sessionB = createdSessions.find((session) => session.deviceId === 'device-B');
    if (!sessionB) throw new Error('device-B session was not opened');

    const stateChanged = vi.fn();
    service.on('stateChanged', stateChanged);

    // B reaches 'connected': the aggregate is 'connected' again - the SAME
    // value as the pre-revoke baseline. Before the fix, the throttle's check
    // compared this fresh 'connected' against that STALE, never-rebaselined
    // 'connected' and swallowed the emission, leaving the renderer's
    // indicator stuck forever. With the fix, revokeDevice()'s direct emit
    // rebaselined lastEmittedRelayState to 'idle', so this transition is
    // correctly recognized as a real change and emitted.
    sessionB.setTransportState('connected');
    await vi.advanceTimersByTimeAsync(500);

    expect(stateChanged).toHaveBeenCalledTimes(1);
    expect(service.getStatus().relayState).toBe('connected');

    service.dispose();
  });
});
