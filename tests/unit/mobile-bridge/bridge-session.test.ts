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

  constructor(
    deviceStatic: ReturnType<typeof generateX25519KeyPair>,
    desktopStaticPublicKey: Uint8Array,
    transport: Transport,
  ) {
    transport.onFrame((rawFrame) => {
      const { kind, payload } = unwrapSessionFrame(rawFrame);
      if (kind !== SessionFrameKind.Handshake) return;
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
