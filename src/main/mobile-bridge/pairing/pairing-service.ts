import { EventEmitter } from 'node:events';
import {
  bytesToHex,
  createPairingResponderHandshake,
  deriveShortAuthenticationString,
  openPairingConfirm,
  CAPABILITY_VERBS,
  type CapabilityVerb,
  type CipherState,
  type HandshakeState,
  type ShortAuthenticationString,
  type Transport,
} from '@kangentic/protocol';
import { addOrReplaceDevice } from '../roster-store';
import type { BridgeIdentity } from '../identity';
import { isPairingTokenValid, mintPairingToken, type PairingToken } from './pairing-token';

/**
 * Default grant for a newly paired device: all ten protocol verbs. The
 * phone is an extension of the user's own desktop, not a third-party
 * integration - the QR scan plus SAS comparison already proves physical
 * possession of both devices, so pairing is the only approval the human
 * needs to give. Note what stays true regardless: the protocol defines no
 * shell, file, or arbitrary-command verb at all (see capabilities/verbs.ts),
 * so "full access" means these ten, never more, and unpair remains the
 * kill switch.
 */
export const DEFAULT_PAIRING_CAPABILITIES: CapabilityVerb[] = [...CAPABILITY_VERBS];

/** Untrusted display text; clamp and drop control characters before it ever reaches the roster or the UI. */
export const MAX_DEVICE_NAME_LENGTH = 64;
const MIN_PRINTABLE_CODE_POINT = 32;
const DELETE_CODE_POINT = 127;

/**
 * The single clamp/filter both display-name entry points share: the phone's
 * message-1 payload during pairing, and the renderer-supplied string on
 * `mobile:renameDevice` (see MobileBridgeService.renameDevice). Either value
 * ends up signed into the roster and rendered in the settings list, so
 * neither may skip this.
 */
export function sanitizeDeviceName(rawName: string): string {
  const decoded = Array.from(rawName)
    .filter((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return codePoint >= MIN_PRINTABLE_CODE_POINT && codePoint !== DELETE_CODE_POINT;
    })
    .join('')
    .trim();
  if (!decoded) return 'Paired Device';
  // Clamp by CODE POINT, not UTF-16 code unit: a plain slice() can cut an
  // astral character (an emoji in a phone's default device name) in half and
  // leave a lone unpaired surrogate in the signed roster entry.
  return Array.from(decoded).slice(0, MAX_DEVICE_NAME_LENGTH).join('');
}

function sanitizeDeviceNamePayload(rawPayload: Uint8Array): string {
  return sanitizeDeviceName(new TextDecoder().decode(rawPayload));
}

/** sas-pending waits on a human physically tapping Confirm on their phone; generous so a first-time user fumbling the app does not lose the ceremony. On expiry the pairing token is already consumed, so the desktop's copy directs the user to pair again rather than implying a retry is possible. */
export const SAS_PENDING_TIMEOUT_MS = 5 * 60 * 1000;

type PairingPhase = 'idle' | 'waiting-for-phone' | 'sas-pending' | 'done';

/**
 * Orchestrates one pairing ceremony: mint a token -> (caller builds and
 * displays the QR) -> run the responder side of the Noise IKpsk0
 * handshake over an already-connected Transport -> derive the SAS and
 * surface it for the user to compare -> on the phone's sealed confirm
 * frame (see @kangentic/protocol's pairing/confirm.ts), auto-enroll the
 * phone's static key into the roster with the full capability grant.
 *
 * The confirm frame is a liveness/intent signal, not the security
 * boundary: it opens only if both peers completed the SAME handshake
 * transcript, which is exactly the property the human's SAS comparison
 * already vouches for. Enrollment always uses
 * `this.handshake.getRemoteStaticKey()`, never any payload-carried key -
 * a phone can never enroll itself unilaterally.
 *
 * Emits (see the corresponding IPC push channels in handlers/mobile-bridge.ts):
 *   'sas'       ({ sas, phoneStaticPublicKeyHex }) - show the SAS to the user
 *   'confirmed' ({ deviceId, displayName })        - pairing succeeded
 *   'cancelled' ({ reason })                       - user cancelled before confirming
 *   'failed'    ({ reason })                       - a spent/expired token, a handshake or
 *                                                     transport error, or a ceremony timeout
 *
 * A frame that simply does not authenticate is IGNORED rather than failing the
 * ceremony, in both phases: the relay slot is reachable by anyone who can read
 * the request URI, so one injected frame must not be able to end a pairing.
 *
 * One instance handles exactly one ceremony; the caller (mobile-bridge-service)
 * creates a fresh instance per "Pair a device" attempt.
 */
export class PairingService extends EventEmitter {
  private readonly identity: BridgeIdentity;
  private phase: PairingPhase = 'idle';
  private activeToken: PairingToken | null = null;
  private activeTransport: Transport | null = null;
  private unsubscribeFrame: (() => void) | null = null;
  private handshake: HandshakeState | null = null;
  /** The initiator-to-responder cipher state from the completed handshake's split(), used to open the phone's confirm frame. Set once message 1 completes the pattern. */
  private confirmCipher: CipherState | null = null;
  private phoneDeviceName = 'Paired Device';
  private phaseTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(identity: BridgeIdentity) {
    super();
    this.identity = identity;
  }

  mintToken(): PairingToken {
    if (this.activeToken) throw new Error('mintToken() already called for this ceremony');
    this.activeToken = mintPairingToken();
    return this.activeToken;
  }

  /** `transport` must already be connected and scoped to this pairing token's relay slot. */
  start(transport: Transport): void {
    if (!this.activeToken) throw new Error('mintToken() must be called before start()');
    if (this.phase !== 'idle') throw new Error(`Cannot start a pairing ceremony while phase is "${this.phase}"`);

    this.phase = 'waiting-for-phone';
    this.activeTransport = transport;
    // No handshake is built here: each inbound frame gets its own, and only an
    // authenticated one is committed to this.handshake. See handleMessage1().
    this.unsubscribeFrame = transport.onFrame((frame) => this.onFrame(frame));
    // There is no active-ceremony timeout otherwise: the token's TTL is
    // only checked lazily when message 1 arrives, so a QR that is never
    // scanned would leave this ceremony (and startPairing()'s "already in
    // progress" guard) open indefinitely.
    this.armPhaseTimer(this.remainingTokenTtlMs(), 'Timed out waiting for your phone. Pair again.');
  }

  private remainingTokenTtlMs(): number {
    if (!this.activeToken) return 0;
    return Math.max(0, this.activeToken.expiresAt - Date.now());
  }

  private armPhaseTimer(delayMs: number, timeoutReason: string): void {
    this.clearPhaseTimer();
    this.phaseTimer = setTimeout(() => this.fail(timeoutReason), delayMs);
    this.phaseTimer.unref?.();
  }

  private clearPhaseTimer(): void {
    if (this.phaseTimer) clearTimeout(this.phaseTimer);
    this.phaseTimer = null;
  }

  private onFrame(frame: Uint8Array): void {
    if (this.phase === 'waiting-for-phone') {
      this.handleMessage1(frame);
    } else if (this.phase === 'sas-pending') {
      this.handleConfirmFrame(frame);
    }
    // A stray frame in any other phase (idle/done) is ignored: teardown()
    // already unsubscribed onFrame by the time either phase is reachable.
  }

  private handleMessage1(frame: Uint8Array): void {
    if (!this.activeToken || !this.activeTransport) return;
    if (!isPairingTokenValid(this.activeToken)) {
      this.fail('Pairing token expired or already used');
      return;
    }

    // Every inbound frame gets its OWN handshake state. readMessage() advances
    // messageIndex and mixes the sender's ephemeral into the transcript BEFORE
    // it authenticates anything, so running a rejected frame through a shared
    // HandshakeState would poison it and break the real phone's later attempt.
    // CONSTRUCTING one is BLAKE2s hashing only (no DH), so a fresh state per
    // frame costs essentially nothing over reusing one. The per-frame work is
    // in readMessage() below, whose 'es' token runs one X25519 scalar
    // multiplication against the sender's ephemeral before the AEAD tag can
    // reject the frame - tens of microseconds, not free, so the no-cap
    // reasoning below rests on the TTL and the relay's limits, not on this
    // being hash-only.
    const attempt = createPairingResponderHandshake({
      localStatic: this.identity.staticKeyPair,
      pairingToken: this.activeToken.token,
    });

    let readResult: ReturnType<HandshakeState['readMessage']>;
    try {
      readResult = attempt.readMessage(frame);
    } catch {
      // Unauthenticated garbage. The relay slot is reachable by anyone who can
      // read the request URI, so a frame arriving here proves nothing: ignore
      // it, keep the token, and stay in waiting-for-phone so the real phone can
      // still pair. Consuming the token here (the old behavior) let one frame
      // deterministically burn the ceremony.
      //
      // Deliberately no attempt cap: aborting at N would only turn a one-frame
      // denial into an N-frame one, and against a 32-byte PSK a cap buys
      // nothing cryptographically. The work is already bounded by the token's
      // 10-minute TTL, the relay's per-IP rate limits, and its cap of two
      // peers per slot.
      return;
    }

    // Authenticated: the sender proved possession of the pairing token, so the
    // token is spent now. This is not a check-then-act race against the
    // isPairingTokenValid() call above - onFrame() is synchronous and Node is
    // single-threaded, so no second frame can interleave between the two.
    this.activeToken.consumed = true;
    this.handshake = attempt;
    this.phoneDeviceName = sanitizeDeviceNamePayload(readResult.payload);

    let writeResult: ReturnType<HandshakeState['writeMessage']>;
    try {
      writeResult = attempt.writeMessage(new Uint8Array(0));
    } catch {
      this.fail('Pairing handshake failed to construct the response');
      return;
    }

    const phoneStaticPublicKey = attempt.getRemoteStaticKey();
    if (!phoneStaticPublicKey) {
      this.fail('Pairing handshake did not yield the phone identity key');
      return;
    }
    if (!writeResult.split) {
      this.fail('Pairing handshake did not complete after the expected messages');
      return;
    }
    // IKPSK0 has one message in each direction; index 0 is the
    // initiator(phone)-to-responder(desktop) cipher state by Noise Protocol
    // Framework convention. Both peers take index 0 for this direction, which
    // is what lets the phone's sealed confirm frame open here - pinned by
    // tests/unit/protocol/pairing-confirm.test.ts.
    this.confirmCipher = writeResult.split[0];

    // Commit every piece of state BEFORE sending message 2. Now that many
    // frames can arrive while waiting-for-phone, a transport that delivered one
    // synchronously from inside send() would otherwise re-enter handleMessage1
    // with the token already consumed and fail a ceremony that just succeeded.
    this.phase = 'sas-pending';
    const sas = deriveShortAuthenticationString(attempt.getHandshakeHash());
    this.armPhaseTimer(SAS_PENDING_TIMEOUT_MS, 'Timed out waiting for your phone. Pair again.');
    try {
      this.activeTransport.send(writeResult.message);
    } catch {
      // Transport.send() genuinely throws - RelayClient rejects a send while
      // not connected (the socket can drop mid-ceremony and be reconnecting)
      // and on its per-session byte cap. Because the phase is already
      // sas-pending by this point, letting it escape would park the ceremony
      // for the full SAS timeout waiting on a confirm frame the phone cannot
      // send, since it never received message 2. Fail immediately instead.
      //
      // Distinct from the construct-the-response failure above on purpose: one
      // is local crypto, this one is I/O, and the reason string is all a log or
      // a bug report carries.
      this.fail('Pairing handshake failed while sending the response');
      return;
    }
    this.emit('sas', { sas, phoneStaticPublicKeyHex: bytesToHex(phoneStaticPublicKey) });
  }

  /**
   * Auto-enrolls on the phone's sealed confirm frame, and ignores anything that
   * does not open cleanly.
   *
   * Ignoring rather than failing is the same rule handleMessage1() applies, for
   * the same reason: the relay slot is reachable by anyone who can read the
   * request URI, so one injected frame must not be able to end the ceremony.
   * It is safe here because CipherState.decryptWithAd() advances its nonce only
   * on a SUCCESSFUL decrypt, so a rejected frame leaves the cipher state clean
   * and the real confirm frame still opens. A phone that never confirms is
   * caught by the existing SAS_PENDING_TIMEOUT_MS timer instead.
   */
  private handleConfirmFrame(frame: Uint8Array): void {
    if (!this.confirmCipher) return;
    if (!openPairingConfirm(this.confirmCipher, frame)) return;
    this.confirmSas();
  }

  /** Signs the phone's static key into the roster with the full capability grant, once its confirm frame has opened. */
  private confirmSas(): void {
    if (this.phase !== 'sas-pending' || !this.handshake) {
      throw new Error(`Cannot confirm pairing while phase is "${this.phase}"`);
    }
    const phoneStaticPublicKey = this.handshake.getRemoteStaticKey();
    if (!phoneStaticPublicKey) throw new Error('No phone identity key to confirm');

    const deviceId = bytesToHex(phoneStaticPublicKey);
    addOrReplaceDevice(this.identity, {
      deviceId,
      staticPublicKey: phoneStaticPublicKey,
      displayName: this.phoneDeviceName,
      capabilities: DEFAULT_PAIRING_CAPABILITIES,
      expiresAt: null,
    });

    this.phase = 'done';
    this.emit('confirmed', { deviceId, displayName: this.phoneDeviceName });
    this.teardown();
  }

  /** Called if the user cancels before the phone confirms (e.g. closes the pairing panel). */
  cancel(reason = 'Cancelled by user'): void {
    if (this.phase === 'done') return;
    this.phase = 'done';
    this.emit('cancelled', { reason });
    this.teardown();
  }

  private fail(reason: string): void {
    if (this.phase === 'done') return;
    this.phase = 'done';
    this.emit('failed', { reason });
    this.teardown();
  }

  private teardown(): void {
    this.clearPhaseTimer();
    this.unsubscribeFrame?.();
    this.unsubscribeFrame = null;
    this.activeTransport = null;
    this.handshake = null;
    this.confirmCipher = null;
  }
}

export type { ShortAuthenticationString };
