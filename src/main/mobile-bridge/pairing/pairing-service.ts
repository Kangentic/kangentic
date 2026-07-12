import { EventEmitter } from 'node:events';
import {
  bytesToHex,
  createPairingResponderHandshake,
  deriveShortAuthenticationString,
  type CapabilityVerb,
  type HandshakeState,
  type ShortAuthenticationString,
  type Transport,
} from '@kangentic/protocol';
import { addOrReplaceDevice } from '../roster-store';
import type { BridgeIdentity } from '../identity';
import { isPairingTokenValid, mintPairingToken, type PairingToken } from './pairing-token';

/**
 * Default grant for a newly paired device: read-only. The write/control
 * verbs (send-user-message, move-task, answer-permission-prompt,
 * interactive-terminal, board-tool-write) require an explicit grant
 * afterward via the paired-devices settings UI - matches "1:1 management
 * UX is fine for v1" from the research doc: pair once, then adjust
 * capabilities if wanted, rather than granting everything by default.
 */
export const DEFAULT_PAIRING_CAPABILITIES: CapabilityVerb[] = ['read-stream', 'read-board', 'read-diff', 'board-tool-read'];

type PairingPhase = 'idle' | 'waiting-for-phone' | 'sas-pending' | 'done';

/**
 * Orchestrates one pairing ceremony: mint a token -> (caller builds and
 * displays the QR) -> run the responder side of the Noise IKpsk0
 * handshake over an already-connected Transport -> derive the SAS and
 * surface it for the user to confirm -> on confirmation, sign the
 * phone's static key into the roster.
 *
 * Emits (see the corresponding IPC push channels in handlers/mobile-bridge.ts):
 *   'sas'       ({ sas, phoneStaticPublicKeyHex }) - show the SAS to the user
 *   'confirmed' ({ deviceId })                     - pairing succeeded
 *   'cancelled' ({ reason })                       - user rejected the SAS or cancelled
 *   'failed'    ({ reason })                       - handshake/transport error (e.g. wrong or expired token)
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
  }

  private onFrame(frame: Uint8Array): void {
    if (this.phase === 'waiting-for-phone') this.handleMessage1(frame);
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

    try {
      // The payload (phone device name) is authenticated here but not yet
      // surfaced - Phase 2 threads it through to the paired-device list.
      this.handshake.readMessage(frame);
    } catch {
      this.fail('Pairing handshake failed to authenticate (wrong or expired code)');
      return;
    }

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

    this.phase = 'sas-pending';
    const sas = deriveShortAuthenticationString(this.handshake.getHandshakeHash());
    this.emit('sas', { sas, phoneStaticPublicKeyHex: bytesToHex(phoneStaticPublicKey) });
  }

  /** Called once the user confirms both screens show the same SAS. Signs the phone's static key into the roster. */
  confirmSas(deviceId: string, displayName: string, capabilities: CapabilityVerb[] = DEFAULT_PAIRING_CAPABILITIES): void {
    if (this.phase !== 'sas-pending' || !this.handshake) {
      throw new Error(`Cannot confirm pairing while phase is "${this.phase}"`);
    }
    const phoneStaticPublicKey = this.handshake.getRemoteStaticKey();
    if (!phoneStaticPublicKey) throw new Error('No phone identity key to confirm');

    addOrReplaceDevice(this.identity, {
      deviceId,
      staticPublicKey: phoneStaticPublicKey,
      displayName,
      capabilities,
      expiresAt: null,
    });

    this.phase = 'done';
    this.emit('confirmed', { deviceId });
    this.teardown();
  }

  /** Called if the user reports the SAS codes do NOT match, or cancels before that point. */
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
    this.unsubscribeFrame?.();
    this.unsubscribeFrame = null;
    this.activeTransport = null;
    this.handshake = null;
  }
}

export type { ShortAuthenticationString };
