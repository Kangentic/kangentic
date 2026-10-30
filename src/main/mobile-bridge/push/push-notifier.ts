/**
 * Decides when a session deserves a push notification, seals the real
 * content into an E2E envelope per registered device, and hands the
 * opaque blob to a WakeChannel. Triggers, keyed off SessionManager's
 * activity/exit emissions:
 *
 * - transition INTO 'permission': 'input-required'. Debounced 2s and
 *   re-checked at fire time, so a prompt the user answers at the desk
 *   within the debounce never pings their phone. The envelope's `waitKind`
 *   (a question or an approval) is read at fire time too, from the same
 *   snapshot, so the phone can title the push by it.
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
 * category) instead of per session. A sixth, 'workflow-complete', has
 * neither a session nor one task: notifyWorkflowComplete (called by
 * workflows/workflow-complete.ts) names the workflow and cools down per
 * workflow.
 *
 * A Notify me automation row sends an 'input-required' too, through
 * notifyAutomation, with the row's own Title and Body sealed in. The row is
 * the user's own choice to be told, so it skips everything below that stands
 * between a notification and a device: presence, the device's categories and
 * the cooldown. It is never recorded for clears either (see CLEARS).
 *
 * Per registered device: presence suppression (a bridge session reporting
 * 'connected' means the user is already watching from that device), then
 * the device's own category preferences (registered via register-push;
 * absent means every category), then a 30s per (device, session,
 * category) cooldown - stamped before the send so a synchronous burst of
 * the same category cannot double up, but released again if the send
 * itself fails, so a genuine delivery failure never spends a real
 * notification's retry window. Only data.blob (a notification) and
 * data.clear (a clear, below) carry real content.
 *
 * THE VISIBLE TITLE/BODY ARE iOS-ONLY, and that is load-bearing rather
 * than an optimisation. On Android, expo-notifications presents the
 * payload ITSELF, natively, before handing off to the app's background
 * task - so every push was rendered twice: once as the generic
 * placeholder here, once as the decrypted notification Notifee posts.
 * Making Android data-only stops that, but title/body are not the whole
 * story: Expo attaches an FCM android.notification block to ANY message
 * that carries a channelId too, title/body or not, and that block is
 * what decides who renders. With the block present the FCM SDK draws the
 * tray item itself - with no title/body that is a blank row - and
 * onMessageReceived is never called, so the app's background task never
 * runs and Notifee never posts the decrypted notification either. A
 * push is data-only, and actually reaches the app, only when it carries
 * NEITHER title/body NOR channelId. So Android gets no channelId at all
 * - which costs nothing, since the channel actually used is chosen
 * on-device from the DECRYPTED category (channelIdForCategory in the
 * phone's background task), and only the phone knows that. iOS keeps
 * title/body: the Notification Service Extension that decrypts the
 * envelope runs only for a push that carries an alert, and the
 * placeholder is what shows when it cannot open one. Stripping it would
 * make iOS silent by construction. channelId is dropped for iOS too,
 * since Expo ignores it for APNs and there is nothing to gain by sending
 * it.
 *
 * A DeviceNotRegistered ticket drops the registration.
 *
 * CLEARS. A notification goes stale when its condition resolves at the
 * desk, and only the desktop sees that moment, so it tells the phone
 * (the protocol's crypto/push-clear.ts). Only a device that registered
 * with acceptsClears takes part: an older app shows the placeholder for
 * any message it cannot open, so a clear would arrive there as a new
 * notification. Every notification dispatched to such a device is
 * recorded in a PushClearLedger, and these resolve it:
 *
 * - input-required: the session leaves 'permission', or exits.
 * - turn-complete: the session leaves 'idle'. An exit does not resolve
 *   it: the idle timeout suspends an idle session with nobody at the
 *   desk, and that alert is still owed.
 * - plan-complete: a turn of the same task that BEGAN after it ends
 *   ('turn-ended'). Not "thinking": approving the plan takes the session
 *   from permission to thinking in the same breath as 'plan-exit'. Matched
 *   by task, because the plan-exit auto-move may respawn the session
 *   under a new id.
 * - session-failed: a different session of the task reaches 'running'.
 * - spawn-stalled: a session of the task reaches 'running'.
 * - every one of these: the task changes lane, is archived (Done), or is
 *   deleted (boardEvents). The plan-exit auto-move resolves all but
 *   plan-complete, whose recorded lane moves with the task instead.
 * - workflow-complete is never recorded; the phone clears it when the
 *   Board opens.
 * - A Notify me push is never recorded. It reports a moment, which nothing
 *   at the desk resolves, and an exit row fires as its task leaves the lane,
 *   so a recorded one would be cleared by the very move that sent it.
 *
 * A device connected at that moment is skipped: the app is running and
 * reconciles its own notifications. Otherwise the clear waits a short
 * coalescing window and goes out as one sealed message under data.clear:
 * data-only at NORMAL priority on Android (FCM deprioritizes an app whose
 * high-priority messages show nothing), and a background push on iOS
 * (contentAvailable, no alert, APNs priority 5), at most once per device
 * per IOS_STANDALONE_CLEAR_INTERVAL_MS (one Expo refused does not count).
 *
 * Pending clears also ride the device's next visible envelope as
 * `clears`. An Android clear is done once Expo accepts it; an iOS one
 * stays pending until a visible push carries it or 24h pass, because iOS
 * delivers background pushes only when it chooses to, and never to an app
 * the user force-quit. The ledger is memory-only, so a desktop restart
 * forgets it.
 */
import {
  hexToBytes,
  PUSH_CLEAR_DATA_KEY,
  PUSH_ENVELOPE_DATA_KEY,
  sealPushClear,
  sealPushEnvelope,
  sealedPushBlobLength,
  type PushCategory,
  type PushEnvelopePlaintext,
  type PushSessionKind,
} from '@kangentic/protocol';
import type { ActivityReason, ActivityState, MobileDeviceConnectionState, Session, TaskMoveRecordOrigin } from '../../../shared/types';
import { isWorkflowAgentSession } from '../../../shared/session-owner';
import type { SessionManager, TurnEndedPayload } from '../../pty/session-manager';
import type { BoardChangedEvent, BoardEventBus } from '../board-event-bus';
import type { PushRegistration, PushRegistrationEntry, PushRegistrationStore } from './push-registration-store';
import { createExpoWakeChannel, type FetchLike } from './expo-push-client';
import { PushClearLedger, type OutstandingNotification, type PickedClear, type PushClearIdentity } from './push-clear-ledger';
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

/** How long a device's clears gather before they go out, so one task move costs one message rather than several. */
const CLEAR_COALESCE_MS = 5_000;
/** Apple asks for no more than two or three background pushes an hour; past that iOS throttles them anyway. */
const IOS_STANDALONE_CLEAR_INTERVAL_MS = 20 * 60_000;
/**
 * The longest sealed blob (base64url characters) a message carrying clears,
 * or text the user wrote, may have. Expo caps the whole payload it hands
 * APNs and FCM at 4096 bytes; this leaves room for Expo's own fields and the
 * iOS placeholder.
 */
const CLEAR_BLOB_BUDGET = 3_000;
/** A Notify me row's Title is cut to this many characters before sealing; its Body shrinks to fit CLEAR_BLOB_BUDGET. */
const AUTOMATION_TITLE_MAX_CHARS = 200;

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
  'workflow-complete': 'Workflow complete',
};

export interface PushTaskContext {
  projectId: string;
  taskId: string;
  /** The task's title, or a Command Terminal's name. */
  taskTitle: string;
  /** Set for a session that is not a task's agent, so the phone routes the tap to it. */
  sessionKind?: PushSessionKind;
  /** The task's lane right now. Absent for a Command Terminal, whose taskId names no task row. */
  swimlaneId?: string;
}

/** Where a task sits on its board: what a lane-change or archive resolution is checked against. */
export interface PushTaskPlacement {
  swimlaneId: string;
  archived: boolean;
  /** How the task reached its current lane; null when no move row records it. */
  lastMoveOrigin: TaskMoveRecordOrigin | null;
}

/**
 * Devices whose phone is genuinely attached right now, so a push would
 * land on a screen the user is already looking at.
 *
 * Keys off connectionState, NOT the raw isEstablished. On a silent death
 * (a phone that dies with no clean close) nothing nulls the bridge
 * session's streams, so isEstablished stays true for the whole relay
 * keepalive sweep - 30 to 60s - while the presence probe has already
 * concluded 'offline'. Suppressing on that window is permanent for the
 * turn: the idle settle timer is one-shot and lastActivityState already
 * holds 'idle' by the time presence clears, so nothing re-arms.
 *
 * The 2s reconnect grace holds the session's last presence verdict
 * (bridge-session.ts's connectionState getter). For a phone that was
 * present it reports 'connected' with the streams already dropped.
 * Suppressing there is correct, not a leak of the same bug: the phone was
 * demonstrably present a moment ago and the socket is coming back. An
 * absent phone's hold reports 'offline', so it never lands in this set.
 */
export function collectConnectedDeviceIds(
  sessions: Iterable<[string, { connectionState: MobileDeviceConnectionState }]>,
): Set<string> {
  const connectedDeviceIds = new Set<string>();
  for (const [deviceId, session] of sessions) {
    if (session.connectionState === 'connected') connectedDeviceIds.add(deviceId);
  }
  return connectedDeviceIds;
}

/**
 * Strips any Expo push token out of text before it reaches a log line.
 *
 * The failure detail a send reports is Expo's own ticket `message` - text
 * this codebase neither authors nor constrains - and Expo does quote the
 * device's token back inside it: its documented not-registered message is
 * literally `"ExponentPushToken[...]" is not a registered push
 * notification recipient`. That particular ticket is intercepted earlier
 * by `details.error`, but only when the response carries the shape
 * `extractTicket` expects, and nothing stops another ticket from quoting
 * the token the same way. Logging the detail verbatim would put a live
 * push capability in the desktop log, which is the one thing the
 * notifier's header promises it never does. What survives the
 * substitution is the diagnostic half: the reason, the status code, and
 * Expo's description of the problem.
 */
export function redactPushTokens(text: string): string {
  return text.replace(/Expo(?:nent)?PushToken\[[^\]]*\]/g, 'ExponentPushToken[redacted]');
}

export interface PushNotifierOptions {
  sessionManager: Pick<SessionManager, 'on' | 'off' | 'getActivityStatsSnapshot'>;
  registrationStore: Pick<PushRegistrationStore, 'list' | 'remove'>;
  /** Task moves, archives and deletes: what resolves a task's outstanding notifications. */
  boardEvents: Pick<BoardEventBus, 'onBoardChanged'>;
  /**
   * The Mobile bridge switch, read at every notification. Off, nothing is sent: a
   * push goes to Expo directly, so closing the relay sessions alone would not stop it.
   */
  isBridgeEnabled: () => boolean;
  /** Devices whose bridge session reports 'connected' - already watching, never pinged. */
  getConnectedDeviceIds: () => Set<string>;
  resolveTaskContext: (sessionId: string) => PushTaskContext | null;
  /** For triggers with no session yet (spawn-stalled). Scans by taskId instead. */
  resolveTaskContextByTaskId: (taskId: string) => PushTaskContext | null;
  /** The task's lane and archive state now, or null when its row is gone. Read only for a task with notifications outstanding. */
  readTaskPlacement: (projectId: string, taskId: string) => PushTaskPlacement | null;
  /** The device's roster static public key, sealed into every envelope as AAD. Null means "unknown device, skip". */
  getDeviceStaticPublicKey: (deviceId: string) => Uint8Array | null;
  /**
   * Is this session a running workflow task's, mid-route? Its idle is its step
   * check's to report (`notifyWorkflowTask`), so `turn-complete` skips it.
   */
  isWorkflowStepSession?: (sessionId: string) => boolean;
  /** Injectable for tests; defaults to the protocol package's sealPushEnvelope. */
  sealEnvelope?: typeof sealPushEnvelope;
  /** Injectable for tests; defaults to the protocol package's sealPushClear. */
  sealClear?: typeof sealPushClear;
  /** Injectable for tests; defaults to a WakeChannel over the global fetch. */
  wakeChannel?: WakeChannel;
  /** Injectable for tests; only used to build the default Expo wake channel. Ignored when wakeChannel is set. */
  fetchImpl?: FetchLike;
}

/** One visible notification on its way to one device. */
interface VisibleDelivery {
  cooldownKey: string;
  stampedAt: number;
  deviceId: string;
  expoPushToken: string;
  platform: PushRegistration['platform'];
  category: PushCategory;
  sealedBlob: string;
  /** The ledger key the notification was recorded under; null for a device that takes no clears. */
  clearKey: string | null;
  /** The record this one replaced under clearKey, restored if the send fails. */
  replacedRecord: OutstandingNotification | undefined;
  /** Pending clears riding this envelope. */
  piggybacked: PickedClear[];
}

/** How one notification is dispatched, beyond its category and task. */
interface DispatchOptions {
  /** Optional envelope fields the notification carries. */
  envelope?: Pick<PushEnvelopePlaintext, 'waitKind' | 'title' | 'body'>;
  /**
   * The user asked for this notification (a Notify me row). It reaches every
   * registered device: presence, the device's categories and the cooldown do
   * not apply, and it is not recorded for clears.
   */
  userRequested?: boolean;
}

/**
 * `text` cut to `maxChars` characters, ending in "..." when cut. A cut below
 * 3 characters is "..." alone, so the reader still sees that text was cut.
 */
function truncateText(text: string, maxChars: number): string {
  const characters = Array.from(text);
  if (characters.length <= maxChars) return text;
  return `${characters.slice(0, Math.max(0, maxChars - 3)).join('')}...`;
}

/**
 * A Notify me row's text, cut to fit one push. The Title is capped; the Body,
 * sealed twice (as `body`, and as `detail` for a phone that predates `body`),
 * is halved until the sealed blob fits CLEAR_BLOB_BUDGET. Both are templated
 * fields, so a row can carry a whole task description, and a blob over
 * Expo's limit is refused outright.
 *
 * `base` must hold every field `notifyWithContext` seals besides these three,
 * or the fit measures a smaller blob than the one sent.
 */
function fitAutomationText(
  base: Omit<PushEnvelopePlaintext, 'detail' | 'title' | 'body'>,
  title: string,
  body: string,
): { title: string; body: string } {
  const fittedTitle = truncateText(title, AUTOMATION_TITLE_MAX_CHARS);
  let maxBodyChars = Array.from(body).length;
  let fittedBody = body;
  while (maxBodyChars > 0 && sealedPushBlobLength({ ...base, detail: fittedBody, title: fittedTitle, body: fittedBody }) > CLEAR_BLOB_BUDGET) {
    maxBodyChars = Math.floor(maxBodyChars / 2);
    fittedBody = truncateText(body, maxBodyChars);
  }
  return { title: fittedTitle, body: fittedBody };
}

/** A thrown send's stack (or message), redacted: a replacement WakeChannel may put the token in its error text. */
function describeThrownSend(error: unknown): string {
  return redactPushTokens(error instanceof Error ? (error.stack ?? error.message) : String(error));
}

function isRunningTaskSession(session: Session): boolean {
  // A workflow's own agent and a Command Terminal are transient; neither is
  // a session of a board task.
  return session.status === 'running' && !session.transient && !isWorkflowAgentSession(session);
}

export class PushNotifier {
  private readonly options: PushNotifierOptions;
  private readonly sealEnvelope: typeof sealPushEnvelope;
  private readonly sealClear: typeof sealPushClear;
  private readonly wakeChannel: WakeChannel;
  private readonly lastActivityState = new Map<string, ActivityState>();
  private readonly permissionDebounceTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly idleSettleTimers = new Map<string, ReturnType<typeof setTimeout>>();
  /** Last-notified wall-clock ms per `${deviceId}|${sessionId}|${category}`. */
  private readonly cooldowns = new Map<string, number>();
  private readonly clearLedger = new PushClearLedger();
  private readonly clearFlushTimers = new Map<string, ReturnType<typeof setTimeout>>();
  /** When each iOS device last got a standalone clear, for IOS_STANDALONE_CLEAR_INTERVAL_MS. */
  private readonly lastStandaloneClearAt = new Map<string, number>();
  private unsubscribeBoardEvents: (() => void) | null = null;
  private started = false;
  private disposed = false;

  constructor(options: PushNotifierOptions) {
    this.options = options;
    this.sealEnvelope = options.sealEnvelope ?? sealPushEnvelope;
    this.sealClear = options.sealClear ?? sealPushClear;
    this.wakeChannel = options.wakeChannel ?? createExpoWakeChannel(options.fetchImpl ?? fetch);
  }

  private readonly onActivity = (sessionId: string, state: ActivityState, _reason: ActivityReason): void => {
    const previousState = this.lastActivityState.get(sessionId);
    this.lastActivityState.set(sessionId, state);
    if (state === previousState) return;

    // The edges that make a notification stale (see the header's CLEARS).
    if (previousState === 'permission') this.resolveSessionCategory(sessionId, 'input-required');
    if (previousState === 'idle') this.resolveSessionCategory(sessionId, 'turn-complete');

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
    // The prompt died with the process. Resolved before the crash alert so
    // the clear can ride it.
    this.resolveSessionCategory(sessionId, 'input-required');
    // The spawn-failure path emits no flag; a spawn failure is not a
    // deliberate stop, so only an explicit true suppresses.
    if (intentional === true) return;
    this.notify(sessionId, 'session-failed', `exit code ${exitCode}`);
  };

  private readonly onPlanExit = (sessionId: string): void => {
    this.notify(sessionId, 'plan-complete', '');
  };

  /** A turn the agent finished, in any session of a task: resolves a plan-complete sent before that turn began. */
  private readonly onTurnEnded = (payload: TurnEndedPayload): void => {
    const turnStartedAt = payload.turnStartedAt;
    if (turnStartedAt === null) return;
    this.resolveClears((notification) =>
      notification.identity.category === 'plan-complete' &&
      notification.identity.projectId === payload.projectId &&
      notification.identity.taskId === payload.taskId &&
      turnStartedAt > notification.notifiedAt,
    );
  };

  /** A session of a task running: a failed earlier session and a stalled spawn are both over. Fires repeatedly per session. */
  private readonly onSessionChanged = (sessionId: string, session: Session): void => {
    if (!isRunningTaskSession(session)) return;
    this.resolveClears((notification) => {
      const { identity } = notification;
      if (identity.projectId !== session.projectId || identity.taskId !== session.taskId) return false;
      if (identity.category === 'spawn-stalled') return true;
      return identity.category === 'session-failed' && identity.sessionId !== sessionId;
    });
  };

  private readonly onBoardChanged = (event: BoardChangedEvent): void => {
    // Synchronous inside the move's task lock, and the MCP emitters do not
    // catch: a throw here must not fail the move that announced itself.
    try {
      if (event.change === 'task-deleted') {
        for (const taskId of event.ids) this.resolveTask(event.projectId, taskId, () => true);
        return;
      }
      if (event.change !== 'task-updated') return;
      for (const taskId of event.ids) this.reconcileTaskPlacement(event.projectId, taskId);
    } catch (error) {
      console.warn('[mobile-bridge/push-notifier] resolving clears for a board change failed:', error);
    }
  };

  start(): void {
    if (this.started || this.disposed) return;
    this.started = true;
    this.options.sessionManager.on('activity', this.onActivity);
    this.options.sessionManager.on('exit', this.onExit);
    this.options.sessionManager.on('plan-exit', this.onPlanExit);
    this.options.sessionManager.on('turn-ended', this.onTurnEnded);
    this.options.sessionManager.on('session-changed', this.onSessionChanged);
    this.unsubscribeBoardEvents = this.options.boardEvents.onBoardChanged(this.onBoardChanged);
  }

  private schedulePermissionNotification(sessionId: string): void {
    if (this.permissionDebounceTimers.has(sessionId)) return;
    const debounceTimer = setTimeout(() => {
      this.permissionDebounceTimers.delete(sessionId);
      // Re-check at fire time: a prompt answered within the debounce
      // window must not ping the phone.
      const statsSnapshot = this.options.sessionManager.getActivityStatsSnapshot(sessionId);
      if (!statsSnapshot?.permissionPending) return;
      const waitKind = statsSnapshot.permissionWaitKind;
      this.notify(sessionId, 'input-required', '', waitKind ? { envelope: { waitKind } } : {});
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
   * Shares schedulePermissionNotification's fire-time re-check, but the
   * hazard it covers is narrower than "the state moved without telling
   * us": ActivityEngine.commitTransition is the only writer of
   * state.activity and it emits unconditionally, so there is no missed
   * emission to catch. What it does catch is the session's engine state
   * being TORN DOWN between arming and firing (suspend / removeSession
   * delete it), after which the snapshot is null and the pending "went
   * idle" is correctly dropped. It re-reads the same engine that produced
   * the idle, so a false idle survives it either way.
   *
   * The arming differs from the permission debounce. Every route back to
   * 'idle' passes through 'thinking' first, and that branch calls
   * clearIdleSettle, so a flickering session cancels its pending timer and
   * the next settled idle starts a fresh full window rather than
   * inheriting the old deadline. Restarting the clock on every bounce IS
   * the debounce: only an idle that sticks for IDLE_SETTLE_MS alerts.
   * That also leaves the guard below unreachable from onActivity today,
   * since the three-value ActivityState offers no other way in; it stays
   * as cheap insurance against a future caller that arms twice.
   */
  private scheduleIdleNotification(sessionId: string): void {
    if (this.idleSettleTimers.has(sessionId)) return;
    const settleTimer = setTimeout(() => {
      this.idleSettleTimers.delete(sessionId);
      const statsSnapshot = this.options.sessionManager.getActivityStatsSnapshot(sessionId);
      if (statsSnapshot?.activity !== 'idle') return;
      // A running workflow task says itself when it needs the user.
      if (this.options.isWorkflowStepSession?.(sessionId)) return;
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

  private notify(sessionId: string, category: PushCategory, detail: string, dispatch: DispatchOptions = {}): void {
    if (this.disposed) return;
    const taskContext = this.options.resolveTaskContext(sessionId);
    if (!taskContext) return;
    this.notifyWithContext(taskContext, sessionId, sessionId, category, detail, dispatch);
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

  /**
   * A running workflow task needs the user: its agent waits on them, or the
   * workflow stalled on it (`workflow-recovery.ts`). Sent as `input-required`,
   * which every phone already shows and opens on the task, so no protocol
   * release is needed. Cooled down and cleared per task, not per session: the
   * idle sweep can pause the session after a stall, and its exit must not
   * clear the notice. A move of the task clears it.
   */
  notifyWorkflowTask(input: { projectId: string; taskId: string; taskTitle: string; swimlaneId?: string; detail: string }): void {
    if (this.disposed) return;
    const { detail, ...taskContext } = input;
    this.notifyWithContext(taskContext, `workflow-task:${input.taskId}`, '', 'input-required', detail);
  }

  /**
   * Every task of a workflow reached Done. A workflow has no session and no one
   * task, so the envelope names the workflow as its task title, carries an empty
   * task and session id, and cools down per workflow. Where a tap on it lands is
   * the mobile app's to decide; its tap router was written for envelopes that
   * name a task.
   */
  notifyWorkflowComplete(input: { projectId: string; workflowId: string; title: string; taskCount: number }): void {
    if (this.disposed) return;
    const detail = input.taskCount === 1 ? 'Its task is in Done.' : `All ${input.taskCount} tasks are in Done.`;
    this.notifyWithContext({ projectId: input.projectId, taskId: '', taskTitle: input.title }, input.workflowId, '', 'workflow-complete', detail);
  }

  /**
   * A Notify me automation row ran: its own Title and Body, to every paired
   * phone. Sent as `input-required`, which every phone already shows and opens
   * on the task, with an empty session id so a tap opens the task and the push
   * never replaces a session's own alert. A phone that predates `title` and
   * `body` shows "Agent needs your input" over `taskTitle - detail`, so
   * `detail` carries the Body as well. See DispatchOptions.userRequested for
   * what it skips.
   */
  notifyAutomation(input: { projectId: string; taskId: string; taskTitle: string; title: string; body: string }): void {
    if (this.disposed || !this.options.isBridgeEnabled()) return;
    const { title, body, ...taskContext } = input;
    const fitted = fitAutomationText(
      // The plaintext notifyWithContext seals, less detail, title and body.
      { category: 'input-required', projectId: input.projectId, taskId: input.taskId, sessionId: '', taskTitle: input.taskTitle, sentAt: Date.now() },
      title,
      body,
    );
    this.notifyWithContext(taskContext, `automation:${input.taskId}`, '', 'input-required', fitted.body, {
      envelope: { title: fitted.title, body: fitted.body },
      userRequested: true,
    });
  }

  private notifyWithContext(
    taskContext: PushTaskContext,
    cooldownSubject: string,
    envelopeSessionId: string,
    category: PushCategory,
    detail: string,
    dispatch: DispatchOptions = {},
  ): void {
    if (!this.options.isBridgeEnabled()) return;
    const userRequested = dispatch.userRequested === true;
    const connectedDeviceIds = this.options.getConnectedDeviceIds();
    const now = Date.now();
    this.clearLedger.prune(now);

    for (const registration of this.options.registrationStore.list()) {
      if (!userRequested) {
        if (connectedDeviceIds.has(registration.deviceId)) continue;
        // undefined categories means every category (the device's default / an older registration).
        if (registration.categories && !registration.categories.includes(category)) continue;
      }

      const cooldownKey = `${registration.deviceId}|${cooldownSubject}|${category}`;
      const lastNotifiedAt = this.cooldowns.get(cooldownKey);
      if (!userRequested && lastNotifiedAt !== undefined && now - lastNotifiedAt < CATEGORY_COOLDOWN_MS) continue;

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
        ...(taskContext.sessionKind ? { sessionKind: taskContext.sessionKind } : {}),
        ...dispatch.envelope,
      };
      const acceptsClears = registration.acceptsClears === true;
      const piggybacked = acceptsClears
        ? this.clearLedger.pickForMessage(
            registration.deviceId,
            (entries) => sealedPushBlobLength({ ...plaintext, clears: entries }) <= CLEAR_BLOB_BUDGET,
          ).picked
        : [];
      const sealedPlaintext: PushEnvelopePlaintext =
        piggybacked.length > 0 ? { ...plaintext, clears: piggybacked.map((pick) => pick.entry) } : plaintext;
      let sealedBlob: string;
      try {
        sealedBlob = this.sealEnvelope(hexToBytes(registration.pushKeyHex), deviceStaticPublicKey, sealedPlaintext);
      } catch {
        continue; // a malformed stored key must not take down the other devices' sends
      }
      if (!userRequested) this.cooldowns.set(cooldownKey, now);
      // The phone has nothing to clear a workflow's completion against until
      // it opens the Board, so that one is never recorded, and nothing at the
      // desk resolves a notification the user asked for.
      const clearKey = acceptsClears && category !== 'workflow-complete' && !userRequested ? `${cooldownSubject}|${category}` : null;
      let replacedRecord: OutstandingNotification | undefined;
      if (clearKey !== null) {
        // Copied from the sealed plaintext, never from the cooldown subject:
        // the phone matches a clear against the envelope it decrypted.
        const identity: PushClearIdentity = {
          category,
          projectId: plaintext.projectId,
          taskId: plaintext.taskId,
          sessionId: plaintext.sessionId,
          ...(plaintext.sessionKind ? { sessionKind: plaintext.sessionKind } : {}),
        };
        replacedRecord = this.clearLedger.recordDispatched(registration.deviceId, clearKey, identity, now, taskContext.swimlaneId);
      }
      void this.deliver({
        cooldownKey,
        stampedAt: now,
        deviceId: registration.deviceId,
        expoPushToken: registration.expoPushToken,
        platform: registration.platform,
        category,
        sealedBlob,
        clearKey,
        replacedRecord,
        piggybacked,
      });
    }
  }

  private async deliver(delivery: VisibleDelivery): Promise<void> {
    const { cooldownKey, stampedAt, deviceId, platform, category } = delivery;
    // Best-effort: a failed send never propagates into the session
    // pipeline. It is not silent, though - every non-delivery is logged
    // below, with the short device id only and never the sealed blob.
    // The failure detail is Expo's own ticket text rather than ours, and
    // it names the push token in some cases, so it goes through
    // redactPushTokens on the way out.
    try {
      // See the file header for why: Android gets a data-only message,
      // iOS gets the placeholder, and neither gets a channelId.
      const placeholder =
        platform === 'ios' ? { title: NOTIFICATION_TITLE, body: PLACEHOLDER_BODIES[category] } : {};
      const result = await this.wakeChannel.send({
        token: delivery.expoPushToken,
        ...placeholder,
        blob: delivery.sealedBlob,
        dataKey: PUSH_ENVELOPE_DATA_KEY,
        priority: 'high',
        mutableContent: true,
        contentAvailable: false,
      });
      if (result.delivered) {
        this.clearLedger.removeIfUnchanged(deviceId, delivery.piggybacked);
        return;
      }
      if (result.reason === 'device-not-registered') {
        this.dropUnregisteredDevice(deviceId);
        return;
      }
      // A genuine send failure (network, Expo outage) should not spend
      // the 30s cooldown window - the phone was never actually notified,
      // so a later recurrence of the same (device, session, category)
      // deserves a real retry rather than a silently swallowed one.
      // Compare-and-clear: only release the stamp this call itself made,
      // never a fresher one a later notifyWithContext call already set
      // for the same key while this send was in flight.
      this.releaseCooldownIfUnclaimed(cooldownKey, stampedAt);
      this.forgetUndelivered(delivery);
      console.warn(`[mobile-bridge/push-notifier] ${category} push to ${deviceId.slice(0, 8)} failed:`, result.reason, redactPushTokens(result.detail));
    } catch (error) {
      this.releaseCooldownIfUnclaimed(cooldownKey, stampedAt);
      this.forgetUndelivered(delivery);
      // The stack is kept, not reduced to the message: sendExpoPush never
      // throws, so this branch only ever fires for a replacement
      // WakeChannel, where the stack is the whole diagnostic. It is
      // redacted for the same reason the detail above is - a thrown
      // client may well have put the token it was posting to into its
      // own error text.
      console.warn(`[mobile-bridge/push-notifier] ${category} push to ${deviceId.slice(0, 8)} threw:`, describeThrownSend(error));
    }
  }

  /** Expo says the token is dead: forget the registration and everything owed to the device. */
  private dropUnregisteredDevice(deviceId: string): void {
    console.warn(`[mobile-bridge/push-notifier] ${deviceId.slice(0, 8)} is no longer registered with Expo; dropping its push registration`);
    this.options.registrationStore.remove(deviceId);
    this.clearLedger.dropDevice(deviceId);
  }

  /** The phone never got this notification, so there is nothing on it to clear. Its piggybacked clears stay pending. */
  private forgetUndelivered(delivery: VisibleDelivery): void {
    if (delivery.clearKey === null) return;
    this.clearLedger.forgetIfUnchanged(delivery.deviceId, delivery.clearKey, delivery.stampedAt, delivery.replacedRecord);
  }

  private releaseCooldownIfUnclaimed(cooldownKey: string, stampedAt: number): void {
    if (this.cooldowns.get(cooldownKey) === stampedAt) this.cooldowns.delete(cooldownKey);
  }

  private resolveSessionCategory(sessionId: string, category: PushCategory): void {
    this.resolveClears((notification) => notification.identity.category === category && notification.identity.sessionId === sessionId);
  }

  private resolveTask(projectId: string, taskId: string, matches: (notification: OutstandingNotification) => boolean): void {
    this.resolveClears((notification) =>
      notification.identity.projectId === projectId && notification.identity.taskId === taskId && matches(notification),
    );
  }

  /**
   * A task-updated board event: resolve the task's notifications whose
   * recorded lane it has left, or all of them once it is archived or gone.
   * Only notifications with a recorded lane take part: a Command Terminal's
   * taskId names no task row, and reading that as "deleted" would clear its
   * alert the moment it went out. The plan-exit auto-move resolves all but
   * plan-complete, which moves lane with the task instead (its own trigger
   * is the next turn's end).
   */
  private reconcileTaskPlacement(projectId: string, taskId: string): void {
    const placed = this.clearLedger.outstandingForTask(projectId, taskId).filter((notification) => notification.swimlaneId !== undefined);
    if (placed.length === 0) return;
    const placement = this.options.readTaskPlacement(projectId, taskId);
    if (!placement || placement.archived) {
      this.resolveTask(projectId, taskId, (notification) => notification.swimlaneId !== undefined);
      return;
    }
    const leftLane = (notification: OutstandingNotification): boolean =>
      notification.swimlaneId !== undefined && notification.swimlaneId !== placement.swimlaneId;
    if (!placed.some(leftLane)) return;
    if (placement.lastMoveOrigin === 'auto-move') {
      this.clearLedger.rebaseline(
        (notification) =>
          notification.identity.projectId === projectId &&
          notification.identity.taskId === taskId &&
          notification.identity.category === 'plan-complete' &&
          leftLane(notification),
        placement.swimlaneId,
      );
      this.resolveTask(projectId, taskId, (notification) => notification.identity.category !== 'plan-complete' && leftLane(notification));
      return;
    }
    this.resolveTask(projectId, taskId, leftLane);
  }

  private resolveClears(matches: (notification: OutstandingNotification) => boolean): void {
    if (this.disposed) return;
    const devicesWithNewClears = this.clearLedger.resolve(matches, () => this.options.getConnectedDeviceIds(), Date.now());
    for (const deviceId of devicesWithNewClears) this.scheduleClearFlush(deviceId);
  }

  private findRegistration(deviceId: string): PushRegistrationEntry | undefined {
    return this.options.registrationStore.list().find((registration) => registration.deviceId === deviceId);
  }

  private scheduleClearFlush(deviceId: string): void {
    if (this.disposed || this.clearFlushTimers.has(deviceId)) return;
    let delayMs = CLEAR_COALESCE_MS;
    const lastStandaloneAt = this.lastStandaloneClearAt.get(deviceId);
    if (lastStandaloneAt !== undefined && this.findRegistration(deviceId)?.platform === 'ios') {
      delayMs = Math.max(delayMs, lastStandaloneAt + IOS_STANDALONE_CLEAR_INTERVAL_MS - Date.now());
    }
    const flushTimer = setTimeout(() => {
      this.clearFlushTimers.delete(deviceId);
      this.flushClears(deviceId);
    }, delayMs);
    flushTimer.unref?.();
    this.clearFlushTimers.set(deviceId, flushTimer);
  }

  /** Sends one standalone clear carrying as many of the device's pending clears as fit, and reschedules for the rest. */
  private flushClears(deviceId: string): void {
    if (this.disposed) return;
    const now = Date.now();
    this.clearLedger.prune(now);
    if (!this.options.isBridgeEnabled()) {
      this.clearLedger.dropPending(deviceId);
      return;
    }
    const registration = this.findRegistration(deviceId);
    if (!registration || registration.acceptsClears !== true) {
      this.clearLedger.dropDevice(deviceId);
      return;
    }
    // Watching from the app now, which reconciles its own notifications.
    if (this.options.getConnectedDeviceIds().has(deviceId)) {
      this.clearLedger.dropPending(deviceId);
      return;
    }
    const deviceStaticPublicKey = this.options.getDeviceStaticPublicKey(deviceId);
    if (!deviceStaticPublicKey) {
      this.clearLedger.dropPending(deviceId);
      return;
    }
    const { picked, unsentLeft } = this.clearLedger.pickForMessage(
      deviceId,
      (entries) => sealedPushBlobLength({ clears: entries, sentAt: now }) <= CLEAR_BLOB_BUDGET,
    );
    if (picked.length === 0) {
      // Pending clears exist only when a resolution queued one, so an empty
      // pick means not one of them fits a message alone. Never true of a
      // real entry; drop them rather than reschedule forever.
      this.clearLedger.dropPending(deviceId);
      return;
    }
    let sealedClear: string;
    try {
      sealedClear = this.sealClear(hexToBytes(registration.pushKeyHex), deviceStaticPublicKey, {
        clears: picked.map((pick) => pick.entry),
        sentAt: now,
      });
    } catch {
      this.clearLedger.dropPending(deviceId); // a malformed stored key will not seal the next try either
      return;
    }
    // Stamped before the send so a flush scheduled meanwhile waits out the
    // window; released again below if Expo refuses the clear.
    if (registration.platform === 'ios') this.lastStandaloneClearAt.set(deviceId, now);
    if (unsentLeft) this.scheduleClearFlush(deviceId);
    void this.deliverClear(deviceId, registration, picked, sealedClear, now);
  }

  /**
   * A background clear Expo refused never reached Apple, so it must not
   * spend the device's interval: compare-and-clear, as the notification
   * cooldown does, so a fresher stamp from a later flush survives.
   */
  private releaseStandaloneStampIfUnclaimed(deviceId: string, stampedAt: number): void {
    if (this.lastStandaloneClearAt.get(deviceId) === stampedAt) this.lastStandaloneClearAt.delete(deviceId);
  }

  private async deliverClear(
    deviceId: string,
    registration: PushRegistrationEntry,
    picked: PickedClear[],
    sealedClear: string,
    stampedAt: number,
  ): Promise<void> {
    try {
      // No title, body or channelId on either platform: nothing for the OS
      // to show. Normal priority on both; iOS adds the background wake.
      const result = await this.wakeChannel.send({
        token: registration.expoPushToken,
        blob: sealedClear,
        dataKey: PUSH_CLEAR_DATA_KEY,
        priority: 'normal',
        mutableContent: false,
        contentAvailable: registration.platform === 'ios',
      });
      if (result.delivered) {
        // Expo accepting an iOS background push says nothing about the app
        // getting it, so those entries wait for a visible push as well.
        if (registration.platform === 'ios') this.clearLedger.markStandaloneSent(deviceId, picked, Date.now());
        else this.clearLedger.removeIfUnchanged(deviceId, picked);
        return;
      }
      if (result.reason === 'device-not-registered') {
        this.dropUnregisteredDevice(deviceId);
        return;
      }
      // The entries stay pending: the next flush or visible push carries them.
      this.releaseStandaloneStampIfUnclaimed(deviceId, stampedAt);
      console.warn(`[mobile-bridge/push-notifier] clear push to ${deviceId.slice(0, 8)} failed:`, result.reason, redactPushTokens(result.detail));
    } catch (error) {
      this.releaseStandaloneStampIfUnclaimed(deviceId, stampedAt);
      console.warn(`[mobile-bridge/push-notifier] clear push to ${deviceId.slice(0, 8)} threw:`, describeThrownSend(error));
    }
  }

  /** Synchronous, per synchronous-shutdown.md: detaches listeners and clears every pending debounce, settle and flush timer. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.started) {
      this.options.sessionManager.off('activity', this.onActivity);
      this.options.sessionManager.off('exit', this.onExit);
      this.options.sessionManager.off('plan-exit', this.onPlanExit);
      this.options.sessionManager.off('turn-ended', this.onTurnEnded);
      this.options.sessionManager.off('session-changed', this.onSessionChanged);
    }
    this.unsubscribeBoardEvents?.();
    this.unsubscribeBoardEvents = null;
    for (const debounceTimer of this.permissionDebounceTimers.values()) clearTimeout(debounceTimer);
    this.permissionDebounceTimers.clear();
    for (const settleTimer of this.idleSettleTimers.values()) clearTimeout(settleTimer);
    this.idleSettleTimers.clear();
    for (const flushTimer of this.clearFlushTimers.values()) clearTimeout(flushTimer);
    this.clearFlushTimers.clear();
    this.lastActivityState.clear();
    this.cooldowns.clear();
    this.clearLedger.clear();
    this.lastStandaloneClearAt.clear();
  }
}
