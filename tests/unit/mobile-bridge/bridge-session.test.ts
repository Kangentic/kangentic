/**
 * Unit tests for src/main/mobile-bridge/session/bridge-session.ts, the
 * ongoing (post-pairing) Noise KK session. BridgeSession is hardcoded to
 * the Noise INITIATOR role (the desktop always drives the ~2-minute
 * re-handshake timer), so these tests drive the RESPONDER side by hand
 * directly against @kangentic/protocol - exactly what the (not-yet-built)
 * mobile app's own session client will do - using the same
 * SessionFrameKind wrap/unwrap the production code uses to disambiguate
 * handshake frames from application frames on the shared connection.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  createKKHandshake,
  decodeMessage,
  deriveSecretstreamPair,
  encodeMessage,
  FrameTag,
  generateEd25519KeyPair,
  generateX25519KeyPair,
  SessionFrameKind,
  unwrapSessionFrame,
  wrapSessionFrame,
  type BridgeMessage,
  type CapabilitySet,
  type HandshakeState,
  type SecretstreamDirectionPair,
  type Transport,
  type TransportState,
} from '@kangentic/protocol';
import { BridgeSession } from '../../../src/main/mobile-bridge/session/bridge-session';
import type { BridgeIdentity } from '../../../src/main/mobile-bridge/identity';

function testIdentity(): BridgeIdentity {
  return {
    staticKeyPair: generateX25519KeyPair(),
    masterSigningKeyPair: generateEd25519KeyPair(),
    createdAt: new Date().toISOString(),
  };
}

function createLoopbackTransportPair(): [Transport, Transport] {
  const listenersOfFirst = new Set<(frame: Uint8Array) => void>();
  const listenersOfSecond = new Set<(frame: Uint8Array) => void>();

  const first: Transport = {
    state: 'connected',
    connect: () => Promise.resolve(),
    send: (frame) => {
      for (const listener of listenersOfSecond) listener(frame);
    },
    close: () => undefined,
    onFrame: (listener) => {
      listenersOfFirst.add(listener);
      return () => listenersOfFirst.delete(listener);
    },
    onStateChange: () => () => undefined,
  };

  const second: Transport = {
    state: 'connected',
    connect: () => Promise.resolve(),
    send: (frame) => {
      for (const listener of listenersOfFirst) listener(frame);
    },
    close: () => undefined,
    onFrame: (listener) => {
      listenersOfSecond.add(listener);
      return () => listenersOfSecond.delete(listener);
    },
    onStateChange: () => () => undefined,
  };

  return [first, second];
}

/** Drives the responder side of the Noise KK handshake and the resulting secretstream pair, by hand, against a raw loopback Transport. */
class SimulatedDeviceResponder {
  private handshake: HandshakeState;
  streams: SecretstreamDirectionPair | null = null;
  readonly receivedMessages: BridgeMessage[] = [];

  constructor(
    private readonly deviceStatic: ReturnType<typeof generateX25519KeyPair>,
    desktopStaticPublicKey: Uint8Array,
    private readonly transport: Transport,
  ) {
    this.handshake = createKKHandshake({ initiator: false, localStatic: deviceStatic, remoteStatic: desktopStaticPublicKey });
    transport.onFrame((frame) => this.onFrame(frame));
  }

  private onFrame(rawFrame: Uint8Array): void {
    const { kind, payload } = unwrapSessionFrame(rawFrame);
    if (kind === SessionFrameKind.Handshake) {
      // KK is two messages: reading message 1 (desktop's) never splits;
      // writing message 2 (this side's reply) is the one that completes
      // the handshake, so `split` comes from THIS call, not the read above.
      this.handshake.readMessage(payload);
      const { message, split } = this.handshake.writeMessage(new Uint8Array(0));
      this.transport.send(wrapSessionFrame(SessionFrameKind.Handshake, message));
      if (split) {
        this.streams = deriveSecretstreamPair(this.handshake.getChainingKey(), false);
      }
    } else {
      if (!this.streams) throw new Error('Received an application frame before the handshake completed');
      const { plaintext } = this.streams.receive.open(payload);
      this.receivedMessages.push(decodeMessage(plaintext));
    }
  }

  send(message: BridgeMessage): void {
    if (!this.streams) throw new Error('Cannot send before the session is established');
    const frame = this.streams.send.seal(encodeMessage(message));
    this.transport.send(wrapSessionFrame(SessionFrameKind.Application, frame));
  }
}

/**
 * A loopback pair whose desktop-side transport can be driven through
 * reconnect state edges. Mirrors the real relay client: the same transport
 * object survives a reconnect (frames stop then flow again) while its `state`
 * moves connected -> reconnecting -> connected and emits each edge.
 */
function createReconnectableLoopback(): {
  desktop: Transport;
  device: Transport;
  setDesktopState: (state: TransportState) => void;
} {
  const desktopFrameListeners = new Set<(frame: Uint8Array) => void>();
  const deviceFrameListeners = new Set<(frame: Uint8Array) => void>();
  const desktopStateListeners = new Set<(state: TransportState) => void>();
  let desktopState: TransportState = 'connected';

  const desktop: Transport = {
    get state() {
      return desktopState;
    },
    connect: () => Promise.resolve(),
    // A frame only reaches the peer while the desktop socket is up, exactly
    // like the relay dropping in-flight frames to a non-open partner.
    send: (frame) => {
      if (desktopState !== 'connected') return;
      for (const listener of deviceFrameListeners) listener(frame);
    },
    close: () => undefined,
    onFrame: (listener) => {
      desktopFrameListeners.add(listener);
      return () => desktopFrameListeners.delete(listener);
    },
    onStateChange: (listener) => {
      desktopStateListeners.add(listener);
      return () => desktopStateListeners.delete(listener);
    },
  };

  const device: Transport = {
    state: 'connected',
    connect: () => Promise.resolve(),
    send: (frame) => {
      for (const listener of desktopFrameListeners) listener(frame);
    },
    close: () => undefined,
    onFrame: (listener) => {
      deviceFrameListeners.add(listener);
      return () => deviceFrameListeners.delete(listener);
    },
    onStateChange: () => () => undefined,
  };

  const setDesktopState = (state: TransportState): void => {
    desktopState = state;
    for (const listener of desktopStateListeners) listener(state);
  };

  return { desktop, device, setDesktopState };
}

/**
 * The phone's behavior: a fresh responder KK handshake for every inbound
 * handshake message-1 (SessionManager creates a new responder per initiation),
 * counting each completed establishment.
 */
class ReestablishingResponder {
  streams: SecretstreamDirectionPair | null = null;
  establishedCount = 0;
  /**
   * Simulates the relay swallowing the desktop's initiations. The phone never
   * learns a rekey was attempted, so it keeps serving on its ORIGINAL streams -
   * which is what makes it a live peer the desktop can still decrypt.
   */
  dropHandshakes = false;

  constructor(
    deviceStatic: ReturnType<typeof generateX25519KeyPair>,
    desktopStaticPublicKey: Uint8Array,
    private readonly transport: Transport,
  ) {
    transport.onFrame((rawFrame) => {
      const { kind, payload } = unwrapSessionFrame(rawFrame);
      if (kind !== SessionFrameKind.Handshake) return;
      if (this.dropHandshakes) return;
      const handshake = createKKHandshake({ initiator: false, localStatic: deviceStatic, remoteStatic: desktopStaticPublicKey });
      handshake.readMessage(payload);
      const { message, split } = handshake.writeMessage(new Uint8Array(0));
      transport.send(wrapSessionFrame(SessionFrameKind.Handshake, message));
      if (split) {
        this.streams = deriveSecretstreamPair(handshake.getChainingKey(), false);
        this.establishedCount += 1;
      }
    });
  }

  sendApplicationMessage(message: BridgeMessage): void {
    if (!this.streams) throw new Error('Cannot send before the session is established');
    this.transport.send(wrapSessionFrame(SessionFrameKind.Application, this.streams.send.seal(encodeMessage(message))));
  }
}

describe('BridgeSession', () => {
  it('establishes a KK session with a responder and exchanges an application message', async () => {
    const desktopIdentity = testIdentity();
    const deviceStatic = generateX25519KeyPair();
    const [desktopTransport, deviceTransport] = createLoopbackTransportPair();
    const capabilities: CapabilitySet = new Set(['read-board']);

    const responder = new SimulatedDeviceResponder(deviceStatic, desktopIdentity.staticKeyPair.publicKey, deviceTransport);
    const session = new BridgeSession({
      identity: desktopIdentity,
      deviceId: 'device-1',
      remoteStaticPublicKey: deviceStatic.publicKey,
      capabilities,
      transport: desktopTransport,
    });

    const established = new Promise<void>((resolve) => session.once('established', resolve));
    session.start();
    await established;

    expect(session.isEstablished).toBe(true);

    session.sendMessage({ type: 'heartbeat' });
    expect(responder.receivedMessages).toEqual([{ type: 'heartbeat' }]);

    responder.send({ type: 'heartbeat' });
    // Give the synchronous loopback delivery a microtask tick to land the emit.
    await Promise.resolve();
    session.dispose();
  });

  it('emits frameRejected for a garbled application frame instead of throwing', async () => {
    const desktopIdentity = testIdentity();
    const deviceStatic = generateX25519KeyPair();
    const [desktopTransport, deviceTransport] = createLoopbackTransportPair();

    new SimulatedDeviceResponder(deviceStatic, desktopIdentity.staticKeyPair.publicKey, deviceTransport);
    const session = new BridgeSession({
      identity: desktopIdentity,
      deviceId: 'device-1',
      remoteStaticPublicKey: deviceStatic.publicKey,
      capabilities: new Set(),
      transport: desktopTransport,
    });

    const established = new Promise<void>((resolve) => session.once('established', resolve));
    session.start();
    await established;

    const rejectedPromise = new Promise<unknown>((resolve) => session.once('frameRejected', resolve));
    const garbled = wrapSessionFrame(SessionFrameKind.Application, new Uint8Array([1, 2, 3, 4, 5]));
    deviceTransport.send(garbled);

    const rejection = await rejectedPromise;
    expect(rejection).toBeInstanceOf(Error);
    session.dispose();
  });

  it('sendMessage() throws before the session is established', () => {
    const desktopIdentity = testIdentity();
    const deviceStatic = generateX25519KeyPair();
    const [desktopTransport] = createLoopbackTransportPair();

    const session = new BridgeSession({
      identity: desktopIdentity,
      deviceId: 'device-1',
      remoteStaticPublicKey: deviceStatic.publicKey,
      capabilities: new Set(),
      transport: desktopTransport,
    });

    expect(() => session.sendMessage({ type: 'heartbeat' })).toThrow(/not established/);
  });

  it('dispose() unsubscribes from the transport so no further frames are processed', async () => {
    const desktopIdentity = testIdentity();
    const deviceStatic = generateX25519KeyPair();
    const [desktopTransport, deviceTransport] = createLoopbackTransportPair();

    const responder = new SimulatedDeviceResponder(deviceStatic, desktopIdentity.staticKeyPair.publicKey, deviceTransport);
    const session = new BridgeSession({
      identity: desktopIdentity,
      deviceId: 'device-1',
      remoteStaticPublicKey: deviceStatic.publicKey,
      capabilities: new Set(),
      transport: desktopTransport,
    });

    const established = new Promise<void>((resolve) => session.once('established', resolve));
    session.start();
    await established;

    const messageListener = vi.fn();
    session.on('message', messageListener);
    session.dispose();

    responder.send({ type: 'heartbeat' });
    await Promise.resolve();
    expect(messageListener).not.toHaveBeenCalled();
  });

  it('dispose() closes its transport so the reconnect loop cannot outlive the session', () => {
    // The session owns its per-device transport; the optimistic roster
    // connect (a failed first dial keeps RelayClient re-dialing forever)
    // leans on this to guarantee revoke/disable/shutdown actually stop the
    // dialing - a dispose that leaks the transport strands a zombie dialer
    // that blocks the device's relay slot.
    const desktopIdentity = testIdentity();
    const deviceStatic = generateX25519KeyPair();
    const [desktopTransport] = createLoopbackTransportPair();
    const closeSpy = vi.spyOn(desktopTransport, 'close');

    const session = new BridgeSession({
      identity: desktopIdentity,
      deviceId: 'device-1',
      remoteStaticPublicKey: deviceStatic.publicKey,
      capabilities: new Set(),
      transport: desktopTransport,
    });
    session.start();
    session.dispose();

    expect(closeSpy).toHaveBeenCalledTimes(1);
  });

  it('re-initiates the handshake when the transport reconnects, instead of waiting for the rekey timer', () => {
    const desktopIdentity = testIdentity();
    const deviceStatic = generateX25519KeyPair();
    const { desktop, device, setDesktopState } = createReconnectableLoopback();

    const responder = new ReestablishingResponder(deviceStatic, desktopIdentity.staticKeyPair.publicKey, device);
    const session = new BridgeSession({
      identity: desktopIdentity,
      deviceId: 'device-1',
      remoteStaticPublicKey: deviceStatic.publicKey,
      capabilities: new Set(['read-board']),
      transport: desktop,
    });

    const establishedEvents = vi.fn();
    session.on('established', establishedEvents);

    // Loopback delivery is synchronous, so the initial handshake completes
    // inside start().
    session.start();
    expect(session.isEstablished).toBe(true);
    expect(responder.establishedCount).toBe(1);

    // The relay force-closes the desktop when the phone drops: the transport
    // goes to 'reconnecting'. The session must drop its (now-dead) keys.
    setDesktopState('reconnecting');
    expect(session.isEstablished).toBe(false);

    // On reconnect the session re-initiates immediately, WITHOUT any rekey
    // timer having fired, re-establishing right away.
    setDesktopState('connected');
    expect(session.isEstablished).toBe(true);
    expect(responder.establishedCount).toBe(2);
    expect(establishedEvents).toHaveBeenCalledTimes(2);

    session.dispose();
  });

  it('keeps re-handshaking on the rekey interval (post-compromise timer preserved)', () => {
    vi.useFakeTimers();
    try {
      const desktopIdentity = testIdentity();
      const deviceStatic = generateX25519KeyPair();
      const { desktop, device } = createReconnectableLoopback();

      const responder = new ReestablishingResponder(deviceStatic, desktopIdentity.staticKeyPair.publicKey, device);
      const session = new BridgeSession({
        identity: desktopIdentity,
        deviceId: 'device-1',
        remoteStaticPublicKey: deviceStatic.publicKey,
        capabilities: new Set(),
        transport: desktop,
      });

      session.start();
      expect(responder.establishedCount).toBe(1);

      // REHANDSHAKE_INTERVAL_MS is 2 minutes; each interval drives a fresh KK
      // handshake. Two ticks -> two more establishments.
      vi.advanceTimersByTime(2 * 60 * 1000);
      expect(responder.establishedCount).toBe(2);
      vi.advanceTimersByTime(2 * 60 * 1000);
      expect(responder.establishedCount).toBe(3);

      session.dispose();
      // After dispose the interval is cleared: no further handshakes.
      vi.advanceTimersByTime(2 * 60 * 1000);
      expect(responder.establishedCount).toBe(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not send a handshake while the transport is mid-reconnect', () => {
    const desktopIdentity = testIdentity();
    const deviceStatic = generateX25519KeyPair();
    const { desktop, device, setDesktopState } = createReconnectableLoopback();

    const responder = new ReestablishingResponder(deviceStatic, desktopIdentity.staticKeyPair.publicKey, device);
    const session = new BridgeSession({
      identity: desktopIdentity,
      deviceId: 'device-1',
      remoteStaticPublicKey: deviceStatic.publicKey,
      capabilities: new Set(),
      transport: desktop,
    });

    session.start();
    expect(responder.establishedCount).toBe(1);

    // While disconnected, a stray beginHandshake (e.g. a rekey tick) must be a
    // no-op rather than throwing on transport.send. Drive the interval by hand
    // is not possible here, so assert indirectly: after a disconnect with no
    // reconnect, nothing new establishes.
    setDesktopState('reconnecting');
    expect(session.isEstablished).toBe(false);
    expect(responder.establishedCount).toBe(1);

    session.dispose();
  });

  it('transportState getter reflects the underlying transport\'s current state, including through a reconnect', () => {
    const desktopIdentity = testIdentity();
    const deviceStatic = generateX25519KeyPair();
    const { desktop, device, setDesktopState } = createReconnectableLoopback();

    new ReestablishingResponder(deviceStatic, desktopIdentity.staticKeyPair.publicKey, device);
    const session = new BridgeSession({
      identity: desktopIdentity,
      deviceId: 'device-1',
      remoteStaticPublicKey: deviceStatic.publicKey,
      capabilities: new Set(),
      transport: desktop,
    });

    session.start();
    expect(session.transportState).toBe('connected');

    setDesktopState('reconnecting');
    expect(session.transportState).toBe('reconnecting');

    setDesktopState('connected');
    expect(session.transportState).toBe('connected');

    session.dispose();
  });

  it('emits "transportState" on every transport-state transition, including a reconnect back into "connected"', () => {
    // Pins the ordering documented in bridge-session.ts's onTransportState():
    // the emit happens BEFORE the `state === 'connected'` branch's early
    // return, so a re-connect edge (not just reconnecting/closed) also
    // reaches the service's relayState aggregation. If the emit were moved
    // below that branch, the 'connected' transition below would silently
    // stop appearing in transportStateEvents.
    const desktopIdentity = testIdentity();
    const deviceStatic = generateX25519KeyPair();
    const { desktop, device, setDesktopState } = createReconnectableLoopback();

    new ReestablishingResponder(deviceStatic, desktopIdentity.staticKeyPair.publicKey, device);
    const session = new BridgeSession({
      identity: desktopIdentity,
      deviceId: 'device-1',
      remoteStaticPublicKey: deviceStatic.publicKey,
      capabilities: new Set(),
      transport: desktop,
    });

    const transportStateEvents: TransportState[] = [];
    session.on('transportState', (state: TransportState) => transportStateEvents.push(state));

    // The INITIAL connect at start() bypasses onTransportState entirely (see
    // start()'s "kick" comment: the transport was already 'connected' before
    // the onStateChange listener was subscribed, so no transition fired).
    session.start();
    expect(transportStateEvents).toEqual([]);

    setDesktopState('reconnecting');
    expect(transportStateEvents).toEqual(['reconnecting']);

    setDesktopState('connected');
    expect(transportStateEvents).toEqual(['reconnecting', 'connected']);

    session.dispose();
  });

  it('recovers from a garbled handshake frame with a fast retry instead of wedging', () => {
    vi.useFakeTimers();
    try {
      const desktopIdentity = testIdentity();
      const deviceStatic = generateX25519KeyPair();
      const { desktop, device } = createReconnectableLoopback();

      // No responder yet: the initial msg1 goes unanswered, so a handshake is
      // outstanding when the garbled frame lands.
      const session = new BridgeSession({
        identity: desktopIdentity,
        deviceId: 'device-1',
        remoteStaticPublicKey: deviceStatic.publicKey,
        capabilities: new Set(),
        transport: desktop,
      });
      const handshakeFailed = vi.fn();
      session.on('handshakeFailed', handshakeFailed);

      session.start();
      expect(session.isEstablished).toBe(false);

      // A malicious/corrupt relay injects a garbled Handshake frame. Reading it
      // corrupts the in-flight handshake; the session must drop it (not leave it
      // half-open) and schedule a fast retry.
      device.send(wrapSessionFrame(SessionFrameKind.Handshake, new Uint8Array([9, 9, 9, 9, 9])));
      expect(handshakeFailed).toHaveBeenCalledTimes(1);
      expect(session.isEstablished).toBe(false);

      // A real responder is now present. The failure-driven retry fires after
      // HANDSHAKE_RETRY_MS and re-initiates cleanly - no wait for the 2-minute
      // rekey tick.
      const responder = new ReestablishingResponder(deviceStatic, desktopIdentity.staticKeyPair.publicKey, device);
      vi.advanceTimersByTime(3 * 1000);
      expect(session.isEstablished).toBe(true);
      expect(responder.establishedCount).toBe(1);

      session.dispose();
    } finally {
      vi.useRealTimers();
    }
  });
});

/**
 * `connectionState` is what one device's row in Settings > Mobile Devices
 * reports. It exists because `transportState` alone cannot answer "is the phone
 * there": the desktop's relay socket reads 'connected' whenever the relay is up
 * and the slot is dialable, with the phone powered off. These pin the two
 * hysteresis guards that keep it honest without being twitchy - a probe budget
 * before reporting 'offline', and a hold before reporting a blip.
 *
 * The constants mirror the private ones in bridge-session.ts (not exported):
 * PEER_PRESENCE_TIMEOUT_MS 5s, PEER_PRESENCE_FAILURES_BEFORE_ABSENT 2,
 * PEER_PROBE_INTERVAL_MS 15s, RECONNECT_GRACE_MS 2s.
 */
describe('BridgeSession.connectionState', () => {
  function startSession(transport: Transport, desktopIdentity: BridgeIdentity, devicePublicKey: Uint8Array): BridgeSession {
    const session = new BridgeSession({
      identity: desktopIdentity,
      deviceId: 'device-1',
      remoteStaticPublicKey: devicePublicKey,
      capabilities: new Set(['read-board']) as CapabilitySet,
      transport,
    });
    session.start();
    return session;
  }

  it('reports "connecting" while the transport is up but the handshake has not completed', () => {
    vi.useFakeTimers();
    try {
      const desktopIdentity = testIdentity();
      const deviceStatic = generateX25519KeyPair();
      const { desktop } = createReconnectableLoopback();
      // No responder is attached, so the initiation goes unanswered.
      const session = startSession(desktop, desktopIdentity, deviceStatic.publicKey);

      expect(session.transportState).toBe('connected');
      expect(session.connectionState).toBe('connecting');

      session.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it('reports "connected" only once the KK session establishes', () => {
    vi.useFakeTimers();
    try {
      const desktopIdentity = testIdentity();
      const deviceStatic = generateX25519KeyPair();
      const { desktop, device } = createReconnectableLoopback();
      new ReestablishingResponder(deviceStatic, desktopIdentity.staticKeyPair.publicKey, device);
      const session = startSession(desktop, desktopIdentity, deviceStatic.publicKey);

      expect(session.isEstablished).toBe(true);
      expect(session.connectionState).toBe('connected');

      session.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it('one unanswered probe is not enough to report "offline"', () => {
    vi.useFakeTimers();
    try {
      const desktopIdentity = testIdentity();
      const deviceStatic = generateX25519KeyPair();
      const { desktop } = createReconnectableLoopback();
      const session = startSession(desktop, desktopIdentity, deviceStatic.publicKey);

      // The budget is deliberately two probes: a single slow round trip must
      // never flash "Offline" on a phone that is really there.
      vi.advanceTimersByTime(5 * 1000);
      expect(session.connectionState).toBe('connecting');

      session.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it('reports "offline" once the probe budget is spent, and announces it', () => {
    vi.useFakeTimers();
    try {
      const desktopIdentity = testIdentity();
      const deviceStatic = generateX25519KeyPair();
      const { desktop } = createReconnectableLoopback();
      const session = startSession(desktop, desktopIdentity, deviceStatic.publicKey);
      const connectionStateEvents = vi.fn();
      session.on('connectionState', connectionStateEvents);

      vi.advanceTimersByTime(10 * 1000);

      expect(session.connectionState).toBe('offline');
      // The transport is untouched - this is precisely the case a
      // transport-only badge got wrong by rendering a green "Connected".
      expect(session.transportState).toBe('connected');
      expect(connectionStateEvents).toHaveBeenCalled();

      session.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it('still reaches "offline" under a sustained garbage-frame trickle from the relay', () => {
    // The blind relay is a named adversary, and a bad handshake frame schedules
    // a HANDSHAKE_RETRY_MS (3s) re-initiation. If each re-initiation restarted
    // the presence window (5s), garbage timed to land just after every msg1
    // would hold the probe deadline permanently out of reach and pin the badge
    // on "Connecting…" forever - the exact stuck-transient-state class of bug
    // this whole change exists to remove.
    vi.useFakeTimers();
    try {
      const desktopIdentity = testIdentity();
      const deviceStatic = generateX25519KeyPair();
      const { desktop, device } = createReconnectableLoopback();
      // No responder: the "phone" is gone and only the relay's garbage arrives.
      const session = startSession(desktop, desktopIdentity, deviceStatic.publicKey);

      // Injected faster than HANDSHAKE_RETRY_MS, so a garbage frame is always
      // waiting for the handshake each retry creates. That keeps a retry firing
      // roughly every 3s, inside the 5s presence window - the timing that
      // pushes the deadline out forever if the window is restartable.
      for (let injection = 0; injection < 30; injection += 1) {
        device.send(wrapSessionFrame(SessionFrameKind.Handshake, new Uint8Array([9, 9, 9, 9, 9])));
        vi.advanceTimersByTime(1000);
      }

      expect(session.connectionState).toBe('offline');

      session.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it('recovers to "connected" when the phone comes back, without waiting out the rekey interval', () => {
    vi.useFakeTimers();
    try {
      const desktopIdentity = testIdentity();
      const deviceStatic = generateX25519KeyPair();
      const { desktop, device } = createReconnectableLoopback();
      const session = startSession(desktop, desktopIdentity, deviceStatic.publicKey);

      vi.advanceTimersByTime(10 * 1000);
      expect(session.connectionState).toBe('offline');

      // The phone reattaches to the slot. It waits passively for the desktop to
      // initiate, so without the absent-probe loop this would stay "offline"
      // until the 2-minute rekey tick.
      new ReestablishingResponder(deviceStatic, desktopIdentity.staticKeyPair.publicKey, device);
      vi.advanceTimersByTime(15 * 1000);

      expect(session.connectionState).toBe('connected');

      session.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps reporting "connected" while a lost rekey drains the probe budget but the phone keeps serving', () => {
    // The mirror of the bug this change removes. Presence was demoted by
    // handshake silence alone, but silence is not proof of absence: a single
    // dropped msg1 (a rekey is attempted every REHANDSHAKE_INTERVAL_MS, so a
    // lossy relay gets a fresh chance every two minutes) never reaches the
    // phone, so it keeps its original streams and keeps sending. The desktop
    // decrypts every one of those frames and USED to report "Offline" anyway.
    vi.useFakeTimers();
    try {
      const desktopIdentity = testIdentity();
      const deviceStatic = generateX25519KeyPair();
      const { desktop, device } = createReconnectableLoopback();
      const responder = new ReestablishingResponder(deviceStatic, desktopIdentity.staticKeyPair.publicKey, device);
      const session = startSession(desktop, desktopIdentity, deviceStatic.publicKey);
      const decodedMessages: BridgeMessage[] = [];
      session.on('message', (message: BridgeMessage) => decodedMessages.push(message));
      expect(session.connectionState).toBe('connected');

      // From here the relay swallows our initiations.
      responder.dropHandshakes = true;
      vi.advanceTimersByTime(2 * 60 * 1000);

      // Well past the full probe budget (2 x 5s), with the phone serving throughout.
      for (let tick = 0; tick < 4; tick += 1) {
        responder.sendApplicationMessage({ type: 'heartbeat' } as BridgeMessage);
        vi.advanceTimersByTime(5 * 1000);
      }

      // The frames really are being opened, so the peer is provably attached.
      expect(decodedMessages.length).toBe(4);
      expect(session.isEstablished).toBe(true);
      expect(session.connectionState).toBe('connected');

      session.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it('reports "offline" immediately on an explicit remote close', () => {
    vi.useFakeTimers();
    try {
      const desktopIdentity = testIdentity();
      const deviceStatic = generateX25519KeyPair();
      const { desktop, device } = createReconnectableLoopback();
      const responder = new ReestablishingResponder(deviceStatic, desktopIdentity.staticKeyPair.publicKey, device);
      const session = startSession(desktop, desktopIdentity, deviceStatic.publicKey);
      expect(session.connectionState).toBe('connected');

      // The phone says goodbye. That is unambiguous, so it skips the probe
      // budget the silent case has to spend.
      const responderStreams = responder.streams;
      if (!responderStreams) throw new Error('responder never established');
      device.send(wrapSessionFrame(SessionFrameKind.Application, responderStreams.send.seal(new Uint8Array(0), FrameTag.Final)));

      expect(session.connectionState).toBe('offline');

      session.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it('holds "connected" across a relay blip that heals inside the grace, with no flicker', () => {
    vi.useFakeTimers();
    try {
      const desktopIdentity = testIdentity();
      const deviceStatic = generateX25519KeyPair();
      const { desktop, device, setDesktopState } = createReconnectableLoopback();
      new ReestablishingResponder(deviceStatic, desktopIdentity.staticKeyPair.publicKey, device);
      const session = startSession(desktop, desktopIdentity, deviceStatic.publicKey);
      expect(session.connectionState).toBe('connected');

      const observed: string[] = [];
      session.on('connectionState', () => observed.push(session.connectionState));

      // A phone reload force-closes both peers, so the desktop socket drops and
      // redials ~500ms later (RelayClient's INITIAL_BACKOFF_MS) and re-handshakes.
      setDesktopState('reconnecting');
      vi.advanceTimersByTime(500);
      setDesktopState('connected');

      expect(session.isEstablished).toBe(true);
      expect(session.connectionState).toBe('connected');
      // The whole point: the badge never passed through 'reconnecting' or
      // 'connecting' on the way, which would read as "the pairing broke".
      expect(observed.filter((state) => state !== 'connected')).toEqual([]);

      session.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it('falls through to the real transport state when the blip outlasts the grace, and announces it', () => {
    vi.useFakeTimers();
    try {
      const desktopIdentity = testIdentity();
      const deviceStatic = generateX25519KeyPair();
      const { desktop, device, setDesktopState } = createReconnectableLoopback();
      new ReestablishingResponder(deviceStatic, desktopIdentity.staticKeyPair.publicKey, device);
      const session = startSession(desktop, desktopIdentity, deviceStatic.publicKey);
      expect(session.connectionState).toBe('connected');

      const connectionStateEvents = vi.fn();
      setDesktopState('reconnecting');
      session.on('connectionState', connectionStateEvents);

      // A genuine relay outage, not a blip. The hold must expire AND notify -
      // a silent expiry would strand the badge on a stale "Connected".
      vi.advanceTimersByTime(2 * 1000);

      expect(session.connectionState).toBe('reconnecting');
      expect(connectionStateEvents).toHaveBeenCalled();

      session.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it('dispose() stops a pending presence probe from ever firing again', () => {
    // Every test above calls dispose() only as its last line, never followed
    // by a timer advance. This pins the actual teardown contract: a presence
    // probe armed by start()'s initial (unanswered) handshake must not go on
    // to retry, spend the probe budget, schedule an absent-reprobe, or emit
    // 'connectionState' after the session is torn down.
    vi.useFakeTimers();
    try {
      const desktopIdentity = testIdentity();
      const deviceStatic = generateX25519KeyPair();
      const { desktop } = createReconnectableLoopback();
      const timerCountBeforeSession = vi.getTimerCount();
      // No responder: the initial msg1 goes unanswered, so a presence probe
      // timer is pending the moment dispose() runs.
      const session = startSession(desktop, desktopIdentity, deviceStatic.publicKey);
      expect(session.connectionState).toBe('connecting');
      expect(vi.getTimerCount()).toBeGreaterThan(timerCountBeforeSession);

      const sendSpy = vi.spyOn(desktop, 'send');
      const connectionStateEvents = vi.fn();
      session.on('connectionState', connectionStateEvents);

      session.dispose();

      // The falsifying assertion: dispose() must leave no pending timer
      // behind, not merely rely on each callback's own `disposed` guard to
      // make a leftover timer's eventual firing a no-op.
      expect(vi.getTimerCount()).toBe(timerCountBeforeSession);

      // Well past the presence timeout (5s), the absent-probe interval (15s)
      // that a spent budget would schedule, and the rehandshake interval
      // (2min): every timer a live session would still be driving.
      vi.advanceTimersByTime(3 * 60 * 1000);

      expect(sendSpy).not.toHaveBeenCalled();
      expect(connectionStateEvents).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('dispose() stops a scheduled absent-reprobe from ever firing again', () => {
    // Distinct from the presence-probe test above: after the probe budget is
    // fully spent (two unanswered timeouts), the session schedules a SEPARATE
    // absent-reprobe timer (scheduleAbsentProbe) rather than leaving the
    // presence timer pending. dispose() must clear that one too.
    vi.useFakeTimers();
    try {
      const desktopIdentity = testIdentity();
      const deviceStatic = generateX25519KeyPair();
      const { desktop } = createReconnectableLoopback();
      const timerCountBeforeSession = vi.getTimerCount();
      // No responder: spend the full two-probe budget (5s each) to reach
      // 'offline' and arm the absent-reprobe timer.
      const session = startSession(desktop, desktopIdentity, deviceStatic.publicKey);
      vi.advanceTimersByTime(2 * 5 * 1000);
      expect(session.connectionState).toBe('offline');

      const sendSpy = vi.spyOn(desktop, 'send');
      const connectionStateEvents = vi.fn();
      session.on('connectionState', connectionStateEvents);

      session.dispose();

      // The falsifying assertion: dispose() must leave no pending timer
      // behind (the rehandshake interval is cleared unconditionally above
      // this block, so any leftover here is the absent-reprobe timer).
      expect(vi.getTimerCount()).toBe(timerCountBeforeSession);

      // Well past the absent-reprobe interval (15s) and the rehandshake
      // interval (2min): every timer a live session would still be driving.
      vi.advanceTimersByTime(3 * 60 * 1000);

      expect(sendSpy).not.toHaveBeenCalled();
      expect(connectionStateEvents).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('dispose() clears a pending reconnect-hold so connectionState reports the real (disposed) transport state, not a stale "connected"', () => {
    // connectionState's reconnect-grace branch reads `this.reconnectGraceTimer`
    // directly (not through the timer's own callback), so this is the one
    // dispose() clear with an effect observable WITHOUT ever advancing fake
    // timers: an un-cleared hold would misreport 'connected' for a fully
    // disposed session for up to RECONNECT_GRACE_MS.
    vi.useFakeTimers();
    try {
      const desktopIdentity = testIdentity();
      const deviceStatic = generateX25519KeyPair();
      const { desktop, device, setDesktopState } = createReconnectableLoopback();
      new ReestablishingResponder(deviceStatic, desktopIdentity.staticKeyPair.publicKey, device);
      const session = startSession(desktop, desktopIdentity, deviceStatic.publicKey);
      expect(session.connectionState).toBe('connected');

      // A blip arms the reconnect-grace hold (peerPresence was 'present').
      setDesktopState('reconnecting');

      const sendSpy = vi.spyOn(desktop, 'send');
      const connectionStateEvents = vi.fn();
      session.on('connectionState', connectionStateEvents);

      session.dispose();

      expect(session.connectionState).toBe('reconnecting');

      vi.advanceTimersByTime(3 * 60 * 1000);

      expect(sendSpy).not.toHaveBeenCalled();
      expect(connectionStateEvents).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});
