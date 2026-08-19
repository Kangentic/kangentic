/**
 * Decides when a session deserves a push notification, seals the real
 * content into an E2E envelope per registered device, and hands the
 * opaque blob to a WakeChannel. Triggers, keyed off SessionManager's
 * activity/exit emissions:
 *
 * - transition INTO 'permission': 'input-required'. Debounced 2s and
 *   re-checked at fire time, so a prompt the user answers at the desk
 *   within the debounce never pings their phone.
 * - transition 'thinking' -> 'idle': 'turn-complete', on the same
 *   debounce-and-re-check pattern but with a much longer window. It
 *   used to fire inline, which made it one alert PER REPLY: every
 *   exchange in a conversation ends in idle, so a trivial task could
 *   produce twenty of them and several tasks in flight multiplied it.
 *   It now means "this session went quiet", not "a turn ended".
 * - exit with intentional false (a crash, including the flag-less
 *   spawn-failure emit): 'session-failed'. A deliberate stop never
 *   notifies.
 * - 'plan-exit': 'plan-complete'.
 *
 * A fifth category, 'spawn-stalled', has no session to key off (spawn
 * hasn't produced one yet) - it is driven externally via
 * notifyTaskStalled(taskId) (wired to spawn-stall-watcher.ts), which
 * resolves task context by taskId and cools down per (device, taskId,
 * category) instead of per session.
 *
 * Per registered device: presence suppression (an established bridge
 * session means the user is already watching from that device), then the
 * device's own category preferences (registered via register-push;
 * absent means every category), then a 30s per (device, session,
 * category) cooldown. Only data.blob carries real content.
 *
 * THE VISIBLE TITLE/BODY ARE iOS-ONLY, and that is load-bearing rather
 * than an optimisation. On Android, expo-notifications presents the
 * payload ITSELF, natively, before handing off to the app's background
 * task - so every push was rendered twice: once as the generic
 * placeholder here, once as the decrypted notification Notifee posts.
 * Omitting title/body suppresses the first one entirely
 * (ExpoHandlingDelegate.handleNotification presents a backgrounded
 * notification only when title or text is non-empty) while the task
 * still runs, so nothing is lost. iOS keeps them: with no Notification
 * Service Extension yet, that placeholder is the ONLY visible content an
 * iOS push can have, and stripping it globally would turn iOS from
 * "silent because unauthorized" into "silent by construction".
 *
 * A DeviceNotRegistered ticket drops the registration.
 */
import { hexToBytes, sealPushEnvelope, type PushCategory, type PushEnvelopePlaintext } from '@kangentic/protocol';
import type { ActivityReason, ActivityState } from '../../../shared/types';
import type { SessionManager } from '../../pty/session-manager';
import type { PushRegistration, PushRegistrationStore } from './push-registration-store';
import { createExpoWakeChannel, type FetchLike } from './expo-push-client';
import type { WakeChannel } from './wake-channel';

const PERMISSION_DEBOUNCE_MS = 2000;

/**
 * How long a session must STAY idle before 'turn-complete' fires.
 *
 * Far longer than the permission debounce because it is answering a
 * different question. Two seconds is "did the user answer this prompt at
 * the desk"; this is "is the session actually finished, or just between
 * replies" - and a conversational back-and-forth leaves gaps of tens of
 * seconds, every one of which used to be its own notification. The 30s
 * cooldown below never covered it: turns are routinely further apart
 * than that, so each one passed the cooldown cleanly.
 *
 * 45s is a starting value, to be tuned against real sessions.
 */
const IDLE_SETTLE_MS = 45_000;
const CATEGORY_COOLDOWN_MS = 30_000;
const NOTIFICATION_TITLE = 'Kangentic';

/**
 * OS-visible placeholder body per category - never real content, and
 * (see the file header) only ever sent to iOS devices.
 */
const PLACEHOLDER_BODIES: Record<PushCategory, string> = {
  'input-required': 'Agent needs your attention',
  // Not "Task update": this category is settle-debounced now, so it
  // reports a session going quiet. Still generic, per the E2E push rule.
  'turn-complete': 'Agent went idle',
  'session-failed': 'Session stopped',
  'plan-complete': 'Plan complete',
  'spawn-stalled': 'Task is taking a while to start',
};

/** Android notification channel per category (mirrored by the app's Notifee channel setup). */
const CHANNEL_IDS: Record<PushCategory, string> = {
  'input-required': 'needs-attention',
  'turn-complete': 'completions',
  'session-failed': 'failures',
  'plan-complete': 'completions',
  'spawn-stalled': 'stalls',
};

export interface PushTaskContext {
  projectId: string;
  taskId: string;
  taskTitle: string;
}

export interface PushNotifierOptions {
  sessionManager: Pick<SessionManager, 'on' | 'off' | 'getActivityStatsSnapshot'>;
  registrationStore: Pick<PushRegistrationStore, 'list' | 'remove'>;
  /** Devices with a live established bridge session - already watching, never pinged. */
  getEstablishedDeviceIds: () => Set<string>;
  resolveTaskContext: (sessionId: string) => PushTaskContext | null;
  /** For triggers with no session yet (spawn-stalled). Scans by taskId instead. */
  resolveTaskContextByTaskId: (taskId: string) => PushTaskContext | null;
  /** The device's roster static public key, sealed into every envelope as AAD. Null means "unknown device, skip". */
  getDeviceStaticPublicKey: (deviceId: string) => Uint8Array | null;
  /** Injectable for tests; defaults to the protocol package's sealPushEnvelope. */
  sealEnvelope?: typeof sealPushEnvelope;
  /** Injectable for tests; defaults to a WakeChannel over the global fetch. */
  wakeChannel?: WakeChannel;
  /** Injectable for tests; only used to build the default Expo wake channel. Ignored when wakeChannel is set. */
  fetchImpl?: FetchLike;
}

export class PushNotifier {
  private readonly options: PushNotifierOptions;
  private readonly sealEnvelope: typeof sealPushEnvelope;
  private readonly wakeChannel: WakeChannel;
  private readonly lastActivityState = new Map<string, ActivityState>();
  private readonly permissionDebounceTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly idleSettleTimers = new Map<string, ReturnType<typeof setTimeout>>();
  /** Last-notified wall-clock ms per `${deviceId}|${sessionId}|${category}`. */
  private readonly cooldowns = new Map<string, number>();
  private started = false;
  private disposed = false;

  constructor(options: PushNotifierOptions) {
    this.options = options;
    this.sealEnvelope = options.sealEnvelope ?? sealPushEnvelope;
    this.wakeChannel = options.wakeChannel ?? createExpoWakeChannel(options.fetchImpl ?? fetch);
  }

  private readonly onActivity = (sessionId: string, state: ActivityState, _reason: ActivityReason): void => {
    const previousState = this.lastActivityState.get(sessionId);
    this.lastActivityState.set(sessionId, state);
    if (state === previousState) return;

    if (state === 'permission') {
      // Emphatically not finished: a prompt is the clearest possible
      // signal that a pending "went idle" would be wrong.
      this.clearIdleSettle(sessionId);
      this.schedulePermissionNotification(sessionId);
      return;
    }
    // Left permission (answered at the desk, or the turn moved on):
    // cancel a pending debounce so the fire-time re-check never even runs.
    this.clearPermissionDebounce(sessionId);
    if (state !== 'idle') {
      // Back to work inside the settle window - the session was between
      // replies, not finished.
      this.clearIdleSettle(sessionId);
      return;
    }
    if (previousState === 'thinking') this.scheduleIdleNotification(sessionId);
  };

  private readonly onExit = (sessionId: string, exitCode: number, intentional?: boolean): void => {
    this.lastActivityState.delete(sessionId);
    this.clearPermissionDebounce(sessionId);
    // An exited session is reported as session-failed (below) or not at
    // all; either way a pending "went idle" is stale.
    this.clearIdleSettle(sessionId);
    // The spawn-failure path emits no flag; a spawn failure is not a
    // deliberate stop, so only an explicit true suppresses.
    if (intentional === true) return;
    this.notify(sessionId, 'session-failed', `exit code ${exitCode}`);
  };

  private readonly onPlanExit = (sessionId: string): void => {
    this.notify(sessionId, 'plan-complete', '');
  };

  start(): void {
    if (this.started || this.disposed) return;
    this.started = true;
    this.options.sessionManager.on('activity', this.onActivity);
    this.options.sessionManager.on('exit', this.onExit);
    this.options.sessionManager.on('plan-exit', this.onPlanExit);
  }

  private schedulePermissionNotification(sessionId: string): void {
    if (this.permissionDebounceTimers.has(sessionId)) return;
    const debounceTimer = setTimeout(() => {
      this.permissionDebounceTimers.delete(sessionId);
      // Re-check at fire time: a prompt answered within the debounce
      // window must not ping the phone.
      const statsSnapshot = this.options.sessionManager.getActivityStatsSnapshot(sessionId);
      if (!statsSnapshot?.permissionPending) return;
      this.notify(sessionId, 'input-required', '');
    }, PERMISSION_DEBOUNCE_MS);
    debounceTimer.unref?.();
    this.permissionDebounceTimers.set(sessionId, debounceTimer);
  }

  private clearPermissionDebounce(sessionId: string): void {
    const debounceTimer = this.permissionDebounceTimers.get(sessionId);
    if (!debounceTimer) return;
    clearTimeout(debounceTimer);
    this.permissionDebounceTimers.delete(sessionId);
  }

  /**
   * Same shape as schedulePermissionNotification, and deliberately so:
   * first-write-wins (a re-arm must not push the deadline out, or a
   * flickering session never alerts at all) plus a fire-time re-check
   * against the live snapshot, which catches a session that changed
   * without an activity emission reaching us.
   */
  private scheduleIdleNotification(sessionId: string): void {
    if (this.idleSettleTimers.has(sessionId)) return;
    const settleTimer = setTimeout(() => {
      this.idleSettleTimers.delete(sessionId);
      const statsSnapshot = this.options.sessionManager.getActivityStatsSnapshot(sessionId);
      if (statsSnapshot?.activity !== 'idle') return;
      this.notify(sessionId, 'turn-complete', '');
    }, IDLE_SETTLE_MS);
    settleTimer.unref?.();
    this.idleSettleTimers.set(sessionId, settleTimer);
  }

  private clearIdleSettle(sessionId: string): void {
    const settleTimer = this.idleSettleTimers.get(sessionId);
    if (!settleTimer) return;
    clearTimeout(settleTimer);
    this.idleSettleTimers.delete(sessionId);
  }

  private notify(sessionId: string, category: PushCategory, detail: string): void {
    if (this.disposed) return;
    const taskContext = this.options.resolveTaskContext(sessionId);
    if (!taskContext) return;
    this.notifyWithContext(taskContext, sessionId, sessionId, category, detail);
  }

  /**
   * A task-spawn stall has no session yet - the session doesn't exist
   * until spawn finishes - so it resolves task context by taskId and
   * cools down per (device, taskId, category) instead of per session.
   * The envelope's sessionId rides empty; the phone's tap router already
   * defaults a missing sessionId to route to the task's screen.
   */
  notifyTaskStalled(taskId: string): void {
    if (this.disposed) return;
    const taskContext = this.options.resolveTaskContextByTaskId(taskId);
    if (!taskContext) return;
    this.notifyWithContext(taskContext, taskId, '', 'spawn-stalled', '');
  }

  private notifyWithContext(taskContext: PushTaskContext, cooldownSubject: string, envelopeSessionId: string, category: PushCategory, detail: string): void {
    const establishedDeviceIds = this.options.getEstablishedDeviceIds();
    const now = Date.now();

    for (const registration of this.options.registrationStore.list()) {
      if (establishedDeviceIds.has(registration.deviceId)) continue;
      // undefined categories means every category (the device's default / an older registration).
      if (registration.categories && !registration.categories.includes(category)) continue;

      const cooldownKey = `${registration.deviceId}|${cooldownSubject}|${category}`;
      const lastNotifiedAt = this.cooldowns.get(cooldownKey);
      if (lastNotifiedAt !== undefined && now - lastNotifiedAt < CATEGORY_COOLDOWN_MS) continue;

      const deviceStaticPublicKey = this.options.getDeviceStaticPublicKey(registration.deviceId);
      if (!deviceStaticPublicKey) continue;

      const plaintext: PushEnvelopePlaintext = {
        category,
        projectId: taskContext.projectId,
        taskId: taskContext.taskId,
        sessionId: envelopeSessionId,
        taskTitle: taskContext.taskTitle,
        detail,
        sentAt: now,
      };
      let sealedBlob: string;
      try {
        sealedBlob = this.sealEnvelope(hexToBytes(registration.pushKeyHex), deviceStaticPublicKey, plaintext);
      } catch {
        continue; // a malformed stored key must not take down the other devices' sends
      }
      this.cooldowns.set(cooldownKey, now);
      void this.deliver(registration.deviceId, registration.expoPushToken, registration.platform, category, sealedBlob);
    }
  }

  private async deliver(
    deviceId: string,
    expoPushToken: string,
    platform: PushRegistration['platform'],
    category: PushCategory,
    sealedBlob: string,
  ): Promise<void> {
    try {
      // See the file header: a title/body on an Android push is rendered
      // natively by expo-notifications ON TOP of the decrypted one our
      // background task posts, so Android gets a data-only message. iOS
      // needs them - the placeholder is all it can show until the
      // Notification Service Extension ships.
      const placeholder =
        platform === 'ios' ? { title: NOTIFICATION_TITLE, body: PLACEHOLDER_BODIES[category] } : {};
      const result = await this.wakeChannel.send({
        token: expoPushToken,
        channelId: CHANNEL_IDS[category],
        ...placeholder,
        blob: sealedBlob,
      });
      if (!result.delivered && result.reason === 'device-not-registered') {
        this.options.registrationStore.remove(deviceId);
      }
    } catch {
      // Best-effort: a failed send never propagates into the session pipeline.
    }
  }

  /** Synchronous, per synchronous-shutdown.md: detaches listeners and clears every pending debounce timer. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.started) {
      this.options.sessionManager.off('activity', this.onActivity);
      this.options.sessionManager.off('exit', this.onExit);
      this.options.sessionManager.off('plan-exit', this.onPlanExit);
    }
    for (const debounceTimer of this.permissionDebounceTimers.values()) clearTimeout(debounceTimer);
    this.permissionDebounceTimers.clear();
    for (const settleTimer of this.idleSettleTimers.values()) clearTimeout(settleTimer);
    this.idleSettleTimers.clear();
    this.lastActivityState.clear();
    this.cooldowns.clear();
  }
}
