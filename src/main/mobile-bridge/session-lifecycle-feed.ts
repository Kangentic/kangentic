/**
 * Bridges session lifecycle transitions onto the board-changed bus so a
 * phone's board view updates when a task's session spawns, queues,
 * resumes, suspends, exits, or is removed. The renderer learns these through its own
 * IPC pushes; the bridge's read-board subscription only hears
 * BoardEventBus, and nothing fed that bus on a session lifecycle edge -
 * so a phone watching the board saw stale "running" badges until the
 * next agent-driven mutation happened to fire.
 *
 * Each signal emits immediately AND schedules one settle re-emit
 * (default 1s, coalesced per task): several lifecycle edges land before
 * their DB writes settle (exit-code persistence, transition-engine
 * moves), so the immediate emit gives the phone the fast edge and the
 * settle emit re-syncs whatever the follow-up writes changed.
 */
import type { Session } from '../../shared/types';
import type { SessionManager } from '../pty/session-manager';
import type { BoardChangedEvent } from './board-event-bus';

export interface SessionLifecycleBoardFeedOptions {
  sessionManager: Pick<SessionManager, 'on' | 'off' | 'getSessionTaskId' | 'getSessionProjectId'>;
  boardEvents: { emitBoardChanged(event: BoardChangedEvent): void };
  /** Delay before the coalesced settle re-emit. Defaults to 1000ms. */
  settleDelayMs?: number;
}

export class SessionLifecycleBoardFeed {
  private readonly sessionManager: SessionLifecycleBoardFeedOptions['sessionManager'];
  private readonly boardEvents: SessionLifecycleBoardFeedOptions['boardEvents'];
  private readonly settleDelayMs: number;
  /** One pending settle timer per taskId - a second signal for the same task rides the already-scheduled re-emit. */
  private readonly settleTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private started = false;
  private disposed = false;

  constructor(options: SessionLifecycleBoardFeedOptions) {
    this.sessionManager = options.sessionManager;
    this.boardEvents = options.boardEvents;
    this.settleDelayMs = options.settleDelayMs ?? 1000;
  }

  private readonly onSessionChanged = (_sessionId: string, session: Session): void => {
    this.notifyTaskUpdated(session.projectId, session.taskId);
  };

  private readonly onExit = (sessionId: string): void => {
    // The exit emission carries no task/project ids; the registry still
    // holds the exited session at emit time, so resolve through it.
    const taskId = this.sessionManager.getSessionTaskId(sessionId);
    const projectId = this.sessionManager.getSessionProjectId(sessionId);
    if (!taskId || !projectId) return;
    this.notifyTaskUpdated(projectId, taskId);
  };

  start(): void {
    if (this.started || this.disposed) return;
    this.started = true;
    this.sessionManager.on('session-changed', this.onSessionChanged);
    // A removal carries the same (id, Session) payload and is the last edge a
    // session has; a phone watching the board would otherwise keep a badge
    // for a session main has torn down without a natural exit.
    this.sessionManager.on('session-removed', this.onSessionChanged);
    this.sessionManager.on('exit', this.onExit);
  }

  private notifyTaskUpdated(projectId: string, taskId: string): void {
    if (this.disposed || !projectId || !taskId) return;
    this.boardEvents.emitBoardChanged({ projectId, change: 'task-updated', ids: [taskId] });
    if (this.settleTimers.has(taskId)) return;
    const settleTimer = setTimeout(() => {
      this.settleTimers.delete(taskId);
      this.boardEvents.emitBoardChanged({ projectId, change: 'task-updated', ids: [taskId] });
    }, this.settleDelayMs);
    settleTimer.unref?.();
    this.settleTimers.set(taskId, settleTimer);
  }

  /** Synchronous, per synchronous-shutdown.md: detaches listeners and clears every pending settle timer. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.started) {
      this.sessionManager.off('session-changed', this.onSessionChanged);
      this.sessionManager.off('session-removed', this.onSessionChanged);
      this.sessionManager.off('exit', this.onExit);
    }
    for (const settleTimer of this.settleTimers.values()) clearTimeout(settleTimer);
    this.settleTimers.clear();
  }
}
