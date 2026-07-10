import { EventEmitter } from 'node:events';
import {
  bytesToHex,
  capabilitySetFromArray,
  encodePairingQrPayload,
  PROTOCOL_VERSION,
  type CapabilityVerb,
  type PairingQrPayload,
  type ShortAuthenticationString,
} from '@kangentic/protocol';
import { isGenuineEncryptionAvailable } from '../boards/shared/auth';
import { loadBridgeIdentity, loadOrCreateBridgeIdentity, type BridgeIdentity } from './identity';
import {
  loadRoster,
  revokeDevice as revokeDeviceInRoster,
  setDeviceCapabilities as setDeviceCapabilitiesInRoster,
} from './roster-store';
import { DEFAULT_PAIRING_CAPABILITIES, PairingService } from './pairing/pairing-service';
import { createTransport } from './transport/transport-factory';
import type { BridgeSession } from './session/bridge-session';
import { CapabilityRouter } from './capability-router';

export interface MobileBridgeConfig {
  enabled: boolean;
  relayUrl: string;
}

export interface MobileBridgeStatus {
  enabled: boolean;
  secureStorageAvailable: boolean;
  /** Hex-encoded static public key, for display/verification - never the private key. */
  identityFingerprint: string | null;
  relayUrl: string;
  pairedDeviceCount: number;
  pairingInProgress: boolean;
}

export interface PairedDeviceSummary {
  deviceId: string;
  displayName: string;
  capabilities: CapabilityVerb[];
  pairedAt: string;
}

/**
 * The long-lived mobile bridge service: owned by IpcContext (constructed
 * in register-all.ts, torn down synchronously in index.ts's
 * clearPendingTimers), modeled on SessionManager/TranscriptionService's
 * shape. Owns the desktop's identity, the signed device roster, the
 * active pairing ceremony (if any), and (once Phase 2 gives sessions
 * something to do) one BridgeSession per connected paired device.
 *
 * Identity creation is deferred to the FIRST deliberate pairing attempt
 * (ensureIdentity(), called only from startPairing()), not the
 * constructor and not any read path (getStatus/listDevices/etc use
 * tryLoadIdentity(), which never creates one). Merely opening the
 * settings tab or checking status must not have the side effect of
 * generating and persisting a device keypair. Constructing this service
 * never throws even when secure storage is unavailable - getStatus()
 * surfaces that condition for the settings UI instead.
 */
export class MobileBridgeService extends EventEmitter {
  readonly capabilityRouter = new CapabilityRouter();
  private config: MobileBridgeConfig;
  private identity: BridgeIdentity | null = null;
  private activePairing: PairingService | null = null;
  private pendingPairingDeviceId: string | null = null;
  private readonly sessions = new Map<string, BridgeSession>();
  private disposed = false;

  constructor(config: MobileBridgeConfig) {
    super();
    this.config = config;
  }

  /** Applies effective config. Called from register-all.ts at startup and from applyRuntimeConfig on every config:set. */
  reconcile(config: MobileBridgeConfig): void {
    const wasEnabled = this.config.enabled;
    this.config = config;
    if (!config.enabled && wasEnabled) {
      this.cancelPairing('Mobile bridge disabled');
      this.disposeAllSessions();
    }
    // Reconnecting already-paired devices' sessions on enable/relayUrl
    // change is a Phase 2 concern once capability verbs give a session
    // something to do; Phase 1 establishes the identity/roster/pairing
    // surface.
  }

  /** Creates a new identity if none exists. Only called from startPairing() - a deliberate user action - never from a read path. */
  private ensureIdentity(): BridgeIdentity {
    if (!this.identity) this.identity = loadOrCreateBridgeIdentity();
    return this.identity;
  }

  /**
   * Reads the identity WITHOUT creating one. Merely checking status,
   * listing devices, or opening the settings tab must never have the side
   * effect of generating and persisting a new device keypair - only
   * startPairing() (a deliberate "Pair a device" click) does that.
   */
  private tryLoadIdentity(): BridgeIdentity | null {
    if (this.identity) return this.identity;
    const loaded = loadBridgeIdentity();
    if (loaded) this.identity = loaded;
    return loaded;
  }

  getStatus(): MobileBridgeStatus {
    const secureStorageAvailable = isGenuineEncryptionAvailable();
    let identityFingerprint: string | null = null;
    let pairedDeviceCount = 0;
    if (secureStorageAvailable) {
      const identity = this.tryLoadIdentity();
      if (identity) {
        identityFingerprint = bytesToHex(identity.staticKeyPair.publicKey);
        pairedDeviceCount = loadRoster(identity).devices.length;
      }
    }
    return {
      enabled: this.config.enabled,
      secureStorageAvailable,
      identityFingerprint,
      relayUrl: this.config.relayUrl,
      pairedDeviceCount,
      pairingInProgress: this.activePairing !== null,
    };
  }

  listDevices(): PairedDeviceSummary[] {
    const identity = this.tryLoadIdentity();
    if (!identity) return [];
    return loadRoster(identity).devices.map((device) => ({
      deviceId: device.deviceId,
      displayName: device.displayName,
      capabilities: device.capabilities,
      pairedAt: device.pairedAt,
    }));
  }

  revokeDevice(deviceId: string): void {
    const identity = this.tryLoadIdentity();
    if (!identity) return; // No identity means no roster, so nothing to revoke.
    revokeDeviceInRoster(identity, deviceId);
    const session = this.sessions.get(deviceId);
    if (session) {
      session.dispose();
      this.sessions.delete(deviceId);
    }
    // Revocation = drop from the roster AND rotate channel keys (see
    // roster-store.ts's revokeDevice doc comment). Rotating the desktop's
    // own static key also invalidates every OTHER paired device's ability
    // to complete a KK handshake, since KK requires both sides to already
    // know the CURRENT static key - an actual rotation + re-provisioning
    // flow for any remaining paired devices is Phase 2/3 scope once there
    // is more than a single paired device to reason about in practice.
    // Phase 1 ships the roster-side "drop" half.
    this.emit('stateChanged');
  }

  setDeviceCapabilities(deviceId: string, capabilities: CapabilityVerb[]): void {
    const identity = this.tryLoadIdentity();
    if (!identity) throw new Error(`No such paired device: ${deviceId}`);
    setDeviceCapabilitiesInRoster(identity, deviceId, capabilities);
    const session = this.sessions.get(deviceId);
    if (session) session.capabilities = capabilitySetFromArray(capabilities);
    this.emit('stateChanged');
  }

  async startPairing(): Promise<{ qrPayload: PairingQrPayload; qrUri: string }> {
    if (!this.config.enabled) throw new Error('Mobile bridge is not enabled');
    if (this.activePairing) throw new Error('A pairing ceremony is already in progress');

    const identity = this.ensureIdentity();
    const pairingService = new PairingService(identity);
    const token = pairingService.mintToken();
    this.activePairing = pairingService;
    this.pendingPairingDeviceId = null;

    const slotId = bytesToHex(token.token);
    const transport = createTransport({ relayUrl: this.config.relayUrl, slotId });

    pairingService.on('sas', (payload: { sas: ShortAuthenticationString; phoneStaticPublicKeyHex: string }) => {
      this.pendingPairingDeviceId = payload.phoneStaticPublicKeyHex;
      this.emit('pairingSas', payload);
    });
    pairingService.once('confirmed', () => {
      this.activePairing = null;
      this.pendingPairingDeviceId = null;
      this.emit('stateChanged');
    });
    pairingService.once('cancelled', (payload: { reason: string }) => {
      this.activePairing = null;
      this.pendingPairingDeviceId = null;
      transport.close();
      this.emit('pairingEnded', payload);
    });
    pairingService.once('failed', (payload: { reason: string }) => {
      this.activePairing = null;
      this.pendingPairingDeviceId = null;
      transport.close();
      this.emit('pairingEnded', payload);
    });

    try {
      await transport.connect();
    } catch (error) {
      // Close the transport we just created before rethrowing: RelayClient
      // arms an internal reconnect timer on a failed dial, so abandoning it
      // here (it is not stored on `this`, so dispose() cannot reach it)
      // would leak a permanent reconnect loop against a now-meaningless slot.
      transport.close();
      this.activePairing = null;
      throw error;
    }
    pairingService.start(transport);

    const qrPayload: PairingQrPayload = {
      desktopStaticPublicKey: identity.staticKeyPair.publicKey,
      pairingToken: token.token,
      relayAddress: this.config.relayUrl,
      expiresAt: new Date(token.expiresAt).toISOString(),
      protocolVersion: PROTOCOL_VERSION,
    };
    return { qrPayload, qrUri: encodePairingQrPayload(qrPayload) };
  }

  /** deviceId is derived from the phone's static key at SAS time, not chosen by the caller - the settings UI only ever supplies a display name and the granted capabilities. */
  confirmPairing(displayName: string, capabilities: CapabilityVerb[] = DEFAULT_PAIRING_CAPABILITIES): void {
    if (!this.activePairing || !this.pendingPairingDeviceId) {
      throw new Error('No pairing ceremony with a confirmed SAS is in progress');
    }
    this.activePairing.confirmSas(this.pendingPairingDeviceId, displayName, capabilities);
  }

  cancelPairing(reason = 'Cancelled by user'): void {
    this.activePairing?.cancel(reason);
    this.activePairing = null;
    this.pendingPairingDeviceId = null;
  }

  private disposeAllSessions(): void {
    for (const session of this.sessions.values()) session.dispose();
    this.sessions.clear();
  }

  /** Synchronous, per synchronous-shutdown.md: no async work, no timers left un-cleared. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.cancelPairing('Mobile bridge service shutting down');
    this.disposeAllSessions();
  }
}
