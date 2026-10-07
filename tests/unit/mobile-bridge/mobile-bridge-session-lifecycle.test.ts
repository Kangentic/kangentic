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
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import type { BrowserWindow } from 'electron';
import type { CapabilityRequestMessage, CapabilityResponseMessage, RosterDeviceEntry, TransportState } from '@kangentic/protocol';
import type { MobileDeviceConnectionState } from '../../../src/shared/types';
import { emitSpawnProgress, __resetSpawnProgressForTest } from '../../../src/main/transition-engine/spawn-progress';

vi.mock('electron', async () => {
  const { createFakeSafeStorage } = await import('../helpers/fake-safe-storage');
  return {
    app: { isReady: () => true, whenReady: () => Promise.resolve() },
    safeStorage: createFakeSafeStorage(),
    ipcMain: { handle: vi.fn(), on: vi.fn(), removeHandler: vi.fn() },
  };
});

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
  loadBridgeIdentity: async () => fakeIdentity,
  loadOrCreateBridgeIdentity: async () => fakeIdentity,
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
  /** Mutable, same reasoning as above - read by the slow-request line, which names it only when the transport still holds bytes. */
  transportBufferedBytes: number | null = null;
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
// The real module's other exports (MessageEncodeError, which the service
// matches a too-large response against) stay real; only the session is faked.
vi.mock('../../../src/main/mobile-bridge/session/bridge-session', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/main/mobile-bridge/session/bridge-session')>()),
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

// Seams for the attachContext() wiring cases at the bottom of the file. Each
// wrapper below passes straight through to the real module unless a case sets
// the matching field, so every other case in this file runs unchanged.
const attachCapture = vi.hoisted(() => ({
  /** The options attachContext() built its PushNotifier from. */
  pushNotifierOptions: null as { resolveTaskContextByTaskId: (taskId: string) => { projectId: string; taskId: string; taskTitle: string } | null } | null,
  /** The deps attachContext() registered the capability handlers with. */
  handlerDeps: null as { spawnProgressFeed: { onTaskSpawnProgressChanged: (listener: (projectId: string, taskId: string) => void) => () => void } } | null,
  /** Stands in for getProjectRepos when set: the fake repos of one project, or a throw. */
  projectRepos: null as ((projectId: string) => unknown) | null,
}));

vi.mock('../../../src/main/ipc/helpers/project-repos', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/main/ipc/helpers/project-repos')>();
  return {
    ...actual,
    getProjectRepos: (...args: Parameters<typeof actual.getProjectRepos>) => (
      attachCapture.projectRepos ? attachCapture.projectRepos(args[1] ?? '') : actual.getProjectRepos(...args)
    ),
  };
});

vi.mock('../../../src/main/mobile-bridge/push/push-notifier', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/main/mobile-bridge/push/push-notifier')>();
  class CapturingPushNotifier extends actual.PushNotifier {
    constructor(options: ConstructorParameters<typeof actual.PushNotifier>[0]) {
      super(options);
      attachCapture.pushNotifierOptions = options;
    }
  }
  return { ...actual, PushNotifier: CapturingPushNotifier };
});

vi.mock('../../../src/main/mobile-bridge/handlers', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/main/mobile-bridge/handlers')>();
  return {
    ...actual,
    registerCapabilityHandlers: (...args: Parameters<typeof actual.registerCapabilityHandlers>) => {
      attachCapture.handlerDeps = args[1];
      return actual.registerCapabilityHandlers(...args);
    },
  };
});

const { MobileBridgeService, resetForcedRedialTelemetryForTests } = await import('../../../src/main/mobile-bridge/mobile-bridge-service');
const { MessageEncodeError } = await import('../../../src/main/mobile-bridge/session/bridge-session');
const { noteRequestSpan, takeRequestSpans, resetRequestSpansForTests } = await import('../../../src/main/mobile-bridge/request-spans');
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
  // The identity and the secure-storage verdict load once, asynchronously,
  // in the warm-up attachContext() starts; runSyncSessions() waits for it too.
  await service.whenStorageReady();
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

  it('writes one slow-request warn line naming the verb, action, ids and the spans, and stays quiet under the threshold', async () => {
    const service = new MobileBridgeService({ enabled: true, relayUrl: 'wss://relay.example.com' });
    const session = await openSession(service);
    resetRequestSpansForTests();
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    // A controllable clock: the handler "takes" whatever the case sets.
    let clockMs = 0;
    const nowSpy = vi.spyOn(performance, 'now').mockImplementation(() => clockMs);
    let handlerCostMs = 0;
    service.capabilityRouter.register('read-board', (request) => {
      noteRequestSpan(session.deviceId, request.requestId, 'seed 800 ms, 120k chars');
      clockMs += handlerCostMs;
      return { type: 'capability-response', requestId: request.requestId, ok: true };
    });
    session.sendMessage.mockImplementation(() => {
      clockMs += 40;
      return 96 * 1024;
    });

    handlerCostMs = 900;
    session.emit('message', { type: 'capability-request', requestId: 'slowreq-1234', verb: 'read-board', payload: { action: 'subscribe' } });
    await flushMicrotasks();
    const slowLines = warnSpy.mock.calls.map((call) => String(call[0])).filter((line) => line.includes('slow request'));
    expect(slowLines).toEqual(['[mobile-bridge] slow request read-board/subscribe slowreq-1234 from device-A: handler 900 ms, seed 800 ms, 120k chars, send 40 ms, 96 kB frame, longest main-loop block 920 ms']);

    // Under the threshold: no line, and the span registry still let go of the
    // request (the handler above noted a span for it too).
    warnSpy.mockClear();
    handlerCostMs = 100;
    session.emit('message', { type: 'capability-request', requestId: 'fastreq-1234', verb: 'read-board', payload: {} });
    await flushMicrotasks();
    expect(warnSpy.mock.calls.some((call) => String(call[0]).includes('slow request'))).toBe(false);
    expect(takeRequestSpans(session.deviceId, 'fastreq-1234')).toEqual([]);

    nowSpy.mockRestore();
    warnSpy.mockRestore();
    service.dispose();
  });

  it('lets go of a fast request: its spans are collected and its block probe stopped, so no interval is left ticking', async () => {
    const service = new MobileBridgeService({ enabled: true, relayUrl: 'wss://relay.example.com' });
    const session = await openSession(service);
    resetRequestSpansForTests();
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    // Only the probe's interval and the clock are fake; promises still settle,
    // so the microtask flush below behaves as in every other case.
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'performance'] });
    try {
      const timersBeforeRequest = vi.getTimerCount();
      let timersDuringHandler = -1;
      service.capabilityRouter.register('read-board', (request) => {
        noteRequestSpan(session.deviceId, request.requestId, 'seed 5 ms, 1k chars');
        timersDuringHandler = vi.getTimerCount();
        return { type: 'capability-response', requestId: request.requestId, ok: true };
      });

      session.emit('message', { type: 'capability-request', requestId: 'fastreq-1234', verb: 'read-board', payload: {} });
      await flushMicrotasks();

      expect(session.sendMessage).toHaveBeenCalledTimes(1);
      // The probe was running while the handler worked, and is gone now.
      expect(timersDuringHandler).toBe(timersBeforeRequest + 1);
      expect(vi.getTimerCount()).toBe(timersBeforeRequest);
      // The span the handler noted was collected although no line was written.
      expect(takeRequestSpans(session.deviceId, 'fastreq-1234')).toEqual([]);
      expect(warnSpy.mock.calls.some((call) => String(call[0]).includes('slow request'))).toBe(false);
    } finally {
      warnSpy.mockRestore();
      resetRequestSpansForTests();
      vi.useRealTimers();
      service.dispose();
    }
  });

  it('names the bytes still buffered on the transport in the slow-request line, and only when there are any', async () => {
    const service = new MobileBridgeService({ enabled: true, relayUrl: 'wss://relay.example.com' });
    const session = await openSession(service);
    resetRequestSpansForTests();
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    let clockMs = 0;
    const nowSpy = vi.spyOn(performance, 'now').mockImplementation(() => clockMs);
    try {
      service.capabilityRouter.register('read-board', (request) => {
        clockMs += 900;
        return { type: 'capability-response', requestId: request.requestId, ok: true };
      });
      session.sendMessage.mockImplementation(() => {
        clockMs += 40;
        return 96 * 1024;
      });
      const slowLineFor = async (requestId: string): Promise<string> => {
        warnSpy.mockClear();
        session.emit('message', { type: 'capability-request', requestId, verb: 'read-board', payload: {} });
        await flushMicrotasks();
        const slowLines = warnSpy.mock.calls.map((call) => String(call[0])).filter((line) => line.includes('slow request'));
        expect(slowLines).toHaveLength(1);
        return slowLines[0];
      };

      session.transportBufferedBytes = 300 * 1024;
      expect(await slowLineFor('buffered-1')).toBe(
        '[mobile-bridge] slow request read-board buffered-1 from device-A: handler 900 ms, send 40 ms, 96 kB frame, 300 kB still buffered, longest main-loop block 920 ms',
      );

      // A few stalled bytes round up, never down to a contradictory "0 kB".
      session.transportBufferedBytes = 100;
      expect(await slowLineFor('buffered-2')).toBe(
        '[mobile-bridge] slow request read-board buffered-2 from device-A: handler 900 ms, send 40 ms, 96 kB frame, 1 kB still buffered, longest main-loop block 920 ms',
      );

      // An empty buffer, and a transport that cannot report one, add nothing.
      const lineWithoutBuffer = '[mobile-bridge] slow request read-board unbuffered-1 from device-A: handler 900 ms, send 40 ms, 96 kB frame, longest main-loop block 920 ms';
      session.transportBufferedBytes = 0;
      expect(await slowLineFor('unbuffered-1')).toBe(lineWithoutBuffer);
      session.transportBufferedBytes = null;
      expect(await slowLineFor('unbuffered-1')).toBe(lineWithoutBuffer);
    } finally {
      nowSpy.mockRestore();
      warnSpy.mockRestore();
      resetRequestSpansForTests();
      service.dispose();
    }
  });

  it('answers a response too large to encode with a short refusal on the same stream, and says so in a warn line', async () => {
    const service = new MobileBridgeService({ enabled: true, relayUrl: 'wss://relay.example.com' });
    const session = await openSession(service);
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    service.capabilityRouter.register('read-board', (request) => ({ type: 'capability-response', requestId: request.requestId, ok: true, payload: { huge: true } }));
    session.sendMessage.mockImplementationOnce(() => {
      throw new MessageEncodeError(new Error('Encoded bridge message exceeds 1048576 bytes'));
    });

    session.emit('message', { type: 'capability-request', requestId: 'bigreq-1', verb: 'read-board', payload: {} });
    await flushMicrotasks();

    expect(session.sendMessage).toHaveBeenCalledTimes(2);
    expect(session.sendMessage).toHaveBeenLastCalledWith({ type: 'capability-response', requestId: 'bigreq-1', ok: false, error: 'Response too large to send' });
    expect(
      warnSpy.mock.calls.some((call) =>
        String(call[0]).includes('response to read-board bigreq-1 from device-A not sent: Encoded bridge message exceeds 1048576 bytes; answered with a refusal'),
      ),
    ).toBe(true);

    warnSpy.mockRestore();
    service.dispose();
  });

  it('sends nothing more when a response fails for any reason other than encoding (the session dropped mid-dispatch)', async () => {
    const service = new MobileBridgeService({ enabled: true, relayUrl: 'wss://relay.example.com' });
    const session = await openSession(service);
    service.capabilityRouter.register('read-board', (request) => ({ type: 'capability-response', requestId: request.requestId, ok: true }));
    session.sendMessage.mockImplementationOnce(() => {
      throw new Error('BridgeSession is not established yet');
    });

    session.emit('message', { type: 'capability-request', requestId: 'dropreq-1', verb: 'read-board', payload: {} });
    await flushMicrotasks();

    // A retry would seal a second frame onto a stream whose transport is gone.
    expect(session.sendMessage).toHaveBeenCalledTimes(1);

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

  it('revokeDevice() on an offline (session-less) device drops it without throwing', async () => {
    const service = new MobileBridgeService({ enabled: true, relayUrl: 'wss://relay.example.com' });
    // The identity is read in the async secure-storage warm-up; the
    // synchronous roster edits serve that cached copy.
    await service.whenStorageReady();

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

  // The routine releases (the phone replied, or the session is being torn down)
  // are log lines. The four that sealed held frames under the old keys after the
  // phone may already have switched are the ones to look for next to a phone
  // request that timed out, so they are warn lines.
  it.each([
    { reason: 'established', level: 'log' },
    { reason: 'dispose', level: 'log' },
    { reason: 'deadline', level: 'warn' },
    { reason: 'overflow', level: 'warn' },
    { reason: 'read-failed', level: 'warn' },
    { reason: 'send-failed', level: 'warn' },
  ] as const)('writes a rekey hold released as "$reason" at $level level in the documented format', async ({ reason, level }) => {
    const service = new MobileBridgeService({ enabled: true, relayUrl: 'wss://relay.example.com' });
    const session = await openSession(service);
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const rekeyLines = (spy: typeof warnSpy): string[] => spy.mock.calls.map((call) => String(call[0])).filter((line) => line.includes('rekey held'));
    try {
      session.emit('rekeyHoldReleased', { frames: 3, heldMs: 1250, reason });

      const expectedLine = `[mobile-bridge] device ${session.deviceId.slice(0, 8)} rekey held 3 frame(s) for 1250 ms, released (${reason})`;
      expect(rekeyLines(level === 'log' ? logSpy : warnSpy)).toEqual([expectedLine]);
      expect(rekeyLines(level === 'log' ? warnSpy : logSpy)).toEqual([]);
    } finally {
      warnSpy.mockRestore();
      logSpy.mockRestore();
      service.dispose();
    }
  });

  it('connectionStateSince is null before a session opens, set at wiring time, bumped only on an actual state change, and cleared when the session is dropped', async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
      const service = new MobileBridgeService({ enabled: true, relayUrl: 'wss://relay.example.com' });
      // The identity (and so the roster listDevices reads) loads in the async
      // secure-storage warm-up.
      await service.whenStorageReady();

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

describe('MobileBridgeService.attachContext() task-owner and spawn-progress wiring', () => {
  /** Task titles by task id for each fake project, or 'throws' for a project whose repos will not open. */
  type FakeProjects = Record<string, Record<string, string> | 'throws'>;

  const servicesToDispose: Array<InstanceType<typeof MobileBridgeService>> = [];

  /** attachContext() over a fake project list, with `getProjectRepos` answering from `projects` in list order. */
  function attachWithProjects(projects: FakeProjects): InstanceType<typeof MobileBridgeService> {
    attachCapture.projectRepos = (projectId) => {
      const tasks = projects[projectId];
      if (tasks === 'throws') throw new Error('this project database will not open');
      return {
        tasks: { getById: (taskId: string) => (tasks && taskId in tasks ? { id: taskId, title: tasks[taskId] } : undefined) },
      };
    };
    const service = new MobileBridgeService({ enabled: true, relayUrl: 'wss://relay.example.com' });
    servicesToDispose.push(service);
    const sessionManager = Object.assign(new EventEmitter(), { setMobileTerminalProbe: vi.fn() });
    const projectRepo = { list: () => Object.keys(projects).map((id) => ({ id })) };
    service.attachContext({ sessionManager, boardEvents: { emitBoardChanged: vi.fn() }, projectRepo } as never);
    return service;
  }

  function resolveForSpawnStall(taskId: string): { projectId: string; taskId: string; taskTitle: string } | null {
    const options = attachCapture.pushNotifierOptions;
    if (!options) throw new Error('attachContext() did not build a PushNotifier');
    return options.resolveTaskContextByTaskId(taskId);
  }

  /** The feed attachContext() handed the capability handlers, which read-board subscribes to. */
  function handlerFeed(): NonNullable<typeof attachCapture.handlerDeps>['spawnProgressFeed'] {
    const deps = attachCapture.handlerDeps;
    if (!deps) throw new Error('attachContext() did not register the capability handlers');
    return deps.spawnProgressFeed;
  }

  function fakeWindow(): BrowserWindow {
    return { isDestroyed: () => false, webContents: { send: vi.fn() } } as unknown as BrowserWindow;
  }

  beforeEach(() => {
    attachCapture.pushNotifierOptions = null;
    attachCapture.handlerDeps = null;
    attachCapture.projectRepos = null;
    __resetSpawnProgressForTest();
  });

  afterEach(() => {
    for (const service of servicesToDispose) service.dispose();
    servicesToDispose.length = 0;
    attachCapture.projectRepos = null;
    __resetSpawnProgressForTest();
  });

  it('a spawn stall resolves the task to the project that owns it and to its title, skipping a project that does not hold it', () => {
    attachWithProjects({
      'proj-other': { 'task-9': 'Somebody else\'s task' },
      'proj-owner': { 'task-1': 'Add dark mode' },
    });

    expect(resolveForSpawnStall('task-1')).toEqual({ projectId: 'proj-owner', taskId: 'task-1', taskTitle: 'Add dark mode' });
  });

  it('a spawn stall skips a project whose repos throw and keeps looking', () => {
    attachWithProjects({
      'proj-broken': 'throws',
      'proj-owner': { 'task-1': 'Add dark mode' },
    });

    expect(resolveForSpawnStall('task-1')).toEqual({ projectId: 'proj-owner', taskId: 'task-1', taskTitle: 'Add dark mode' });
  });

  it('a spawn stall for a task no project owns resolves to null', () => {
    attachWithProjects({
      'proj-broken': 'throws',
      'proj-other': { 'task-9': 'Somebody else\'s task' },
    });

    expect(resolveForSpawnStall('task-1')).toBeNull();
  });

  it('registers the capability handlers with a started spawn-progress feed that names the owning project', () => {
    attachWithProjects({
      'proj-broken': 'throws',
      'proj-other': {},
      'proj-owner': { 'task-1': 'Add dark mode' },
    });
    const onProgressChanged = vi.fn();
    handlerFeed().onTaskSpawnProgressChanged(onProgressChanged);

    // A real push through the spawn-progress module: only a started feed hears
    // it, and only a working owner lookup can name the project.
    emitSpawnProgress(fakeWindow(), 'task-1', 'starting-agent');

    expect(onProgressChanged).toHaveBeenCalledExactlyOnceWith('proj-owner', 'task-1');
  });

  it('dispose() detaches the spawn-progress feed from the module-level push', () => {
    const service = attachWithProjects({
      'proj-owner': { 'task-1': 'Add dark mode', 'task-2': 'Fix the login bug' },
    });
    const onProgressChanged = vi.fn();
    handlerFeed().onTaskSpawnProgressChanged(onProgressChanged);
    emitSpawnProgress(fakeWindow(), 'task-1', 'starting-agent');
    expect(onProgressChanged).toHaveBeenCalledTimes(1);

    service.dispose();

    // A DIFFERENT task: task-1's first push opened a throttle window, so a
    // second change for it would never deliver at once and this would pass even
    // with the feed still attached.
    emitSpawnProgress(fakeWindow(), 'task-2', 'starting-agent');
    expect(onProgressChanged).toHaveBeenCalledTimes(1);
  });
});
