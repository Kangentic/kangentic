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
  receivedGoodbyes = 0;

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
      const opened = this.streams.receive.open(payload);
      // A goodbye's plaintext is empty and decodeMessage throws on empty
      // bytes - branch on the tag first, the way the phone's receiver does.
      if (opened.tag === FrameTag.Final) {
        this.receivedGoodbyes += 1;
        return;
      }
      this.receivedMessages.push(decodeMessage(opened.plaintext));
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
 * Models kangentic-relay's actual behavior for an unpaired ("parked") slot
 * (its SlotTable, src/rendezvous.ts), which createReconnectableLoopback above
 * does not: a parked connection's frames are BUFFERED (SlotTable.park() /
 * connection.ts's onMessage `pending` array), never dropped, and the whole
 * buffer is delivered to the phone, in order, the instant it attaches
 * (SlotTable.pair()'s flush) - before any live traffic. The relay also closes
 * a parked socket after its own PARK_TIMEOUT_MS (60s) and force-closes BOTH
 * sides of a pair the instant either drops, so on every phone departure the
 * desktop's transport bounces reconnecting -> connected (RelayClient's
 * INITIAL_BACKOFF_MS, 500ms) into a BRAND NEW, empty park - never a resumed
 * one. This is the harness gap #635 exposed: the drop-based double above
 * cannot reproduce a burst of buffered msg1s flushed together on arrival.
 */
/** kangentic-relay's PARK_TIMEOUT_MS: how long it holds an unpaired slot before closing it. */
const MOCK_RELAY_PARK_TIMEOUT_MS = 60 * 1000;

/** RelayClient's INITIAL_BACKOFF_MS: how long it waits before redialing a closed socket. */
const MOCK_RELAY_REDIAL_BACKOFF_MS = 500;

function createParkingRelayLoopback(options: { disableParkTimeout?: boolean } = {}): {
  desktop: Transport;
  device: Transport;
  /** Delivers the parked buffer to the device's listeners, in order, then leaves the desktop forwarding live - SlotTable.pair(). */
  attachPhone: () => void;
  /** The relay force-closing both sides on the phone's departure - bounces the desktop into a fresh, empty park (500ms later). */
  detachPhone: () => void;
} {
  // Models a self-hosted relay with no PARK_TIMEOUT_MS (armRehandshakeTimer()'s
  // own comment calls this case out): the connection can stay parked and
  // unanswered indefinitely, past even REHANDSHAKE_INTERVAL_MS, instead of
  // kangentic-relay's real 60s park timeout redialing first and masking that
  // path.
  const disableParkTimeout = options.disableParkTimeout ?? false;
  const desktopStateListeners = new Set<(state: TransportState) => void>();
  const desktopFrameListeners = new Set<(frame: Uint8Array) => void>();
  const deviceFrameListeners = new Set<(frame: Uint8Array) => void>();
  let desktopState: TransportState = 'connected';
  let attached = false;
  let pending: Uint8Array[] = [];
  let parkTimer: ReturnType<typeof setTimeout> | null = null;

  const setDesktopState = (state: TransportState): void => {
    desktopState = state;
    for (const listener of desktopStateListeners) listener(state);
  };

  const clearParkTimer = (): void => {
    if (!parkTimer) return;
    clearTimeout(parkTimer);
    parkTimer = null;
  };

  // SlotTable.park(): a connection with no live peer waiting is parked and
  // given PARK_TIMEOUT_MS (60s) before the relay closes it outright,
  // discarding whatever it buffered. Disabled entirely when
  // disableParkTimeout is set, so armPark() and redial() (which re-arms it
  // on every fresh park) both become no-ops and the connection just stays
  // parked forever.
  const armPark = (): void => {
    if (disableParkTimeout) return;
    clearParkTimer();
    parkTimer = setTimeout(() => {
      parkTimer = null;
      pending = [];
      redial();
    }, MOCK_RELAY_PARK_TIMEOUT_MS);
    parkTimer.unref?.();
  };

  // The relay closing the desktop's socket (park timeout, or the mirrored
  // force-close on the phone's own departure) and RelayClient redialing
  // ~500ms later (INITIAL_BACKOFF_MS) into a brand-new connection, which the
  // relay parks fresh since no phone is there yet.
  const redial = (): void => {
    attached = false;
    setDesktopState('reconnecting');
    setTimeout(() => {
      setDesktopState('connected');
      armPark();
    }, MOCK_RELAY_REDIAL_BACKOFF_MS);
  };

  armPark();

  const desktop: Transport = {
    get state() {
      return desktopState;
    },
    connect: () => Promise.resolve(),
    send: (frame) => {
      if (desktopState !== 'connected') return;
      if (attached) {
        for (const listener of deviceFrameListeners) listener(frame);
        return;
      }
      // Parked: buffered, not dropped - the crux of #635.
      pending.push(frame);
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

  const attachPhone = (): void => {
    clearParkTimer();
    attached = true;
    const buffered = pending;
    pending = [];
    // SlotTable.pair(): the whole buffer, in order, before any live traffic.
    for (const frame of buffered) for (const listener of deviceFrameListeners) listener(frame);
  };

  const detachPhone = (): void => {
    redial();
  };

  return { desktop, device, attachPhone, detachPhone };
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
 * RECONNECT_GRACE_MS 2s.
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

  it('a reconnect resets the probe budget, so a stale partial count cannot fast-track a fresh episode to "offline"', () => {
    // onTransportState()'s 'connected' branch resets failedPresenceProbes to
    // zero ("a fresh socket gets a fresh probe budget"). Without that reset, a
    // probe failure from BEFORE a reconnect would carry over and combine with
    // the first failure of the NEW episode to spend the two-probe budget in
    // one shot - flashing "Offline" on a phone that is genuinely mid-reconnect,
    // a full probe window (5s) earlier than the budget allows. No responder is
    // ever attached, so peerPresence never reaches 'present' and no reconnect
    // grace is armed - isolating this reset from that other hysteresis guard.
    vi.useFakeTimers();
    try {
      const desktopIdentity = testIdentity();
      const deviceStatic = generateX25519KeyPair();
      const { desktop, setDesktopState } = createReconnectableLoopback();
      const session = startSession(desktop, desktopIdentity, deviceStatic.publicKey);

      // One probe of the original episode's budget is spent (1 of 2).
      vi.advanceTimersByTime(5 * 1000);
      expect(session.connectionState).toBe('connecting');

      // The transport drops and comes back - a fresh episode.
      setDesktopState('reconnecting');
      setDesktopState('connected');

      // A single probe failure in the FRESH episode must not be enough to
      // reach 'offline' - it would be exactly enough only if the prior
      // episode's one failure had carried over uncleared.
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
      const peerAbsentEvents = vi.fn();
      session.on('peerAbsent', peerAbsentEvents);

      vi.advanceTimersByTime(10 * 1000);

      expect(session.connectionState).toBe('offline');
      // The transport is untouched - this is precisely the case a
      // transport-only badge got wrong by rendering a green "Connected".
      expect(session.transportState).toBe('connected');
      expect(connectionStateEvents).toHaveBeenCalled();
      // The absence EDGE also announces itself: the service tears down the
      // device's subscriptions on it, because a silent departure emits no
      // 'remoteClosed' and the terminal-stream marker must not outlive the
      // phone (a stale marker keeps the resting park armed and the panel tab
      // dropped indefinitely). Exactly once - absence is an edge, not a level.
      expect(peerAbsentEvents).toHaveBeenCalledTimes(1);

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

  it('recovers to "connected" when the phone comes back, picked up immediately from the parked msg1 rather than a re-probe loop', () => {
    vi.useFakeTimers();
    try {
      const desktopIdentity = testIdentity();
      const deviceStatic = generateX25519KeyPair();
      const { desktop, device, attachPhone } = createParkingRelayLoopback();
      const session = startSession(desktop, desktopIdentity, deviceStatic.publicKey);

      vi.advanceTimersByTime(10 * 1000);
      expect(session.connectionState).toBe('offline');

      // The phone attaches to the still-parked slot: the relay flushes the
      // ONE msg1 the desktop parked (see createParkingRelayLoopback and
      // beginHandshake()'s guard) the instant it arrives, so recovery is
      // immediate - there is no separate re-probe loop to wait out.
      const responder = new ReestablishingResponder(deviceStatic, desktopIdentity.staticKeyPair.publicKey, device);
      attachPhone();

      expect(session.connectionState).toBe('connected');
      expect(responder.establishedCount).toBe(1);

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

  /**
   * The exact mirror of the test above: a phone that dies silently rather
   * than one that keeps serving. Nothing sends a Final frame and no
   * application traffic arrives, so the desktop's `streams` are never
   * nulled - only the presence probe budget (spent over the dropped rekey)
   * concludes the peer is gone. This is the precondition the push
   * presence-suppression fix depends on: connectionState must reach
   * 'offline' here even though isEstablished stays true.
   */
  it('reports "offline" once a rekey goes unanswered and the phone sends nothing back (a silent death)', () => {
    vi.useFakeTimers();
    try {
      const desktopIdentity = testIdentity();
      const deviceStatic = generateX25519KeyPair();
      const { desktop, device } = createReconnectableLoopback();
      const responder = new ReestablishingResponder(deviceStatic, desktopIdentity.staticKeyPair.publicKey, device);
      const session = startSession(desktop, desktopIdentity, deviceStatic.publicKey);
      expect(session.connectionState).toBe('connected');

      // From here the phone is gone: the relay swallows the rekey and
      // nothing ever answers or sends again.
      responder.dropHandshakes = true;
      vi.advanceTimersByTime(2 * 60 * 1000); // the rekey tick fires and arms the probe
      vi.advanceTimersByTime(15 * 1000); // past both 5s probe failures (10s) with margin

      expect(session.connectionState).toBe('offline');
      expect(session.transportState).toBe('connected');
      // The streams are still held - nothing on this path nulls them, which
      // is exactly the window push presence suppression must not read as
      // "still watching".
      expect(session.isEstablished).toBe(true);

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
      // The streams are left intact by markPeerAbsent (see the class doc):
      // clearing them here would break the independent send path for no
      // benefit, since connectionState already moved to 'offline' on
      // peerPresence alone. This is exactly the window push presence
      // suppression must read connectionState rather than this raw flag
      // to avoid treating the device as still watching.
      expect(session.isEstablished).toBe(true);

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
    // to retry, spend the probe budget, or emit 'connectionState' after the
    // session is torn down.
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

      // Well past the presence timeout (5s) and the rehandshake interval
      // (2min): every timer a live session would still be driving.
      vi.advanceTimersByTime(3 * 60 * 1000);

      expect(sendSpy).not.toHaveBeenCalled();
      expect(connectionStateEvents).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('dispose() clears the rekey interval left running after the peer goes absent, with no further sends', () => {
    // Distinct from the presence-probe test above: once the probe budget is
    // fully spent (two unanswered timeouts) and markPeerAbsent() fires, the
    // ONLY timer left running is the REHANDSHAKE_INTERVAL_MS interval armed
    // by the original beginHandshake() call. There is no separate re-probe
    // loop while absent (see beginHandshake()'s parked-slot guard: a spent
    // presence budget's markPeerAbsent() does not re-arm anything). dispose()
    // must still clear that rekey interval.
    vi.useFakeTimers();
    try {
      const desktopIdentity = testIdentity();
      const deviceStatic = generateX25519KeyPair();
      const { desktop } = createReconnectableLoopback();
      const timerCountBeforeSession = vi.getTimerCount();
      // No responder: spend the full two-probe budget (5s each) to reach 'offline'.
      const session = startSession(desktop, desktopIdentity, deviceStatic.publicKey);
      vi.advanceTimersByTime(2 * 5 * 1000);
      expect(session.connectionState).toBe('offline');

      const sendSpy = vi.spyOn(desktop, 'send');
      const connectionStateEvents = vi.fn();
      session.on('connectionState', connectionStateEvents);

      session.dispose();

      // The falsifying assertion: dispose() must leave no pending timer
      // behind - the only candidate at this point is the rehandshake interval.
      expect(vi.getTimerCount()).toBe(timerCountBeforeSession);

      // Well past the rehandshake interval (2min): every timer a live
      // session would still be driving.
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

/**
 * #635: while the relay has the desktop's connection parked (no phone
 * attached yet), every msg1 it sends accumulates in the relay's park buffer
 * rather than being dropped or delivered - so a phone attaching mid-park
 * used to receive a burst of buffered handshakes at once (one 'established'
 * plus a rekey per extra msg1) instead of the single handshake it started
 * with. `createParkingRelayLoopback` is the harness fix: the earlier
 * drop-based doubles cannot reproduce this because they never buffer
 * anything for an absent peer.
 *
 * This block also covers the rest of #635's fix to the same guard: the
 * un-blocking `!peerSeenOnThisConnection` term (a lost rekey msg1 IS
 * re-sent once a live peer proves the slot is paired) and the resulting
 * armPresenceTimer()/beginHandshake() ordering in onPresenceProbeTimeout().
 * Those two need a live peer proving the slot paired, not an absent one
 * buffering, so they drive `createReconnectableLoopback` instead.
 */
describe('BridgeSession park-buffer behavior (#635)', () => {
  it('parks a fresh connection and buffers only ONE msg1, so an arriving phone establishes in a single handshake', () => {
    vi.useFakeTimers();
    try {
      const desktopIdentity = testIdentity();
      const deviceStatic = generateX25519KeyPair();
      const { desktop, device, attachPhone } = createParkingRelayLoopback();
      const session = new BridgeSession({
        identity: desktopIdentity,
        deviceId: 'device-1',
        remoteStaticPublicKey: deviceStatic.publicKey,
        capabilities: new Set(['read-board']) as CapabilitySet,
        transport: desktop,
      });

      session.start(); // msg1 #1 buffered by the park.

      // Well past the presence-probe window (10s) and the old absent-probe
      // cadence (15s x 2 = 30s), still inside the relay's 60s park timeout.
      vi.advanceTimersByTime(30 * 1000);

      const responder = new ReestablishingResponder(deviceStatic, desktopIdentity.staticKeyPair.publicKey, device);
      attachPhone();

      // Exactly one handshake - the buffered msg1 - completed. Before the
      // fix this was 3 (msg1 sent at t=0, t=5s, t=25s, all buffered and
      // flushed together), which forced the phone through 2 spurious
      // rekeys and left the desktop's own session unestablished until the
      // 3s failure retry that follows a stale msg2.
      expect(responder.establishedCount).toBe(1);
      expect(session.isEstablished).toBe(true);
      expect(session.connectionState).toBe('connected');

      session.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it('sends exactly one msg1 while the relay has it parked, not one per probe tick', () => {
    vi.useFakeTimers();
    try {
      const desktopIdentity = testIdentity();
      const deviceStatic = generateX25519KeyPair();
      const { desktop } = createParkingRelayLoopback();
      const sendSpy = vi.spyOn(desktop, 'send');
      const session = new BridgeSession({
        identity: desktopIdentity,
        deviceId: 'device-1',
        remoteStaticPublicKey: deviceStatic.publicKey,
        capabilities: new Set(),
        transport: desktop,
      });

      session.start();
      // Just short of the relay's 60s park timeout, so this is still the
      // same parked connection throughout.
      vi.advanceTimersByTime(55 * 1000);

      const handshakeFrames = sendSpy.mock.calls.filter(([frame]) => unwrapSessionFrame(frame).kind === SessionFrameKind.Handshake);
      expect(handshakeFrames).toHaveLength(1);

      session.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it('the relay closing a parked socket after PARK_TIMEOUT_MS starts a fresh park with its own single msg1', () => {
    vi.useFakeTimers();
    try {
      const desktopIdentity = testIdentity();
      const deviceStatic = generateX25519KeyPair();
      const { desktop, device, attachPhone } = createParkingRelayLoopback();
      const sendSpy = vi.spyOn(desktop, 'send');
      const session = new BridgeSession({
        identity: desktopIdentity,
        deviceId: 'device-1',
        remoteStaticPublicKey: deviceStatic.publicKey,
        capabilities: new Set(),
        transport: desktop,
      });

      session.start();

      // Assert WHILE the first park is still alive, not only after
      // attachPhone(): the post-attach assertions below hold whether the
      // parked window sent one msg1 (this guard) or several (a failed-probe
      // loop that kept re-initiating into the same buffer), because the
      // relay's park timeout below discards whatever accumulated either way
      // and attachPhone() only ever sees the ONE fresh msg1 sent after the
      // redial. Checked just short of the 60s park timeout, so this is still
      // the same parked connection the whole time.
      vi.advanceTimersByTime(MOCK_RELAY_PARK_TIMEOUT_MS - 1000);
      const parkedHandshakeFrames = sendSpy.mock.calls.filter(([frame]) => unwrapSessionFrame(frame).kind === SessionFrameKind.Handshake);
      expect(parkedHandshakeFrames).toHaveLength(1);

      // Past the relay's park timeout (60s) plus the redial backoff (500ms):
      // the FIRST parked connection is closed and its buffer discarded, and
      // a fresh one dials in and is parked again.
      vi.advanceTimersByTime(1000 + MOCK_RELAY_REDIAL_BACKOFF_MS);

      const responder = new ReestablishingResponder(deviceStatic, desktopIdentity.staticKeyPair.publicKey, device);
      attachPhone();

      expect(responder.establishedCount).toBe(1);
      expect(session.isEstablished).toBe(true);

      session.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it('reaches "offline" while parked, even though beginHandshake() is blocked from re-sending', () => {
    // The falsifying test for splitting the probe-budget bookkeeping off of
    // the send: without onPresenceProbeTimeout's unconditional
    // armPresenceTimer() call, blocking the re-send would also stop the
    // budget from ever reaching PEER_PRESENCE_FAILURES_BEFORE_ABSENT, and
    // the badge would rest on 'connecting' forever instead of reaching
    // 'offline'.
    vi.useFakeTimers();
    try {
      const desktopIdentity = testIdentity();
      const deviceStatic = generateX25519KeyPair();
      const { desktop } = createParkingRelayLoopback();
      const session = new BridgeSession({
        identity: desktopIdentity,
        deviceId: 'device-1',
        remoteStaticPublicKey: deviceStatic.publicKey,
        capabilities: new Set(['read-board']) as CapabilitySet,
        transport: desktop,
      });
      const peerAbsentEvents = vi.fn();
      session.on('peerAbsent', peerAbsentEvents);

      session.start();
      vi.advanceTimersByTime(10 * 1000);

      expect(session.connectionState).toBe('offline');
      expect(peerAbsentEvents).toHaveBeenCalledTimes(1);

      session.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it('re-parks with an empty buffer on a clean departure, so re-attaching does not force an extra rekey', () => {
    // The falsifying test for guarding on peerSeenOnThisConnection rather
    // than on peerPresence: a phone that just left cleanly leaves
    // peerPresence === 'present' behind (nothing demotes it on the way
    // down), so a guard keyed off THAT would sail a second msg1 into the
    // fresh park's buffer the moment the first presence probe (5s) timed
    // out - two rekeys on the very next arrival, in the most common
    // departure there is.
    vi.useFakeTimers();
    try {
      const desktopIdentity = testIdentity();
      const deviceStatic = generateX25519KeyPair();
      const { desktop, device, attachPhone, detachPhone } = createParkingRelayLoopback();
      const session = new BridgeSession({
        identity: desktopIdentity,
        deviceId: 'device-1',
        remoteStaticPublicKey: deviceStatic.publicKey,
        capabilities: new Set(['read-board']) as CapabilitySet,
        transport: desktop,
      });

      session.start();
      const responder = new ReestablishingResponder(deviceStatic, desktopIdentity.staticKeyPair.publicKey, device);
      attachPhone();
      expect(responder.establishedCount).toBe(1);
      expect(session.connectionState).toBe('connected');

      // The phone leaves; the relay force-closes the desktop's socket too
      // and it redials into a fresh, empty park.
      detachPhone();
      vi.advanceTimersByTime(MOCK_RELAY_REDIAL_BACKOFF_MS);

      // Idle well past the first presence-probe timeout (5s) in the fresh
      // park, and past the second (10s) that would demote peerPresence to
      // 'absent' on its own.
      vi.advanceTimersByTime(30 * 1000);

      attachPhone();

      // 1 from the first live session, 1 from this second park - never 3.
      expect(responder.establishedCount).toBe(2);

      session.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it('re-keys a still-parked connection on the REHANDSHAKE_INTERVAL_MS tick by REPLACING the outstanding msg1, not skipping it', () => {
    // Pins armRehandshakeTimer()'s `this.beginHandshake(true)` call
    // specifically: reverting it to a plain `this.beginHandshake()` leaves
    // the whole suite green today, because kangentic-relay's own 60s park
    // timeout always redials - and re-initiates via onTransportState()'s
    // 'connected' branch - well before the 120s rekey tick could ever land
    // on the same still-outstanding handshake. A self-hosted relay with no
    // park timeout (the case armRehandshakeTimer()'s own comment calls out)
    // has no such redial to mask it, so this test disables the double's park
    // timeout to reach that path directly.
    vi.useFakeTimers();
    try {
      const desktopIdentity = testIdentity();
      const deviceStatic = generateX25519KeyPair();
      const { desktop } = createParkingRelayLoopback({ disableParkTimeout: true });
      const sendSpy = vi.spyOn(desktop, 'send');
      const session = new BridgeSession({
        identity: desktopIdentity,
        deviceId: 'device-1',
        remoteStaticPublicKey: deviceStatic.publicKey,
        capabilities: new Set(),
        transport: desktop,
      });

      // No responder is ever attached: the connection stays parked,
      // unanswered, for the whole test - there is nothing to reply and clear
      // this.handshake, so it is still outstanding when the rekey tick fires.
      session.start();

      vi.advanceTimersByTime(2 * 60 * 1000);

      const handshakeFrames = sendSpy.mock.calls.filter(([frame]) => unwrapSessionFrame(frame).kind === SessionFrameKind.Handshake);
      // One at start(), one from the rekey tick REPLACING it. Without
      // replaceOutstanding the second would be blocked by beginHandshake()'s
      // own parked-slot guard, leaving this at 1.
      expect(handshakeFrames).toHaveLength(2);

      session.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it('re-sends a lost rekey msg1 on every probe timeout once the peer has proven the slot is live, not just once', () => {
    // Pins the `!this.peerSeenOnThisConnection` term of beginHandshake()'s
    // guard, specifically for its UN-blocking direction: dropping that term
    // (leaving only `this.handshake && !replaceOutstanding`) makes the guard
    // strictly MORE restrictive, and the existing "keeps reporting
    // 'connected' while a lost rekey drains the probe budget" test above
    // never notices, because it only asserts connectionState and a decoded-
    // message count - both hold whether or not the presence-probe path
    // actually re-sends anything. A live peer proven on a PAIRED slot (an
    // application frame the desktop can still open) is proof a dropped msg1
    // is genuinely lost rather than merely parked, so beginHandshake() must
    // keep re-sending it on every probe timeout while that evidence holds.
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
      expect(session.isEstablished).toBe(true);

      // From here the relay swallows our initiations, so the rekey below
      // never gets a reply and this.handshake stays outstanding - but the
      // phone keeps serving on its original streams, so it can still prove
      // the slot is live.
      responder.dropHandshakes = true;
      vi.advanceTimersByTime(2 * 60 * 1000); // The rekey tick sends the now-lost msg1.

      // Isolate the probe-driven re-initiations from the rekey tick's own
      // send above: only what happens from here is under test.
      const sendSpy = vi.spyOn(desktop, 'send');
      // Each iteration proves the slot is live just before its
      // presence-probe window (PEER_PRESENCE_TIMEOUT_MS, 5s) expires, so the
      // probe budget never spends and every window's beginHandshake() call
      // is the one under test.
      for (let tick = 0; tick < 4; tick += 1) {
        responder.sendApplicationMessage({ type: 'heartbeat' } as BridgeMessage);
        vi.advanceTimersByTime(5 * 1000);
      }

      const handshakeFrames = sendSpy.mock.calls.filter(([frame]) => unwrapSessionFrame(frame).kind === SessionFrameKind.Handshake);
      // One per probe window, not just once on the first timeout - the test
      // name's "on every probe timeout" claim, pinned exactly rather than
      // merely "more than one".
      expect(handshakeFrames).toHaveLength(4);

      session.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it('arms a fresh presence timer BEFORE re-initiating, not after, so a synchronous establishment cannot strand a stray probe on a healthy session', () => {
    // Pins the ORDER of armPresenceTimer() before beginHandshake() inside
    // onPresenceProbeTimeout(). On any in-process transport whose send()
    // resolves a handshake synchronously (every test double in this file),
    // calling beginHandshake() first lets handleHandshakeFrame()'s
    // clearPresenceTimer() run before the trailing armPresenceTimer() ever
    // executes. That trailing arm then has nothing to consume and leaves a
    // probe running on an ALREADY-ESTABLISHED session, which re-initiates and
    // re-arms itself again on its own timeout - rekeying a healthy session
    // every PEER_PRESENCE_TIMEOUT_MS (5s) forever instead of settling.
    vi.useFakeTimers();
    try {
      const desktopIdentity = testIdentity();
      const deviceStatic = generateX25519KeyPair();
      const { desktop, device } = createReconnectableLoopback();
      const responder = new ReestablishingResponder(deviceStatic, desktopIdentity.staticKeyPair.publicKey, device);
      // The FIRST msg1 goes unanswered, so a presence probe is genuinely
      // pending when the garbage frame below lands.
      responder.dropHandshakes = true;
      const session = new BridgeSession({
        identity: desktopIdentity,
        deviceId: 'device-1',
        remoteStaticPublicKey: deviceStatic.publicKey,
        capabilities: new Set(),
        transport: desktop,
      });

      session.start();
      expect(session.isEstablished).toBe(false);

      // A frame that fails unwrapSessionFrame outright - its first byte is
      // not a valid SessionFrameKind - unlike the "recovers from a garbled
      // handshake frame" test above, which wraps its garbage as a Handshake
      // frame and so sets this.handshake = null and schedules its own retry.
      // This one leaves this.handshake untouched while still proving, via
      // onFrame()'s unconditional peerSeenOnThisConnection = true, that the
      // slot is live.
      device.send(new Uint8Array([9, 9, 9, 9, 9]));

      // The relay is live again from here, so the probe timeout's
      // re-initiation below is answered synchronously.
      responder.dropHandshakes = false;

      vi.advanceTimersByTime(5 * 1000);
      expect(session.isEstablished).toBe(true);
      expect(responder.establishedCount).toBe(1);

      // Well past several more PEER_PRESENCE_TIMEOUT_MS windows. A correctly
      // cleared probe stays quiet; a stray one re-establishes every 5s.
      vi.advanceTimersByTime(30 * 1000);

      expect(responder.establishedCount).toBe(1);

      session.dispose();
    } finally {
      vi.useRealTimers();
    }
  });
});

/**
 * The revoke goodbye. A FrameTag.Final is only ever sent on deliberate
 * unpair - revokeDevice() says it, dispose() (quit, disable, shutdown)
 * never does - and it must only be sealed when the frame can actually
 * leave, because a sealed-but-dropped frame desyncs the phone's receive
 * counter and poisons every later frame on the stream.
 */
describe('BridgeSession.sendGoodbye', () => {
  function establishSession(transport: Transport, desktopIdentity: BridgeIdentity, devicePublicKey: Uint8Array): BridgeSession {
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

  it('seals exactly one Final the phone opens as a goodbye, leaving later sends intact', () => {
    const desktopIdentity = testIdentity();
    const deviceStatic = generateX25519KeyPair();
    const [desktopTransport, deviceTransport] = createLoopbackTransportPair();
    const responder = new SimulatedDeviceResponder(deviceStatic, desktopIdentity.staticKeyPair.publicKey, deviceTransport);
    const session = establishSession(desktopTransport, desktopIdentity, deviceStatic.publicKey);
    expect(session.isEstablished).toBe(true);

    session.sendGoodbye();

    expect(responder.receivedGoodbyes).toBe(1);
    expect(responder.receivedMessages).toEqual([]);
    // The goodbye spent one counter slot legitimately: a later frame on the
    // same stream still opens, so the counters stayed aligned.
    session.sendMessage({ type: 'heartbeat' });
    expect(responder.receivedMessages).toEqual([{ type: 'heartbeat' }]);

    session.dispose();
  });

  it('sends nothing before the session is established', () => {
    const desktopIdentity = testIdentity();
    const deviceStatic = generateX25519KeyPair();
    // No responder is attached, so the initiation goes unanswered.
    const { desktop } = createReconnectableLoopback();
    const session = establishSession(desktop, desktopIdentity, deviceStatic.publicKey);
    expect(session.isEstablished).toBe(false);

    const sendSpy = vi.spyOn(desktop, 'send');
    expect(() => session.sendGoodbye()).not.toThrow();

    const applicationFrames = sendSpy.mock.calls.filter(([frame]) => unwrapSessionFrame(frame).kind === SessionFrameKind.Application);
    expect(applicationFrames).toEqual([]);

    session.dispose();
  });

  it('sends nothing and does not throw while the transport is disconnected', () => {
    const desktopIdentity = testIdentity();
    const deviceStatic = generateX25519KeyPair();
    const { desktop, device, setDesktopState } = createReconnectableLoopback();
    new SimulatedDeviceResponder(deviceStatic, desktopIdentity.staticKeyPair.publicKey, device);
    const session = establishSession(desktop, desktopIdentity, deviceStatic.publicKey);
    expect(session.isEstablished).toBe(true);

    // A blip, not a teardown: the session still holds streams, but the
    // socket cannot carry a frame. The transport-state guard is the only
    // thing standing between this call and a burned counter slot.
    setDesktopState('reconnecting');
    const sendSpy = vi.spyOn(desktop, 'send');
    expect(() => session.sendGoodbye()).not.toThrow();
    expect(sendSpy).not.toHaveBeenCalled();

    session.dispose();
  });

  it('dispose() never sends a goodbye - Final means unpair, never shutdown', () => {
    const desktopIdentity = testIdentity();
    const deviceStatic = generateX25519KeyPair();
    const [desktopTransport, deviceTransport] = createLoopbackTransportPair();
    const responder = new SimulatedDeviceResponder(deviceStatic, desktopIdentity.staticKeyPair.publicKey, deviceTransport);
    const session = establishSession(desktopTransport, desktopIdentity, deviceStatic.publicKey);
    expect(session.isEstablished).toBe(true);

    const sendSpy = vi.spyOn(desktopTransport, 'send');
    session.dispose();

    const applicationFrames = sendSpy.mock.calls.filter(([frame]) => unwrapSessionFrame(frame).kind === SessionFrameKind.Application);
    expect(applicationFrames).toEqual([]);
    expect(responder.receivedGoodbyes).toBe(0);
  });
});
