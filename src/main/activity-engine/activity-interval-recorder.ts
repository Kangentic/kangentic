import type { ActivityState } from '../../shared/types';
import { dispositionOf } from '../../shared/activity-state';
import type { SessionManager } from '../pty/session-manager';
import { ActivityIntervalStore } from './activity-interval-store';

export interface ActivityIntervalRecorderOptions {
  sessionManager: Pick<
    SessionManager,
    'on' | 'off' | 'getSession' | 'getSessionProjectId' | 'getSessionTaskId' | 'getActivityStatsSnapshot'
  >;
  /** Resolve the interval store for a project. Injectable for tests; production wiring wraps
   *  `getProjectDb(projectId)`. `getProjectDb` caches connections per project, so calling this
   *  on every event is cheap - it is not opening a new connection each time. */
  getStore: (projectId: string) => ActivityIntervalStore;
  /** UTC ISO 8601 clock for `recorded_at`. Injectable for tests. */
  now?: () => string;
}

/**
 * Writes the activity engine's committed disposition transitions ("the green
 * spinner turned into the yellow mail icon", and back) to a durable
 * per-project table. The engine itself never persists this: its state is
 * in-memory only, and the one on-disk trace (events.jsonl) records raw hook
 * events, not committed transitions, so it can both miss a real transition
 * (a raw idle cancelled by the 400ms stability window) and record one that
 * never happened (a watchdog-synthesized idle with no matching raw event).
 *
 * Symmetric by design: every real disposition flip (active -> idle or
 * idle -> active) closes whichever interval was open and opens the next -
 * NOT idle-only. Recording both directly means "active time" and "idle
 * time" are each a straight SUM over the table; deriving one as the inverse
 * of the other would need exact session-boundary reconciliation across
 * resumes/suspends and would silently break on a crash-orphaned open row.
 * A permission<->idle crossing stays within the same 'idle'-disposition
 * interval (both map to the same disposition via `dispositionOf`), so nothing
 * closes/reopens for it.
 *
 * Modelled on `PushNotifier` (`src/main/mobile-bridge/push/push-notifier.ts`):
 * a single listener on `sessionManager`'s `activity` and `exit` events, no
 * per-session state map. Unlike PushNotifier, this recorder needs no
 * `lastActivityState` map either - it reads provenance (`from` and
 * `trigger`) straight off the engine's own transition ring
 * (`getActivityStatsSnapshot(sessionId).recentTransitions`), which
 * `ActivityEngine.commitTransition` appends to immediately before firing the
 * `activity` event this recorder listens on.
 */
export class ActivityIntervalRecorder {
  private readonly options: ActivityIntervalRecorderOptions;
  private readonly now: () => string;
  private started = false;
  private disposed = false;

  constructor(options: ActivityIntervalRecorderOptions) {
    this.options = options;
    this.now = options.now ?? (() => new Date().toISOString());
  }

  private readonly onActivity = (sessionId: string, activity: ActivityState): void => {
    // Never let a ledger write escape into the emit stack. This listener is
    // attached to SessionManager BEFORE the session handlers (register-all.ts
    // starts this recorder ahead of registerSessionHandlers), and
    // EventEmitter.emit does not isolate listener exceptions - a throw here
    // would abort the session DB persistence and the SESSION_ACTIVITY
    // broadcast that run after us on the same synchronous emit, and would
    // unwind back into ActivityEngine.commitTransition before it can call
    // scheduleTimer(), leaving the stale-thinking watchdog unarmed. A lost
    // interval row is an acceptable failure; a skipped session-lifecycle
    // write or a disarmed watchdog is not. Mirrors DesktopNotifier's guard.
    try {
      this.handleActivity(sessionId, activity);
    } catch (error) {
      console.error('[ACTIVITY-INTERVAL] recorder activity handler failed', error);
    }
  };

  private handleActivity(sessionId: string, activity: ActivityState): void {
    if (this.disposed) return;
    const session = this.options.sessionManager.getSession(sessionId);
    // Command Terminal sessions carry a synthetic taskId that is not a real
    // task row - skip them, matching the guard in handlers/sessions.ts.
    if (!session || session.transient) return;
    const projectId = this.options.sessionManager.getSessionProjectId(sessionId);
    if (!projectId) return;

    const snapshot = this.options.sessionManager.getActivityStatsSnapshot(sessionId);
    const lastTransition = snapshot?.recentTransitions[snapshot.recentTransitions.length - 1];
    // ActivityEngine.initSession's seed path calls onActivityChange directly
    // (see activity-engine.ts) without going through commitTransition, so it
    // never appends to recentTransitions. A missing or stale tail entry
    // therefore means this emission is a seed (resume / Command Terminal
    // spawn / orphan recovery), not a real transition - skip it. The window
    // this leaves unrecorded (spawn until the session's first real
    // transition) is deliberate and small; see the migration comment.
    if (!lastTransition || lastTransition.to !== activity) return;

    const previousState = lastTransition.from;
    const previousDisposition = dispositionOf(previousState);
    const newDisposition = dispositionOf(activity);
    // Equal dispositions mean a permission<->idle crossing within the same
    // 'idle' interval (do not reopen it) - the only case two DIFFERENT
    // ActivityStates share a disposition, since 'active' has just the one
    // member ('thinking'). commitTransition only fires when activity
    // actually changed, so previousState !== activity is guaranteed here.
    if (previousDisposition === newDisposition) return;

    const store = this.options.getStore(projectId);
    // A flip always closes whichever interval was open (a no-op if this is
    // the session's first real transition - nothing was open yet) and opens
    // the next, so the table never has gaps once the first flip lands.
    store.closeOpenInterval(sessionId, lastTransition.ts, lastTransition.trigger);
    store.openInterval(
      {
        sessionId,
        taskId: this.options.sessionManager.getSessionTaskId(sessionId) ?? null,
        disposition: newDisposition,
        state: activity,
        previousState,
        enterTrigger: lastTransition.trigger,
        startedMs: lastTransition.ts,
      },
      this.now(),
    );
  }

  private readonly onExit = (sessionId: string): void => {
    // See handleActivity: a throw here would abort the session-lifecycle
    // bookkeeping that runs after this listener on the same emit.
    try {
      this.handleExit(sessionId);
    } catch (error) {
      console.error('[ACTIVITY-INTERVAL] recorder exit handler failed', error);
    }
  };

  private handleExit(sessionId: string): void {
    if (this.disposed) return;
    // For a natural PTY exit and for killByTaskId, the registry still holds
    // the exited session at emit time (see SessionLifecycleBoardFeed's onExit
    // for the same observation), so project/transient resolution below
    // resolves. KNOWN GAP: SessionManager.remove()/removeByTaskId() call
    // registry.delete() synchronously while the PTY dies asynchronously, so
    // the later 'exit' emit finds no session and this returns early, leaving
    // that session's interval permanently open. Consumers must filter
    // `ended_ms IS NOT NULL` for totals. Closing that gap needs the recorder
    // to cache projectId per open interval rather than re-resolving it here.
    const session = this.options.sessionManager.getSession(sessionId);
    if (!session || session.transient) return;
    const projectId = this.options.sessionManager.getSessionProjectId(sessionId);
    if (!projectId) return;
    // Unconditional and safe even when no interval is open: closeOpenInterval
    // is a WHERE-guarded UPDATE that no-ops when it matches zero rows.
    this.options.getStore(projectId).closeOpenInterval(sessionId, Date.now(), 'session-exit');
  }

  start(): void {
    if (this.started || this.disposed) return;
    this.started = true;
    this.options.sessionManager.on('activity', this.onActivity);
    this.options.sessionManager.on('exit', this.onExit);
  }

  /** Synchronous, per synchronous-shutdown.md: detaches listeners with no async work. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.started) {
      this.options.sessionManager.off('activity', this.onActivity);
      this.options.sessionManager.off('exit', this.onExit);
    }
  }
}
