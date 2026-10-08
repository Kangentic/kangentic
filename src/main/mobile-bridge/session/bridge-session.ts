import { EventEmitter } from 'node:events';
import {
  createKKHandshake,
  decodeMessage,
  deriveSecretstreamPair,
  encodeMessage,
  FrameTag,
  isUnsupportedVerbError,
  RESPONSE_TOO_LARGE_ERROR_CODE,
  SessionFrameKind,
  UNSUPPORTED_VERB_ERROR_CODE,
  unwrapSessionFrame,
  wrapSessionFrame,
  type BridgeMessage,
  type CapabilityResponseMessage,
  type CapabilitySet,
  type HandshakeState,
  type SecretstreamDirectionPair,
  type Transport,
  type TransportState,
} from '@kangentic/protocol';
import type { MobileDeviceConnectionState } from '../../../shared/types';
import type { BridgeIdentity } from '../identity';
import { isRedialableTransport } from '../transport/relay-client';
import { FORCED_REDIAL_DESCRIPTIONS, type ForcedRedialReason } from './forced-redial-reason';

/** WireGuard's REKEY_AFTER_TIME: bounded post-compromise security via periodic re-handshake, not just initial forward secrecy. */
const REHANDSHAKE_INTERVAL_MS = 2 * 60 * 1000;

/**
 * Fast recovery after a failed handshake read. A KK read can fail on a garbled,
 * duplicated, or maliciously-injected Handshake frame (the blind relay is a
 * named adversary); the corrupted handshake is dropped and a fresh initiation
 * is scheduled this soon rather than stalling until the next rehandshake tick.
 * This retry is driven ONLY by an actual failed read, never by a quiet wait, so
 * a bad-frame flood cannot make us answer with a msg1 per bad frame. The quiet
 * wait has its own, far slower cadence - see PEER_PRESENCE_TIMEOUT_MS.
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
 *
 * There is deliberately no separate re-probe loop once absent: while the
 * relay's slot is parked (waiting for the phone), any further msg1 we send
 * only accumulates in the relay's parked-slot buffer alongside the one
 * already sitting there (kangentic-relay's SlotTable.pair() flushes the whole
 * buffer, in order, the instant the phone attaches) - so a second initiation
 * does not speed up recovery, it forces the phone through an extra rekey the
 * moment it arrives (#635). The relay's own park timeout (60s, PARK_TIMEOUT_MS
 * in kangentic-relay) closes a parked socket and RelayClient redials, which is
 * what re-initiates a stale attempt; see beginHandshake()'s guard.
 *
 * A spent budget is ALSO the one liveness verdict the transport cannot reach
 * on its own. A socket the relay already reaped (its keepalive terminates a
 * peer that misses a pong) never receives that park-timeout close, yet still
 * reads 'connected' here: a router restart left four such sockets ESTABLISHED
 * for 31 minutes while the relay had nothing for this desktop at all. So when
 * the budget is spent on a socket that carried NOTHING inbound for the whole
 * episode, and the socket is one the relay's park timeout could not have
 * been about to close anyway (see onPresenceProbeTimeout()), the session
 * abandons it and redials. A wrong verdict costs the phone one bounce (the
 * relay closes its half with PEER_CLOSED, it redials in 500 ms and
 * re-handshakes); today that same verdict already reported 'offline' and
 * dropped the phone's subscriptions.
 */
const PEER_PRESENCE_FAILURES_BEFORE_ABSENT = 2;

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
 * The longest a rekey holds application frames waiting for the phone's msg2:
 * the whole presence budget. A reply that stalls past one window still lands
 * inside it (the re-probe's second msg1 is answered in order, see
 * handleHandshakeFrame), so the frames go out under the keys the phone ended
 * on rather than being lost; past the budget the phone is reported absent,
 * and the frames go out under the keys the session still holds, which is what
 * every frame did before the hold existed. Relay stalls measured on the
 * hosted relay on 2026-10-07 ran 1-5 s per direction, so a 5 s hold alone
 * released into exactly the window where the phone had already switched.
 */
const REKEY_HOLD_MAX_MS = PEER_PRESENCE_TIMEOUT_MS * PEER_PRESENCE_FAILURES_BEFORE_ABSENT;

/**
 * The most encoded bytes a rekey holds before it releases early under the
 * keys the session still holds, as the deadline does. A busy terminal stream
 * can push several MB a second, and the hold would otherwise keep all of it
 * for up to REKEY_HOLD_MAX_MS and then seal it in one synchronous burst.
 */
const REKEY_HOLD_MAX_BYTES = 8 * 1024 * 1024;

/**
 * Initiations kept for a stalled reply. At this many, no further msg1 is sent
 * (see beginHandshake), so every reply the phone can send belongs to one the
 * desktop still holds. The cost lands only on a phone that never answers
 * msg1s yet keeps serving: rekeys pause until the next reconnect, and the
 * session keeps working on the keys it has.
 */
const MAX_OUTSTANDING_HANDSHAKES = 8;

/**
 * Why a rekey hold ended, carried on the 'rekeyHoldReleased' event. Only
 * 'established' seals under the new keys; every other reason seals under the
 * keys the session still holds, or discards on a dead transport.
 */
export type RekeyHoldReleaseReason = 'established' | 'deadline' | 'overflow' | 'read-failed' | 'send-failed' | 'dispose';

/**
 * Whether the phone is actually attached to this device's relay slot, which
 * the transport alone cannot answer: the desktop's socket reads 'connected'
 * whenever the relay is up and the slot is dialable, with the phone powered
 * off. Demoted only by EVIDENCE (an explicit goodbye, or a spent probe
 * budget), never by a transport transition - that hysteresis is what lets a
 * known-good session ride out a relay blip.
 */
type PeerPresence = 'unknown' | 'present' | 'absent';

/**
 * A message that could not be encoded, which today means it was over the
 * protocol's frame caps (MAX_DECODED_LENGTH before compression,
 * MAX_FRAME_LENGTH after). Thrown BEFORE anything is sealed, so no send-counter
 * slot is burned and the caller can still answer on the same stream: a
 * capability response this big is replaced with a short refusal instead of
 * leaving the phone to time out.
 */
export class MessageEncodeError extends Error {
  constructor(cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause));
    this.name = 'MessageEncodeError';
  }
}

/** The error a capability response carries when the response it replaces was over the frame caps. */
export const RESPONSE_TOO_LARGE_ERROR = 'Response too large to send';

/**
 * The refusal the service sends in place of a response over the frame caps,
 * for a verb that has no way to send less. It carries the `response-too-large`
 * code so a phone can tell it from a refusal that means the target is gone.
 * `read-stream` never reaches it, because that handler shrinks its terminal
 * seed to fit before it answers.
 */
export function responseTooLargeRefusal(requestId: string): CapabilityResponseMessage {
  return { type: 'capability-response', requestId, ok: false, error: RESPONSE_TOO_LARGE_ERROR, code: RESPONSE_TOO_LARGE_ERROR_CODE };
}

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

  /**
   * Initiations sent and not yet answered, oldest first. Usually zero or one;
   * a second appears when a reply stalls past the presence window and the
   * re-probe sends another msg1 (see handleHandshakeFrame). Bounded by
   * MAX_OUTSTANDING_HANDSHAKES: at the cap no further msg1 is sent.
   */
  private outstandingHandshakes: HandshakeState[] = [];
  private streams: SecretstreamDirectionPair | null = null;
  private rehandshakeTimer: ReturnType<typeof setInterval> | null = null;
  private handshakeRetryTimer: ReturnType<typeof setTimeout> | null = null;
  private unsubscribeFrame: (() => void) | null = null;
  private unsubscribeState: (() => void) | null = null;
  private disposed = false;

  private peerPresence: PeerPresence = 'unknown';
  private failedPresenceProbes = 0;
  /**
   * Whether the peer has sent anything at all on the CURRENT transport
   * connection. While false the relay's slot is `waiting` for this device, so
   * every frame we send is appended to its park buffer rather than forwarded,
   * and a second msg1 is not a retry - it is a second handshake the phone
   * will answer on arrival, retiring the keys its first reply just agreed
   * (see beginHandshake()). Reset on every fresh `'connected'` transition,
   * same as failedPresenceProbes: a fresh socket knows nothing yet.
   */
  private peerSeenOnThisConnection = false;
  /**
   * Whether ANY frame, valid or garbled, arrived since the current probe
   * episode opened. Episode-scoped on purpose, unlike peerSeenOnThisConnection
   * above, which stays true for the whole life of a socket that went dead
   * after the phone had answered on it - exactly the socket the spent-budget
   * redial exists to abandon. A frame that arrived proves the socket is
   * forwarding whatever the frame says, so the redial must stand down; this
   * is the desktop analogue of the phone's rekeyEpoch guard.
   */
  private inboundSinceProbeStart = false;
  /**
   * Whether the current probe episode was opened by the REHANDSHAKE_INTERVAL_MS
   * tick rather than a 'connected' edge. On the hosted relay a live parked
   * socket is closed at the 60 s park timeout, so a 120 s tick can only ever
   * land on a parked socket whose close never arrived; a connect-edge episode
   * on a never-answered socket is the ordinary "phone is away" park, which
   * the relay's own timeout recycles and which must not be redialed every
   * 10 s instead.
   */
  private probeOpenedByRekey = false;
  /** Initiations that actually left through the transport; probePresenceNow() reads it to report whether the guard let one through. */
  private initiationsSent = 0;
  private presenceTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectGraceTimer: ReturnType<typeof setTimeout> | null = null;
  /**
   * Application frames encoded while a rekey's msg1 is outstanding on an
   * established session, waiting to be sealed under the keys that rekey
   * produces. The phone (Noise responder) switches to the new streams the
   * moment it writes msg2 and silently drops whatever it cannot open, so a
   * frame sealed under the old keys in that window is lost. WireGuard states
   * the same rule: a sender "must either queue up packets to be sent later,
   * or use the previous session" (https://www.wireguard.com/protocol/).
   * Null while no rekey is in flight.
   */
  private rekeyHeldFrames: Array<{ plaintext: Uint8Array; tag: FrameTag }> | null = null;
  private rekeyHoldStartedAtMs = 0;
  /** Encoded bytes in rekeyHeldFrames, checked against REKEY_HOLD_MAX_BYTES. */
  private rekeyHeldBytes = 0;
  private rekeyHoldTimer: ReturnType<typeof setTimeout> | null = null;

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
      // A fresh socket gets a fresh probe budget and knows nothing about the
      // new slot yet. The reconnect grace (if one is armed) deliberately
      // stays armed until the handshake actually completes: the flicker it
      // suppresses spans the re-handshake too.
      this.failedPresenceProbes = 0;
      this.peerSeenOnThisConnection = false;
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
    this.outstandingHandshakes = [];
    this.dropRekeyHold();
    this.clearHandshakeRetryTimer();
    // No socket means no probe can be answered; the transport branch of
    // connectionState governs the badge until the next 'connected' edge.
    this.clearPresenceTimer();
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

  /**
   * @param replaceOutstanding Send a fresh msg1 even while one is already
   * outstanding and unanswered on this connection. Only the
   * REHANDSHAKE_INTERVAL_MS tick passes this - see the guard below. The older
   * initiation stays in outstandingHandshakes: if its reply does turn up, it
   * is read and retired in order (see handleHandshakeFrame).
   */
  private beginHandshake(replaceOutstanding = false): void {
    if (this.disposed) return;
    // The rekey interval can fire while the transport is mid-reconnect; sending
    // then would throw. Skip - onTransportState re-initiates on the next connect.
    if (this.transport.state !== 'connected') return;
    // While the relay's slot is `waiting` for this device (no proof-of-life
    // frame has arrived on this connection yet), a second initiation is not a
    // retry: it is a second msg1 that accumulates in the relay's parked-slot
    // buffer alongside the one already sitting there, and both get flushed to
    // the phone the instant it attaches - forcing it through an extra rekey
    // for one arrival (#635). Skip unless this call is explicitly replacing
    // the outstanding attempt, or the peer has already proven the slot is
    // paired and forwarding live (a msg1 lost there is genuinely lost, and
    // re-sending costs nothing).
    if (this.outstandingHandshakes.length > 0 && !replaceOutstanding && !this.peerSeenOnThisConnection) return;
    // At the cap, nothing more goes out until a reply or a reconnect clears
    // the list. Forgetting the oldest instead would let ITS reply arrive later
    // and be tried against every initiation still held, and a failed read
    // destroys each one it touches.
    if (this.outstandingHandshakes.length >= MAX_OUTSTANDING_HANDSHAKES) return;
    // A fresh initiation supersedes any pending failure retry.
    this.clearHandshakeRetryTimer();
    const handshake = createKKHandshake({
      initiator: true,
      localStatic: this.identity.staticKeyPair,
      remoteStatic: this.remoteStaticPublicKey,
    });
    const { message } = handshake.writeMessage(new Uint8Array(0));
    this.outstandingHandshakes.push(handshake);
    // A probe episode OPENS here and only here: when no window is armed. The
    // under-budget re-arm in onPresenceProbeTimeout() arms its window BEFORE
    // calling back into this method, so on that call the timer is non-null
    // and both flags survive from the episode's open - a garbled frame in the
    // first window still counts as inbound at the second exhaustion, and a
    // tick-opened episode still reads as tick-opened. Reordering that re-arm
    // against its beginHandshake() call would silently reset both.
    if (this.presenceTimer === null) {
      this.inboundSinceProbeStart = false;
      this.probeOpenedByRekey = replaceOutstanding;
    }
    // Every initiation doubles as a presence probe: a reply proves the phone is
    // attached to this slot, silence eventually proves it is not. Armed BEFORE
    // the send, because a peer that replies synchronously (any in-process
    // transport, and every test double) completes the handshake inside send()
    // - arming afterwards would leave a probe nothing can ever cancel.
    this.armPresenceTimer();
    // A rekey on an established session: hold application frames until the
    // reply arrives (see rekeyHeldFrames). Started BEFORE the send for the same
    // reason the presence timer is armed before it: a transport that completes
    // the handshake synchronously inside send() releases the hold right there.
    // A hold already open from an earlier msg1 (the presence re-probe, an
    // unlock probe) stays open with its original deadline: the phone may have
    // switched on that msg1 already, so the held frames wait for the reply
    // that leaves both sides on the same keys.
    const openedHold = this.streams ? this.startRekeyHold() : false;
    this.initiationsSent += 1;
    try {
      this.transport.send(wrapSessionFrame(SessionFrameKind.Handshake, message));
    } catch (error) {
      // This msg1 never left. Forget it, so it neither counts toward the cap
      // nor reads a later reply first and fails. A hold it opened releases
      // under the old keys, since the phone never switched on it; a hold an
      // earlier msg1 opened keeps waiting for that msg1's reply.
      const unsentIndex = this.outstandingHandshakes.indexOf(handshake);
      if (unsentIndex !== -1) this.outstandingHandshakes.splice(unsentIndex, 1);
      if (openedHold) this.releaseRekeyHold('send-failed');
      throw error;
    }
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
   *
   * Called from beginHandshake() on every successful initiation, and also
   * explicitly from onPresenceProbeTimeout() for the still-under-budget case -
   * see that method's comment for why the second call site exists.
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
   * The initiation went unanswered. Spend one unit of the probe budget; only a
   * fully spent budget concludes the peer is absent, so a single slow round
   * trip never flashes 'offline' on a phone that is really there.
   *
   * Still under budget: re-arm the presence window UNCONDITIONALLY, then
   * re-initiate (a no-op while parked - see beginHandshake()'s guard - since
   * the outstanding msg1 is still sitting in the relay's buffer and a second
   * one would only pile up alongside it). The re-arm cannot be left to
   * beginHandshake()'s own internal call: when the guard blocks the send,
   * beginHandshake() returns before ever reaching it, and without this
   * explicit call here the budget would stop advancing the moment the guard
   * starts blocking - stranding the badge on 'connecting' forever instead of
   * reaching 'offline'.
   *
   * The re-arm goes FIRST so the initiation still has a window to CLEAR. A
   * transport that completes the handshake synchronously inside send() (any
   * in-process transport, and every test double) reaches
   * handleHandshakeFrame()'s clearPresenceTimer() before beginHandshake()
   * returns; arming after that would leave a probe running on an
   * already-established session, and that probe's own timeout would
   * re-initiate and re-arm again, rekeying a healthy session every
   * PEER_PRESENCE_TIMEOUT_MS forever. Ordering it first makes
   * beginHandshake()'s internal arm the no-op instead of this one, which is
   * what the async case already does.
   */
  private onPresenceProbeTimeout(): void {
    if (this.disposed) return;
    if (this.transport.state !== 'connected') return;
    this.failedPresenceProbes += 1;
    if (this.failedPresenceProbes >= PEER_PRESENCE_FAILURES_BEFORE_ABSENT) {
      this.markPeerAbsent();
      this.redialIfSocketProvablyDead();
      return;
    }
    this.armPresenceTimer();
    this.beginHandshake();
  }

  /**
   * The spent-budget liveness verdict, taken on EVERY exhaustion rather than
   * only on the absence edge: a parked device's edge fired at app start, and
   * on a zombie only the non-edge exhaustion recurs (5 s after each rekey
   * tick, since markPeerAbsent() pins the counter). Lives here, not in
   * markPeerAbsent(), because the Final-goodbye path also calls that and a
   * deliberate unpair must never redial; budget exhaustion is the one path
   * where "the socket carried nothing" is evidence.
   *
   * Three conditions, all required: nothing inbound during the episode (a
   * frame of any kind proves the relay is forwarding); the socket is one the
   * relay's park timeout could not be about to recycle anyway (the phone had
   * answered on it, or a rekey tick found it still open past the park
   * timeout); and the transport still reads 'connected' with a redial to
   * offer. A fresh park whose phone is simply away fails the second and keeps
   * the relay's 60 s churn, which is what preserves #635's one initiation per
   * parked connection: this redial closes the old socket rather than sending
   * on it, so the fresh 'connected' edge's msg1 lands in an empty buffer.
   *
   * Runs synchronously inside the probe callback and arms no timer of its
   * own: RelayClient.redialNow() emits 'reconnecting' before it dials, so
   * onTransportState()'s leave-connected cleanup runs re-entrantly here
   * (presence is already 'absent', so no reconnect grace arms) and the next
   * 'connected' edge re-initiates. No loop: the new socket's first
   * exhaustion is a connect-edge episode the second condition rejects. On a
   * self-hosted relay with a park timeout longer than REHANDSHAKE_INTERVAL_MS
   * this is one redial per ~125 s per absent device instead of a persistent
   * socket; the hosted relay never lets a live park reach that tick.
   */
  private redialIfSocketProvablyDead(): void {
    if (this.inboundSinceProbeStart) return;
    if (!this.peerSeenOnThisConnection && !this.probeOpenedByRekey) return;
    if (this.transport.state !== 'connected') return;
    if (!isRedialableTransport(this.transport)) return;
    const reason: ForcedRedialReason = this.peerSeenOnThisConnection ? 'paired-silent' : 'parked-stale';
    this.emit('forcedRedial', reason);
    this.redialTransport(FORCED_REDIAL_DESCRIPTIONS[reason]);
  }

  /**
   * Abandon this device's socket and dial afresh, for a caller with
   * out-of-band proof the socket is dead: the spent budget above, and a
   * sleep resume with no phone attached. No-op on a transport that cannot
   * redial (every in-process test double).
   */
  redialTransport(reason: string): void {
    if (this.disposed || !isRedialableTransport(this.transport)) return;
    this.transport.redialNow({ force: true, reason });
  }

  /**
   * The system resumed from sleep. Every relay socket older than the relay's
   * keepalive cycle has been reaped while the machine was away, and nothing
   * tells the bridge - but powerMonitor's 'resume' also fires after a standby
   * short enough that the socket survived, and a forced redial on a socket a
   * live phone is using costs that phone a bounce (PEER_CLOSED, a reconnect,
   * a handshake) on every wake. So the decision is per session, on the same
   * evidence rule as the spent budget: a session with no phone attached
   * (parked, or already absent) redials at once, since there is nobody to
   * bounce and the ~125 s the rekey tick would take is pure delay; a session
   * whose phone was present is probed instead, and only a spent budget (~10 s)
   * redials it. Returns what it did, for the service's log line.
   */
  resumeFromSleep(reason: string): 'redialed' | 'probed' | 'skipped' {
    if (this.disposed || !isRedialableTransport(this.transport)) return 'skipped';
    if (this.peerPresence === 'present') return this.probePresenceNow() ? 'probed' : 'skipped';
    this.redialTransport(reason);
    return 'redialed';
  }

  /**
   * Send one presence probe now, for a caller with a hint rather than proof
   * (the screen unlocking). The GUARDED initiation, never the rekey tick's
   * replacing one: on a parked slot with a msg1 already buffered a second one
   * is #635's extra rekey per arrival, so this is a no-op there and the rekey
   * tick covers a parked zombie within 125 s regardless. On a paired socket
   * it costs one rekey, which the phone handles routinely; if the socket is
   * dead the budget spends in ~10 s and redialIfSocketProvablyDead() acts.
   * A paired socket whose rekey msg1 is already outstanding lets this through
   * too (the phone had answered on it). The phone answers both msg1s in order,
   * and handleHandshakeFrame reads the replies oldest first, so both sides end
   * on the second keys.
   * Returns whether an initiation actually left, so the caller can log the
   * number that probed rather than the number it asked.
   */
  probePresenceNow(): boolean {
    if (this.disposed) return false;
    const before = this.initiationsSent;
    this.beginHandshake();
    return this.initiationsSent !== before;
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
    this.emit('connectionState');
  }

  private markPeerAbsent(): void {
    const changed = this.peerPresence !== 'absent';
    this.peerPresence = 'absent';
    this.failedPresenceProbes = PEER_PRESENCE_FAILURES_BEFORE_ABSENT;
    // The peer is gone, so a held 'connected' is no longer defensible. There
    // is no re-probe loop to (re-)arm here: while parked, the outstanding
    // msg1 already sits in the relay's buffer, and the relay's own park
    // timeout (60s) is what forces a fresh connection and a fresh initiation -
    // see beginHandshake()'s guard and onTransportState()'s 'connected' branch.
    // The one exception, a socket that can never receive that close, is
    // decided by the probe-timeout caller (redialIfSocketProvablyDead), not
    // here: this method is also the Final-goodbye path.
    this.clearReconnectGrace();
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

  /**
   * Opens a rekey hold, or leaves an open one alone: a re-initiation during a
   * hold never extends its deadline, so no frame waits longer than
   * REKEY_HOLD_MAX_MS from the first msg1 of the episode. Returns whether
   * this call opened it.
   */
  private startRekeyHold(): boolean {
    if (this.rekeyHeldFrames) return false;
    this.rekeyHeldFrames = [];
    this.rekeyHeldBytes = 0;
    this.rekeyHoldStartedAtMs = Date.now();
    this.rekeyHoldTimer = setTimeout(() => {
      this.rekeyHoldTimer = null;
      this.releaseRekeyHold('deadline');
    }, REKEY_HOLD_MAX_MS);
    this.rekeyHoldTimer.unref?.();
    return true;
  }

  /** Adds one encoded frame to the open hold, releasing it early once it passes REKEY_HOLD_MAX_BYTES. */
  private holdFrame(held: Array<{ plaintext: Uint8Array; tag: FrameTag }>, plaintext: Uint8Array, tag: FrameTag): void {
    held.push({ plaintext, tag });
    this.rekeyHeldBytes += plaintext.byteLength;
    if (this.rekeyHeldBytes >= REKEY_HOLD_MAX_BYTES) this.releaseRekeyHold('overflow');
  }

  /**
   * Seals and sends every held frame under the CURRENT streams, then closes
   * the hold. Called with the new streams installed when the rekey completes,
   * and with the old ones still installed when it does not (the deadline, an
   * overflow, a failed read, a msg1 that never left). In the second case the
   * phone either
   * never switched (absent, or msg1 lost), so the old keys are the right ones,
   * or it switched and its msg2 is late, in which case these frames are lost
   * exactly as every frame in the window was before the hold existed.
   */
  private releaseRekeyHold(reason: RekeyHoldReleaseReason): void {
    const held = this.rekeyHeldFrames;
    if (!held) return;
    this.rekeyHeldFrames = null;
    this.rekeyHeldBytes = 0;
    if (this.rekeyHoldTimer) {
      clearTimeout(this.rekeyHoldTimer);
      this.rekeyHoldTimer = null;
    }
    if (held.length > 0) this.emit('rekeyHoldReleased', { frames: held.length, heldMs: Date.now() - this.rekeyHoldStartedAtMs, reason });
    if (!this.streams || this.transport.state !== 'connected') return;
    for (const { plaintext, tag } of held) {
      try {
        this.transport.send(wrapSessionFrame(SessionFrameKind.Application, this.streams.send.seal(plaintext, tag)));
      } catch {
        // The socket dropped mid-flush; onTransportState discards the keys and
        // the next 'connected' edge re-handshakes.
        return;
      }
    }
  }

  /** The transport left 'connected': the phone discarded its keys too, so held frames can never be opened. */
  private dropRekeyHold(): void {
    if (this.rekeyHoldTimer) {
      clearTimeout(this.rekeyHoldTimer);
      this.rekeyHoldTimer = null;
    }
    this.rekeyHeldFrames = null;
    this.rekeyHeldBytes = 0;
  }

  private armRehandshakeTimer(): void {
    if (this.rehandshakeTimer) clearInterval(this.rehandshakeTimer);
    // Passes replaceOutstanding: true so a rekey tick that lands while a
    // prior initiation is still outstanding (unanswered, unparked - e.g. a
    // self-hosted relay with no park timeout) replaces it rather than being
    // silently blocked by beginHandshake()'s parked-slot guard. Against the
    // real relay a LIVE parked socket never reaches this tick: the 60s park
    // timeout closes it first. A parked socket that does is one whose close
    // never arrived, which is why a tick-opened probe episode is one of the
    // two grounds redialIfSocketProvablyDead() accepts.
    this.rehandshakeTimer = setInterval(() => this.beginHandshake(true), REHANDSHAKE_INTERVAL_MS);
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
    // Any frame at all - handshake reply or application data, valid or
    // garbled - proves the relay has this slot PAIRED and forwarding live,
    // never parked and buffering: while genuinely parked, nobody is on the
    // other end to send us anything. See beginHandshake()'s guard.
    this.peerSeenOnThisConnection = true;
    this.inboundSinceProbeStart = true;
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

  /**
   * Reads a msg2 against the outstanding initiations, OLDEST FIRST. The phone
   * answers every msg1 it receives, in order, and switches keys on each, so
   * when a reply stalls past the presence window and the re-probe sends a
   * second msg1, two replies come back in order. readMessage is NOT
   * transactional: a failed read has already advanced the handshake's message
   * index and mixed the bogus ephemeral in, so that object can never complete.
   * Reading reply 1 with handshake 2 therefore destroyed handshake 2, reply 2
   * then found no handshake at all, and the desktop stayed on the old keys
   * while the phone moved on: every frame both ways was lost until the next
   * rekey tick. Oldest first, a failed read only spends a superseded
   * initiation, and the newer ones stay intact for the replies still coming.
   */
  private handleHandshakeFrame(payload: Uint8Array): void {
    if (this.outstandingHandshakes.length === 0) {
      this.emit('handshakeFailed', new Error('Received a handshake frame with no handshake in progress'));
      return;
    }
    let matched: HandshakeState | null = null;
    let lastError: unknown = null;
    while (this.outstandingHandshakes.length > 0 && !matched) {
      const candidate = this.outstandingHandshakes.shift();
      if (!candidate) break;
      try {
        // KK is exactly two messages; reading the responder's reply always completes it.
        if (candidate.readMessage(payload).split) matched = candidate;
        else lastError = new Error('KK handshake did not complete after the expected two messages');
      } catch (error) {
        lastError = error;
      }
    }
    if (!matched) {
      // Nothing this side sent can read the frame: garbled, injected, or a
      // reply to an initiation already abandoned. An unestablished session
      // schedules a fresh initiation here. An established one does not
      // (scheduleHandshakeRetry returns early): the presence window its msg1
      // armed re-initiates on timeout. If a reply to an older msg1 already
      // matched, that window is cleared, and the next rekey tick re-initiates.
      this.releaseRekeyHold('read-failed');
      this.emit('handshakeFailed', lastError);
      this.scheduleHandshakeRetry();
      return;
    }
    this.streams = deriveSecretstreamPair(matched.getChainingKey(), true);
    // The phone has been on these keys since it wrote this msg2. If a newer
    // msg1 is still outstanding it has switched again on that one too, so the
    // held frames wait for the reply that leaves the two sides on the same keys.
    if (this.outstandingHandshakes.length === 0) {
      this.releaseRekeyHold('established');
      // The flush can cross the relay's per-socket byte cap, whose redial runs
      // onTransportState('reconnecting') re-entrantly and drops these keys.
      // The session is no longer established, so none of what follows applies.
      if (!this.streams) return;
    }
    this.clearHandshakeRetryTimer();
    // The peer answered: it is attached to this slot. Retire the probe budget
    // and drop any reconnect hold - if one was armed, the blip healed inside
    // it and the badge never moved.
    this.clearPresenceTimer();
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
      // silent case has to spend. `streams` is deliberately left intact:
      // this side's send stream is independent of the peer's goodbye, and
      // clearing it would break the send path for no benefit - markPeerAbsent
      // already moves connectionState to 'offline' regardless of isEstablished,
      // so push presence (which reads connectionState, not the raw
      // isEstablished flag - see push-notifier.ts's collectConnectedDeviceIds)
      // is unaffected either way. The service escalates 'remoteClosed' to a
      // full device drop - a Final is only ever a deliberate unpair - but
      // that is its decision; the session-level contract here stays
      // presence-only.
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
      if (isUnsupportedVerbError(error)) {
        this.refuseUnsupportedVerb(error.requestId, error.verb);
        return;
      }
      this.emit('frameRejected', error);
      return;
    }
    this.emit('message', message);
  }

  /**
   * A well-formed capability-request for a verb this build's protocol does
   * not carry: a NEWER phone talking to an older desktop. Answered here, at
   * the session, rather than dropped as a rejected frame: the router never
   * sees it (the verb is not a `CapabilityVerb`, so there is no capability
   * check to pass and no handler to run - deny-by-default holds because the
   * reply is a fixed refusal keyed on nothing but the verb's name), and a
   * silent drop left the phone timing out, unable to tell an old desktop
   * from an unreachable one. The peer is post-Noise-authenticated and the
   * router already answers an unauthorized verb with a response, so a reply
   * per unknown verb is no new exposure. 'unsupportedVerb' is the
   * observability edge (the service logs it); 'frameRejected' is deliberately
   * NOT emitted, because the frame was answered, not dropped.
   */
  private refuseUnsupportedVerb(requestId: string, verb: string): void {
    try {
      this.sendMessage({
        type: 'capability-response',
        requestId,
        ok: false,
        error: `Unsupported verb: ${verb}`,
        code: UNSUPPORTED_VERB_ERROR_CODE,
      });
    } catch {
      // The transport dropped between the open and the send; the phone's own
      // per-verb timeout covers a refusal that never left.
    }
    this.emit('unsupportedVerb', { requestId, verb });
  }

  /**
   * Returns the size of the frame handed to the transport, for the service's
   * slow-request line; while a rekey holds frames, the encoded size of the one
   * it held. Encoding runs first either way, so a too-large message still
   * throws MessageEncodeError synchronously.
   */
  sendMessage(message: BridgeMessage): number {
    if (!this.streams) throw new Error('BridgeSession is not established yet');
    let encoded: Uint8Array;
    try {
      encoded = encodeMessage(message);
    } catch (error) {
      throw new MessageEncodeError(error);
    }
    if (this.rekeyHeldFrames) {
      this.holdFrame(this.rekeyHeldFrames, encoded, FrameTag.Message);
      return encoded.byteLength;
    }
    const frame = wrapSessionFrame(SessionFrameKind.Application, this.streams.send.seal(encoded));
    this.transport.send(frame);
    return frame.byteLength;
  }

  /**
   * Bytes the transport has accepted but the OS socket has not, or null when
   * the transport cannot say (a test double, or a future transport with no
   * such queue). Not the bytes still in flight: on undici a 4 MB burst through
   * the hosted relay read 0 here within 30 ms while the receiver needed 2.5 s
   * for it, because the OS takes the whole burst into its send buffer. A
   * nonzero value next to a slow request means a stalled socket.
   */
  get transportBufferedBytes(): number | null {
    return 'bufferedAmount' in this.transport && typeof this.transport.bufferedAmount === 'number' ? this.transport.bufferedAmount : null;
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
    // Behind a rekey it waits its turn, after the frames sent before it.
    if (this.rekeyHeldFrames) {
      this.rekeyHeldFrames.push({ plaintext: new Uint8Array(0), tag: FrameTag.Final });
      return;
    }
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
    // Best effort, before teardown: a revoke's goodbye queued behind a rekey
    // still leaves, under the keys the session holds right now.
    this.releaseRekeyHold('dispose');
    this.disposed = true;
    if (this.rehandshakeTimer) {
      clearInterval(this.rehandshakeTimer);
      this.rehandshakeTimer = null;
    }
    this.clearHandshakeRetryTimer();
    // Only clearReconnectGrace() is observable on its own: the presence
    // callback already self-guards on `disposed`, so this clear is
    // defense-in-depth against a future edit dropping that guard. Keep both -
    // the dispose tests pin each one independently via the live timer count.
    this.clearPresenceTimer();
    this.clearReconnectGrace();
    this.unsubscribeFrame?.();
    this.unsubscribeFrame = null;
    this.unsubscribeState?.();
    this.unsubscribeState = null;
    this.outstandingHandshakes = [];
    this.streams = null;
    // The session owns its per-device transport (created alongside it in
    // openSessionForDevice); closing it here stops RelayClient's reconnect
    // loop from outliving a revoked or disabled session.
    this.transport.close();
  }
}
