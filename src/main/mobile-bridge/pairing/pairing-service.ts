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
 *   'failed'    ({ reason })                       - handshake/transport error, an unopenable
 *                                                     confirm frame, or a ceremony timeout
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
    this.handshake = createPairingResponderHandshake({
      localStatic: this.identity.staticKeyPair,
      pairingToken: this.activeToken.token,
    });
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
    if (!this.handshake || !this.activeToken || !this.activeTransport) return;
    if (!isPairingTokenValid(this.activeToken)) {
      this.fail('Pairing token expired or already used');
      return;
    }
    // Single-use regardless of outcome: one attempt is all an attacker (or a
    // legitimate retry) gets against this token.
    this.activeToken.consumed = true;

    let readResult: ReturnType<HandshakeState['readMessage']>;
    try {
      readResult = this.handshake.readMessage(frame);
    } catch {
      this.fail('Pairing handshake failed to authenticate (wrong or expired code)');
      return;
    }
    this.phoneDeviceName = sanitizeDeviceNamePayload(readResult.payload);

    let writeResult: ReturnType<HandshakeState['writeMessage']>;
    try {
      writeResult = this.handshake.writeMessage(new Uint8Array(0));
    } catch {
      this.fail('Pairing handshake failed while responding');
      return;
    }
    this.activeTransport.send(writeResult.message);

    const phoneStaticPublicKey = this.handshake.getRemoteStaticKey();
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

    this.phase = 'sas-pending';
    const sas = deriveShortAuthenticationString(this.handshake.getHandshakeHash());
    this.armPhaseTimer(SAS_PENDING_TIMEOUT_MS, 'Timed out waiting for your phone. Pair again.');
    this.emit('sas', { sas, phoneStaticPublicKeyHex: bytesToHex(phoneStaticPublicKey) });
  }

  /** Auto-enrolls on the phone's sealed confirm frame; fails the ceremony on anything that does not open cleanly. */
  private handleConfirmFrame(frame: Uint8Array): void {
    if (!this.confirmCipher) {
      this.fail('Pairing confirm arrived before the handshake completed');
      return;
    }
    if (!openPairingConfirm(this.confirmCipher, frame)) {
      this.fail('Could not verify your phone. Pair again.');
      return;
    }
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
