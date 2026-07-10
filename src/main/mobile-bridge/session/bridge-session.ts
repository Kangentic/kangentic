import { EventEmitter } from 'node:events';
import {
  createKKHandshake,
  decodeMessage,
  deriveSecretstreamPair,
  encodeMessage,
  FrameTag,
  SessionFrameKind,
  unwrapSessionFrame,
  wrapSessionFrame,
  type BridgeMessage,
  type CapabilitySet,
  type HandshakeState,
  type SecretstreamDirectionPair,
  type Transport,
} from '@kangentic/protocol';
import type { BridgeIdentity } from '../identity';

/** WireGuard's REKEY_AFTER_TIME: bounded post-compromise security via periodic re-handshake, not just initial forward secrecy. */
const REHANDSHAKE_INTERVAL_MS = 2 * 60 * 1000;

export interface BridgeSessionOptions {
  identity: BridgeIdentity;
  deviceId: string;
  remoteStaticPublicKey: Uint8Array;
  capabilities: CapabilitySet;
  transport: Transport;
}

/**
 * One connected device's secure session: the desktop always initiates the
 * Noise KK handshake (both statics already pinned via the roster), so it
 * owns the ~2-minute re-handshake timer - it is the always-on, source-of-truth
 * side, so it is the natural side to drive that timing rather than
 * waiting on the phone. Once established, application traffic
 * (wire/messages.ts's BridgeMessage envelope) flows over secretstream
 * framing keyed off the Noise session's chaining key.
 *
 * Phase 1 wires this session lifecycle and message transport; it does
 * NOT dispatch capability-request messages to real handlers (that is
 * Phase 2's capability router filling in). `capabilities` is carried here
 * so Phase 2 has it ready to enforce.
 */
export class BridgeSession extends EventEmitter {
  private readonly identity: BridgeIdentity;
  readonly deviceId: string;
  readonly remoteStaticPublicKey: Uint8Array;
  capabilities: CapabilitySet;
  private readonly transport: Transport;

  private handshake: HandshakeState | null = null;
  private streams: SecretstreamDirectionPair | null = null;
  private rehandshakeTimer: ReturnType<typeof setInterval> | null = null;
  private unsubscribeFrame: (() => void) | null = null;
  private disposed = false;

  constructor(options: BridgeSessionOptions) {
    super();
    this.identity = options.identity;
    this.deviceId = options.deviceId;
    this.remoteStaticPublicKey = options.remoteStaticPublicKey;
    this.capabilities = options.capabilities;
    this.transport = options.transport;
  }

  get isEstablished(): boolean {
    return this.streams !== null;
  }

  start(): void {
    if (this.unsubscribeFrame) throw new Error('BridgeSession.start() called twice');
    this.unsubscribeFrame = this.transport.onFrame((frame) => this.onFrame(frame));
    this.beginHandshake();
    this.rehandshakeTimer = setInterval(() => this.beginHandshake(), REHANDSHAKE_INTERVAL_MS);
    this.rehandshakeTimer.unref?.();
  }

  private beginHandshake(): void {
    if (this.disposed) return;
    this.handshake = createKKHandshake({
      initiator: true,
      localStatic: this.identity.staticKeyPair,
      remoteStatic: this.remoteStaticPublicKey,
    });
    const { message } = this.handshake.writeMessage(new Uint8Array(0));
    this.transport.send(wrapSessionFrame(SessionFrameKind.Handshake, message));
  }

  private onFrame(rawFrame: Uint8Array): void {
    if (this.disposed) return;
    let unwrapped: { kind: SessionFrameKind; payload: Uint8Array };
    try {
      unwrapped = unwrapSessionFrame(rawFrame);
    } catch (error) {
      this.emit('frameRejected', error);
      return;
    }
    if (unwrapped.kind === SessionFrameKind.Handshake) {
      this.handleHandshakeFrame(unwrapped.payload);
    } else {
      this.handleApplicationFrame(unwrapped.payload);
    }
  }

  private handleHandshakeFrame(payload: Uint8Array): void {
    if (!this.handshake) {
      this.emit('handshakeFailed', new Error('Received a handshake frame with no handshake in progress'));
      return;
    }
    let readResult: ReturnType<HandshakeState['readMessage']>;
    try {
      readResult = this.handshake.readMessage(payload);
    } catch (error) {
      this.emit('handshakeFailed', error);
      return;
    }
    if (!readResult.split) {
      // KK is exactly two messages; reading the responder's reply always completes it.
      this.emit('handshakeFailed', new Error('KK handshake did not complete after the expected two messages'));
      return;
    }
    const chainingKey = this.handshake.getChainingKey();
    this.streams = deriveSecretstreamPair(chainingKey, true);
    this.handshake = null;
    this.emit('established');
  }

  private handleApplicationFrame(payload: Uint8Array): void {
    if (!this.streams) {
      // A stray application frame arriving before the first handshake
      // completed, or after this session was disposed - ignore rather
      // than throw, since a peer can legitimately race a reconnect.
      return;
    }
    let opened: ReturnType<SecretstreamDirectionPair['receive']['open']>;
    try {
      opened = this.streams.receive.open(payload);
    } catch (error) {
      this.emit('frameRejected', error);
      return;
    }
    if (opened.tag === FrameTag.Final) {
      this.emit('remoteClosed');
      return;
    }
    let message: BridgeMessage;
    try {
      message = decodeMessage(opened.plaintext);
    } catch (error) {
      this.emit('frameRejected', error);
      return;
    }
    this.emit('message', message);
  }

  sendMessage(message: BridgeMessage): void {
    if (!this.streams) throw new Error('BridgeSession is not established yet');
    const frame = this.streams.send.seal(encodeMessage(message));
    this.transport.send(wrapSessionFrame(SessionFrameKind.Application, frame));
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.rehandshakeTimer) {
      clearInterval(this.rehandshakeTimer);
      this.rehandshakeTimer = null;
    }
    this.unsubscribeFrame?.();
    this.unsubscribeFrame = null;
    this.handshake = null;
    this.streams = null;
  }
}
