import { EventEmitter } from 'node:events';
import {
  bytesToHex,
  capabilitySetFromArray,
  CAPABILITY_VERBS,
  derivePairingSlotId,
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
import { validateRelayUrl } from '../../shared/relay';
import type { MobileBridgeStatus, MobileBridgeTransportState, MobileDeviceConnectionState } from '../../shared/types';
import { DevQuickPair } from './dev-quick-pair';
import { DiffWatcher } from '../git/diff-watcher';
import { loadBridgeIdentity, loadOrCreateBridgeIdentity, type BridgeIdentity } from './identity';
import {
  loadRoster,
  revokeDevice as revokeDeviceInRoster,
  setDeviceCapabilities as setDeviceCapabilitiesInRoster,
  setDeviceDisplayName as setDeviceDisplayNameInRoster,
} from './roster-store';
import { PairingService, sanitizeDeviceName } from './pairing/pairing-service';
import { createTransport } from './transport/transport-factory';
import { BridgeSession } from './session/bridge-session';
import { SubscriptionRegistry } from './session/subscription-registry';
import { CapabilityRouter } from './capability-router';
import { registerCapabilityHandlers } from './handlers';
import { terminalStreamKeyFor, TERMINAL_STREAM_KEY_PREFIX } from './handlers/read-stream';
import { sizeGuardKeyFor } from './handlers/terminal-size-guard';
import { SessionLifecycleBoardFeed } from './session-lifecycle-feed';
import { PushRegistrationStore } from './push/push-registration-store';
import { PushNotifier } from './push/push-notifier';
import { SpawnStallWatcher } from './push/spawn-stall-watcher';
import { getProjectRepos } from '../ipc/helpers/project-repos';
import type { IpcContext } from '../ipc/ipc-context';

export interface MobileBridgeConfig {
  enabled: boolean;
  relayUrl: string;
}

/** MobileBridgeStatus is defined once, in src/shared/types.ts (the renderer needs the same shape) - this file only builds and returns it. */

/**
 * RelayClient cycles connecting<->reconnecting on a 500ms backoff while a
 * relay is unreachable; without coalescing, every device's transport flap
 * would fire 'stateChanged' (which the renderer answers with a status +
 * devices re-fetch) up to twice a second. A device's relayState is always
 * readable synchronously via getStatus() regardless of this window - only
 * the CHANGE NOTIFICATION is throttled, not the value itself.
 */
const RELAY_STATE_EMIT_WINDOW_MS = 500;

export interface PairedDeviceSummary {
  deviceId: string;
  displayName: string;
  capabilities: CapabilityVerb[];
  pairedAt: string;
  /** Live, not persisted - per-device connection state, sourced from its open BridgeSession (or 'idle' if none is open yet). Replaces a panel-wide relay indicator with one that answers "is THIS device reachable". */
  connectionState: MobileDeviceConnectionState;
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
  private readonly sessions = new Map<string, BridgeSession>();
  private readonly subscriptionsByDevice = new Map<string, SubscriptionRegistry>();
  /**
   * Bridge-owned diff watcher, NEVER `IpcContext.diffWatcher` - that
   * instance is shared with the renderer's git-diff panel and is
   * single-watch-per-path, so a bridge subscription teardown would kill
   * the renderer's live watch on the same worktree (and vice versa).
   */
  private readonly diffWatcher = new DiffWatcher();
  /**
   * Dev-only instant pairing for the mobile dev rig. `null` in a production
   * build: constructed only inside `if (__KANGENTIC_DEV__)` in the
   * constructor below, not as an unconditional field initializer, because an
   * unconditional `new DevQuickPair(...)` here would still run (and keep the
   * module reachable, defeating dead-code elimination) in every build - the
   * gate has to wrap the CONSTRUCTION, not just the later reconcile() call.
   */
  private readonly devQuickPair: DevQuickPair | null;
  private ipcContext: IpcContext | null = null;
  /** Feeds session lifecycle edges onto the board-changed bus so phones' board views track spawn/queue/suspend/exit. */
  private sessionLifecycleFeed: SessionLifecycleBoardFeed | null = null;
  /** Per-device push registrations (Expo token + envelope key), written by the register-push handler and read by the notifier. */
  readonly pushRegistrations = new PushRegistrationStore();
  /** Seals and sends E2E push notifications on permission/turn-complete/crash/plan/stall triggers. */
  private pushNotifier: PushNotifier | null = null;
  /** Fires PushNotifier.notifyTaskStalled() when a task's spawn sits in-flight past the stall threshold. */
  private spawnStallWatcher: SpawnStallWatcher | null = null;
  /**
   * The connection signature most recently emitted via 'stateChanged', so
   * RELAY_STATE_EMIT_WINDOW_MS only re-emits on an actual value change, not on
   * every transport flap.
   *
   * It covers the aggregate AND every device's own connection state, because
   * 'stateChanged' tells the renderer to re-read both. Gating on the aggregate
   * alone was the "Connecting... forever" bug: precedence pins the aggregate at
   * 'connected' the moment ANY device connects, so a second device's own
   * transitions never moved it, never notified, and left that row frozen at
   * whatever the last fetch happened to see - stale in both directions.
   */
  private lastEmittedConnectionSignature: string | null = null;
  private relayStateEmitTimer: ReturnType<typeof setTimeout> | null = null;
  private terminalStreamsEmitScheduled = false;
  private lastEmittedTerminalStreamsSignature = '';
  private disposed = false;

  constructor(config: MobileBridgeConfig) {
    super();
    this.config = config;
    this.devQuickPair = __KANGENTIC_DEV__
      ? new DevQuickPair({
          getIdentity: () => this.ensureIdentity(),
          getRelayUrl: () => this.config.relayUrl,
          onRosterChanged: () => {
            void this.syncSessions();
            this.emitStateChanged();
          },
        })
      : null;
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
    // The resting park's two questions (see MobileTerminalProbe), answered
    // from the per-device subscription registries the guard and read-stream
    // handlers already maintain through every release path (explicit release,
    // transport drop, revoke, shutdown). A desktop that never pairs never
    // constructs this service's transports or registries, and a session
    // manager with no probe never parks - the unpaired desktop is untouched
    // by the whole mobile terminal feature.
    context.sessionManager.setMobileTerminalProbe({
      isSizeHeld: (sessionId) => this.anyDeviceSubscriptionHas(sizeGuardKeyFor(sessionId)),
      // TERMINAL-wanting subscriptions only, never the bare stream key: the
      // phone holds a list-only stream subscription for EVERY live session
      // whenever it is connected (its activity feed), and answering from
      // `stream:<id>` made the park fire for all of them - which reshaped
      // sessions no phone terminal ever opened and garbled their later panel
      // reveals (observed live 2026-08-02).
      hasStreamSubscriber: (sessionId) => this.anyDeviceSubscriptionHas(terminalStreamKeyFor(sessionId)),
    });
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
      // A spawn stall has no session yet, so there is no getSessionProjectId
      // to consult - scan every known project's task repo instead. Rare
      // (fires once per stalled spawn, 8s after it starts), so a linear
      // scan over the project list is fine.
      resolveTaskContextByTaskId: (taskId) => {
        for (const project of context.projectRepo.list()) {
          try {
            const task = getProjectRepos(context, project.id).tasks.getById(taskId);
            if (task) return { projectId: project.id, taskId, taskTitle: task.title };
          } catch {
            // This project's repos may not be initialized; try the next one.
          }
        }
        return null;
      },
      getDeviceStaticPublicKey: (deviceId) => {
        const identity = this.tryLoadIdentity();
        if (!identity) return null;
        return loadRoster(identity).devices.find((device) => device.deviceId === deviceId)?.staticPublicKey ?? null;
      },
    });
    this.pushNotifier.start();
    this.spawnStallWatcher = new SpawnStallWatcher({
      onStall: (taskId) => this.pushNotifier?.notifyTaskStalled(taskId),
    });
    this.spawnStallWatcher.start();
    // Runs exactly once, before the first reconcile()'s syncSessions() opens
    // any BridgeSession - see the method's own doc comment for why this
    // cannot be a plain roster field mutation.
    this.migrateDevicesToFullCapabilityGrant();
  }

  /**
   * One-shot upgrade for devices paired before pairing granted the full
   * verb set: capabilities live inside the Ed25519-signed roster payload
   * (roster-store.ts), so mutating them without re-signing would fail
   * verifyRosterEntry and silently drop the device from the roster on the
   * next load. Routing through the public setDeviceCapabilities (which
   * re-signs) is what makes this safe, and it also updates any
   * already-open BridgeSession's live capability set - though at
   * attachContext() time no session has opened yet, so in practice this
   * only rewrites the on-disk roster before syncSessions() reads it.
   */
  private migrateDevicesToFullCapabilityGrant(): void {
    const identity = this.tryLoadIdentity();
    if (!identity) return;
    const fullGrant = new Set<CapabilityVerb>(CAPABILITY_VERBS);
    for (const device of loadRoster(identity).devices) {
      const currentGrant = new Set(device.capabilities);
      const hasFullGrant = currentGrant.size === fullGrant.size && CAPABILITY_VERBS.every((verb) => currentGrant.has(verb));
      if (!hasFullGrant) this.setDeviceCapabilities(device.deviceId, [...CAPABILITY_VERBS]);
    }
  }

  private getOrCreateSubscriptions(deviceId: string): SubscriptionRegistry {
    let subscriptions = this.subscriptionsByDevice.get(deviceId);
    if (!subscriptions) {
      subscriptions = new SubscriptionRegistry(() => this.scheduleTerminalStreamsEmit());
      this.subscriptionsByDevice.set(deviceId, subscriptions);
    }
    return subscriptions;
  }

  /** Whether ANY paired device currently holds a subscription under this key. */
  private anyDeviceSubscriptionHas(key: string): boolean {
    for (const subscriptions of this.subscriptionsByDevice.values()) {
      if (subscriptions.has(key)) return true;
    }
    return false;
  }

  /**
   * Sessions with a live terminal-WANTING stream subscription on any device -
   * the sessions a phone is actually watching the terminal of, not merely
   * listing in its feed. The renderer suspends the bottom panel's terminal
   * for these (the resting park owns their grid; a panel xterm fitting them
   * to its strip is what produced both the phone's sliver view and the
   * mis-wrapped panel), so it needs to know the set and every change to it.
   */
  terminalStreamedSessionIds(): string[] {
    const sessionIds = new Set<string>();
    for (const subscriptions of this.subscriptionsByDevice.values()) {
      for (const key of subscriptions.keys()) {
        if (key.startsWith(TERMINAL_STREAM_KEY_PREFIX)) sessionIds.add(key.slice(TERMINAL_STREAM_KEY_PREFIX.length));
      }
    }
    return [...sessionIds].sort();
  }

  /**
   * Coalesced per microtask (a re-subscribe fires remove + add back to back;
   * a device drop clears many keys at once) and deduplicated against the
   * last emitted value, so listeners only ever see actual changes.
   */
  private scheduleTerminalStreamsEmit(): void {
    if (this.terminalStreamsEmitScheduled || this.disposed) return;
    this.terminalStreamsEmitScheduled = true;
    queueMicrotask(() => {
      this.terminalStreamsEmitScheduled = false;
      if (this.disposed) return;
      const sessionIds = this.terminalStreamedSessionIds();
      const signature = sessionIds.join(',');
      if (signature === this.lastEmittedTerminalStreamsSignature) return;
      this.lastEmittedTerminalStreamsSignature = signature;
      this.emit('terminalStreamsChanged', sessionIds);
    });
  }

  /** Applies effective config. Called from register-all.ts at startup and from applyRuntimeConfig on every config:set. */
  reconcile(config: MobileBridgeConfig): void {
    const previousRelayUrl = this.config.relayUrl;
    const wasEnabled = this.config.enabled;
    this.config = config;
    if (__KANGENTIC_DEV__) {
      // config.relayUrl is always resolved (see src/shared/relay.ts's
      // resolveRelayUrl at both reconcile() call sites) and therefore never
      // '', so there is no longer a meaningful empty-URL case to gate on here.
      this.devQuickPair?.reconcile(config.enabled && isGenuineEncryptionAvailable());
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
    session.on('peerAbsent', () => {
      // The SILENT departure (backgrounding, lost network, OS kill) sends no
      // Final frame, so 'remoteClosed' never fires for it - yet the phone's
      // subscriptions are just as dead. Without this, the stream-terminal
      // marker outlived the phone: the resting park stayed armed and the
      // bottom panel's tab stayed dropped for a device the desktop itself
      // showed as offline, healing only when the phone happened to return.
      // Same recovery contract as 'remoteClosed': re-arm on reconnect.
      this.subscriptionsByDevice.get(deviceId)?.dispose();
      this.subscriptionsByDevice.delete(deviceId);
    });
    session.on('transportState', () => this.scheduleRelayStateEmit());
    // The per-device badge tracks establishment and peer presence, not just
    // the transport, so it moves on edges 'transportState' never sees (a
    // completed handshake, a spent presence probe, an expired reconnect
    // hold). Scheduling from both is free - the signature check dedupes.
    session.on('connectionState', () => this.scheduleRelayStateEmit());
  }

  /**
   * Precedence connected > connecting > reconnecting > closed, so any one
   * healthy device reads as healthy overall; 'idle' when there are no
   * sessions. Deliberately excludes the ephemeral pairing transport (see
   * startPairing()) - it has its own error surface via 'pairingEnded', and
   * including it would flap this steady-state field during every pairing
   * ceremony.
   */
  private aggregateRelayState(): MobileBridgeTransportState {
    if (this.sessions.size === 0) return 'idle';
    const states = new Set<MobileBridgeTransportState>();
    for (const session of this.sessions.values()) states.add(session.transportState);
    if (states.has('connected')) return 'connected';
    if (states.has('connecting')) return 'connecting';
    if (states.has('reconnecting')) return 'reconnecting';
    if (states.has('closed')) return 'closed';
    return 'idle';
  }

  /**
   * Everything a 'stateChanged' asks the renderer to re-read that can change
   * without a deliberate roster mutation: the aggregate plus each device's own
   * connection state. Device order is fixed by the map's insertion order being
   * irrelevant here - the pairs are sorted - so the signature is stable.
   */
  private connectionSignature(): string {
    const perDevice = [...this.sessions.entries()]
      .map(([deviceId, session]) => `${deviceId}:${session.connectionState}`)
      .sort();
    return `${this.aggregateRelayState()}|${perDevice.join(',')}`;
  }

  /**
   * Coalesces bursts of per-session connection churn into at most one
   * 'stateChanged' emission per RELAY_STATE_EMIT_WINDOW_MS, and only when
   * something actually changed - not a plain debounce (which would
   * reset on every flap and could delay delivery indefinitely under
   * sustained backoff churn), a throttle: the first change in a window
   * schedules a check at the end of that window, and further changes
   * during the window are absorbed into it.
   */
  private scheduleRelayStateEmit(): void {
    if (this.relayStateEmitTimer) return;
    this.relayStateEmitTimer = setTimeout(() => {
      this.relayStateEmitTimer = null;
      const signature = this.connectionSignature();
      if (signature === this.lastEmittedConnectionSignature) return;
      // Hand over the signature just computed rather than making
      // emitStateChanged() rebuild an identical one.
      this.emitStateChanged(signature);
    }, RELAY_STATE_EMIT_WINDOW_MS);
    this.relayStateEmitTimer.unref?.();
  }

  /**
   * The ONLY way this service emits 'stateChanged'. Rebaselines
   * lastEmittedConnectionSignature so the throttle above always compares
   * against what the renderer was last actually told.
   *
   * A bare this.emit('stateChanged') leaves that baseline stale, and the
   * throttle then suppresses a later REAL transition as a no-op change. The
   * concrete failure: connect device A (baseline := 'connected'), revoke it
   * (direct emit, aggregate now 'idle', baseline still 'connected'), pair
   * device B - when B reaches 'connected' the throttle compares 'connected'
   * against the stale 'connected', suppresses, and the indicator stays stuck
   * on "Connecting..." forever.
   *
   * Its direct callers (rename / revoke / capabilities / pairing confirmed /
   * dev quick pair) reach this BYPASSING the throttle, and only rebaseline as
   * a side effect - they may have their own preconditions, but none of them is
   * the signature. The signature is a throttle input, not an emit precondition:
   * it covers connection state, not displayName or capabilities, so routing
   * those callers through scheduleRelayStateEmit() "for consistency" would
   * silently swallow a rename.
   *
   * `signature` is an optimization only: the throttle passes the value it just
   * computed. Omit it anywhere the current signature has not already been built.
   */
  private emitStateChanged(signature?: string): void {
    this.lastEmittedConnectionSignature = signature ?? this.connectionSignature();
    this.emit('stateChanged');
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
      // Computed fresh every call - only the CHANGE NOTIFICATION
      // ('stateChanged') is throttled, never the value itself.
      relayState: this.aggregateRelayState(),
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
      connectionState: this.sessions.get(device.deviceId)?.connectionState ?? 'idle',
    }));
  }

  renameDevice(deviceId: string, displayName: string): void {
    const identity = this.tryLoadIdentity();
    if (!identity) throw new Error(`No such paired device: ${deviceId}`);
    // Same clamp and control-character filter the pairing path applies to the
    // phone-supplied name: a rename lands in the same signed roster entry and
    // the same settings list, so it cannot be the unguarded way in.
    setDeviceDisplayNameInRoster(identity, deviceId, sanitizeDeviceName(displayName));
    this.emitStateChanged();
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
    this.emitStateChanged();
  }

  setDeviceCapabilities(deviceId: string, capabilities: CapabilityVerb[]): void {
    const identity = this.tryLoadIdentity();
    if (!identity) throw new Error(`No such paired device: ${deviceId}`);
    setDeviceCapabilitiesInRoster(identity, deviceId, capabilities);
    const session = this.sessions.get(deviceId);
    if (session) session.capabilities = capabilitySetFromArray(capabilities);
    this.emitStateChanged();
  }

  async startPairing(): Promise<{ qrPayload: PairingQrPayload; qrUri: string }> {
    if (!this.config.enabled) throw new Error('Mobile bridge is not enabled');
    if (this.activePairing) {
      // Supersede rather than throw: this is what makes "Pair a device"
      // self-heal after the pairing panel was closed mid-ceremony without a
      // cancel ever reaching the main process (a stale ceremony used to
      // wedge every future click on this guard until an app restart).
      this.cancelPairing('Superseded by a new pairing attempt');
    }
    // Both reconcile() call sites resolve relayUrl through resolveRelayUrl()
    // before it ever reaches this.config, so this should be unreachable in
    // practice - it is insurance against minting a QR the phone will refuse,
    // not the primary validation path.
    const relayValidation = validateRelayUrl(this.config.relayUrl);
    if (!relayValidation.ok) throw new Error(`Cannot start pairing: ${relayValidation.reason}`);

    const identity = this.ensureIdentity();
    const pairingService = new PairingService(identity);
    const token = pairingService.mintToken();
    this.activePairing = pairingService;

    // Derived, never the token itself: the slot travels in cleartext in the
    // relay URL, and the token is the Noise PSK. See derivePairingSlotId().
    const slotId = derivePairingSlotId(token.token);
    const transport = createTransport({ relayUrl: this.config.relayUrl, slotId });

    pairingService.on('sas', (payload: { sas: ShortAuthenticationString; phoneStaticPublicKeyHex: string }) => {
      this.emit('pairingSas', payload);
    });
    pairingService.once('confirmed', (payload: { deviceId: string; displayName: string }) => {
      this.activePairing = null;
      // Close the ephemeral pairing transport on the SUCCESS path too - it
      // used to be closed only on cancelled/failed, leaking a live
      // RelayClient reconnecting against a consumed-token slot for the rest
      // of the process's lifetime after every successful pairing.
      transport.close();
      this.emitStateChanged();
      this.emit('pairingConfirmed', payload);
      // The freshly-paired device is now in the roster; open its
      // BridgeSession immediately rather than waiting for the next
      // config-driven reconcile() (which may not happen again this run).
      void this.syncSessions();
    });
    pairingService.once('cancelled', (payload: { reason: string }) => {
      this.activePairing = null;
      transport.close();
      this.emit('pairingEnded', { ...payload, kind: 'cancelled' });
    });
    pairingService.once('failed', (payload: { reason: string }) => {
      this.activePairing = null;
      transport.close();
      this.emit('pairingEnded', { ...payload, kind: 'failed' });
    });

    try {
      await transport.connect();
    } catch (error) {
      // Close the transport we just created before rethrowing: RelayClient
      // arms an internal reconnect timer on a failed dial, so abandoning it
      // here (it is not stored on `this`, so dispose() cannot reach it)
      // would leak a permanent reconnect loop against a now-meaningless slot.
      transport.close();
      // Clear the pointer ONLY if it still refers to this ceremony. A
      // concurrent startPairing() can supersede us while connect() is in
      // flight: its cancel path closes THIS transport, which is exactly what
      // rejected the dial above, and it has already installed its own
      // PairingService. Nulling unconditionally here would orphan that live
      // ceremony - pairingInProgress would read false, cancelPairing() would
      // no-op against it, and the next startPairing() would skip the
      // supersede branch and leak a second live ceremony alongside it.
      if (this.activePairing === pairingService) this.activePairing = null;
      throw error;
    }
    if (this.activePairing !== pairingService) {
      // Superseded while connect() was in flight, but the dial happened to
      // resolve anyway. Do not arm a ceremony nothing points at any more.
      transport.close();
      throw new Error('Pairing was superseded by a new pairing attempt');
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

  cancelPairing(reason = 'Cancelled by user'): void {
    this.activePairing?.cancel(reason);
    this.activePairing = null;
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
    if (this.relayStateEmitTimer) {
      clearTimeout(this.relayStateEmitTimer);
      this.relayStateEmitTimer = null;
    }
    this.devQuickPair?.stop();
    this.sessionLifecycleFeed?.dispose();
    this.sessionLifecycleFeed = null;
    this.pushNotifier?.dispose();
    this.pushNotifier = null;
    this.spawnStallWatcher?.dispose();
    this.spawnStallWatcher = null;
    this.cancelPairing('Mobile bridge service shutting down');
    this.disposeAllSessions();
    this.diffWatcher.closeAll();
  }
}
