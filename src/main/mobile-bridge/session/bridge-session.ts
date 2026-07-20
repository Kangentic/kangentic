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
  type TransportState,
} from '@kangentic/protocol';
import type { BridgeIdentity } from '../identity';

/** WireGuard's REKEY_AFTER_TIME: bounded post-compromise security via periodic re-handshake, not just initial forward secrecy. */
const REHANDSHAKE_INTERVAL_MS = 2 * 60 * 1000;

/**
 * Fast recovery after a failed handshake read. A KK read can fail on a garbled,
 * duplicated, or maliciously-injected Handshake frame (the blind relay is a
 * named adversary); the corrupted handshake is dropped and a fresh initiation
 * is scheduled this soon rather than stalling until the next rehandshake tick.
 * This retry is driven ONLY by an actual failed read, never by a quiet wait, so
 * a parked socket with no peer never floods the relay with buffered msg1s.
 */
const HANDSHAKE_RETRY_MS = 3 * 1000;

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
  private handshakeRetryTimer: ReturnType<typeof setTimeout> | null = null;
  private unsubscribeFrame: (() => void) | null = null;
  private unsubscribeState: (() => void) | null = null;
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
    // Re-initiate the handshake on every (re)connect, not just once. The relay
    // force-closes BOTH peers when either drops, so a phone reload tears down
    // this desktop socket too; the relay client reconnects in ~500ms but the
    // phone then waits passively for us to initiate. Without this, that only
    // happened on the next REHANDSHAKE_INTERVAL_MS tick - up to a 2-minute stall.
    this.unsubscribeState = this.transport.onStateChange((state) => this.onTransportState(state));
    // connect() is awaited before start(), so the initial 'connected' edge fired
    // before we subscribed above and the listener missed it; kick the first
    // handshake from the current state. Subsequent 'connected' edges (reconnects)
    // are driven by the listener.
    if (this.transport.state === 'connected') this.beginHandshake();
  }

  private onTransportState(state: TransportState): void {
    if (this.disposed) return;
    if (state === 'connected') {
      // A reconnect (the initial connect was handled in start()). Re-initiate
      // immediately so the phone re-establishes in ~1s instead of waiting out
      // the rekey interval.
      this.beginHandshake();
      return;
    }
    // Left 'connected' (reconnecting / closed). The relay tore the phone's
    // socket down too, so it has discarded its secretstream keys; drop ours so
    // we never seal a frame with keys the phone can no longer open, and abandon
    // any half-finished handshake or pending retry. The next 'connected' edge
    // re-initiates.
    this.streams = null;
    this.handshake = null;
    this.clearHandshakeRetryTimer();
  }

  private beginHandshake(): void {
    if (this.disposed) return;
    // The rekey interval can fire while the transport is mid-reconnect; sending
    // then would throw. Skip - onTransportState re-initiates on the next connect.
    if (this.transport.state !== 'connected') return;
    // A fresh initiation supersedes any pending failure retry.
    this.clearHandshakeRetryTimer();
    this.handshake = createKKHandshake({
      initiator: true,
      localStatic: this.identity.staticKeyPair,
      remoteStatic: this.remoteStaticPublicKey,
    });
    const { message } = this.handshake.writeMessage(new Uint8Array(0));
    this.transport.send(wrapSessionFrame(SessionFrameKind.Handshake, message));
    // Re-arm the rekey timer from this handshake (WireGuard REKEY_AFTER_TIME is
    // measured from the last handshake), so a reconnect-driven initiation resets
    // the clock rather than leaving a redundant tick queued moments later.
    this.armRehandshakeTimer();
  }

  private armRehandshakeTimer(): void {
    if (this.rehandshakeTimer) clearInterval(this.rehandshakeTimer);
    this.rehandshakeTimer = setInterval(() => this.beginHandshake(), REHANDSHAKE_INTERVAL_MS);
    this.rehandshakeTimer.unref?.();
  }

  private scheduleHandshakeRetry(): void {
    // At most one retry outstanding: under a frame flood this caps re-initiation
    // to one msg1 per HANDSHAKE_RETRY_MS rather than one per bad frame.
    if (this.disposed || this.handshakeRetryTimer || this.isEstablished) return;
    this.handshakeRetryTimer = setTimeout(() => {
      this.handshakeRetryTimer = null;
      // beginHandshake self-guards on transport state and disposal.
      this.beginHandshake();
    }, HANDSHAKE_RETRY_MS);
    this.handshakeRetryTimer.unref?.();
  }

  private clearHandshakeRetryTimer(): void {
    if (this.handshakeRetryTimer) {
      clearTimeout(this.handshakeRetryTimer);
      this.handshakeRetryTimer = null;
    }
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
      // readMessage is NOT transactional: a failed read has already advanced the
      // handshake's internal message index and mixed the bogus ephemeral in, so
      // the object can never complete - even the legitimate reply would now fail.
      // Drop it and schedule a fresh initiation rather than leaving a half-open
      // handshake that wedges this device until the next rehandshake tick.
      this.handshake = null;
      this.emit('handshakeFailed', error);
      this.scheduleHandshakeRetry();
      return;
    }
    if (!readResult.split) {
      // KK is exactly two messages; reading the responder's reply always completes it.
      this.handshake = null;
      this.emit('handshakeFailed', new Error('KK handshake did not complete after the expected two messages'));
      this.scheduleHandshakeRetry();
      return;
    }
    const chainingKey = this.handshake.getChainingKey();
    this.streams = deriveSecretstreamPair(chainingKey, true);
    this.handshake = null;
    this.clearHandshakeRetryTimer();
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
    this.clearHandshakeRetryTimer();
    this.unsubscribeFrame?.();
    this.unsubscribeFrame = null;
    this.unsubscribeState?.();
    this.unsubscribeState = null;
    this.handshake = null;
    this.streams = null;
    // The session owns its per-device transport (created alongside it in
    // openSessionForDevice); closing it here stops RelayClient's reconnect
    // loop from outliving a revoked or disabled session.
    this.transport.close();
  }
}
