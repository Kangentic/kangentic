import { EventType, AgentTool, IdleReason, PromptReason, Activity } from '../../shared/types';
import type { SessionUsage, SessionUsagePatch, ActivityState, ActivityReason, SessionEvent, AgentParser, PerToolStat } from '../../shared/types';
import { PtyActivityTracker } from './pty-activity-tracker';
import {
  ActivityEngine,
  ActivitySnapshotWriter,
  type ActivityEngineOptions,
  type ActivityStatsSnapshot,
  type BackgroundShellServiceOutcome,
  type TurnStartCause,
} from './engine';
import { BgShellWatcher } from './background-shell/watcher';
import {
  createProcessTreeProbe,
  type ProcessTreeProbe,
} from './background-shell/process-tree';
import { looksLikeShellId } from './background-shell/looks-like-shell-id';
import { UsageAccumulator } from './usage-accumulator';
import { PRCommandDetector } from './pr-command-detector';
import { PushCommandDetector } from './push-command-detector';
import { PlanModeTrail } from './plan-mode-trail';
import { PlanApprovalGate } from './plan-approval-gate';
import { UserInterruptCoordinator } from './user-interrupt-coordinator';
import { OpenWorkLedger, type OpenWork } from './open-work-ledger';
import { ConversationSwitchGate } from './conversation-switch-gate';
import { sessionStartOfLine } from '../agent/shared/session-start-hook';

const MAX_EVENTS_PER_SESSION = 500;

/**
 * Poll cadence for the manually-rejected-permission-prompt check (task
 * #640), matching the bg-shell watcher's 2s cycle.
 */
const PERMISSION_REJECTION_POLL_MS = 2_000;

/**
 * When a background session's SessionStart is checked for a move
 * (`confirmBackgroundMove`): at once, then four more times over 30 s. On a live
 * task the CLI's record of the move landed about 2 s BEFORE the hook, so the
 * first check normally answers. The later ones cover a record written after its
 * hook: a move never proven holds the conversation's status writes, which
 * freezes the context bar and the resume id until the next Resume.
 */
const BACKGROUND_MOVE_CHECK_DELAYS_MS = [0, 1_500, 4_000, 10_000, 30_000];

/**
 * Safely extract the `hookContext` string from a raw JSONL line written
 * by event-bridge.js. Returns null for any parse failure or unexpected
 * shape.
 */
function extractHookContext(line: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const hookContext = (parsed as { hookContext?: unknown }).hookContext;
  return typeof hookContext === 'string' ? hookContext : null;
}

interface SessionTelemetryCallbacks {
  onUsageChange(sessionId: string, usage: SessionUsage): void;
  onActivityChange(sessionId: string, activity: ActivityState, reason: ActivityReason): void;
  /**
   * The reason changed kind without the activity changing. Optional, because
   * only the production wiring forwards it to the renderer; every test harness
   * and every consumer that cares about state transitions ignores it.
   */
  onReasonChange?(sessionId: string, activity: ActivityState, reason: ActivityReason): void;
  /**
   * A turn the agent itself ended has settled (see
   * `ActivityEngineCallbacks.onTurnEnded`). Optional: only the production
   * wiring consumes it.
   */
  onTurnEnded?(sessionId: string, turnStartedAt: number | null, workSerial: number): void;
  /**
   * The engine stamped a turn's start (see
   * `ActivityEngineCallbacks.onTurnStarted`). Optional: only the production
   * wiring consumes it.
   */
  onTurnStarted?(sessionId: string, turnStartedAt: number, cause: TurnStartCause): void;
  onEvent(sessionId: string, event: SessionEvent): void;
  onIdleTimeout(sessionId: string): void;
  onPlanExit(sessionId: string): void;
  onPRCandidate(sessionId: string): void;
  /**
   * Called when the agent's own `git push` finished, with the branch the push
   * named as its destination. The listener records it as the task's
   * `pushed_branch`, the PR ladder's per-task anchor for a task with no
   * worktree. Optional: only the production wiring cares.
   */
  onBranchPushed?(sessionId: string, branch: string): void;
  /** Called when the agent reports its own session_id (from status.json). */
  onAgentSessionId?(sessionId: string, agentReportedId: string): void;
  /**
   * A SessionStart named the CLI's own background session: did the session's
   * conversation `fromAgentSessionId` move there, rather than a copy start
   * beside it (`statusFile.confirmsBackgroundMove`, which this answers with the
   * session's cwd, place and reported transcript)? Optional: unwired, such a
   * hook is a move like any other.
   */
  confirmsBackgroundMove?(sessionId: string, fromAgentSessionId: string, toAgentSessionId: string): Promise<boolean>;
  /**
   * The idle sweep asks for a session it timed out to be suspended, just
   * before `onIdleTimeout`. The session manager suspends only a workflow's own
   * agent here, which has no task record; a task's agent is paused by the
   * idle-timeout listener, which records the pause first.
   */
  requestSuspend(sessionId: string): void;
  isSessionRunning(sessionId: string): boolean;
  /**
   * The idle sweep leaves this session alone: no suspend, no idle-timeout
   * report. A Command Terminal is exempt, because a suspend ends it and its
   * conversation with it. Optional: a missing answer means the sweep applies.
   */
  isIdleTimeoutExempt?(sessionId: string): boolean;
  /**
   * Returns the OS PID of the agent CLI for the session, used by the
   * bg-shell watcher to enumerate descendant processes. Returns
   * undefined for unknown / not-yet-spawned sessions.
   */
  getSessionRootPid?(sessionId: string): number | undefined;
  /**
   * Resolve the on-disk output file for a NAMED background shell, or null
   * when the agent has no such file or it cannot be located. The bg-shell
   * watcher stats it each cycle for liveness (file growth keeps a PID-less
   * named shell from being reclaimed at the 5-min cap). Agent-specific path
   * knowledge stays behind this generic callback.
   */
  resolveBackgroundShellOutputFile?(sessionId: string, shellId: string): string | null;
  /**
   * Report which of `shellIds` have a terminal notification in the agent's
   * durable session transcript - definitive proof of completion for a NAMED
   * shell whose OS PID was never captured (task #386). The bg-shell watcher
   * calls this every cycle a PID-less named shell exists. Agent-specific
   * transcript knowledge stays behind this generic callback.
   */
  reportTerminatedBackgroundShells?(sessionId: string, shellIds: string[]): string[];
  /**
   * Report which of `toolIds` were manually REJECTED, per a terminal
   * marker in the agent's durable session transcript at or after
   * `sinceMs`. An approval is out of scope here: it already clears
   * through the normal ToolEnd hook. Called every poll tick for each
   * session awaiting a permission decision (task #640) - a denial fires
   * no hook of any kind, so this transcript check is the only way the
   * flag ever clears without a human typing into the session.
   * Agent-specific transcript knowledge stays behind this generic callback.
   */
  reportRejectedPermissionTools?(sessionId: string, toolIds: string[], sinceMs: number): string[];
  /**
   * Whether the session's plan approval decision approves its next plan, so
   * the plan approval gate holds a plan-exit permission idle for the
   * approver's marker. Optional, and false when unwired: nothing is held.
   */
  approvesPlanAutomatically?(sessionId: string): boolean;
  /**
   * Whether the session's agent's plan tool approval hook may answer a prompt
   * for this tool (`AgentParser.mayApprovePlanTool`), so the gate holds that
   * tool's permission idle for the hook's marker. Asked only while
   * `approvesPlanAutomatically` holds. Optional, and false when unwired.
   */
  mayApprovePlanTool?(sessionId: string, toolName: string): boolean;
  /**
   * May the bg-shell watcher's agent-absence sweep judge this session? See
   * `SessionManager.isAgentAbsenceCandidate` for the arms. Optional, and it
   * defaults to FALSE below: unwired, the sweep never fires at all.
   */
  isAgentAbsenceCandidate?(sessionId: string): boolean;
  /**
   * Retire a session whose agent CLI exited while its shell PTY survived. See
   * `SessionManager.retireAgentlessSession`.
   */
  retireAgentlessSession?(sessionId: string): void;
}

/** How one batch of events entered (`ingestEvents`). */
export interface IngestEventsOptions {
  /**
   * False when the batch comes from a session history file that must not turn
   * the PTY tracker off (`sessionHistory.suppressesPtyFallback`). Default true.
   */
  suppressesPtyTracker?: boolean;
}

export interface SessionTelemetryOptions {
  /** Engine timing overrides (test-only typically). */
  activityEngineOptions?: ActivityEngineOptions;
  /**
   * Disable the bg-shell process-tree watcher. Defaults to false
   * (watcher ON). Tests that don't want OS process enumeration can set
   * this to true. Production users can opt out via env var
   * `KANGENTIC_BG_SHELL_WATCHER=0`.
   */
  disableBgShellWatcher?: boolean;
  /** Custom process-tree probe. Tests inject mocks. */
  processTreeProbe?: ProcessTreeProbe;
  /**
   * Directory for activity-engine debug snapshots, or a resolver
   * function returning the directory. When the value resolves to a
   * string, the engine writes the latest stats snapshot to
   * `<dir>/<sessionId>.json` on every state change. Used for
   * post-mortem diagnostics ("what was the engine doing 5 minutes
   * ago?") without needing the live overlay open.
   *
   * Function form lets callers tie the path to a runtime toggle
   * (e.g. `developer.activityDebugOverlay`); the resolver is invoked
   * before each write, so toggling on/off takes effect live without
   * reconstructing SessionTelemetry. Disabled (no writes) when
   * undefined or when the resolver returns undefined.
   */
  debugDumpDir?: string | (() => string | undefined);
}

/**
 * Per-session telemetry orchestrator. Owns the activity engine, the
 * bg-shell process-tree watcher, the PTY-pattern fallback tracker, the
 * usage / per-tool accumulator, and the PR-command detector. Routes
 * parsed events from every telemetry source (Claude hooks, Codex
 * session history, Gemini logs, raw PTY) into the right submodule and
 * forwards the resulting state changes to its callbacks.
 *
 * Single per-SessionManager instance. Lifecycle methods (initSession /
 * clearSessionTracking / removeSession / dispose) keep the submodules
 * in sync.
 *
 * Was originally `UsageTracker`, but its actual responsibility grew
 * well beyond usage. The token/cost work now lives in
 * `UsageAccumulator`; the PR sniffing in `PRCommandDetector`. What's
 * left here is wiring + idle-timeout + agent-session-id capture.
 */
export class SessionTelemetry {
  /** Per-session activity engine (predicate-based). */
  readonly activityEngine: ActivityEngine;
  /** Process-tree-based bg-shell natural-exit detector. Null when disabled. */
  readonly bgShellWatcher: BgShellWatcher | null;

  private readonly ptyTracker: PtyActivityTracker;
  private readonly usage = new UsageAccumulator();
  private readonly prCommandDetector = new PRCommandDetector();
  private readonly pushCommandDetector = new PushCommandDetector();
  private readonly planModeTrail = new PlanModeTrail();
  /** What each session still has open, from its hook events (`open-work-ledger.ts`). */
  private readonly openWork = new OpenWorkLedger();
  private readonly planApprovalGate: PlanApprovalGate;
  /**
   * Live snapshot writer. Recreated on demand when the resolver returns a
   * different path so toggle changes (e.g. `developer.activityDebugOverlay`)
   * take effect mid-session. Null when no path is currently configured.
   */
  private snapshotWriter: ActivitySnapshotWriter | null;
  private snapshotWriterPath: string | null = null;
  private readonly debugDumpDirResolver: (() => string | undefined) | null;
  private readonly userInterrupts: UserInterruptCoordinator;

  private readonly sessionParsers = new Map<string, AgentParser>();
  private readonly agentSessionIdChecked = new Set<string>();
  /**
   * Last agent session id reported through onAgentSessionId, per PTY session
   * (any channel seeds it, through `recordReportedId`; only the status-file
   * channel consults it). The streaming status file carries the CURRENT id on
   * every write, so comparing against the last reported value lets a
   * mid-session move (the agent continues under a new id, e.g. Claude /clear)
   * re-fire the capture while same-id churn (a status rewrite every ~10s)
   * stays quiet.
   */
  private readonly lastReportedAgentSessionIds = new Map<string, string>();
  /**
   * Whether a status write's new id is the conversation moving or another
   * process writing the same status file. Consulted only for an adapter that
   * declares `statusFile.parseSessionStart`; see `ConversationSwitchGate`.
   */
  private readonly conversationSwitches = new ConversationSwitchGate();
  /**
   * PTY sessions that have had a status write. The first one is a baseline:
   * before it, the cached usage is the spawn's model-only seed, and a resumed
   * conversation's first report carries its whole history's output against it.
   */
  private readonly statusWriteSeen = new Set<string>();
  private readonly eventCache = new Map<string, SessionEvent[]>();
  /**
   * Tool calls the session's track made in earlier runs (earlier session
   * records of the same task and isolated swimlane), added to the live count
   * when it is stamped onto the usage payload. Kept apart from the accumulator
   * so the per-run reads `captureSessionMetrics` persists stay per run. Set by
   * `SessionManager` at spawn and refreshed when the per-tool table is read.
   */
  private readonly earlierToolCallCounts = new Map<string, number>();
  private _idleTimeoutMinutes = 0;
  private idleTimeoutInterval: ReturnType<typeof setInterval> | null = null;
  /**
   * Sessions currently `permissionPending`, tracked via the engine's own
   * `onActivityChange` transitions (task #640). Drives the lazy start/stop of
   * `permissionRejectionPollInterval`, mirroring the bg-shell watcher's own
   * lazy-polling precedent: idle Kangentic (no session awaiting a decision)
   * costs zero timers. A flat always-running interval costs zero
   * filesystem calls but still one timer, and was tried first and
   * rejected: it broke the existing "watcher polling stops entirely when
   * the last session is cleared" `vi.getTimerCount()` invariant
   * (session-telemetry-wiring.test.ts).
   */
  private readonly permissionPendingSessions = new Set<string>();
  /** Poll for a manually-rejected permission prompt - see
   *  `pollRejectedPermissionPrompts`. Null while no session is pending. */
  private permissionRejectionPollInterval: ReturnType<typeof setInterval> | null = null;

  private readonly callbacks: SessionTelemetryCallbacks;

  constructor(
    callbacks: SessionTelemetryCallbacks,
    options: SessionTelemetryOptions = {},
  ) {
    this.callbacks = callbacks;
    this.planApprovalGate = new PlanApprovalGate({
      approvesPlans: (sessionId) => callbacks.approvesPlanAutomatically?.(sessionId) ?? false,
      mayApproveTool: (sessionId, toolName) => callbacks.mayApprovePlanTool?.(sessionId, toolName) ?? false,
      // A held idle the approver never answered: it reaches the pipeline late,
      // and the session shows as waiting on the user, as it is.
      release: (sessionId, event) => this.processAdmittedEvents(sessionId, [event]),
    });
    const activityEngineOptions = options.activityEngineOptions ?? {};
    // Two equivalent forms: a literal string path (legacy / test usage) or
    // a resolver function (production hookup, lets the path follow a
    // runtime toggle). Static strings are normalized into a resolver so
    // the writeDebugSnapshot path is uniform.
    if (typeof options.debugDumpDir === 'function') {
      this.debugDumpDirResolver = options.debugDumpDir;
      const initialPath = options.debugDumpDir();
      this.snapshotWriter = initialPath ? new ActivitySnapshotWriter(initialPath) : null;
      this.snapshotWriterPath = initialPath ?? null;
    } else if (typeof options.debugDumpDir === 'string') {
      this.debugDumpDirResolver = null;
      this.snapshotWriter = new ActivitySnapshotWriter(options.debugDumpDir);
      this.snapshotWriterPath = options.debugDumpDir;
    } else {
      this.debugDumpDirResolver = null;
      this.snapshotWriter = null;
    }

    this.activityEngine = new ActivityEngine({
      onActivityChange: (sessionId, activity, reason) => {
        this.callbacks.onActivityChange(sessionId, activity, reason);
        // Refresh the on-disk debug snapshot whenever activity state
        // changes. Counter-only events (non-transitions) also affect
        // the snapshot but go through onSyntheticEvent or are caught
        // by the next state change; this is a deliberate trade-off
        // to avoid writing on every counter increment.
        this.writeDebugSnapshot(sessionId);
        // Task #640: track entry/exit of the 'permission' state so the
        // rejection-poll interval can start/stop lazily (see
        // permissionPendingSessions' doc comment).
        if (activity === 'permission') {
          this.permissionPendingSessions.add(sessionId);
          this.ensurePermissionRejectionPollRunning();
        } else if (this.permissionPendingSessions.delete(sessionId)) {
          this.stopPermissionRejectionPollIfIdle();
        }
      },
      onReasonChange: (sessionId, activity, reason) => {
        // Reason moved, activity did not. Forwarded so the renderer's stored
        // reason stays current through a long turn, and deliberately NOT given
        // the rest of the onActivityChange body above: the debug snapshot is a
        // synchronous disk write, and the permission bookkeeping is about
        // entering and leaving the permission STATE, neither of which a
        // reason-only refresh has anything to say about.
        this.callbacks.onReasonChange?.(sessionId, activity, reason);
      },
      onSyntheticEvent: (sessionId, event) => {
        // Push the engine-originated synthetic event (e.g. watchdog-driven
        // Idle/Timeout) into the activity log so the renderer can render
        // a "why did this go idle?" entry. Fired BEFORE the matching
        // onActivityChange so the log entry appears before the state
        // change in any listener that observes both streams.
        this.pushEvent(sessionId, event);
      },
      onTurnEnded: (sessionId, turnStartedAt, workSerial) => this.callbacks.onTurnEnded?.(sessionId, turnStartedAt, workSerial),
      onTurnStarted: (sessionId, turnStartedAt, cause) => this.callbacks.onTurnStarted?.(sessionId, turnStartedAt, cause),
    }, activityEngineOptions);

    this.ptyTracker = new PtyActivityTracker({
      onThinking: (sessionId) => this.handlePtyThinking(sessionId),
      onIdle: (sessionId, detail) => this.handlePtyIdle(sessionId, detail),
      getActivity: (sessionId) => this.activityEngine.getState(sessionId)?.activity,
      isSessionRunning: (sessionId) => callbacks.isSessionRunning(sessionId),
    });

    const envDisabled = process.env.KANGENTIC_BG_SHELL_WATCHER === '0';
    if (options.disableBgShellWatcher === true || envDisabled || !callbacks.getSessionRootPid) {
      this.bgShellWatcher = null;
    } else {
      this.bgShellWatcher = new BgShellWatcher({
        probe: options.processTreeProbe ?? createProcessTreeProbe(),
        callbacks: {
          getRootPid: (sessionId) => callbacks.getSessionRootPid?.(sessionId),
          // Both getters deliberately include `exemptBackgroundShellIds`. An
          // exempt shell is excluded from the PREDICATE, not from tracking:
          // its process is real and alive, so the watcher must keep capturing
          // its PID, confirming its liveness, and draining it on exit. Leaving
          // it out here would shrink `expected = preExistingHelpers + tracked`
          // below the observed process count, take the watcher's surplus
          // branch, and permanently fold a real shell into the helper baseline
          // - corrupting deficit detection for the rest of the session.
          getActiveShellCount: (sessionId) => {
            const state = this.activityEngine.getState(sessionId);
            if (!state) return 0;
            return state.activeBackgroundShellIds.size
              + state.exemptBackgroundShellIds.size
              + state.anonymousBackgroundShellCount;
          },
          getNamedShellIds: (sessionId) => {
            const state = this.activityEngine.getState(sessionId);
            if (!state) return [];
            return [...state.activeBackgroundShellIds, ...state.exemptBackgroundShellIds];
          },
          getPendingToolCount: (sessionId) => {
            const state = this.activityEngine.getState(sessionId);
            return state?.pendingToolCount ?? 0;
          },
          onNaturalExit: (sessionId, exitedCount) => {
            for (let i = 0; i < exitedCount; i++) {
              const syntheticEvent: SessionEvent = {
                ts: Date.now(),
                type: EventType.BackgroundShellEnd,
                detail: IdleReason.NaturalExit,
              };
              this.pushEvent(sessionId, syntheticEvent);
              this.activityEngine.markBackgroundShellEnded(sessionId);
            }
          },
          onShellPidExited: (sessionId, shellId) => {
            const syntheticEvent: SessionEvent = {
              ts: Date.now(),
              type: EventType.BackgroundShellEnd,
              detail: shellId,
            };
            this.pushEvent(sessionId, syntheticEvent);
            this.activityEngine.markBackgroundShellEnded(sessionId, shellId);
            // The shell's own process exited: a real end.
            this.openWork.closeShells(sessionId, [shellId]);
          },
          onNamedShellLikelyExited: (sessionId, shellId) => {
            // Watcher reclaimed a PID-less named bg shell whose output file has
            // been quiescent past the threshold while the OS process tree shows
            // a persistent deficit (its `background_shell_end` hook was dropped).
            // Drain it by id, same as a Tier A PID exit - the engine's named
            // drain is identity-aware.
            //
            // The open-work ledger keeps it: a gate that prints nothing for
            // minutes while other worktrees churn the process count reads the
            // same way, and its real end (the transcript's notice) closes it.
            const syntheticEvent: SessionEvent = {
              ts: Date.now(),
              type: EventType.BackgroundShellEnd,
              detail: shellId,
            };
            this.pushEvent(sessionId, syntheticEvent);
            this.activityEngine.markBackgroundShellEnded(sessionId, shellId);
          },
          onRootProcessDied: (sessionId) => {
            this.activityEngine.forceIdle(sessionId);
          },
          // Default FALSE, so a SessionTelemetry built without this wiring (every
          // existing test construction) leaves the sweep permanently inert rather
          // than judging sessions it cannot describe.
          isAgentAbsenceCandidate: (sessionId) =>
            callbacks.isAgentAbsenceCandidate?.(sessionId) ?? false,
          onAgentProcessAbsent: (sessionId) => {
            // No synthetic event and no activity-state change: the session is
            // being retired outright, and the kill's own onExit emits the
            // session_end. Unlike onRootProcessDied, forcing idle here would
            // just describe a session that is about to stop existing.
            callbacks.retireAgentlessSession?.(sessionId);
          },
          onShellsObservedAlive: (sessionId) => {
            // Watcher confirmed the tracked bg shells are still alive in the
            // OS tree. Refresh the bg-shell sole-holder grace anchor so a
            // genuinely-running long bg shell is not reclaimed at 30s. No
            // synthetic event: this is liveness confirmation, not a state
            // change (mirrors markThinkingSignal).
            this.activityEngine.markBackgroundShellsAlive(sessionId);
          },
          resolveShellOutputFile: (sessionId, shellId) =>
            callbacks.resolveBackgroundShellOutputFile?.(sessionId, shellId) ?? null,
          reportTerminatedShellsFromTranscript: (sessionId, shellIds) =>
            callbacks.reportTerminatedBackgroundShells?.(sessionId, shellIds) ?? [],
          onNamedShellTerminated: (sessionId, shellId) => {
            // Watcher confirmed the shell's terminal notification directly in
            // the durable transcript - definitive proof of completion,
            // independent of output/count state. Drain it by id, same as a
            // Tier A PID exit.
            const syntheticEvent: SessionEvent = {
              ts: Date.now(),
              type: EventType.BackgroundShellEnd,
              detail: shellId,
            };
            this.pushEvent(sessionId, syntheticEvent);
            this.activityEngine.markBackgroundShellEnded(sessionId, shellId, { source: 'transcript' });
            this.openWork.closeShells(sessionId, [shellId]);
          },
        },
      });
    }

    this.userInterrupts = new UserInterruptCoordinator({
      engine: this.activityEngine,
      pushEvent: (sessionId, event) => this.pushEvent(sessionId, event),
    });
  }

  // ==== Bg-shell watcher hooks (called from session-manager / spawn flow) ====

  notifySessionSpawned(sessionId: string): void {
    if (!this.bgShellWatcher) return;
    this.bgShellWatcher.registerSession(sessionId);
  }

  notifySessionEnded(sessionId: string): void {
    if (!this.bgShellWatcher) return;
    this.bgShellWatcher.unregisterSession(sessionId);
  }

  /** Ask the agent-absence sweep to judge this session soon (see BgShellWatcher.requestAgentAbsenceCheck). */
  requestAgentAbsenceCheck(sessionId: string): void {
    this.bgShellWatcher?.requestAgentAbsenceCheck(sessionId);
  }

  /** Withdraw that request (see BgShellWatcher.cancelAgentAbsenceCheck). */
  cancelAgentAbsenceCheck(sessionId: string): void {
    this.bgShellWatcher?.cancelAgentAbsenceCheck(sessionId);
  }

  /**
   * Does the agent-absence sweep run at all? It lives in the bg-shell watcher,
   * so it is off whenever the watcher is, and a session it cannot judge needs
   * another way to notice its agent exited (see SessionManager's end settle).
   */
  get hasAgentAbsenceSweep(): boolean {
    return this.bgShellWatcher !== null;
  }

  // ==== Idle-timeout sweep ====

  get idleTimeoutMinutes(): number {
    return this._idleTimeoutMinutes;
  }

  setIdleTimeout(minutes: number): void {
    this._idleTimeoutMinutes = minutes;
    if (this.idleTimeoutInterval) {
      clearInterval(this.idleTimeoutInterval);
      this.idleTimeoutInterval = null;
    }
    if (minutes > 0) {
      this.idleTimeoutInterval = setInterval(() => this.checkIdleTimeouts(), 60_000);
      this.idleTimeoutInterval.unref();
    }
  }

  private checkIdleTimeouts(): void {
    if (this._idleTimeoutMinutes <= 0) return;
    const timeoutMs = this._idleTimeoutMinutes * 60_000;
    const now = Date.now();
    this.activityEngine.forEachState((sessionId, state) => {
      if (state.activity !== 'idle') return;
      if (!this.callbacks.isSessionRunning(sessionId)) return;
      // Skipped before either callback: an idle-timeout report alone would
      // reach the renderer and mark the session suspended.
      if (this.callbacks.isIdleTimeoutExempt?.(sessionId)) return;
      const idleStart = state.idleTimestamp;
      if (idleStart && (now - idleStart) > timeoutMs) {
        this.callbacks.requestSuspend(sessionId);
        this.callbacks.onIdleTimeout(sessionId);
      }
    });
  }

  // ==== Permission-rejection poll (task #640) ====

  /** Start the poll interval if it isn't already running. Called whenever a
   *  session enters `permission` - the interval must be armed before the
   *  FIRST tick can observe it, not just while one is already pending. */
  private ensurePermissionRejectionPollRunning(): void {
    if (this.permissionRejectionPollInterval) return;
    this.permissionRejectionPollInterval = setInterval(
      () => this.pollRejectedPermissionPrompts(),
      PERMISSION_REJECTION_POLL_MS,
    );
    this.permissionRejectionPollInterval.unref();
  }

  /** Stop the poll interval once no session is awaiting a decision - mirrors
   *  the bg-shell watcher's own "stop polling when the last session clears"
   *  behavior (see `permissionPendingSessions`' doc comment). */
  private stopPermissionRejectionPollIfIdle(): void {
    if (this.permissionPendingSessions.size > 0) return;
    if (!this.permissionRejectionPollInterval) return;
    clearInterval(this.permissionRejectionPollInterval);
    this.permissionRejectionPollInterval = null;
  }

  /**
   * Check every session currently `permissionPending` for a manual denial
   * recorded in its durable transcript, and clear the flag on a match.
   *
   * A denial fires NO hook event of any kind (see
   * `permission-rejection-transcript.ts` and
   * `ActivityEngine.markPermissionRejected` for the full rationale), so
   * without this poll the flag sticks forever once nobody types into the
   * session again - the mobile-answer-then-put-the-phone-down case that
   * surfaced task #640. A null `permissionAwaitedToolId` (the pending stack
   * was empty at prompt time - no correlation id to check) is left exactly
   * as it behaves today rather than guessing from a looser match, which
   * parallel-subagent tool churn could trip (the same reason
   * `updatePermissionFlag`'s awaited-tool clear requires an exact id).
   */
  private pollRejectedPermissionPrompts(): void {
    if (!this.callbacks.reportRejectedPermissionTools) return;
    // Snapshot first: markPermissionRejected below can synchronously mutate
    // permissionPendingSessions (via the onActivityChange it triggers), and
    // iterating a Set while deleting from it mid-iteration is exactly the
    // kind of thing not worth relying on here.
    for (const sessionId of Array.from(this.permissionPendingSessions)) {
      const state = this.activityEngine.getState(sessionId);
      if (!state?.permissionPending) continue;
      const toolId = state.permissionAwaitedToolId;
      if (toolId === null) continue;
      if (!this.callbacks.isSessionRunning(sessionId)) continue;
      const sinceMs = state.needsUserSince ?? 0;
      const rejectedIds = this.callbacks.reportRejectedPermissionTools?.(sessionId, [toolId], sinceMs) ?? [];
      if (rejectedIds.includes(toolId)) {
        this.activityEngine.markPermissionRejected(sessionId, toolId);
        // A denied call never runs, so its end never comes.
        this.openWork.closeToolCallById(sessionId, toolId);
      }
    }
  }

  // ==== Status-update ingest (Claude statusline) ====

  /**
   * Rich status-update ingestion for agents whose telemetry comes from
   * a streaming status file (Claude's statusline). Performs agent session
   * ID capture (change-sensitive, see below), runs heartbeat recovery
   * (tokens increased while idle → force thinking), resets the
   * stale-thinking timer, and replaces the cached usage. Called by
   * `StatusFileReader`.
   */
  processStatusUpdate(sessionId: string, usage: SessionUsage): void {
    // Agent session id capture, status-file channel. Unlike the strictly
    // one-shot PTY-output/hook channels (notifyAgentSessionId /
    // captureHookSessionIds), this channel is CHANGE-SENSITIVE: the status
    // file is authoritative and continuous, and a moved CLI session (a new
    // conversation under a new id, e.g. Claude /clear) re-reports its id
    // here. Firing again on a changed id keeps sessions.agent_session_id
    // resumable after the move; comparing against the last reported value
    // keeps same-id status churn quiet. Capturing here also closes the
    // one-shot channels (the Set), so a later PTY scrollback echo can never
    // override a status-reported id.
    //
    // The file can have more than one writer (every process started with the
    // session's --settings runs its statusLine into it), so for an adapter
    // that reads its SessionStart hooks a CHANGED id is adopted only once a
    // hook that moves the conversation named it (`noteSessionStartHooks`). A
    // write from any other writer stops here, before its usage reaches the
    // cache: an empty sibling's zeros would blank the context bar and reset
    // the heartbeat baseline.
    let conversationSwitched = false;
    if (this.callbacks.onAgentSessionId && usage.sessionId && typeof usage.sessionId === 'string') {
      const previouslyReportedId = this.lastReportedAgentSessionIds.get(sessionId);
      if (previouslyReportedId !== usage.sessionId) {
        if (
          previouslyReportedId !== undefined
          && this.readsSessionStartHooks(sessionId)
          && this.conversationSwitches.admit(sessionId, usage.sessionId, usage) === 'hold'
        ) {
          return;
        }
        conversationSwitched = previouslyReportedId !== undefined;
        this.recordReportedId(sessionId, usage.sessionId);
        this.agentSessionIdChecked.add(sessionId);
        this.callbacks.onAgentSessionId(sessionId, usage.sessionId);
      }
    } else if (this.callbacks.onAgentSessionId && !this.agentSessionIdChecked.has(sessionId)) {
      // Status write without a session id: keep the legacy "checked on first
      // status" semantics (gates the SessionIdManager diagnostic timer and
      // output scanning) WITHOUT consuming the capture, so a later id-bearing
      // status write still lands.
      this.agentSessionIdChecked.add(sessionId);
    }

    // A write that reports another conversation than the last one (a `/resume`
    // or `/clear` inside the terminal), or the session's first write (whose
    // cached usage is only the spawn's seed, while a resumed conversation
    // reports its whole history), compares two different conversations'
    // totals. It sets the baseline instead: growth against it is no proof of
    // work. Counting it as work held a resumed or switched terminal "working"
    // for the heartbeat's 30 s.
    const firstStatusWrite = !this.statusWriteSeen.has(sessionId);
    this.statusWriteSeen.add(sessionId);
    const previousUsage = firstStatusWrite || conversationSwitched ? undefined : this.usage.getSessionUsage(sessionId);

    // Stamp the authoritative cumulative tool-call count onto the payload.
    // It lives in the accumulator and survives the bounded event cache, so the
    // renderer cannot derive it from `sessionEvents`. Stamping before the cache
    // write means snapshot reads (getUsageCache) carry it too.
    this.stampToolCallCount(sessionId, usage);
    this.usage.replaceSessionUsage(sessionId, usage);
    this.callbacks.onUsageChange(sessionId, usage);
    // A free usage reset in this report brought sibling sessions' cached rate
    // limits up with it. Push them too, so a renderer that filters out this
    // session (another project) still sees the reset through its own sessions.
    this.reemitBackfilled(this.usage.takeSessionsCaughtUpToReset());

    // status.json is authoritative: teach the accumulator this model's window,
    // and re-emit any sibling background session it back-fills (an idle card of
    // the same model, whose own statusLine never painted, that was waiting to
    // learn the window). See UsageAccumulator.recordKnownWindow.
    this.reemitBackfilled(
      this.usage.recordKnownWindow(usage.model.id, usage.contextWindow.contextWindowSize),
    );

    const state = this.activityEngine.getOrCreateState(sessionId);

    // Keep a genuinely-thinking session warm for the stale-thinking watchdog,
    // but only on PROOF OF WORK: OUTPUT tokens grew since the last status write.
    // Two conditions must both hold, and each closes a distinct false-active pin:
    //   - NOT once the agent reported waiting-for-input (`idleHintPending`).
    //     After an idle_hint, status.json churn is parked-TUI statusline noise;
    //     refreshing `lastSignalAt` here would re-blind the (then `signal`-
    //     anchored) stale-thinking net exactly as PTY repaints did (task #294).
    //   - Output must have GROWN since the previous write. A `--resume`
    //     resume-picker reload is a CLI-internal turn that fires NO turn hooks,
    //     so it never gets an idle_hint: when it finishes and Claude parks, the
    //     idle-hint gate alone cannot stop the parked statusline churn from
    //     re-warming `lastSignalAt` forever, starving the 180s watchdog (task
    //     #331). Gating on growth (the same output-only compare the heartbeat
    //     recovery below uses, #298) makes frozen-output churn stop re-warming,
    //     so `lastSignalAt` freezes at the last real generation and the
    //     stale-thinking net self-heals to idle.
    // First-ever write (no `previousUsage`) does not warm: hook events refresh
    // `lastSignalAt` independently, so a genuinely-working turn loses nothing.
    const outputGrew =
      previousUsage !== undefined
      && usage.contextWindow.totalOutputTokens > previousUsage.contextWindow.totalOutputTokens;
    if (state.activity === 'thinking' && !state.idleHintPending && outputGrew) {
      this.activityEngine.markThinkingSignal(sessionId);
    }

    // Heartbeat recovery: if OUTPUT tokens grew while idle for >1s, the agent
    // resumed generating, so force thinking. Compare output only, never input.
    // Claude's `totalInputTokens` is current context-window occupancy
    // (cache_read + cache_creation + input), which climbs monotonically while a
    // session is parked at its prompt (cache settling, pending/pasted input,
    // statusline recompute) with no generation at all. Summing it with output lets
    // context-fill alone trip `currentTokens > previousTokens` and force-flip a
    // correct, hook-derived idle to thinking on a parked Claude session - and the
    // heartbeat is the ONLY force-thinking path for pure-hooks agents, so nothing
    // corrected it (empirically observed on #295 / #297: false flips fired in
    // windows with zero assistant output). `totalOutputTokens` is the current
    // turn's output: frozen while parked, growing only on real generation. The
    // 1-second grace prevents races between a status update and an idle event
    // landing in the same tick.
    //
    // Provenance gate (`!state.idleAuthoritative`): even output-only growth is
    // not always real generation. A parked Claude session ticks
    // `total_output_tokens` upward on background, non-turn housekeeping
    // (compaction/summarization) with NO turn-start hook, which would override a
    // fresh, hook-derived idle and pin a parked agent ACTIVE (task #294). So the
    // heartbeat may only force-think when the current idle is NOT
    // hook-authoritative - preserving its real job (waking a fallback/watchdog
    // idle whose agent is actually generating) while ignoring housekeeping on a
    // session the agent explicitly told us was done.
    //
    // `forceThinking(sessionId, true)`: this is the ONLY caller that passes
    // `forcedByHeartbeat=true`, recording that the resulting `turnActive` has NO
    // turn-hook confirmation (e.g. a `--resume` resume-picker reload, which
    // fires no turn hooks and so can never later produce an `idle_hint`). The
    // stale-thinking watchdog reads this provenance to narrow its anchor to
    // `signal` for this turn too - closing the residual PTY-repaint pin a
    // hook-less parked turn would otherwise hold indefinitely (task #364).
    if (previousUsage && state.activity === 'idle' && !state.idleAuthoritative) {
      const previousOutputTokens = previousUsage.contextWindow.totalOutputTokens;
      const currentOutputTokens = usage.contextWindow.totalOutputTokens;
      const idleStart = state.idleTimestamp;
      if (currentOutputTokens > previousOutputTokens && idleStart && (Date.now() - idleStart) > 1000) {
        this.activityEngine.forceThinking(sessionId, true);
      }
    }
  }

  /**
   * One-shot hook-based agent session ID capture. Scans raw JSON lines
   * from event-bridge and calls the parser's
   * `runtime.sessionId.fromHook` to extract the agent-reported UUID.
   */
  captureHookSessionIds(sessionId: string, rawLines: string[]): void {
    if (this.agentSessionIdChecked.has(sessionId)) return;
    const parser = this.sessionParsers.get(sessionId);
    if (!parser?.runtime?.sessionId?.fromHook) return;
    for (const line of rawLines) {
      this.tryCaptureAgentSessionId(sessionId, line, parser);
      if (this.agentSessionIdChecked.has(sessionId)) return;
    }
  }

  private tryCaptureAgentSessionId(sessionId: string, line: string, parser: AgentParser | undefined): void {
    if (this.agentSessionIdChecked.has(sessionId)) return;
    const fromHook = parser?.runtime?.sessionId?.fromHook;
    if (!fromHook) return;
    const hookContext = extractHookContext(line);
    if (!hookContext) return;
    const capturedId = fromHook(hookContext);
    if (!capturedId) return;
    this.agentSessionIdChecked.add(sessionId);
    // Seed the status channel's change detection (see notifyAgentSessionId).
    this.recordReportedId(sessionId, capturedId);
    this.callbacks.onAgentSessionId?.(sessionId, capturedId);
  }

  /**
   * Read the SessionStart hooks in a batch of raw event-bridge lines, for an
   * adapter that declares `statusFile.parseSessionStart`. A hook that moves
   * the conversation (anything but a fresh launch) confirms the id it names,
   * so the status channel may switch to it (`ConversationSwitchGate`). When a
   * status write of that id arrived first and was held, it is applied now
   * rather than at the next ~10 s refresh. Runs on every batch: unlike
   * `captureHookSessionIds`, it is not a one-shot capture.
   */
  noteSessionStartHooks(sessionId: string, rawLines: string[]): void {
    const statusFile = this.sessionParsers.get(sessionId)?.runtime?.statusFile;
    if (!statusFile?.parseSessionStart) return;
    for (const line of rawLines) {
      const sessionStart = sessionStartOfLine(statusFile, line);
      if (!sessionStart?.movesConversation) continue;
      const currentId = this.lastReportedAgentSessionIds.get(sessionId);
      // A background session's hook reads the same whether the conversation
      // moved there (Claude's /bg) or a copy started beside it (/fork), and a
      // copy must not take the terminal's place. Its write stays held until
      // the move is proven, and is applied then.
      if (
        sessionStart.inBackgroundSession
        && statusFile.confirmsBackgroundMove
        && this.callbacks.confirmsBackgroundMove
        && currentId !== undefined
        && currentId !== sessionStart.agentSessionId
      ) {
        void this.confirmBackgroundMove(sessionId, currentId, sessionStart.agentSessionId);
        continue;
      }
      this.confirmConversationMove(sessionId, sessionStart.agentSessionId);
    }
  }

  /** A hook proved the conversation moved to `agentSessionId`: let the status channel switch, and apply a write it held. */
  private confirmConversationMove(sessionId: string, agentSessionId: string): void {
    const heldUsage = this.conversationSwitches.confirm(
      sessionId,
      agentSessionId,
      this.lastReportedAgentSessionIds.get(sessionId),
    );
    if (heldUsage) this.processStatusUpdate(sessionId, heldUsage);
  }

  /**
   * Ask whether the conversation moved into the background session, and confirm
   * the move when it did. The CLI's record of the move and the background
   * session's hook race, so a no is asked again a few times
   * (`BACKGROUND_MOVE_CHECK_DELAYS_MS`). Stops once the session is gone or has
   * followed another id meanwhile.
   */
  private async confirmBackgroundMove(sessionId: string, fromAgentSessionId: string, toAgentSessionId: string): Promise<void> {
    // Each delay is counted from the hook, so each wait is the gap since the previous check.
    let previousDelayMs = 0;
    for (const delayMs of BACKGROUND_MOVE_CHECK_DELAYS_MS) {
      const waitMs = delayMs - previousDelayMs;
      previousDelayMs = delayMs;
      // Unref'd: a removed session's wait ends at the check below and needs nothing kept alive.
      if (waitMs > 0) {
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, waitMs);
          timer.unref?.();
        });
      }
      if (!this.sessionParsers.has(sessionId)) return;
      if (this.lastReportedAgentSessionIds.get(sessionId) !== fromAgentSessionId) return;
      let moved: boolean;
      try {
        moved = await (this.callbacks.confirmsBackgroundMove?.(sessionId, fromAgentSessionId, toAgentSessionId) ?? Promise.resolve(false));
      } catch {
        moved = false;
      }
      if (moved) {
        if (this.lastReportedAgentSessionIds.get(sessionId) === fromAgentSessionId) this.confirmConversationMove(sessionId, toAgentSessionId);
        return;
      }
    }
  }

  /** Does the session's adapter confirm a status id change with its SessionStart hooks? */
  private readsSessionStartHooks(sessionId: string): boolean {
    return typeof this.sessionParsers.get(sessionId)?.runtime?.statusFile?.parseSessionStart === 'function';
  }

  /** The session now follows `agentSessionId`, on whichever channel reported it. */
  private recordReportedId(sessionId: string, agentSessionId: string): void {
    this.lastReportedAgentSessionIds.set(sessionId, agentSessionId);
    this.conversationSwitches.adopt(sessionId, agentSessionId);
  }

  // ==== Per-event side detectors ====

  /**
   * For `hooks_and_pty` agents, suppress PTY-based activity detection
   * once hooks prove they are working (by delivering at least one
   * thinking event). Pure `pty` agents never get hook events; pure
   * `hooks` agents don't have PTY detection enabled.
   */
  private maybeSuppressPtyTracker(sessionId: string, event: SessionEvent, parser: AgentParser | undefined): void {
    if (!ActivityEngine.isTurnInitiatingEvent(event.type)) return;
    if (parser?.runtime?.activity?.kind !== 'hooks_and_pty') return;
    this.ptyTracker.suppress(sessionId);
  }

  /**
   * Detect approved `ExitPlanMode` completions. Uses ToolEnd (PostToolUse)
   * because the tool only resolves when the user approves the plan; on
   * rejection ("keep planning") no PostToolUse fires and the session stays
   * in plan mode. ToolStart fires at invocation, BEFORE the user decides,
   * and must not trigger the handoff (it would fabricate approval).
   */
  private detectExitPlanMode(sessionId: string, event: SessionEvent): void {
    if (event.type !== EventType.ToolEnd) return;
    if (event.tool !== AgentTool.ExitPlanMode) return;
    this.callbacks.onPlanExit(sessionId);
  }

  // ==== Lifecycle ====

  /**
   * Initialize tracking state for a new session and reset all per-session state.
   * `initialTurnActive` seeds the activity as thinking for a fresh agent spawn
   * (already processing its initial prompt); resumes / command terminals / orphan
   * recovery pass false and start idle.
   */
  initSession(sessionId: string, agentParser?: AgentParser, initialTurnActive = false): void {
    if (agentParser) {
      this.sessionParsers.set(sessionId, agentParser);
    }
    // A new process: nothing the last one left open is still running under it.
    this.openWork.forget(sessionId);
    this.activityEngine.initSession(sessionId, initialTurnActive);
    this.ptyTracker.clearSession(sessionId);
    this.notifySessionSpawned(sessionId);
  }

  hasAgentSessionId(sessionId: string): boolean {
    return this.agentSessionIdChecked.has(sessionId);
  }

  /**
   * Notify that an agent session ID was captured from PTY output.
   * Called by SessionManager when an adapter's
   * `runtime.sessionId.fromOutput` returns a non-null value.
   */
  notifyAgentSessionId(sessionId: string, agentReportedId: string): void {
    if (!this.agentSessionIdChecked.has(sessionId)) {
      this.agentSessionIdChecked.add(sessionId);
      // Seed the status channel's change detection so its first write with
      // this same id does not redundantly re-fire.
      this.recordReportedId(sessionId, agentReportedId);
      this.callbacks.onAgentSessionId?.(sessionId, agentReportedId);
    }
  }

  /**
   * Inject a synthetic session_end event into the event cache. Claude
   * Code's SessionEnd hook won't fire when we kill the PTY, so we
   * synthesize one ourselves so the activity log always shows session
   * end.
   */
  emitSessionEnd(sessionId: string): void {
    // Before the early return: whichever path ended the session, a held plan
    // prompt idle must never be released after it.
    this.planApprovalGate.end(sessionId);
    let events = this.eventCache.get(sessionId);
    if (events && events.length > 0 && events[events.length - 1].type === EventType.SessionEnd) {
      return;
    }
    const event: SessionEvent = { ts: Date.now(), type: EventType.SessionEnd };
    if (!events) {
      events = [];
      this.eventCache.set(sessionId, events);
    }
    events.push(event);
    this.callbacks.onEvent(sessionId, event);
  }

  /** Was a PR command flagged but its ToolEnd never processed? Used by
   *  the exit-time fallback scrollback scan. */
  hasPendingPRCommand(sessionId: string): boolean {
    return this.prCommandDetector.hasPending(sessionId);
  }

  /** Clear the pending PR command flag (used by the exit-time fallback). */
  clearPendingPRCommand(sessionId: string): void {
    this.prCommandDetector.clearPending(sessionId);
  }

  /**
   * A `git push` whose ToolEnd never arrived, cleared on read. The exit-time
   * fallback reports it through `onBranchPushed`'s listener ahead of the
   * pending PR resolve, so the branch is on the row before the ladder runs.
   */
  takePendingPushedBranch(sessionId: string): string | null {
    return this.pushCommandDetector.takePending(sessionId);
  }

  /**
   * Clear all per-session tracking state (used by suspend). Keeps the
   * eventCache and sessionParsers entries because the session record
   * may be reused on resume.
   */
  clearSessionTracking(sessionId: string): void {
    this.activityEngine.deleteSession(sessionId);
    this.openWork.forget(sessionId);
    this.ptyTracker.clearSession(sessionId);
    // A suspend ends the agent's process; a resume reports its mode afresh.
    this.planModeTrail.removeSession(sessionId);
    this.planApprovalGate.clear(sessionId);
    this.notifySessionEnded(sessionId);
    // deleteSession removes engine state directly - it never commits a
    // transition, so onActivityChange never fires to clear this session out
    // of permissionPendingSessions on its own (task #640).
    if (this.permissionPendingSessions.delete(sessionId)) {
      this.stopPermissionRejectionPollIfIdle();
    }
  }

  /** Delete all state for a session (full removal). */
  removeSession(sessionId: string): void {
    this.usage.removeSession(sessionId);
    this.earlierToolCallCounts.delete(sessionId);
    this.activityEngine.deleteSession(sessionId);
    this.openWork.forget(sessionId);
    this.ptyTracker.clearSession(sessionId);
    this.eventCache.delete(sessionId);
    this.sessionParsers.delete(sessionId);
    this.agentSessionIdChecked.delete(sessionId);
    this.lastReportedAgentSessionIds.delete(sessionId);
    this.conversationSwitches.removeSession(sessionId);
    this.statusWriteSeen.delete(sessionId);
    this.prCommandDetector.removeSession(sessionId);
    this.pushCommandDetector.removeSession(sessionId);
    this.planModeTrail.removeSession(sessionId);
    this.planApprovalGate.clear(sessionId);
    this.notifySessionEnded(sessionId);
    // Same reasoning as clearSessionTracking above.
    if (this.permissionPendingSessions.delete(sessionId)) {
      this.stopPermissionRejectionPollIfIdle();
    }
    // Note: we deliberately do NOT remove the debug-dump file here.
    // Surviving past session-end is the whole point - so a developer
    // can read "what was the engine doing right before the session
    // closed?" without racing to capture state pre-cleanup. Stale
    // dumps accumulate in `.kangentic/debug/` and are gitignored.
  }

  dispose(): void {
    if (this.idleTimeoutInterval) {
      clearInterval(this.idleTimeoutInterval);
      this.idleTimeoutInterval = null;
    }
    if (this.permissionRejectionPollInterval) {
      clearInterval(this.permissionRejectionPollInterval);
      this.permissionRejectionPollInterval = null;
    }
    this.userInterrupts.dispose();
    this.ptyTracker.dispose();
    this.planApprovalGate.dispose();
    if (this.bgShellWatcher) this.bgShellWatcher.dispose();
    this.activityEngine.dispose();
  }

  // ==== PTY data forwarding ====

  notifyPtyData(sessionId: string): void {
    this.ptyTracker.onData(sessionId);
  }

  notifyPtyIdle(sessionId: string): void {
    this.ptyTracker.onIdleDetected(sessionId);
  }

  private handlePtyThinking(sessionId: string): void {
    const event: SessionEvent = { ts: Date.now(), type: EventType.Prompt, detail: PromptReason.PtyActivity };
    this.pushEvent(sessionId, event);
    this.activityEngine.forceThinking(sessionId);
  }

  private handlePtyIdle(sessionId: string, detail: IdleReason): void {
    const event: SessionEvent = { ts: Date.now(), type: EventType.Idle, detail };
    this.pushEvent(sessionId, event);
    // A session history parser can report background commands while the PTY
    // tracker still runs (a Codex session whose hooks never flowed, task
    // #859). Silence while one runs is the agent waiting on it, so the idle
    // keeps the shells and the hold, the watcher's counts with them.
    this.activityEngine.forceIdle(sessionId, { keepBackgroundShells: this.tracksBackgroundShells(sessionId) });
  }

  /**
   * Suppress PTY-based activity tracking for a session. Called by
   * subsystems (native history readers, hook pipelines) once they
   * confirm authoritative telemetry is flowing.
   */
  suppressPty(sessionId: string): void {
    this.ptyTracker.suppress(sessionId);
  }

  // ==== Usage accumulator delegation ====

  /**
   * Upsert a partial SessionUsage entry. Used by agents that derive
   * usage from native log files (Codex, Gemini). Merges with any
   * existing entry, seeding a zeroed base if none exists.
   */
  setSessionUsage(sessionId: string, partial: SessionUsagePatch): void {
    const merged = this.usage.setSessionUsage(sessionId, partial);
    // `merged` is the cached object, so stamping the live tool-call count here
    // keeps both the renderer push and snapshot reads consistent (see
    // processStatusUpdate).
    this.stampToolCallCount(sessionId, merged);
    this.callbacks.onUsageChange(sessionId, merged);
    this.reemitBackfilled(this.usage.takeSessionsCaughtUpToReset());
  }

  /**
   * Hydrate the accumulator's known context windows from persisted metrics
   * (called from `applyRuntimeConfig` on project-open and every config-set,
   * via `SessionManager.hydrateDiscoveredContextWindows`), and re-emit any
   * parked session it retroactively back-fills - mirrors the reemit
   * `processStatusUpdate` does for a live status.json.
   */
  hydrateKnownWindows(entries: Array<{ modelId: string; contextWindowSize: number }>): void {
    this.reemitBackfilled(this.usage.hydrateKnownWindows(entries));
  }

  /**
   * Push a fresh usage snapshot to the renderer for each session whose cached
   * usage changed without a report of its own: a context window back-filled
   * from a newly-learned account+model window, or rate limits brought up to
   * another session's reset. Stamps the live tool-call count like the other
   * emit paths so snapshot reads stay consistent.
   */
  private reemitBackfilled(sessionIds: string[]): void {
    for (const sessionId of sessionIds) {
      const usage = this.usage.getSessionUsage(sessionId);
      if (!usage) continue;
      this.stampToolCallCount(sessionId, usage);
      this.callbacks.onUsageChange(sessionId, usage);
    }
  }

  /**
   * The count the pill shows: this run's calls plus the track's earlier runs.
   * The single place a usage payload gets its `toolCallCount`.
   */
  private stampToolCallCount(sessionId: string, usage: SessionUsage): void {
    usage.toolCallCount = this.usage.getToolCallCount(sessionId) + (this.earlierToolCallCounts.get(sessionId) ?? 0);
  }

  /**
   * Record how many tool calls the session's track made in earlier runs. When
   * that changes the stamped count of a usage already on screen, the usage is
   * re-stamped and re-emitted, so the pill agrees with the per-tool table that
   * prompted the refresh. Before the first usage there is nothing to re-emit:
   * the first stamp picks the count up.
   */
  setEarlierToolCallCount(sessionId: string, count: number): void {
    const previous = this.earlierToolCallCounts.get(sessionId) ?? 0;
    this.earlierToolCallCounts.set(sessionId, count);
    if (count === previous) return;
    const usage = this.usage.getSessionUsage(sessionId);
    if (!usage) return;
    this.stampToolCallCount(sessionId, usage);
    this.callbacks.onUsageChange(sessionId, usage);
  }

  // ==== Event ingest (the main pipeline) ====

  /**
   * Ingest a batch of events into the session event log and run each
   * through the activity engine. Generic primitive - any subsystem
   * producing events (native history readers, hook bridges) can call
   * this. Caps the per-session event cache at MAX_EVENTS_PER_SESSION.
   *
   * Per-event side effects, in order:
   *   - usage accumulator records ToolStart/End for per-tool stats
   *   - PR command detector flips pending flag, fires `onPRCandidate`
   *     when ToolStart-then-ToolEnd pair completes
   *   - push command detector remembers a `git push` destination on
   *     ToolStart, fires `onBranchPushed` when that call's ToolEnd arrives
   *   - `maybeSuppressPtyTracker` once a hooks_and_pty agent delivers a
   *     thinking signal
   *   - `detectExitPlanMode` fires plan-exit when ExitPlanMode tool
   *     completes (user approved the plan)
   *   - the plan-mode trail records a changed `planMode` report
   *   - activity engine processes the event (counters + predicate)
   *   - bg-shell watcher baseline re-anchors on BackgroundShellStart
   *
   * Every event passes the plan approval gate first (`plan-approval-gate.ts`),
   * which can drop, hold, or follow one with another, so nothing downstream
   * ever sees the permission idle of a plan Kangentic approved.
   */
  ingestEvents(sessionId: string, events: SessionEvent[], options: IngestEventsOptions = {}): void {
    if (events.length === 0) return;
    this.processAdmittedEvents(
      sessionId,
      events.flatMap((event) => this.planApprovalGate.admit(sessionId, event)),
      options.suppressesPtyTracker !== false,
    );
  }

  private processAdmittedEvents(sessionId: string, events: SessionEvent[], suppressesPtyTracker = true): void {
    if (events.length === 0) return;
    let cached = this.eventCache.get(sessionId);
    if (!cached) {
      cached = [];
      this.eventCache.set(sessionId, cached);
    }
    const parser = this.sessionParsers.get(sessionId);
    for (const event of events) {
      cached.push(event);
      this.callbacks.onEvent(sessionId, event);

      // An internal CLI agent's tool event (an agent id that never started,
      // such as one that runs after a Stop) stays in the log and reaches the
      // engine, which only counts it. Nothing else here acts on work the user
      // never sees.
      if (this.activityEngine.isInternalAgentEvent(sessionId, event)) {
        this.activityEngine.processEvent(sessionId, event);
        continue;
      }

      this.usage.recordToolEvent(sessionId, event);
      // Count context compactions (Claude PreCompact hook -> EventType.Compact)
      // for the per-task lifetime-stats rollup.
      if (event.type === EventType.Compact) this.usage.recordCompaction(sessionId);

      if (suppressesPtyTracker) this.maybeSuppressPtyTracker(sessionId, event, parser);
      this.detectExitPlanMode(sessionId, event);
      this.planModeTrail.note(sessionId, event, Date.now());

      const prResult = this.prCommandDetector.detect(sessionId, event);
      if (prResult.fireCandidate) {
        this.callbacks.onPRCandidate(sessionId);
      }
      const pushResult = this.pushCommandDetector.detect(sessionId, event);
      if (pushResult.pushedBranch) {
        this.callbacks.onBranchPushed?.(sessionId, pushResult.pushedBranch);
      }

      this.activityEngine.processEvent(sessionId, event);
      this.noteOpenWork(sessionId, event);

      // Tier A PID capture: a named bg-shell start lets the watcher try to
      // resolve the shell's OS PID (tree-diff or the foreground-tool memo) so
      // it can confirm liveness even when the count heuristic is out of sync.
      // Agent-agnostic (keyed on the generic event shape, not an agent name).
      if (
        event.type === EventType.BackgroundShellStart
        && looksLikeShellId(event.detail)
      ) {
        this.bgShellWatcher?.noteBackgroundShellStarted(sessionId, event.detail);
      }
    }
    if (cached.length > MAX_EVENTS_PER_SESSION) {
      const trimmed = cached.slice(-MAX_EVENTS_PER_SESSION);
      this.eventCache.set(sessionId, trimmed);
    }
  }

  /**
   * Force the activity state machine to a specific state. Pushes a
   * synthetic event into the log and calls the engine's force methods.
   * Generic primitive callable by any telemetry source that needs to
   * override the default state-machine transitions.
   */
  forceActivity(sessionId: string, activity: Activity): void {
    if (activity === Activity.Thinking) {
      const event: SessionEvent = { ts: Date.now(), type: EventType.Prompt, detail: PromptReason.PtyActivity };
      this.pushEvent(sessionId, event);
      this.activityEngine.forceThinking(sessionId);
    } else if (activity === Activity.Idle) {
      const event: SessionEvent = { ts: Date.now(), type: EventType.Idle, detail: IdleReason.Prompt };
      // A session history parser reports a turn end this way (Grok's
      // updates.jsonl, Codex's rollout). `forceIdle` clears every background
      // shell set, which would drop a live hold and fold the still-running
      // process into the watcher's helper baseline. While any shell is tracked,
      // the hint ends the turn the way a Stop hook's Idle does instead, which
      // keeps the shells (task #859). With none tracked nothing changes.
      if (this.tracksBackgroundShells(sessionId)) {
        this.ingestEvents(sessionId, [event]);
        return;
      }
      this.pushEvent(sessionId, event);
      this.activityEngine.forceIdle(sessionId);
    }
  }

  /** True while the engine tracks any background shell for the session, holding or exempt. */
  private tracksBackgroundShells(sessionId: string): boolean {
    const state = this.activityEngine.getState(sessionId);
    if (!state) return false;
    return state.activeBackgroundShellIds.size
      + state.exemptBackgroundShellIds.size
      + state.anonymousBackgroundShellCount > 0;
  }

  /**
   * User pressed Ctrl+C in the terminal. Delegated to
   * `UserInterruptCoordinator` which arms a settle timer and synthesizes
   * an Interrupted event if the engine is still hot after the window.
   */
  notifyUserInterrupt(sessionId: string): void {
    this.userInterrupts.notify(sessionId);
  }

  // ==== IPC-shape getters ====

  getUsageCache(): Record<string, SessionUsage> {
    return this.usage.getUsageCache();
  }

  /** The transcript path the session's agent last reported, or null. */
  getReportedTranscriptPath(sessionId: string): string | null {
    return this.usage.getSessionUsage(sessionId)?.transcriptPath ?? null;
  }

  /** See `UsageAccumulator.getFirstReportedEffort`. */
  getFirstReportedEffort(sessionId: string): string | null {
    return this.usage.getFirstReportedEffort(sessionId);
  }

  getActivityCache(): Record<string, ActivityState> {
    return this.activityEngine.getActivityCache();
  }

  getSessionActivity(sessionId: string): ActivityState | undefined {
    return this.activityEngine.getState(sessionId)?.activity;
  }

  /**
   * How much work the agent has reported (`SessionEngineState.workSerial`), or
   * undefined for an unknown session.
   */
  getWorkSerial(sessionId: string): number | undefined {
    return this.activityEngine.getState(sessionId)?.workSerial;
  }

  /** Is this a tool event from an internal CLI agent? See `ActivityEngine.isInternalAgentEvent`. */
  isInternalAgentEvent(sessionId: string, event: SessionEvent): boolean {
    return this.activityEngine.isInternalAgentEvent(sessionId, event);
  }

  /** See `PlanModeTrail.hadLeftPlanModeBy`. */
  hadLeftPlanModeBy(sessionId: string, atMs: number): boolean {
    return this.planModeTrail.hadLeftPlanModeBy(sessionId, atMs);
  }

  getActivityReason(sessionId: string): ActivityReason | null {
    return this.activityEngine.getActivityReason(sessionId);
  }

  /** See `ActivityEngine.markIdleAuthoritative`. */
  markIdleAuthoritative(sessionId: string): void {
    this.activityEngine.markIdleAuthoritative(sessionId);
  }

  /** See `ActivityEngine.restartIdleClock`. */
  restartIdleClock(sessionId: string): boolean {
    return this.activityEngine.restartIdleClock(sessionId);
  }

  /** See `ActivityEngine.markBackgroundShellsAsServices`. Null for a session the engine does not track. */
  markBackgroundShellsAsServices(sessionId: string, shellIds: readonly string[]): BackgroundShellServiceOutcome[] | null {
    const outcomes = this.activityEngine.markBackgroundShellsAsServices(sessionId, shellIds);
    // A service is left running on purpose: it is not work anyone waits on.
    if (outcomes) {
      this.openWork.closeShells(sessionId, outcomes.filter((entry) => entry.outcome !== 'pending').map((entry) => entry.shellId));
    }
    return outcomes;
  }

  /** What the session still has open, from its hook events (`open-work-ledger.ts`). */
  getOpenWork(sessionId: string): OpenWork {
    return this.openWork.get(sessionId);
  }

  /**
   * Batch ActivityReason map for every session the engine tracks.
   * Mirrors getActivityCache() so the renderer can reconcile reasons
   * after HMR / full reload via the same eviction semantics.
   */
  getActivityReasonsCache(): Record<string, ActivityReason> {
    const result: Record<string, ActivityReason> = {};
    this.activityEngine.forEachState((sessionId) => {
      const reason = this.activityEngine.getActivityReason(sessionId);
      if (reason) result[sessionId] = reason;
    });
    return result;
  }

  getActivityStatsSnapshot(sessionId: string): ActivityStatsSnapshot | null {
    return this.activityEngine.getStatsSnapshot(sessionId);
  }

  getEventsForSession(sessionId: string): SessionEvent[] {
    return this.eventCache.get(sessionId) || [];
  }

  getEventsCache(): Record<string, SessionEvent[]> {
    const result: Record<string, SessionEvent[]> = {};
    for (const [id, events] of this.eventCache) {
      result[id] = events;
    }
    return result;
  }

  /**
   * This run's tool-call count only, on purpose: `captureSessionMetrics` writes
   * it to this run's record, and the task summary sums records. A count that
   * included earlier runs would be stored again on every record.
   */
  getToolCallCount(sessionId: string): number {
    return this.usage.getToolCallCount(sessionId);
  }

  /** This run's per-tool rows only, for the same reason as `getToolCallCount`. */
  getToolBreakdown(sessionId: string): PerToolStat[] {
    return this.usage.getToolBreakdown(sessionId);
  }

  /** Compaction count for a session's current run (PreCompact -> Compact). */
  getCompactionCount(sessionId: string): number {
    return this.usage.getCompactionCount(sessionId);
  }

  // ==== Internal ====

  /** Append an event to the session cache and notify listeners. */
  private pushEvent(sessionId: string, event: SessionEvent): void {
    let events = this.eventCache.get(sessionId);
    if (!events) { events = []; this.eventCache.set(sessionId, events); }
    events.push(event);
    // The one synthesized event that ends open work: an interrupt that fired no
    // hook (a Ctrl+C or Esc between tool calls) ends every call in flight. Every
    // other synthesized event (a PTY idle, a watcher's guess) says nothing about it.
    if (event.type === EventType.Interrupted) this.openWork.noteInterrupted(sessionId);
    this.callbacks.onEvent(sessionId, event);
  }

  /**
   * Feed the open-work ledger one admitted event. After the engine has seen
   * it, so a named background shell can be told apart from an exempt service:
   * only a shell the engine holds is work the agent waits on.
   */
  private noteOpenWork(sessionId: string, event: SessionEvent): void {
    this.openWork.observe(sessionId, event);
    if (event.type === EventType.BackgroundShellStart && looksLikeShellId(event.detail)) {
      if (this.activityEngine.getState(sessionId)?.activeBackgroundShellIds.has(event.detail)) {
        this.openWork.noteHoldingShell(sessionId, event.detail, event.ts);
      }
    }
  }

  /**
   * Refresh the on-disk activity-engine snapshot for diagnostics. No-op
   * when no `debugDumpDir` is currently configured. Best effort - errors
   * are swallowed inside the writer.
   *
   * Resolves the dump directory via the resolver each call (when one was
   * provided), so toggling `developer.activityDebugOverlay` on/off takes
   * effect on the next state change without restarting SessionTelemetry.
   * Recreates the underlying ActivitySnapshotWriter when the resolved
   * path changes; ActivitySnapshotWriter caches a single output dir per
   * instance so reusing the previous writer would write to the wrong
   * place.
   */
  private writeDebugSnapshot(sessionId: string): void {
    if (this.debugDumpDirResolver) {
      const currentPath = this.debugDumpDirResolver() ?? null;
      if (currentPath !== this.snapshotWriterPath) {
        this.snapshotWriterPath = currentPath;
        this.snapshotWriter = currentPath
          ? new ActivitySnapshotWriter(currentPath)
          : null;
      }
    }
    if (!this.snapshotWriter) return;
    const snapshot = this.activityEngine.getStatsSnapshot(sessionId);
    if (!snapshot) return;
    // `recentPtyChunks` is a live 120s sliding window that the renderer
    // overlay polls; persisting it on every state change would bloat
    // the on-disk snapshot ~10x (up to ~36KB) and proportionally slow
    // every sync write. Strip it before writing - the post-mortem dump
    // is for "what was the engine state at the crash" and the chunk
    // timeline is not load-bearing for that question.
    const persistable = { ...snapshot, recentPtyChunks: [] };
    this.snapshotWriter.write(sessionId, persistable);
  }
}
