/**
 * Owns the count of agents waiting on the user, shown on the app icon. It lives
 * in main because the macOS app outlives its window, and it listens to
 * SessionManager's own events, like `DesktopNotifier`, so no renderer round trip
 * sits between a state change and the icon.
 *
 * The count covers every open project. It reads the registry rather than keeping
 * a tally, so it cannot drift: each event only schedules a recount.
 *
 * A session counts when it is running and waiting on the user, except where
 * `DesktopNotifier` raises no notice either: a workflow's own agent, the end of
 * the turn that moved its own task, and a running workflow step between turns,
 * which its step check judges. A permission prompt always counts, and so does a
 * step the board has stopped (`automations/stopped-mark.ts`): its check found it
 * waiting on the user, or its recovery ran out, so only a person can move it.
 */
import { requiresUserInteraction } from '../../shared/activity-state';
import type { ActivityState, NotificationConfig } from '../../shared/types';
import type { SessionManager } from '../pty/session-manager';

/** The events that can change who is waiting. A reason refresh has its own filter. */
const RECOUNT_EVENTS = ['activity', 'exit', 'session-changed', 'session-removed', 'pty-host-lost'] as const;

export interface AppBadgeOptions {
  sessionManager: Pick<SessionManager, 'on' | 'off' | 'listSessions' | 'getActivityCache' | 'getActivityReason'>;
  getNotificationConfig: () => NotificationConfig;
  isSessionInOwnCall: (sessionId: string) => boolean;
  /** Reads the task's board, so it is asked last. */
  isWorkflowStepTask: (projectId: string, taskId: string) => boolean;
  /** Puts the count on the icon. Called only when the number changes. */
  show: (count: number) => void;
}

export class AppBadge {
  private readonly options: AppBadgeOptions;
  private shownCount = 0;
  private scheduled: NodeJS.Immediate | null = null;
  private started = false;
  private disposed = false;

  constructor(options: AppBadgeOptions) {
    this.options = options;
  }

  start(): void {
    if (this.started || this.disposed) return;
    this.started = true;
    for (const event of RECOUNT_EVENTS) {
      this.options.sessionManager.on(event, this.refresh);
    }
    this.options.sessionManager.on('activity-reason', this.onReasonRefresh);
    this.refresh();
  }

  /**
   * The board stopping a task goes out as a reason-only refresh on its idle session.
   * A working session's are not worth a recount: a long turn sends about 180.
   */
  private readonly onReasonRefresh = (_sessionId: string, state: ActivityState): void => {
    if (requiresUserInteraction(state)) this.refresh();
  };

  /**
   * Schedules a recount. A burst of events costs one, and the recount runs off the
   * emit stack, so a throw in it cannot abort the session-lifecycle writes that
   * run after these listeners on the same synchronous emit.
   */
  readonly refresh = (): void => {
    if (this.disposed || this.scheduled) return;
    this.scheduled = setImmediate(() => {
      this.scheduled = null;
      try {
        this.recount();
      } catch (error) {
        console.error('[NOTIFICATION] app badge recount failed', error);
      }
    });
  };

  private recount(): void {
    const count = this.waitingCount();
    if (count === this.shownCount) return;
    this.shownCount = count;
    this.options.show(count);
  }

  private waitingCount(): number {
    const config = this.options.getNotificationConfig();
    if (config.muted || !config.appBadge) return 0;

    const { sessionManager, isSessionInOwnCall, isWorkflowStepTask } = this.options;
    const activity = sessionManager.getActivityCache();
    let count = 0;
    for (const session of sessionManager.listSessions()) {
      if (session.status !== 'running' || session.workflowId) continue;
      const state = activity[session.id];
      if (!requiresUserInteraction(state)) continue;
      // activity-state-ok: granular, as in DesktopNotifier: only the idle half
      // belongs to the call or the step check, and a permission prompt counts.
      if (state === 'idle') {
        if (isSessionInOwnCall(session.id)) continue;
        const reason = sessionManager.getActivityReason(session.id);
        const stopped = reason?.kind === 'idle' && reason.stopped === true;
        if (!stopped && !session.transient && isWorkflowStepTask(session.projectId, session.taskId)) continue;
      }
      count += 1;
    }
    return count;
  }

  /** Synchronous, per synchronous-shutdown.md. The OS clears the badge with the process. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.scheduled) clearImmediate(this.scheduled);
    this.scheduled = null;
    if (this.started) {
      for (const event of RECOUNT_EVENTS) {
        this.options.sessionManager.off(event, this.refresh);
      }
      this.options.sessionManager.off('activity-reason', this.onReasonRefresh);
    }
  }
}
