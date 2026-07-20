/**
 * Decides when a session's idle/permission state or crash deserves a desktop
 * OS notification. This is the main-process owner of the policy that used to
 * live in the renderer (`App.tsx`'s `shouldNotify` / `sendNotification`):
 * cooldown, window-focus gate, active-project gate, and title/body assembly.
 * Moving it here means it keeps working even when the renderer is gone (the
 * window is closed) - it listens to SessionManager's own 'activity' and
 * 'exit' events rather than an IPC round-trip through a live renderer.
 *
 * This is a structural move, not a redesign: it intentionally does NOT adopt
 * the mobile PushNotifier's edge-tracking or permission debounce. It stays
 * level-triggered on `requiresUserInteraction(state)`, matching the exact
 * renderer behavior it replaces.
 *
 * Two triggers, sharing ONE cooldown bucket keyed by sessionId (matching the
 * renderer, which passed the bare sessionId as the cooldown key for both):
 *
 * - `requiresUserInteraction(state)` true (idle or permission) with
 *   `desktop.onAgentIdle` enabled.
 * - A non-zero, non-intentional exit with `desktop.onAgentCrash` enabled.
 *
 * Suppressed when the window is focused AND the session's project is the
 * active one. A destroyed/missing window counts as unfocused - that is the
 * behavior this notifier exists to preserve.
 */
import { requiresUserInteraction } from '../../shared/activity-state';
import { COMMAND_TERMINAL_NOTIFICATION_TASK_ID } from '../../shared/notification-constants';
import type { ActivityReason, ActivityState, NotificationConfig, NotificationInput } from '../../shared/types';
import type { SessionManager } from '../pty/session-manager';

export interface DesktopNotifierOptions {
  sessionManager: Pick<SessionManager, 'on' | 'off' | 'getSession'>;
  getNotificationConfig: () => NotificationConfig;
  getActiveProjectId: () => string | undefined;
  /** False when the window is destroyed/missing - the whole point of this notifier. */
  isWindowFocused: () => boolean;
  flashFrame: () => void;
  resolveTaskTitle: (projectId: string, taskId: string) => string | undefined;
  resolveProjectName: (projectId: string) => string | undefined;
  showNotification: (input: NotificationInput) => void;
}

export class DesktopNotifier {
  private readonly options: DesktopNotifierOptions;
  /** Last-notified wall-clock ms per sessionId - idle and crash intentionally
   *  share one bucket, matching the renderer policy this replaces. */
  private readonly cooldowns = new Map<string, number>();
  private started = false;
  private disposed = false;

  constructor(options: DesktopNotifierOptions) {
    this.options = options;
  }

  start(): void {
    if (this.started || this.disposed) return;
    this.started = true;
    this.options.sessionManager.on('activity', this.onActivity);
    this.options.sessionManager.on('exit', this.onExit);
  }

  private readonly onActivity = (sessionId: string, state: ActivityState, _reason: ActivityReason): void => {
    // Never let a notification failure escape into the emit stack. These
    // listeners are attached to SessionManager BEFORE the session handlers
    // (register-all.ts starts this notifier ahead of registerSessionHandlers),
    // and EventEmitter.emit does not isolate listener exceptions - a throw here
    // would abort the session DB persistence, analytics, and notifySlotFreed()
    // that run after us on the same synchronous emit. A missed notification is
    // an acceptable failure; a skipped session-lifecycle write is not.
    try {
      this.handleActivity(sessionId, state);
    } catch (error) {
      console.error('[NOTIFICATION] desktop notifier activity handler failed', error);
    }
  };

  private handleActivity(sessionId: string, state: ActivityState): void {
    if (!requiresUserInteraction(state)) return;
    if (!this.options.getNotificationConfig().desktop.onAgentIdle) return;

    const session = this.options.sessionManager.getSession(sessionId);
    if (!session) return;
    if (!this.shouldNotify(sessionId, session.projectId)) return;

    const projectName = this.options.resolveProjectName(session.projectId) ?? 'A project';
    const taskTitle = session.transient ? undefined : this.options.resolveTaskTitle(session.projectId, session.taskId);
    const label = session.transient ? 'Command Terminal' : (taskTitle ?? 'A task');
    // activity-state-ok: granular permission-vs-idle message text, not an idle-vs-active bucket
    const body = state === 'permission' ? `Needs permission: ${projectName}` : projectName;
    const clickTaskId = session.transient ? COMMAND_TERMINAL_NOTIFICATION_TASK_ID : session.taskId;

    this.notify(sessionId, label, body, session.projectId, clickTaskId);
  }

  private readonly onExit = (sessionId: string, exitCode: number, intentional?: boolean): void => {
    // See handleActivity: a throw here would abort the session-lifecycle
    // bookkeeping that runs after this listener on the same emit.
    try {
      this.handleExit(sessionId, exitCode, intentional);
    } catch (error) {
      console.error('[NOTIFICATION] desktop notifier exit handler failed', error);
    }
  };

  private handleExit(sessionId: string, exitCode: number, intentional?: boolean): void {
    // `intentional` is set by main when the session was ended deliberately
    // (suspend/kill teardown), so a non-zero force-kill exit is not a crash.
    if (intentional === true) return;
    if (exitCode === 0) return;
    if (!this.options.getNotificationConfig().desktop.onAgentCrash) return;

    // Transient (Command Terminal) sessions are ephemeral - skip, matching the renderer.
    const session = this.options.sessionManager.getSession(sessionId);
    if (!session || session.transient) return;
    if (!this.shouldNotify(sessionId, session.projectId)) return;

    const projectName = this.options.resolveProjectName(session.projectId) ?? 'A project';
    const taskTitle = this.options.resolveTaskTitle(session.projectId, session.taskId);
    const label = taskTitle ?? sessionId.slice(0, 8);

    this.notify(sessionId, `Session crashed: ${label}`, projectName, session.projectId, session.taskId);
  }

  /** Cooldown + focus/active-project suppression, ported verbatim from the renderer's shouldNotify. */
  private shouldNotify(cooldownKey: string, sessionProjectId: string): boolean {
    const cooldownMs = this.options.getNotificationConfig().cooldownSeconds * 1000;
    const lastNotifiedAt = this.cooldowns.get(cooldownKey) ?? 0;
    if (Date.now() - lastNotifiedAt < cooldownMs) return false;

    const focused = this.options.isWindowFocused();
    const activeProjectId = this.options.getActiveProjectId();
    // Skip if window focused AND viewing the session's project.
    if (focused && sessionProjectId === activeProjectId) return false;

    return true;
  }

  private notify(cooldownKey: string, title: string, body: string, projectId: string, taskId: string): void {
    if (this.disposed) return;
    // Stamped here (not in shouldNotify) so a focus-suppressed event does not
    // consume the cooldown, matching the renderer's sendNotification.
    this.cooldowns.set(cooldownKey, Date.now());
    this.options.showNotification({ title, body, projectId, taskId });
    this.options.flashFrame();
  }

  /** Synchronous, per synchronous-shutdown.md: detaches listeners and clears cooldown state. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.started) {
      this.options.sessionManager.off('activity', this.onActivity);
      this.options.sessionManager.off('exit', this.onExit);
    }
    this.cooldowns.clear();
  }
}
