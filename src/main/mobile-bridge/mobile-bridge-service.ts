import { EventEmitter } from 'node:events';
import {
  bytesToHex,
  capabilitySetFromArray,
  deriveSessionSlotId,
  encodePairingQrPayload,
  PROTOCOL_VERSION,
  rosterDeviceCapabilitySet,
  type CapabilityVerb,
  type PairingQrPayload,
  type RosterDeviceEntry,
  type ShortAuthenticationString,
} from '@kangentic/protocol';
import { isGenuineEncryptionAvailable } from '../boards/shared/auth';
import { DevQuickPair } from './dev-quick-pair';
import { DiffWatcher } from '../git/diff-watcher';
import { loadBridgeIdentity, loadOrCreateBridgeIdentity, type BridgeIdentity } from './identity';
import {
  loadRoster,
  revokeDevice as revokeDeviceInRoster,
  setDeviceCapabilities as setDeviceCapabilitiesInRoster,
} from './roster-store';
import { DEFAULT_PAIRING_CAPABILITIES, PairingService } from './pairing/pairing-service';
import { createTransport } from './transport/transport-factory';
import { BridgeSession } from './session/bridge-session';
import { SubscriptionRegistry } from './session/subscription-registry';
import { CapabilityRouter } from './capability-router';
import { registerCapabilityHandlers } from './handlers';
import { SessionLifecycleBoardFeed } from './session-lifecycle-feed';
import { PushRegistrationStore } from './push/push-registration-store';
import { PushNotifier } from './push/push-notifier';
import { getProjectRepos } from '../ipc/helpers/project-repos';
import type { IpcContext } from '../ipc/ipc-context';

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
 * active pairing ceremony (if any), and one live BridgeSession per roster
 * device once `attachContext()` has wired the capability handlers -
 * `syncSessions()` (driven by `reconcile()` and by a successful pairing
 * confirmation) keeps the `sessions` map in step with the roster.
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
  private readonly subscriptionsByDevice = new Map<string, SubscriptionRegistry>();
  /**
   * Bridge-owned diff watcher, NEVER `IpcContext.diffWatcher` - that
   * instance is shared with the renderer's git-diff panel and is
   * single-watch-per-path, so a bridge subscription teardown would kill
   * the renderer's live watch on the same worktree (and vice versa).
   */
  private readonly diffWatcher = new DiffWatcher();
  /** Dev-only instant pairing for the mobile dev rig; every call site is __KANGENTIC_DEV__-gated so packaged builds drop it. */
  private readonly devQuickPair = new DevQuickPair({
    getIdentity: () => this.ensureIdentity(),
    getRelayUrl: () => this.config.relayUrl,
    onRosterChanged: () => {
      void this.syncSessions();
      this.emit('stateChanged');
    },
  });
  private ipcContext: IpcContext | null = null;
  /** Feeds session lifecycle edges onto the board-changed bus so phones' board views track spawn/queue/suspend/exit. */
  private sessionLifecycleFeed: SessionLifecycleBoardFeed | null = null;
  /** Per-device push registrations (Expo token + envelope key), written by the register-push handler and read by the notifier. */
  readonly pushRegistrations = new PushRegistrationStore();
  /** Seals and sends E2E push notifications on permission/turn-complete/crash triggers. */
  private pushNotifier: PushNotifier | null = null;
  private disposed = false;

  constructor(config: MobileBridgeConfig) {
    super();
    this.config = config;
  }

  /**
   * Wires the capability-verb handlers to the main-process seams they need
   * (SessionManager, repositories, DiffService, commandHandlers) and stores
   * the context for syncSessions() to use. Called once from register-all.ts
   * after IpcContext is assembled - IpcContext does not exist yet at this
   * service's construction time, so it cannot be a constructor argument.
   * Registers handlers exactly once; never call this more than once.
   */
  attachContext(context: IpcContext): void {
    this.ipcContext = context;
    registerCapabilityHandlers(this.capabilityRouter, {
      context,
      diffWatcher: this.diffWatcher,
      getSubscriptions: (deviceId) => this.getOrCreateSubscriptions(deviceId),
      pushRegistrations: this.pushRegistrations,
    });
    this.sessionLifecycleFeed = new SessionLifecycleBoardFeed({
      sessionManager: context.sessionManager,
      boardEvents: context.boardEvents,
    });
    this.sessionLifecycleFeed.start();
    this.pushNotifier = new PushNotifier({
      sessionManager: context.sessionManager,
      registrationStore: this.pushRegistrations,
      // Presence = a live established bridge session for that device; the
      // user is already watching from it, so it is never pinged.
      getEstablishedDeviceIds: () => {
        const establishedDeviceIds = new Set<string>();
        for (const [deviceId, session] of this.sessions) {
          if (session.isEstablished) establishedDeviceIds.add(deviceId);
        }
        return establishedDeviceIds;
      },
      resolveTaskContext: (sessionId) => {
        const projectId = context.sessionManager.getSessionProjectId(sessionId);
        const taskId = context.sessionManager.getSessionTaskId(sessionId);
        if (!projectId || !taskId) return null;
        let taskTitle = '';
        try {
          taskTitle = getProjectRepos(context, projectId).tasks.getById(taskId)?.title ?? '';
        } catch {
          // Best-effort: an unknown title still yields a useful notification.
        }
        return { projectId, taskId, taskTitle };
      },
      getDeviceStaticPublicKey: (deviceId) => {
        const identity = this.tryLoadIdentity();
        if (!identity) return null;
        return loadRoster(identity).devices.find((device) => device.deviceId === deviceId)?.staticPublicKey ?? null;
      },
    });
    this.pushNotifier.start();
  }

  private getOrCreateSubscriptions(deviceId: string): SubscriptionRegistry {
    let subscriptions = this.subscriptionsByDevice.get(deviceId);
    if (!subscriptions) {
      subscriptions = new SubscriptionRegistry();
      this.subscriptionsByDevice.set(deviceId, subscriptions);
    }
    return subscriptions;
  }

  /** Applies effective config. Called from register-all.ts at startup and from applyRuntimeConfig on every config:set. */
  reconcile(config: MobileBridgeConfig): void {
    const previousRelayUrl = this.config.relayUrl;
    const wasEnabled = this.config.enabled;
    this.config = config;
    if (__KANGENTIC_DEV__) {
      this.devQuickPair.reconcile(config.enabled && config.relayUrl.length > 0 && isGenuineEncryptionAvailable());
    }
    if (!config.enabled && wasEnabled) {
      this.cancelPairing('Mobile bridge disabled');
      this.disposeAllSessions();
      return;
    }
    // A relay URL change while already enabled invalidates every open
    // session's transport (it dials a now-stale address) - dispose and let
    // syncSessions() below reopen each roster device against the new relay.
    if (config.enabled && config.relayUrl !== previousRelayUrl) {
      this.disposeAllSessions();
    }
    void this.syncSessions();
  }

  /**
   * Coalesces concurrent sync requests. Session insertion is synchronous now
   * (openSessionForDevice inserts before its fire-and-forget dial), so the
   * historical duplicate-session race is gone; the coalescing stays because
   * its callers still overlap (reconcile() fires on every config:set, and
   * pairing confirmation calls in independently) and a run in flight must not
   * be interleaved with a second roster diff. A request that arrives mid-run
   * queues exactly one follow-up so the roster is re-diffed after the current
   * pass finishes.
   */
  private syncInFlight: Promise<void> | null = null;
  private syncRequestedDuringRun = false;

  private syncSessions(): Promise<void> {
    if (this.syncInFlight) {
      this.syncRequestedDuringRun = true;
      return this.syncInFlight;
    }
    this.syncInFlight = this.runSyncSessions().finally(() => {
      this.syncInFlight = null;
      if (this.syncRequestedDuringRun) {
        this.syncRequestedDuringRun = false;
        void this.syncSessions();
      }
    });
    return this.syncInFlight;
  }

  /**
   * Diffs the live `sessions` map against the signed roster: opens a
   * BridgeSession for every roster device that does not already have one,
   * and disposes any session whose device fell out of the roster
   * (revocation). Never call directly - go through syncSessions() so
   * overlapping runs are coalesced (reconcile() fires on every config:set
   * and pairing confirmation calls in independently).
   */
  private async runSyncSessions(): Promise<void> {
    if (!this.ipcContext) return;
    if (!this.config.enabled || !isGenuineEncryptionAvailable()) {
      this.disposeAllSessions();
      return;
    }
    const identity = this.tryLoadIdentity();
    if (!identity) {
      this.disposeAllSessions();
      return;
    }

    const roster = loadRoster(identity);
    const rosterDeviceIds = new Set(roster.devices.map((device) => device.deviceId));
    for (const deviceId of this.sessions.keys()) {
      if (!rosterDeviceIds.has(deviceId)) this.disposeSession(deviceId);
    }

    for (const device of roster.devices) {
      if (this.sessions.has(device.deviceId)) continue;
      this.openSessionForDevice(identity, device);
    }
  }

  private openSessionForDevice(identity: BridgeIdentity, device: RosterDeviceEntry): void {
    const slotId = deriveSessionSlotId(identity.staticKeyPair.publicKey, device.staticPublicKey);
    const transport = createTransport({ relayUrl: this.config.relayUrl, slotId });
    const session = new BridgeSession({
      identity,
      deviceId: device.deviceId,
      remoteStaticPublicKey: device.staticPublicKey,
      capabilities: rosterDeviceCapabilitySet(device),
      transport,
    });
    this.wireSessionListeners(session);
    session.start();
    this.sessions.set(device.deviceId, session);
    // A roster session is persistent: the first dial can fail outright (a
    // local relay that is not up yet - the desktop-launched-before-relay
    // case), and RelayClient keeps re-dialing with capped backoff while
    // BridgeSession re-initiates the handshake on every transition into
    // 'connected', so the link self-heals whenever the relay appears.
    // Bailing on a failed first dial (the previous behavior) left the
    // bridge permanently disconnected until the user toggled it off and
    // on. The reconnect loop cannot leak: session.dispose() closes the
    // transport (revocation, disable, shutdown all route through it).
    // Unlike a pairing ceremony's transport, this attempt is never
    // meaningless while the device stays in the roster.
    void transport.connect().catch(() => {
      // The transport's own backoff loop owns recovery from here.
    });
  }

  /**
   * Routes every decoded capability-request through the router and sends
   * the response back. Non-request message types (heartbeat,
   * capability-response, event) are inbound-to-phone-only and ignored here.
   */
  private wireSessionListeners(session: BridgeSession): void {
    const deviceId = session.deviceId;
    session.on('message', (message) => {
      if (message.type !== 'capability-request') return;
      void this.capabilityRouter.dispatch(message, session).then((response) => {
        try {
          session.sendMessage(response);
        } catch {
          // The session may have dropped mid-dispatch; nothing to recover here.
        }
      });
    });
    session.on('remoteClosed', () => {
      // Stop pushing events into a dead channel. The BridgeSession/transport
      // stay alive so the relay's reconnect + next re-handshake re-establish
      // the connection; the phone re-arms live subscriptions with fresh
      // read-* requests once reconnected, rather than this side guessing
      // what to re-push.
      this.subscriptionsByDevice.get(deviceId)?.dispose();
      this.subscriptionsByDevice.delete(deviceId);
    });
  }

  private disposeSession(deviceId: string): void {
    this.sessions.get(deviceId)?.dispose();
    this.sessions.delete(deviceId);
    this.subscriptionsByDevice.get(deviceId)?.dispose();
    this.subscriptionsByDevice.delete(deviceId);
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
    // A revoked device must stop receiving pushes too, unconditionally -
    // before the identity guard, so a registration can never outlive its
    // device under any teardown ordering.
    this.pushRegistrations.remove(deviceId);
    const identity = this.tryLoadIdentity();
    if (!identity) return; // No identity means no roster, so nothing to revoke.
    revokeDeviceInRoster(identity, deviceId);
    this.disposeSession(deviceId);
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
      // The freshly-paired device is now in the roster; open its
      // BridgeSession immediately rather than waiting for the next
      // config-driven reconcile() (which may not happen again this run).
      void this.syncSessions();
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
    for (const subscriptions of this.subscriptionsByDevice.values()) subscriptions.dispose();
    this.subscriptionsByDevice.clear();
  }

  /** Synchronous, per synchronous-shutdown.md: no async work, no timers left un-cleared. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.devQuickPair.stop();
    this.sessionLifecycleFeed?.dispose();
    this.sessionLifecycleFeed = null;
    this.pushNotifier?.dispose();
    this.pushNotifier = null;
    this.cancelPairing('Mobile bridge service shutting down');
    this.disposeAllSessions();
    this.diffWatcher.closeAll();
  }
}
