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
import type { MobileDeviceConnectionState } from '../../../shared/types';
import type { BridgeIdentity } from '../identity';

/** WireGuard's REKEY_AFTER_TIME: bounded post-compromise security via periodic re-handshake, not just initial forward secrecy. */
const REHANDSHAKE_INTERVAL_MS = 2 * 60 * 1000;

/**
 * Fast recovery after a failed handshake read. A KK read can fail on a garbled,
 * duplicated, or maliciously-injected Handshake frame (the blind relay is a
 * named adversary); the corrupted handshake is dropped and a fresh initiation
 * is scheduled this soon rather than stalling until the next rehandshake tick.
 * This retry is driven ONLY by an actual failed read, never by a quiet wait, so
 * a bad-frame flood cannot make us answer with a msg1 per bad frame. The quiet
 * wait has its own, far slower cadence - see PEER_PROBE_INTERVAL_MS.
 */
const HANDSHAKE_RETRY_MS = 3 * 1000;

/**
 * How long an initiation waits for the peer's reply before it counts as a
 * failed presence probe. Generous: a KK reply is a single round trip over an
 * already-open socket, so this only expires when nobody is listening.
 */
const PEER_PRESENCE_TIMEOUT_MS = 5 * 1000;

/**
 * Consecutive failed probes before the peer is reported absent. Two rather
 * than one so a single slow round trip never flashes 'offline' on a phone that
 * is really there; the cost is that 'offline' takes ~10s to appear.
 */
const PEER_PRESENCE_FAILURES_BEFORE_ABSENT = 2;

/**
 * Re-probe cadence once the peer is known absent. Without it, beginHandshake()
 * only re-runs on the REHANDSHAKE_INTERVAL_MS tick, so a phone that came back
 * would keep reporting 'offline' for up to two minutes. Combined with the
 * timeout above this is one ~48-byte msg1 per ~20s per absent device, which is
 * why the quiet wait cannot flood a parked slot.
 */
const PEER_PROBE_INTERVAL_MS = 15 * 1000;

/**
 * How long a known-good session keeps reporting 'connected' while its
 * transport reconnects and re-handshakes. The relay force-closes BOTH peers
 * when either drops, so an ordinary phone reload costs a ~500ms reconnect
 * (RelayClient's INITIAL_BACKOFF_MS) plus one handshake round trip. Without
 * this hold the UI would flicker connected -> reconnecting -> connecting ->
 * connected on every reload.
 */
const RECONNECT_GRACE_MS = 2 * 1000;

/**
 * Whether the phone is actually attached to this device's relay slot, which
 * the transport alone cannot answer: the desktop's socket reads 'connected'
 * whenever the relay is up and the slot is dialable, with the phone powered
 * off. Demoted only by EVIDENCE (an explicit goodbye, or a spent probe
 * budget), never by a transport transition - that hysteresis is what lets a
 * known-good session ride out a relay blip.
 */
type PeerPresence = 'unknown' | 'present' | 'absent';

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

  private peerPresence: PeerPresence = 'unknown';
  private failedPresenceProbes = 0;
  private presenceTimer: ReturnType<typeof setTimeout> | null = null;
  private absentProbeTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectGraceTimer: ReturnType<typeof setTimeout> | null = null;

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

  /** The underlying transport's current connection state, for the service's aggregate MobileBridgeStatus.relayState. */
  get transportState(): TransportState {
    return this.transport.state;
  }

  /**
   * What this device's row in Settings > Mobile Devices reports: the transport
   * state refined by whether the phone is actually attached. `transportState`
   * alone cannot answer that - it reads 'connected' whenever the relay is up
   * and the slot is dialable, phone or no phone - so a badge driven by it
   * shows a green "Connected" for a powered-off device.
   *
   * Changes to this value are announced with the 'connectionState' event; the
   * service turns that into the renderer's 'stateChanged' notification.
   */
  get connectionState(): MobileDeviceConnectionState {
    // A known-good session riding out a sub-second relay blip: hold the last
    // good value rather than flickering through the reconnect AND the
    // re-handshake that follows it.
    if (this.reconnectGraceTimer) return 'connected';
    const transport = this.transport.state;
    if (transport !== 'connected') return transport;
    if (this.peerPresence === 'present' && this.isEstablished) return 'connected';
    // Checked independently of isEstablished: a rekey that silently goes
    // unanswered spends the probe budget while the old streams are still
    // held, which is exactly how a phone that died without the relay
    // noticing gets reported.
    if (this.peerPresence === 'absent') return 'offline';
    return 'connecting';
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
    // Roster sessions start() BEFORE their fire-and-forget connect(), so the
    // listener above drives the first handshake on the initial 'connected'
    // edge. The kick below covers a caller that connected the transport before
    // start() - that edge fired before we subscribed and the listener missed it.
    if (this.transport.state === 'connected') this.beginHandshake();
  }

  private onTransportState(state: TransportState): void {
    if (this.disposed) return;
    if (state === 'connected') {
      // A fresh socket gets a fresh probe budget. The reconnect grace (if one
      // is armed) deliberately stays armed until the handshake actually
      // completes: the flicker it suppresses spans the re-handshake too.
      this.failedPresenceProbes = 0;
    } else if (this.peerPresence === 'present') {
      this.armReconnectGrace();
    }
    // Emitted before the branch below (and its early return) so every
    // transition - including into 'connected' - reaches the service's
    // relayState aggregation, not just the ones that fall through.
    this.emit('transportState', state);
    this.emit('connectionState');
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
    // No socket means no probe can be answered; the transport branch of
    // connectionState governs the badge until the next 'connected' edge.
    this.clearPresenceTimer();
    this.clearAbsentProbeTimer();
  }

  /**
   * Holds the last known-good 'connected' across a brief transport outage.
   * Cleared by a completed handshake (the blip healed and the badge never
   * moved) or by its own expiry, which MUST notify - a silent expiry would
   * strand the badge on a stale 'connected' with nothing to trigger a re-read.
   */
  private armReconnectGrace(): void {
    if (this.reconnectGraceTimer) return;
    this.reconnectGraceTimer = setTimeout(() => {
      this.reconnectGraceTimer = null;
      if (this.disposed) return;
      this.emit('connectionState');
    }, RECONNECT_GRACE_MS);
    this.reconnectGraceTimer.unref?.();
  }

  private clearReconnectGrace(): void {
    if (!this.reconnectGraceTimer) return;
    clearTimeout(this.reconnectGraceTimer);
    this.reconnectGraceTimer = null;
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
    // Every initiation doubles as a presence probe: a reply proves the phone is
    // attached to this slot, silence eventually proves it is not. Armed BEFORE
    // the send, because a peer that replies synchronously (any in-process
    // transport, and every test double) completes the handshake inside send()
    // - arming afterwards would leave a probe nothing can ever cancel.
    this.armPresenceTimer();
    this.transport.send(wrapSessionFrame(SessionFrameKind.Handshake, message));
    // Re-arm the rekey timer from this handshake (WireGuard REKEY_AFTER_TIME is
    // measured from the last handshake), so a reconnect-driven initiation resets
    // the clock rather than leaving a redundant tick queued moments later.
    this.armRehandshakeTimer();
  }

  /**
   * Anchors the probe deadline to the START of an unestablished episode, not to
   * each initiation: an open window is never restarted. Otherwise the
   * HANDSHAKE_RETRY_MS (3s) path, which re-initiates faster than this window
   * expires, would push the deadline out on every retry - so a relay injecting
   * garbage handshake frames could hold 'offline' permanently out of reach and
   * pin the badge on "Connecting..." forever, the exact stuck-transient-state
   * bug this file's connectionState exists to remove.
   */
  private armPresenceTimer(): void {
    if (this.presenceTimer) return;
    this.presenceTimer = setTimeout(() => {
      this.presenceTimer = null;
      this.onPresenceProbeTimeout();
    }, PEER_PRESENCE_TIMEOUT_MS);
    this.presenceTimer.unref?.();
  }

  private clearPresenceTimer(): void {
    if (!this.presenceTimer) return;
    clearTimeout(this.presenceTimer);
    this.presenceTimer = null;
  }

  /**
   * The initiation went unanswered. Spend one unit of the probe budget and try
   * again; only a fully spent budget concludes the peer is absent, so a single
   * slow round trip never flashes 'offline' on a phone that is really there.
   */
  private onPresenceProbeTimeout(): void {
    if (this.disposed) return;
    if (this.transport.state !== 'connected') return;
    this.failedPresenceProbes += 1;
    if (this.failedPresenceProbes < PEER_PRESENCE_FAILURES_BEFORE_ABSENT) {
      this.beginHandshake();
      return;
    }
    this.markPeerAbsent();
  }

  /**
   * Promotion is evidence-based, mirroring the demotion rule above: a frame we
   * could OPEN proves the phone is attached to this slot, because only it holds
   * the matching send key. Without this, presence rests on the handshake alone,
   * and an initiation that simply never arrives (one dropped msg1 on a lossy
   * relay - a rekey happens every REHANDSHAKE_INTERVAL_MS, so there is a fresh
   * chance every two minutes) spends the whole probe budget while the phone,
   * never having learned a rekey was attempted, keeps serving on the streams we
   * are still decrypting. That reported 'offline' for a device demonstrably
   * sending data: the exact mirror of the stale green "Connected" this file's
   * connectionState exists to remove.
   */
  private notePeerPresent(): void {
    // Restart the budget on every proof of life, so only genuinely UNANSWERED
    // probe windows accumulate toward 'absent'.
    this.failedPresenceProbes = 0;
    if (this.peerPresence === 'present') return;
    this.peerPresence = 'present';
    this.clearAbsentProbeTimer();
    this.emit('connectionState');
  }

  private markPeerAbsent(): void {
    const changed = this.peerPresence !== 'absent';
    this.peerPresence = 'absent';
    this.failedPresenceProbes = PEER_PRESENCE_FAILURES_BEFORE_ABSENT;
    // The peer is gone, so a held 'connected' is no longer defensible.
    this.clearReconnectGrace();
    this.scheduleAbsentProbe();
    if (changed) {
      // The absence EDGE, for per-device state that must not outlive the
      // phone. The routine departure is SILENT - backgrounding, a lost
      // network, the OS killing the app all send no Final frame - so state
      // keyed to 'remoteClosed' alone (the subscription registries, and with
      // them the resting park's terminal-stream gate and the bottom panel's
      // dropped tab) would persist for a phone nobody is holding. Recovery is
      // the same contract 'remoteClosed' already relies on: the phone re-arms
      // every subscription with fresh read-* requests when it reconnects.
      this.emit('peerAbsent');
      this.emit('connectionState');
    }
  }

  /** Keeps probing a slot whose peer is absent, so a phone that comes back is picked up in ~20s rather than on the next rekey tick. */
  private scheduleAbsentProbe(): void {
    if (this.absentProbeTimer) return;
    this.absentProbeTimer = setTimeout(() => {
      this.absentProbeTimer = null;
      if (this.disposed || this.transport.state !== 'connected') return;
      // beginHandshake() re-arms the presence timer, so a phone that came back
      // re-establishes here instead of waiting out REHANDSHAKE_INTERVAL_MS.
      this.beginHandshake();
    }, PEER_PROBE_INTERVAL_MS);
    this.absentProbeTimer.unref?.();
  }

  private clearAbsentProbeTimer(): void {
    if (!this.absentProbeTimer) return;
    clearTimeout(this.absentProbeTimer);
    this.absentProbeTimer = null;
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
    // The peer answered: it is attached to this slot. Retire the probe budget
    // and drop any reconnect hold - if one was armed, the blip healed inside
    // it and the badge never moved.
    this.clearPresenceTimer();
    this.clearAbsentProbeTimer();
    this.failedPresenceProbes = 0;
    this.peerPresence = 'present';
    this.clearReconnectGrace();
    this.emit('established');
    this.emit('connectionState');
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
      // An explicit goodbye is unambiguous, so it skips the probe budget the
      // silent case has to spend. `streams` is deliberately left intact: this
      // side's send stream is independent, and clearing it would change push
      // presence suppression and the send path (see the class doc). The
      // service escalates 'remoteClosed' to a full device drop - a Final is
      // only ever a deliberate unpair - but that is its decision; the
      // session-level contract here stays presence-only.
      this.markPeerAbsent();
      this.emit('remoteClosed');
      return;
    }
    // Checked AFTER the goodbye above, so a Final frame demotes rather than
    // briefly promoting on its way out.
    this.notePeerPresent();
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

  /**
   * Seals an empty FrameTag.Final frame - the revoke goodbye, the mirror of
   * the phone's own unpair Final. Not a sendMessage() tag parameter on
   * purpose: it is the only frame with no BridgeMessage inside, and callers
   * should not be able to tag an ordinary message Final by accident.
   * Sealing burns a send-counter slot, so it only seals when the frame can
   * actually leave: a frame sealed and then dropped by a disconnected
   * transport would desync the phone's receive counter and poison every
   * later frame on this stream. Never throws - it runs first in the revoke
   * chain, and a failed goodbye must not stop the revoke. A Final is only
   * ever sent on deliberate unpair; dispose() (quit, disable, shutdown)
   * stays silent by contract.
   */
  sendGoodbye(): void {
    if (this.disposed || !this.streams) return;
    if (this.transport.state !== 'connected') return;
    try {
      const frame = this.streams.send.seal(new Uint8Array(0), FrameTag.Final);
      this.transport.send(wrapSessionFrame(SessionFrameKind.Application, frame));
    } catch {
      // The socket dropped between the check and the send; the phone's own
      // disconnect handling covers this case.
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.rehandshakeTimer) {
      clearInterval(this.rehandshakeTimer);
      this.rehandshakeTimer = null;
    }
    this.clearHandshakeRetryTimer();
    // Only clearReconnectGrace() is observable on its own: the presence and
    // absent-probe callbacks already self-guard on `disposed`, so those two are
    // defense-in-depth against a future edit dropping a guard. Keep all three -
    // the dispose tests pin each one independently via the live timer count.
    this.clearPresenceTimer();
    this.clearAbsentProbeTimer();
    this.clearReconnectGrace();
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
