import type { ActivityReason, ActivityState, Session } from '../../shared/types';
import { dispositionOf } from '../../shared/activity-state';
import type { SessionManager } from '../pty/session-manager';
import { ActivityIntervalStore, type OpenIntervalInput } from './activity-interval-store';

export interface ActivityIntervalRecorderOptions {
  sessionManager: Pick<
    SessionManager,
    'on' | 'off' | 'getSession' | 'getSessionProjectId' | 'getSessionTaskId' | 'getActivityStatsSnapshot' | 'getActivityReason'
  >;
  /** Resolve the interval store for a project. Injectable for tests; production wiring wraps
   *  `getProjectDb(projectId)`. `getProjectDb` caches connections per project, so calling this
   *  on every event is cheap - it is not opening a new connection each time. */
  getStore: (projectId: string) => ActivityIntervalStore;
  /** UTC ISO 8601 clock for `recorded_at`. Injectable for tests. */
  now?: () => string;
  /** Epoch-ms clock for an interval the recorder opens itself (a seed, a split). Injectable for tests. */
  nowMs?: () => number;
}

/** The enter trigger of an interval a seeded `thinking` start opened. */
export const SEED_TRIGGER = 'seed';

/** Is this reason kind background work the agent left, rather than its turn's own? */
function isBackgroundReason(reasonKind: string | null): boolean {
  return reasonKind === 'background-shell';
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
 * A thinking span also splits where its reason crosses into or out of
 * `background-shell` (the `activity-reason` event): the agent's turn ended
 * and only work it left running holds the session. Each row carries the
 * reason kind it opened on (`reason_kind`), so what kept a session active
 * survives `events.jsonl`.
 *
 * Modelled on `PushNotifier` (`src/main/mobile-bridge/push/push-notifier.ts`):
 * a single listener on `sessionManager`'s `activity` and `exit` events. Its
 * one per-session map, `openThinkingSide`, is for the background split.
 * Unlike PushNotifier, it keeps no `lastActivityState` map: it reads provenance
 * (`from` and `trigger`) straight off the engine's own transition ring
 * (`getActivityStatsSnapshot(sessionId).recentTransitions`), which
 * `ActivityEngine.commitTransition` appends to immediately before firing the
 * `activity` event this recorder listens on.
 */
export class ActivityIntervalRecorder {
  private readonly options: ActivityIntervalRecorderOptions;
  private readonly now: () => string;
  private readonly nowMs: () => number;
  /**
   * For each session whose open interval is a thinking one this run opened:
   * whether it is background work (true) or the turn's own (false). A row
   * opened before a restart has no entry, so it is never split.
   */
  private readonly openThinkingSide = new Map<string, boolean>();
  private started = false;
  private disposed = false;

  constructor(options: ActivityIntervalRecorderOptions) {
    this.options = options;
    this.now = options.now ?? (() => new Date().toISOString());
    this.nowMs = options.nowMs ?? Date.now;
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
    // therefore means this emission is a seed (a spawn, a resume, a Command
    // Terminal, orphan recovery), not a real transition.
    if (!lastTransition || lastTransition.to !== activity) {
      this.recordSeed(sessionId, projectId, activity);
      return;
    }

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
    this.openRow(store, sessionId, {
      disposition: newDisposition,
      state: activity,
      previousState,
      enterTrigger: lastTransition.trigger,
      startedMs: lastTransition.ts,
      reasonKind: lastTransition.reasonKind,
    });
  }

  /** Open the session's next interval, and note which side of the background boundary it is on. */
  private openRow(
    store: ActivityIntervalStore,
    sessionId: string,
    fields: Omit<OpenIntervalInput, 'sessionId' | 'taskId'>,
  ): void {
    store.openInterval(
      { sessionId, taskId: this.options.sessionManager.getSessionTaskId(sessionId) ?? null, ...fields },
      this.now(),
    );
    this.noteOpenReason(sessionId, fields.state, fields.reasonKind);
  }

  /**
   * A session seeded `thinking`: a spawn whose prompt rode the command line
   * is already working on it, with no transition to record until its first
   * turn ends. Skipping that window wrote nothing for a seeded session's whole
   * first turn: 38 of 709 minutes across one run's Code Review sessions, and
   * no row for one review's first 6h35m. Opened only when the session has no
   * interval open, so a seed emitted again (`adoptSession`) opens nothing.
   * A seed to idle (a resume, a Command Terminal) still opens nothing: the
   * session waits on the user from its first moment, and its first prompt
   * is the first transition.
   */
  private recordSeed(sessionId: string, projectId: string, activity: ActivityState): void {
    if (dispositionOf(activity) !== 'active') return;
    const store = this.options.getStore(projectId);
    if (store.hasOpenInterval(sessionId)) return;
    this.openRow(store, sessionId, {
      disposition: 'active',
      state: activity,
      previousState: 'idle',
      enterTrigger: SEED_TRIGGER,
      startedMs: this.nowMs(),
      reasonKind: this.options.sessionManager.getActivityReason(sessionId)?.kind ?? null,
    });
  }

  /**
   * Which side of the background boundary the session's open interval is on,
   * for a thinking interval; a non-thinking one has no side.
   */
  private noteOpenReason(sessionId: string, activity: ActivityState, reasonKind: string | null): void {
    // activity-state-ok: granular, only a thinking span has turn work or background work to tell apart.
    if (activity === 'thinking') this.openThinkingSide.set(sessionId, isBackgroundReason(reasonKind));
    else this.openThinkingSide.delete(sessionId);
  }

  private readonly onReason = (sessionId: string, activity: ActivityState, reason: ActivityReason): void => {
    try {
      this.handleReason(sessionId, activity, reason);
    } catch (error) {
      console.error('[ACTIVITY-INTERVAL] recorder reason handler failed', error);
    }
  };

  /**
   * A thinking span whose reason crossed into or out of `background-shell`:
   * the agent's turn ended and only work it left running holds the session, or
   * that work ended and a turn holds it again. Closed and reopened there, so
   * "what kept this active" is a row of its own. Only that boundary splits:
   * the reason moves between a tool and the turn itself on every tool call.
   */
  private handleReason(sessionId: string, activity: ActivityState, reason: ActivityReason): void {
    if (this.disposed) return;
    // activity-state-ok: granular, the split is within a thinking span.
    if (activity !== 'thinking') return;
    const openSide = this.openThinkingSide.get(sessionId);
    const side = isBackgroundReason(reason.kind);
    if (openSide === undefined || openSide === side) return;
    const session = this.options.sessionManager.getSession(sessionId);
    if (!session || session.transient) return;
    const projectId = this.options.sessionManager.getSessionProjectId(sessionId);
    if (!projectId) return;
    const store = this.options.getStore(projectId);
    const splitAtMs = this.nowMs();
    const trigger = side ? 'reason:background-shell' : 'reason:turn-work';
    store.closeOpenInterval(sessionId, splitAtMs, trigger);
    this.openRow(store, sessionId, {
      disposition: 'active',
      state: activity,
      previousState: activity,
      enterTrigger: trigger,
      startedMs: splitAtMs,
      reasonKind: reason.kind,
    });
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
    this.openThinkingSide.delete(sessionId);
    // For a natural PTY exit and for killByTaskId, the registry still holds
    // the exited session at emit time (see SessionLifecycleBoardFeed's onExit
    // for the same observation), so project/transient resolution below
    // resolves. A direct SessionManager.remove()/removeByTaskId() deletes the
    // row synchronously while the PTY dies asynchronously, so the later 'exit'
    // finds no session here; that case is closed by handleRemoved below, which
    // resolves the project from the removal payload instead of the registry.
    const session = this.options.sessionManager.getSession(sessionId);
    if (!session || session.transient) return;
    const projectId = this.options.sessionManager.getSessionProjectId(sessionId);
    if (!projectId) return;
    // Unconditional and safe even when no interval is open: closeOpenInterval
    // is a WHERE-guarded UPDATE that no-ops when it matches zero rows.
    this.options.getStore(projectId).closeOpenInterval(sessionId, Date.now(), 'session-exit');
  }

  private readonly onRemoved = (sessionId: string, session: Session): void => {
    // Same isolation as the other two listeners: a ledger write must never
    // escape into the emit stack the removal push rides on.
    try {
      this.handleRemoved(sessionId, session);
    } catch (error) {
      console.error('[ACTIVITY-INTERVAL] recorder removal handler failed', error);
    }
  };

  private handleRemoved(sessionId: string, session: Session): void {
    if (this.disposed) return;
    this.openThinkingSide.delete(sessionId);
    if (session.transient || !session.projectId) return;
    // The removal is the last edge a torn-down session has, and it carries
    // the row's last snapshot, so this closes the interval that used to stay
    // open forever after a To Do reset, a task delete, or a session reset
    // (the KNOWN GAP this recorder documented until the removal push existed).
    // Idempotent with handleExit: the UPDATE matches zero rows the second time.
    this.options.getStore(session.projectId).closeOpenInterval(sessionId, Date.now(), 'session-removed');
  }

  start(): void {
    if (this.started || this.disposed) return;
    this.started = true;
    this.options.sessionManager.on('activity', this.onActivity);
    this.options.sessionManager.on('activity-reason', this.onReason);
    this.options.sessionManager.on('exit', this.onExit);
    this.options.sessionManager.on('session-removed', this.onRemoved);
  }

  /** Synchronous, per synchronous-shutdown.md: detaches listeners with no async work. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.started) {
      this.options.sessionManager.off('activity', this.onActivity);
      this.options.sessionManager.off('activity-reason', this.onReason);
      this.options.sessionManager.off('exit', this.onExit);
      this.options.sessionManager.off('session-removed', this.onRemoved);
    }
  }
}
