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
});
