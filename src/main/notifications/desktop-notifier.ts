/**
 * Decides when a session's idle/permission state or crash deserves a desktop
 * OS notification. This is the main-process owner of the policy that used to
 * live in the renderer (`App.tsx`'s `shouldNotify` / `sendNotification`):
 * cooldown, window-focus gate, active-project gate, and title/body assembly.
 * Moving it here means it keeps working even when the renderer is gone (the
 * window is closed) - it listens to SessionManager's own 'activity' and
 * 'exit' events rather than an IPC round-trip through a live renderer.
 *
 * It arrived as a structural move rather than a redesign, and that still holds
 * for the TRIGGER: it intentionally does NOT adopt the mobile PushNotifier's
 * edge-tracking or permission debounce, and stays level-triggered on
 * `requiresUserInteraction(state)`, matching the renderer behavior it replaced.
 * The cooldown KEYING has since diverged deliberately; see below.
 *
 * (The renderer now raises an in-app toast for the same idle event, and that one
 * IS edge-triggered, because it has no focus gate to hide a repeat behind. See
 * `src/renderer/utils/idle-toast.ts`.)
 *
 * Two triggers, each with its OWN cooldown bucket:
 *
 * - `requiresUserInteraction(state)` true (idle or permission) with
 *   `desktop.onAgentIdle` enabled. A running workflow task's idle is left to
 *   its step check, which calls `notifyWorkflowTask` when the agent waits on
 *   the user or the task stalls.
 * - A non-zero, non-intentional exit with `desktop.onAgentCrash` enabled.
 *
 * They shared one bucket keyed by the bare sessionId until 2026-09-21, ported
 * verbatim from the renderer policy this replaced. That silently swallowed the
 * more important of the two: a session that goes idle and then crashes within
 * `cooldownSeconds` (10s by default) is the ordinary shape of an agent dying
 * right after a turn, and the crash notification never fired. Cooldown exists to
 * stop one event repeating, not to let one event mask a different one.
 *
 * Suppressed when the window is focused AND the session's project is the
 * active one. A destroyed/missing window counts as unfocused - that is the
 * behavior this notifier exists to preserve.
 *
 * The words are this notifier's own and translate (main's translator, the
 * session's language). The names it places in them (task, project and workflow
 * titles) are user data, and a stall or wait reason is main's English, so both
 * stay as written.
 */
import { msg } from '@lingui/core/runtime-macro';
import { translateText } from '../i18n/main-i18n';
import { requiresUserInteraction } from '../../shared/activity-state';
import { COMMAND_TERMINAL_NOTIFICATION_TASK_ID } from '../../shared/notification-constants';
import { PTY_HOST_LOST_EXIT_CODE, PTY_HOST_LOST_NOTICE_WINDOW_MS } from '../../shared/pty-host';
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
  /**
   * The title of the workflow the task belongs to, or undefined for a task
   * outside a workflow. The workflow lives in its home project's database,
   * which can be another project than the task's.
   */
  resolveWorkflowTitle: (projectId: string, taskId: string) => string | undefined;
  /**
   * Is the task in a running workflow, in a column between To Do and Done?
   * Its step check says itself when the agent waits on the user or the task
   * stalls (`notifyWorkflowTask`), so its plain idle raises nothing here.
   */
  isWorkflowStepTask?: (projectId: string, taskId: string) => boolean;
  /**
   * Is the session's own call (a move of its task, a pause of its workflow)
   * still taking effect? Its idle ends the turn that made the call, which
   * belongs to the column the task left or to a paused workflow
   * (`own-call-turn-wait.ts`), so it raises no idle notice.
   */
  isSessionInOwnCall?: (sessionId: string) => boolean;
  showNotification: (input: NotificationInput) => void;
}

/** A running workflow task the user should hear about (`workflow-recovery.ts`). */
export interface WorkflowTaskNotice {
  projectId: string;
  taskId: string;
  /** The session waiting, for a wait on the user: it shares that session's idle cooldown. */
  sessionId?: string;
  /** `stalled`: recovery ran out or a pause stopped it. `waiting`: the agent waits on the user. */
  kind: 'stalled' | 'waiting';
  reason: string;
}

/**
 * A workflow's title as the notification body names it: "Usage budgets
 * workflow". A title that already ends in the word (the default "Untitled
 * workflow") is not given a second one. The check reads the user's own title,
 * so it stays an English test; the word it adds translates.
 */
export function workflowLabel(title: string): string {
  const workflowTitle = title.trim();
  if (/\bworkflow$/i.test(workflowTitle)) return workflowTitle;
  return translateText(msg`${{ workflowTitle }} workflow`);
}

export class DesktopNotifier {
  private readonly options: DesktopNotifierOptions;
  /** Last-notified wall-clock ms, keyed `<trigger>:<sessionId>` so a crash is
   *  never suppressed by this session's recent idle notification. */
  private readonly cooldowns = new Map<string, number>();
  /** When the last pty host crash was considered for a notification, so the
   *  burst of exits one crash produces collapses to one. */
  private lastHostLostNoticeAt = 0;
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
    // A workflow's own agent lives only in the Workflows view, where its pane
    // shows it waiting; it raises no notification of its own.
    if (session.workflowId) return;
    // The end of the turn that moved its own task or paused its own workflow:
    // that turn belongs to the call. A permission prompt in it still notifies.
    // activity-state-ok: granular, only the idle half is the call's.
    if (state === 'idle' && this.options.isSessionInOwnCall?.(sessionId)) return;
    if (!this.shouldNotify(`idle:${sessionId}`, session.projectId)) return;
    // A running workflow task's idle is its step check's to report: a wait on
    // the user at once, a stall only once recovery runs out. A permission
    // prompt still notifies here. Asked after the cheap gates, since it reads
    // the task's board on every idle.
    // activity-state-ok: granular, only the idle half is the step check's.
    if (state === 'idle' && !session.transient && this.options.isWorkflowStepTask?.(session.projectId, session.taskId)) return;

    // A Command Terminal has no task, so no workflow to name.
    const place = session.transient
      ? this.projectName(session.projectId)
      : this.taskPlace(session.projectId, session.taskId);
    const taskTitle = session.transient ? undefined : this.options.resolveTaskTitle(session.projectId, session.taskId);
    const label = session.transient ? translateText(msg`Command Terminal`) : (taskTitle ?? translateText(msg`A task`));
    // activity-state-ok: granular permission-vs-idle message text, not an idle-vs-active bucket
    const body = state === 'permission' ? translateText(msg`Needs permission: ${{ place }}`) : place;
    const clickTaskId = session.transient ? COMMAND_TERMINAL_NOTIFICATION_TASK_ID : session.taskId;

    this.notify(`idle:${sessionId}`, label, body, session.projectId, clickTaskId);
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

    // The pty host died and took every terminal with it: one notification for
    // the crash, not one per session, since the agents resume a moment later.
    if (exitCode === PTY_HOST_LOST_EXIT_CODE) {
      const now = Date.now();
      if (now - this.lastHostLostNoticeAt < PTY_HOST_LOST_NOTICE_WINDOW_MS) return;
      // Stamped only when the notice goes out: an exit the focus gate holds
      // back (the project on screen) must not swallow a background project's
      // exit from the same crash, or the outcome would depend on exit order.
      if (!this.shouldNotify('pty-host-lost', session.projectId)) return;
      this.lastHostLostNoticeAt = now;
      this.notify(
        'pty-host-lost',
        translateText(msg`Terminals restarted`),
        translateText(msg`Running agents are resuming.`),
        session.projectId,
        session.taskId,
      );
      return;
    }

    if (!this.shouldNotify(`crash:${sessionId}`, session.projectId)) return;

    const taskTitle = this.options.resolveTaskTitle(session.projectId, session.taskId);
    const label = taskTitle ?? sessionId.slice(0, 8);

    this.notify(
      `crash:${sessionId}`,
      translateText(msg`Session crashed: ${{ label }}`),
      this.taskPlace(session.projectId, session.taskId),
      session.projectId,
      session.taskId,
    );
  }

  /**
   * A running workflow task's own notice, raised by its recovery
   * (`workflow-recovery.ts`): the task's title over where it runs and why.
   *
   * - A stall is behind `desktop.onWorkflowStalled` and skips the focus gate.
   *   It goes out once a stall, and a window left in front with the project
   *   open would otherwise swallow the only one, its latch already written.
   * - A wait on the user stands in for the idle notice it replaced, so it
   *   shares that one's switch, focus gate and per-session cooldown.
   */
  notifyWorkflowTask(notice: WorkflowTaskNotice): void {
    if (this.disposed) return;
    const config = this.options.getNotificationConfig();
    const title = this.options.resolveTaskTitle(notice.projectId, notice.taskId) ?? translateText(msg`A task`);
    const place = this.taskPlace(notice.projectId, notice.taskId);
    // main's own English, placed as written.
    const reason = notice.reason;
    if (notice.kind === 'stalled') {
      if (!config.desktop.onWorkflowStalled) return;
      this.notify(`stalled:${notice.taskId}`, title, translateText(msg`${{ place }}. Stalled: ${{ reason }}`), notice.projectId, notice.taskId);
      return;
    }
    if (!config.desktop.onAgentIdle) return;
    const cooldownKey = `idle:${notice.sessionId ?? notice.taskId}`;
    if (!this.shouldNotify(cooldownKey, notice.projectId)) return;
    this.notify(cooldownKey, title, translateText(msg`${{ place }}. Waiting on you: ${{ reason }}`), notice.projectId, notice.taskId);
  }

  private projectName(projectId: string): string {
    return this.options.resolveProjectName(projectId) ?? translateText(msg`A project`);
  }

  /**
   * Where a task's session runs, as the idle and crash bodies name it: the
   * project, and for a task in a workflow the workflow too ("kangentic: Usage
   * budgets workflow", #732 board 16), since several of one workflow's tasks
   * can be waiting at once. A task outside a workflow reads as before.
   */
  private taskPlace(projectId: string, taskId: string): string {
    const projectName = this.projectName(projectId);
    const workflowTitle = this.options.resolveWorkflowTitle(projectId, taskId);
    if (!workflowTitle) return projectName;
    const workflowName = workflowLabel(workflowTitle);
    return translateText(msg`${{ projectName }}: ${{ workflowName }}`);
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
