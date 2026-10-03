import { EventEmitter } from 'node:events';
import { promises as fsPromises } from 'node:fs';
import { v4 as uuidv4 } from 'uuid';
import { isAbortError } from '../../shared/abort-utils';

/**
 * Renderer key used when a caller does not identify itself (headless callers, and
 * tests that drive `setFocusedSessions` directly). Real renderers key on their
 * webContents id, which is never negative.
 */
export const SHARED_RENDERER_ID = -1;
import { resolveDebugDumpDir } from '../diagnostics/debug-dump-resolver';
import { ShellResolver } from './spawn/shell-resolver';
import { SessionQueue } from './session-queue';
import { SessionHistoryReader } from './readers/session-history-reader';
import { StatusFileReader } from './readers/status-file-reader';
import { SessionTelemetry } from '../activity-engine/session-telemetry';
import type { TranscriptSink } from './buffer/transcript-writer';
import { SessionIdManager } from './lifecycle/session-id-manager';
import { SessionFileManager } from './lifecycle/session-file-manager';
import { awaitSessionExit, gracefulPtyShutdown } from './shutdown/session-suspend';
import { killAllSessions, writeExitSequence } from './shutdown/session-shutdown';
import type { PtyKillReport } from './shutdown/session-shutdown';
import { DeferredKillRegistry, KILL_GRACE_MS, isYoungSession } from './lifecycle/deferred-kill';
import { PTY_EXIT_DRAIN_DEADLINE_MS } from './shutdown/exit-callback-drain';
import { HostProcessTreeProbe } from './host/host-process-tree-probe';
import type { OffMainPty, OffMainPtyOptions } from '../utility-process/off-main-pty';
import type { CliChildProcess, OffMainCliOptions } from '../utility-process/off-main-cli';

/** How long before the quit drain's deadline the pty host gives up waiting
 *  for exits and exits itself, so main never stops waiting first. */
const HOST_EXIT_MARGIN_MS = 200;
import { FirstOutputTracker } from './lifecycle/first-output-tracker';
import { disposeAdapterAttachment, removeAdapterHooks } from './lifecycle/adapter-lifecycle';
import { safeKillPty } from './lifecycle/pty-kill';
import { DEFAULT_PTY_COLS, DEFAULT_PTY_ROWS, performSpawn } from './lifecycle/session-spawn-flow';
import { SessionRegistry, toSession, filterCacheByProject, type ManagedSession, type ManagedSessionSummary } from './session-registry';
import { createWriteQueue, type WriteQueue } from './write-queue';
import { PromptDraftLedger, type WriteOrigin } from './prompt-draft-ledger';
import { recordTerminalTrace, traceTerminal } from './terminal-trace';
import { InProcessPtyHostTransport, PtyHostClient, type PtyHostTransport } from './host/pty-host-client';
import type { HostExecRequest, HostExecResult, PtyHostEvent } from './host/protocol';
import { isShuttingDown } from '../shutdown-state';
import type {
  Session,
  SessionUsage,
  ActivityState,
  ActivityReason,
  SessionEvent,
  SpawnSessionInput,
  PerToolStat,
  PtyResizeOrigin,
  SessionResizeResult,
} from '../../shared/types';
import type { ActivityEngineOptions, ActivityStatsSnapshot } from '../activity-engine/engine';
import { execFileAsync } from '../utility-process/off-main-exec';
import { isValidTaskTagValue, parseWslShellSpec } from './process-tag/task-process-tag';
import { reapTaggedProcessesInWsl } from './process-tag/wsl-reap';
import { resolveTaskDirectories } from './process-tag/task-directories';
import { reportTaskReapFailure } from './task-reap-failure-report';
import type { LeftoverProcessEntry, StopProcessOutcome } from './process-tag/tagged-reap';

/** How long a task reap may take in the host: two scans, the 1 s grace
 *  between them, and the kills. A scan measured ~30 ms on Windows. */
const TASK_REAP_TIMEOUT_MS = 15_000;
/** How long a task reap waits for a parked PTY of its task to exit: the
 *  deferred force-kill's grace plus the same kill propagation `suspend()`
 *  allows (`gracefulPtyShutdown`). */
const PARKED_EXIT_WAIT_MS = KILL_GRACE_MS + 1500;
/** How long a suspend waits on the host for the scrollback its last-resort
 *  agent session id scan reads. The scan is a fallback; the suspend is not. */
const SUSPEND_SCROLLBACK_SCAN_TIMEOUT_MS = 2_000;
/** How long a teardown waits for a spawn it cancelled to settle, matching
 *  awaitExit's own safety timeout for a PTY that never reports its exit. */
const SPAWN_SETTLE_TIMEOUT_MS = 10_000;

/** A spawn inside doSpawn(): see `SessionManager.spawnsInFlight`. */
interface InFlightSpawn {
  taskId: string;
  cancelled: boolean;
  /** The exit of the PTY a cancelled spawn's host had already started. */
  abandonedPtyExit: Promise<void> | null;
  /** Resolves once the spawn has finished, or been abandoned and its PTY exited. */
  settled: Promise<void>;
}

export interface SessionManagerOptions {
  /**
   * Override activity-engine timings. Production code does not pass
   * this; tests use it to shrink debounce/escape-hatch/watchdog
   * windows so assertions don't have to wall-clock-wait the production
   * defaults.
   */
  activityEngineOptions?: ActivityEngineOptions;
  /**
   * How long a session must stay unwatched before its grid is parked back at
   * the resting grid (see scheduleRestingGridRestore). Production uses the
   * default; tests shrink it so they need neither fake timers nor a wall-clock
   * wait.
   */
  restingGridDelayMs?: number;
  /**
   * Where the PTYs live. Production passes the `kangentic-pty-host` utility
   * process (`host/utility-pty-host-transport.ts`); without one the host core
   * runs in this process, which is what the unit tests use.
   */
  ptyHostTransport?: PtyHostTransport;
}

/** Per-session pipeline numbers for the dev terminal-pipeline route. */
export interface SessionPipelineStats {
  sessionId: string;
  taskId: string;
  status: string;
  focused: boolean;
  pendingBytes: number;
  scrollbackBytes: number;
  paused: boolean;
  inFlightBytes: number;
}

/** Every dimension main and the host know for one session's terminal. */
export interface SessionTerminalDimensions {
  sessionId: string;
  taskId: string;
  status: string;
  ptyCols: number | null;
  ptyRows: number | null;
  lastCols: number | null;
  lastRows: number | null;
  lastDesktopCols: number | null;
  lastDesktopRows: number | null;
  pendingResizeCols: number | null;
  pendingResizeRows: number | null;
  pendingRepaintAt: number | null;
  pendingRepaintStacked: boolean;
  inAltScreen: boolean;
  geometryChangedAtRingIndex: number | null;
}

/**
 * The mobile bridge's answers to the two questions the resting-grid park
 * must ask, injected via setMobileTerminalProbe because the dependency
 * points the other way (the bridge listens to this manager, never vice
 * versa). `isSizeHeld` is the armed terminal-size-guard entry - the actual
 * hold, which no last-writer origin heuristic can stand in for: a desktop
 * resize makes itself the last writer while the guard stays armed. And
 * `hasStreamSubscriber` is the interest that makes a park worth a reflow at
 * all: the park exists so a phone does not mirror whatever strip the last
 * desktop surface left behind, so a desktop nobody paired (no probe) or a
 * session no phone is streaming must never pay its SIGWINCH + repaint.
 */
export interface MobileTerminalProbe {
  isSizeHeld(sessionId: string): boolean;
  hasStreamSubscriber(sessionId: string): boolean;
}

/**
 * Long enough that switching a session between surfaces (which unfocuses and
 * refocuses within a frame or two) never reshapes the PTY in the gap, short
 * enough that a phone watching a session the desktop just stopped showing gets
 * a usable grid while the user is still looking at it.
 */
const RESTING_GRID_DELAY_MS = 1000;

/**
 * The grid an unwatched session rests at: DETAIL-shaped, deliberately not the
 * 120x30 spawn default (user decision 2026-08-02, from a live A/B on the
 * phone). The phone mirrors this grid 1:1, and a phone-fitted narrow grid was
 * built, tested end to end, and judged LESS readable than the desktop's own
 * layout - Claude Code draws its rules and boxes for a wide frame, and at
 * ~49 cols they dominate every line while the text wraps. Resting at the
 * size a task detail typically fits means the phone's view is identical
 * whether the detail is open or closed, and pan/zoom spends the density.
 */
const RESTING_GRID_COLS = 210;
const RESTING_GRID_ROWS = 48;

/**
 * The row floor for a session a phone is actively streaming. Below this, the
 * phone's 1:1 mirror is a sliver of its screen with no recovery available
 * away from the desk (user decision 2026-08-02: that view must never reach a
 * phone). The bottom terminal panel's strip (~14 rows) sits well below the
 * floor; any realistic task detail sits well above it, so detail-driven grids
 * always win. Enforced in resize() (refuse desktop shrinks below the floor
 * while a phone streams) and at subscribe time (park a session already stuck
 * below the floor even though a desktop surface holds it).
 */
const MOBILE_USABLE_MIN_ROWS = 20;

/**
 * How long after a session's PTY spawns before the agent-absence sweep may
 * judge it. This is the one window where "no agent process under the shell" is
 * genuinely expected rather than a fault: the SHELL starts first, Kangentic
 * writes the agent CLI command to its stdin ~100ms later (a further 200ms
 * behind a Windows cwd fixup - see session-spawn-flow), and the CLI process
 * still has to start; a heavy shell profile can stall even reading that stdin.
 *
 * 30s is far more than any of that needs, and it is nearly free: a session
 * whose agent dies inside its own first half-minute is retired on the next
 * sweep instead of this one. A SLOW-STARTING agent never needed this grace at
 * all - its process exists from the moment it launches, it has just not drawn
 * a frame yet, which is exactly the distinction that makes the process tree a
 * safer signal than a first-output timeout.
 */
const AGENT_SPAWN_GRACE_MS = 30_000;

export class SessionManager extends EventEmitter {
  private registry = new SessionRegistry();
  /**
   * PTYs whose force-kill is waiting out the exit-sequence grace. Parked OUTSIDE
   * the registry row: `kill()` nulls `session.pty` at once as it always did, so
   * nothing that walks the registry (a respawn's sibling drain, `awaitExit`'s
   * status checks) can see or cut short a deferred PTY. See
   * lifecycle/deferred-kill.ts for why the grace exists.
   */
  private deferredKills = new DeferredKillRegistry({ killPty: safeKillPty });
  private shellResolver = new ShellResolver();
  private configuredShell: string | null = null;
  /** Which sessions have emitted first output, as the pty host reports it. */
  private firstOutputTracker = new FirstOutputTracker();
  /**
   * The pty host: every PTY, its output pipeline (ring, headless parser,
   * transcript, detectors), backpressure and the redraw filter live there.
   */
  private readonly host: PtyHostClient;
  /** Set by `killAll()`: how long the pty host may wait for exits after
   *  `dispose()`, so it is gone inside the quit drain's deadline. */
  private hostExitWaitMs: number | undefined;
  /** Main's mirror of each session's alternate-screen state, from the host. */
  private inAltScreen = new Map<string, boolean>();
  /** The column count each session's ring was last sized to, mirroring the
   *  host's buffer so `resize()` reports colsChanged synchronously. */
  private bufferCols = new Map<string, number>();
  /** Raw output subscriptions per session (`subscribeDataTap`). */
  private dataTapRefs = new Map<string, number>();
  /** Where an in-process host writes transcripts (unit tests). */
  private transcriptSinkFor: ((projectId: string) => TranscriptSink | null) | null = null;
  /**
   * Sessions currently visible in the renderer (terminal panel + command bar overlay).
   * Only these sessions' PTY data is emitted via IPC - background sessions
   * accumulate silently in the scrollback buffer. This eliminates O(N) IPC
   * flooding when many sessions run concurrently.
   *
   * Default-closed: an empty set means NO session's data is forwarded. The
   * renderer pushes the real set from AppLayout's first render
   * (useFocusedSessionsSync) and sends a legitimately empty set when no
   * terminal is visible (Backlog view, hidden panel); an unfocused session
   * catches up via getScrollback() on focus. Any headless caller listening on
   * the manager's 'data' event must call setFocusedSessions first. The
   * focus-independent seams are 'data-tap' (raw bytes, for a session someone
   * holds a `subscribeDataTap` on) and 'output-seen' (no bytes, every session).
   */
  private focusedSessionIds = new Set<string>();
  /**
   * Per-renderer visible sets, unioned into `focusedSessionIds` above. The union
   * is what gates emitting at all; the individual sets are the ROUTING TABLE for
   * which renderer each session's bytes belong to (a session is hosted by exactly
   * one renderer, because the task-detail owner registry says so).
   */
  private focusedByRenderer = new Map<number, Set<string>>();
  /**
   * Per-session FIFO write queue. Every `write()` call appends to the same
   * buffer and is drained by a single loop that yields via setImmediate
   * between 4KB chunks. Guarantees byte order across concurrent callers
   * (user input, paste, terminal-submit keystrokes) so bracketed-paste sequences
   * cannot be fragmented by interleaved writes.
   */
  private writeQueues = new Map<string, WriteQueue>();
  /**
   * Per-session record of what the user has typed and not yet sent. Read by
   * keystroke injection so an auto_command never concatenates onto a draft.
   */
  private promptDrafts = new PromptDraftLedger();
  /**
   * Terminal dimensions from a resize that arrived before the session's PTY
   * existed (the renderer mounted and fit its container before the auto-resume
   * spawn landed, or while the session was queued/suspended awaiting spawn).
   * performSpawn consumes this so the PTY spawns at the real fitted size
   * instead of the 120x30 default, so no post-spawn corrective resize (and its
   * stale-geometry repaint window) is needed. Keyed by session id, independent of
   * the registry so it survives the registry.delete during a respawn. Consumed
   * at spawn (takePendingResize) or dropped on kill.
   */
  private pendingResizes = new Map<string, { cols: number; rows: number }>();
  /**
   * The last grid a DESKTOP-origin resize set per session - the restore
   * target when a paired phone that resized the PTY (fit-to-phone mode)
   * releases it. Written on every desktop-origin resize (live or pre-spawn
   * stash); lazily seeded with the current PTY grid the first time a
   * mobile-origin resize arrives for a session the desktop never resized,
   * so the restore always lands on what the desktop last had, never on a
   * phone-shaped grid. Cleared on kill/remove with pendingResizes.
   */
  private lastDesktopDimensions = new Map<string, { cols: number; rows: number }>();
  /** See MobileTerminalProbe; null until the bridge attaches (or forever, unpaired). */
  private mobileTerminalProbe: MobileTerminalProbe | null = null;
  /**
   * Pending resting-grid restores, keyed by session. See
   * scheduleRestingGridRestore.
   */
  private restingGridTimers = new Map<string, ReturnType<typeof setTimeout>>();
  /**
   * Per-renderer sets of sessions with an xterm MOUNTED, unioned into
   * mountedSessionIds below. Broader than focus on purpose: a PARKED terminal
   * (Backlog view, occluded window) is unfocused but still mounted, holding a
   * grid it will never re-send - xterm emits a resize only when its OWN size
   * changes. Reshaping such a PTY leaves the two permanently disagreeing, so
   * a mounted session's grid is never parked.
   */
  private mountedByRenderer = new Map<number, Set<string>>();
  private mountedSessionIds = new Set<string>();

  // Sub-modules owned by SessionManager. Cross-wired in the constructor
  // below; `telemetry` and `sessionHistoryReader` form a cycle (the
  // telemetry's onAgentSessionId attaches the history reader; the reader
  // calls back into telemetry) which is resolved via definite-
  // assignment (`!`) so their callbacks can reference each other.
  private sessionQueue: SessionQueue;
  private telemetry!: SessionTelemetry;
  private sessionHistoryReader!: SessionHistoryReader;
  private statusFileReader: StatusFileReader;
  private sessionFiles: SessionFileManager;
  private sessionIdManager: SessionIdManager;
  private activityEngineOptions: ActivityEngineOptions | undefined;
  private restingGridDelayMs: number;

  constructor(options: SessionManagerOptions = {}) {
    super();
    // The mobile bridge's read-stream feed attaches per-subscription listeners
    // (data-tap/activity/usage/event) for every session a paired phone streams,
    // on top of the app's own baseline listeners. That legitimately crosses
    // Node's default max of 10 per event, so raise the cap to keep a normal
    // multi-session fan-out from tripping a spurious MaxListenersExceededWarning
    // (a genuine leak still shows as an unbounded climb well past this).
    this.setMaxListeners(100);
    this.activityEngineOptions = options.activityEngineOptions;
    this.restingGridDelayMs = options.restingGridDelayMs ?? RESTING_GRID_DELAY_MS;

    this.sessionQueue = new SessionQueue({
      // A promotion holds a slot while it spawns, as a direct spawn does: its
      // placeholder is 'queued', which countRunning does not count, so for the
      // host round trip the limit would otherwise read one low and let a direct
      // spawn past it.
      spawner: async (input) => {
        this.spawningCount++;
        try {
          await this.doSpawn(input);
        } catch (error) {
          // A teardown took the session over while it spawned: not a failure.
          if (isAbortError(error)) return;
          throw error;
        } finally {
          this.spawningCount--;
        }
      },
      getActiveCount: () => this.activeCount,
      maxConcurrent: 5,
    });

    const transport: PtyHostTransport = options.ptyHostTransport ?? this.createInProcessHost();
    // A utility host that keeps crashing falls back to the core in this
    // process, which is how every terminal ran before the host existed.
    transport.setFallbackFactory?.(() => this.createInProcessHost());
    this.host = new PtyHostClient(transport);
    this.host.setEventHandler((event) => this.handleHostEvent(event));
    this.host.setLifecycleHandler({
      // The host died and its PTYs were reported exited (each through the
      // spawn flow's own exit handling). The IPC layer resumes the sessions,
      // but only those the host took down: one main was already ending (a
      // suspend inside its exit window, a kill inside its grace) stays ended
      // rather than being resumed against that intent.
      onHostLost: (sessionIds) => {
        const takenDown = sessionIds.filter((sessionId) => {
          const session = this.registry.get(sessionId);
          return !session || (session.status !== 'suspended' && session.intentionalExit !== true);
        });
        this.emit('pty-host-lost', takenDown);
      },
      onHostRestarted: () => {
        // The new host knows nothing: replay what gates its output.
        this.host.post({ type: 'setFocused', sessionIds: [...this.focusedSessionIds] });
        this.publishTapped();
        this.emit('pty-host-restarted');
      },
    });

    this.sessionIdManager = new SessionIdManager({
      hasAgentSessionId: (id) => this.telemetry.hasAgentSessionId(id),
      notifyAgentSessionId: (id, capturedId) => this.telemetry.notifyAgentSessionId(id, capturedId),
      sessionExists: (id) => this.registry.has(id),
    });

    this.telemetry = new SessionTelemetry({
      onUsageChange: (sessionId, usage) => this.emit('usage', sessionId, usage),
      onActivityChange: (sessionId, activity, reason) => {
        // The host's redraw filter reads the current activity (a repaint
        // after a resize must not wake an idle session).
        this.host.post({ type: 'setActivity', sessionId, activity });
        this.emit('activity', sessionId, activity, reason);
      },
      // A separate event, not 'activity', and that separation is load-bearing
      // rather than tidy. Ten listeners read 'activity' as "the state changed",
      // and several of them ACT on it: the mobile push notifier wakes a phone,
      // the desktop notifier raises a toast, turn-completion drives auto-move,
      // the terminal submit scheduler releases queued keystrokes, and the
      // interval recorder opens and closes `session_activity_intervals` rows.
      // A long turn reports a reason ~180 times against ~3 real transitions, so
      // routing these onto 'activity' would fire all of that on a refresh whose
      // only new information is which reason to draw.
      onReasonChange: (sessionId, activity, reason) =>
        this.emit('activity-reason', sessionId, activity, reason),
      onEvent: (sessionId, event) => this.emit('event', sessionId, event),
      onIdleTimeout: (sessionId) => {
        const session = this.registry.get(sessionId);
        if (session) this.emit('idle-timeout', sessionId, session.taskId, this.telemetry.idleTimeoutMinutes);
      },
      onPlanExit: (sessionId) => this.emit('plan-exit', sessionId),
      onPRCandidate: (sessionId) => {
        // A `gh pr ...` Bash command finished - this is just the hint that NOW is
        // a good time to resolve. The authoritative branch->PR query happens in
        // the IPC listener; forward the raw scrollback so it can degrade to
        // scraping if gh is unavailable.
        void this.host.getRawScrollback(sessionId).then(
          (scrollback) => this.emit('pr-candidate', sessionId, scrollback),
          () => this.emit('pr-candidate', sessionId, ''),
        );
      },
      onBranchPushed: (sessionId, branch) => {
        // The agent's own `git push` named this branch as its destination. The
        // IPC listener records it on the task as the per-task PR anchor; no
        // resolve fires here, the PR does not exist yet.
        this.emit('branch-pushed', sessionId, branch);
      },
      onAgentSessionId: (sessionId, agentReportedId) => {
        // Agent session ID capture covers three cases:
        // 1. Fresh capture: agent_session_id was null (Codex/Gemini), now captured from hooks/PTY output.
        // 2. Stale recovery: agent_session_id was pre-specified (Claude --resume) but the agent
        //    created a different session (--resume failed silently). DB needs the correct ID.
        // 3. Mid-session fork: the agent moved the live conversation to a NEW id (Claude /clear)
        //    and its status file re-reported it, so this callback fires AGAIN mid-session.
        //    Everything below is repeat-safe: the mutation is value-guarded, and the history
        //    re-attach is blocked by hasReceivedStatus (see the note further down).
        // recoverStaleSessionId() handles all cases - emit unconditionally.
        const session = this.registry.get(sessionId);
        if (!session) return;
        // The host can stop scanning this session's output for an id.
        this.host.post({ type: 'setAgentSessionIdKnown', sessionId });
        // Reflect the captured ID on the live Session so the renderer (and
        // tests) can observe it via sessions.list() without a DB round-trip.
        if (session.agentSessionId !== agentReportedId) {
          session.agentSessionId = agentReportedId;
          this.emit('session-changed', sessionId, toSession(session));
        }
        this.emit('agent-session-id', sessionId, session.taskId, session.projectId, agentReportedId);
        // Hand off to the session-history reader if the adapter declares
        // a native history hook. Fire-and-forget - the reader logs any
        // failures and degrades gracefully to PtyActivityTracker.
        //
        // For Claude the transcript reader is a background-session FALLBACK,
        // and processStatusUpdate's id capture routes back here. The
        // guard skips a re-attach once status.json has been handed off. Note:
        // on the normal Claude path this callback fires synchronously nested
        // inside the FIRST onUsageParsed - before StatusFileReader sets
        // firstStatusDelivered - so hasReceivedStatus is still false here and
        // the guard does not fire. The no-race guarantee on that path instead
        // comes from SessionHistoryReader.attach being idempotent (the eager
        // spawn-time attach already holds the slot) plus the detach in
        // onFirstStatus (fired right after onUsageParsed) cancelling any
        // in-flight re-attach. The guard covers any path where an id capture
        // could arrive after that handoff - including the mid-session fork
        // (case 3 above): a status-reported id CHANGE implies a prior status
        // write (no adapter reports session ids via both a hook/PTY channel
        // and parseStatus), so by the time it fires here firstStatusDelivered
        // is already true and the deliberately-detached transcript fallback
        // stays detached. status.json remains the live telemetry source for
        // the forked conversation.
        const historyHook = session.agentParser?.runtime?.sessionHistory;
        if (historyHook && !this.statusFileReader.hasReceivedStatus(sessionId)) {
          // No startAtEnd here: this attach only ever runs when the agent id was
          // NOT known at spawn time - either a fresh Codex/Gemini capture (a
          // brand-new transcript whose early entries we want) or a
          // stale-session-id recovery (also a fresh file, under the newly
          // captured id). Reading from the start is correct in both. The
          // resumed-existing-file EOF case never reaches here: it is held by the
          // idempotent spawn-time attach (which passes startAtEnd), so this path
          // never re-parses pre-resume content.
          this.sessionHistoryReader.attach({
            sessionId,
            agentSessionId: agentReportedId,
            cwd: session.cwd,
            hook: historyHook,
            agentName: session.agentName,
          }).catch((err) => {
            console.warn(`[session-history] attach failed for session=${sessionId.slice(0, 8)}:`, err);
          });
        }
      },
      requestSuspend: (sessionId) => this.suspend(sessionId),
      isSessionRunning: (sessionId) => this.registry.get(sessionId)?.status === 'running',
      getSessionRootPid: (sessionId) => {
        const session = this.registry.get(sessionId);
        return session?.pty?.pid;
      },
      resolveBackgroundShellOutputFile: (sessionId, shellId) => {
        const session = this.registry.get(sessionId);
        if (!session) return null;
        return session.agentParser?.runtime?.backgroundShells
          ?.resolveOutputFile({ cwd: session.cwd, shellId }) ?? null;
      },
      reportTerminatedBackgroundShells: (sessionId, shellIds) => {
        const session = this.registry.get(sessionId);
        if (!session?.agentSessionId) return [];
        return session.agentParser?.runtime?.backgroundShells
          ?.reportTerminatedShells?.({ cwd: session.cwd, agentSessionId: session.agentSessionId, shellIds }) ?? [];
      },
      reportRejectedPermissionTools: (sessionId, toolIds, sinceMs) => {
        const session = this.registry.get(sessionId);
        if (!session?.agentSessionId) return [];
        return session.agentParser?.runtime?.permissionPrompts
          ?.reportRejectedPromptTools?.({ cwd: session.cwd, agentSessionId: session.agentSessionId, toolIds, sinceMs }) ?? [];
      },
      isAgentAbsenceCandidate: (sessionId) => this.isAgentAbsenceCandidate(sessionId),
      retireAgentlessSession: (sessionId) => this.retireAgentlessSession(sessionId),
    }, {
      activityEngineOptions: this.activityEngineOptions,
      // The background-shell watcher's process table comes from the pty host
      // (Toolhelp on Windows, `ps` on POSIX; `host-process-table.ts`).
      processTreeProbe: new HostProcessTreeProbe(() => this.host.listProcesses()),
      // Activity-engine debug snapshots land at `<projectRoot>/.kangentic/debug/<sessionId>.json`
      // when `developer.activityDebugOverlay` is on (toggled in Settings →
      // Developer). When that toggle is off, falls back to the existing
      // env-based path used by production installs. Returns `undefined` when
      // neither applies, disabling the dump entirely. The resolver is
      // configured by `installDiagnostics()` at process startup.
      //
      // Pass the function (not its current return value) so SessionTelemetry
      // re-resolves on every snapshot write - this lets toggle changes flip
      // the dump on/off live without restarting the session.
      debugDumpDir: resolveDebugDumpDir,
    });

    this.sessionHistoryReader = new SessionHistoryReader({
      onUsageUpdate: (sessionId, usage) => this.telemetry.setSessionUsage(sessionId, usage),
      onEvents: (sessionId, events) => this.telemetry.ingestEvents(sessionId, events),
      onActivity: (sessionId, activity) => this.telemetry.forceActivity(sessionId, activity),
      onFirstTelemetry: (sessionId) => {
        // Only suppress PTY detection when the adapter uses hooks_and_pty
        // (meaning hook-based events can drive activity transitions). For
        // pure PTY adapters (Codex, Aider), session history provides usage
        // data (model, tokens) but NOT real-time activity signals, so the
        // silence timer must remain active.
        const session = this.registry.get(sessionId);
        const activityKind = session?.agentParser?.runtime?.activity?.kind;
        if (activityKind === 'hooks_and_pty') {
          this.telemetry.suppressPty(sessionId);
        }
      },
    });

    this.statusFileReader = new StatusFileReader({
      onUsageParsed: (sessionId, usage) => this.telemetry.processStatusUpdate(sessionId, usage),
      onEventsParsed: (sessionId, rawLines, events) => {
        this.telemetry.captureHookSessionIds(sessionId, rawLines);
        this.telemetry.ingestEvents(sessionId, events);
      },
      onFirstStatus: (sessionId) => {
        // status.json just started flowing - it is authoritative (full usage
        // replace incl. Claude's own used_percentage, cost, rate limits). Stop
        // the transcript-based fallback reader (Claude's runtime.sessionHistory)
        // so its partial-merge can never overwrite fresher status data; detach
        // also cancels any in-flight re-attach. No-op for adapters (Codex,
        // Gemini) that never emit a parseable status, so onFirstStatus never
        // fires for them.
        this.sessionHistoryReader.detach(sessionId);
      },
    });

    this.sessionFiles = new SessionFileManager(
      this.sessionHistoryReader,
      this.statusFileReader,
    );

    // Free the per-session write queue when a PTY exits naturally (without
    // going through kill()). dispose() is idempotent so the kill() path
    // double-disposing is harmless.
    this.on('exit', (sessionId: string) => {
      const writeQueue = this.writeQueues.get(sessionId);
      if (writeQueue) {
        writeQueue.dispose();
        this.writeQueues.delete(sessionId);
      }
      // The prompt died with the PTY; a remembered draft would otherwise be
      // reported as discarded by the next session to reuse this id. (The host
      // dropped the session's backpressure accounting when the PTY exited.)
      this.promptDrafts.clear(sessionId);
      // Nothing left to reshape either: a respawn spawns at the desktop grid.
      this.cancelRestingGridRestore(sessionId);
      // A deferred force-kill whose PTY exited on its own inside the grace has
      // nothing left to kill. The spawn flow's onExit stays attached through a
      // kill() (only the quit path detaches it), so this event is the cancel
      // signal - the registry deliberately attaches no PTY listener of its own.
      this.deferredKills.cancel(sessionId);
    });
  }

  /** The host core in this process: the unit tests' host, and the fallback. */
  private createInProcessHost(): InProcessPtyHostTransport {
    return new InProcessPtyHostTransport({
      // In-process the detectors are the row's own adapter instance.
      resolveAgent: (sessionId) => this.registry.get(sessionId)?.agentParser,
      transcriptSinkFor: (projectId) => this.transcriptSinkFor?.(projectId) ?? null,
    });
  }

  /**
   * Apply one event from the pty host. The host runs the per-chunk work; what
   * main needs of it arrives here, in the order the host produced it.
   */
  private handleHostEvent(event: PtyHostEvent): void {
    switch (event.type) {
      case 'data':
        // Output for a focused session (the host gates on the focus union).
        // Rechecked here: a focus change can cross a slice in flight, and
        // such a slice has no renderer left to go to. The host releases its
        // accounting for every session a focus change touched.
        if (this.focusedSessionIds.has(event.sessionId)) this.emit('data', event.sessionId, event.data);
        return;
      case 'tap':
        // Raw output for a session someone subscribed to (subscribeDataTap):
        // every flushed slice, plus bytes a replay drained before they could
        // flush. Never the renderer's channel and never in backpressure.
        this.emit('data-tap', event.sessionId, event.data);
        return;
      case 'outputSeen':
        this.telemetry.activityEngine.markPtyChunk(event.sessionId);
        // Production stuck-pending-tools signal: a single timestamp write so a
        // long quiet foreground tool (a test run streaming output with no hook
        // event or status heartbeat for >5 min) is not force-idled. A no-op
        // for an unknown id, so it needs no registry guard.
        this.telemetry.activityEngine.markPtyOutput(event.sessionId);
        this.emit('output-seen', event.sessionId);
        return;
      // These two re-create per-session state too (the first-output latch and
      // the alt-screen mirror), so a session removed while its parked PTY
      // still writes its exit screen is dropped here like the cases below.
      case 'firstOutput':
        if (!this.registry.has(event.sessionId)) return;
        if (!this.firstOutputTracker.markEmitted(event.sessionId)) return;
        this.emit('first-output', event.sessionId);
        // First-output can be tripped by a SHELL preamble, not the agent (see
        // the arming comment in resize()), so this trigger DISARMS only when
        // the stream was already in the alt buffer - the output provably came
        // from the TUI. Otherwise the jiggle still fires (for an inline-mode
        // agent this is the only trigger, and one extra repaint is harmless)
        // but the flag stays armed for the alt-screen-entry trigger, which is
        // what actually reaches a fullscreen agent that boots after the shell.
        // `resuming` is NOT cleared here: the card and the context bar read it
        // for their "Resuming agent..." label until the model name lands.
        this.reassertGeometryForBootingChild(event.sessionId, {
          trigger: 'first-output',
          disarm: event.inAltScreen,
        });
        return;
      case 'altScreen': {
        if (!this.registry.has(event.sessionId)) return;
        this.inAltScreen.set(event.sessionId, event.inAltScreen);
        if (!event.inAltScreen) return;
        // The TUI's first composed frame: the one boot signal a shell
        // preamble cannot fake (see the arming comment in resize()). This
        // trigger always disarms - a child that just switched buffers is
        // demonstrably parsing output, so the re-delivered geometry lands.
        //
        // Stamp the FIRST entry only: it is the upper bound on when Claude
        // armed its fullscreen boot canary, which is what kill() reads to
        // decide whether the force-kill must wait for the exit sequence. A
        // later re-entry is not a boot and must not re-open the window.
        const session = this.registry.get(event.sessionId);
        if (session) session.altScreenEnteredAt ??= Date.now();
        this.reassertGeometryForBootingChild(event.sessionId, {
          trigger: 'alt-screen-enter',
          disarm: true,
        });
        return;
      }
      // The rest re-create per-session state, so each is dropped for a
      // session no longer in the registry (removed while its PTY exits).
      case 'ptyIdle':
        if (this.registry.has(event.sessionId)) this.telemetry.notifyPtyIdle(event.sessionId);
        return;
      case 'ptyData':
        if (this.registry.has(event.sessionId)) this.telemetry.notifyPtyData(event.sessionId);
        return;
      case 'agentSessionId':
        if (!this.registry.has(event.sessionId)) return;
        if (this.telemetry.hasAgentSessionId(event.sessionId)) return;
        this.telemetry.notifyAgentSessionId(event.sessionId, event.capturedId);
        return;
      case 'streamTelemetry':
        if (!this.registry.has(event.sessionId)) return;
        if (event.usage) this.telemetry.setSessionUsage(event.sessionId, event.usage);
        if (event.events && event.events.length > 0) this.telemetry.ingestEvents(event.sessionId, event.events);
        return;
      case 'trace':
        recordTerminalTrace(event.sessionId, event.event, event.detail, event.ts);
        return;
      case 'exit':
      case 'rawData':
      case 'rawExit':
      case 'cliSpawned':
      case 'cliData':
      case 'cliError':
      case 'cliExit':
      case 'cliClose':
        // Routed per PTY or per CLI run by the host client, never here.
        return;
      default: {
        const unknownEvent: never = event;
        console.warn('[SessionManager] unknown pty host event', unknownEvent);
      }
    }
  }

  /**
   * Receive a session's raw output as 'data-tap' events until the returned
   * function is called. Reference-counted per session: the host sends a
   * session's bytes to main only while someone holds a subscription, so a
   * flood in an unwatched session costs main nothing.
   */
  subscribeDataTap(sessionId: string): () => void {
    this.dataTapRefs.set(sessionId, (this.dataTapRefs.get(sessionId) ?? 0) + 1);
    this.publishTapped();
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const remaining = (this.dataTapRefs.get(sessionId) ?? 1) - 1;
      if (remaining > 0) this.dataTapRefs.set(sessionId, remaining);
      else this.dataTapRefs.delete(sessionId);
      this.publishTapped();
    };
  }

  private publishTapped(): void {
    this.host.post({ type: 'setTapped', sessionIds: [...this.dataTapRefs.keys()] });
  }

  /** The pty host process's pid while it runs (null in-process), for the quit
   *  drain: the host flushes and exits after the PTYs die. */
  getPtyHostPid(): number | null {
    return this.host.hostPid;
  }

  /** Run a one-shot child process in the pty host (`off-main-exec.ts`). */
  execInPtyHost(request: HostExecRequest, timeoutMs: number): Promise<HostExecResult> {
    return this.host.exec(request, timeoutMs);
  }

  /** Spawn a probe's raw PTY in the pty host (`off-main-pty.ts`). */
  spawnRawInPtyHost(file: string, args: string[], options: OffMainPtyOptions): Promise<OffMainPty> {
    return this.host.spawnRaw(file, args, options);
  }

  /** Start an agent CLI run in the pty host (`off-main-cli.ts`). */
  spawnCliInPtyHost(command: string, args: string[], options: OffMainCliOptions): CliChildProcess {
    return this.host.spawnCli(command, args, options);
  }

  /**
   * Close the pty host's handle on a project's database before it is deleted.
   * Never rejects: a host that is down holds no handle.
   */
  async closeProjectInPtyHost(projectId: string): Promise<void> {
    try {
      await this.host.transport.request('closeProject', { projectId });
    } catch (error) {
      console.warn('[pty-host] closing a project database failed:', error);
    }
  }

  /**
   * Re-deliver the PTY's geometry to a child that was still booting when a
   * resize was applied (see `ManagedSession.resizeAppliedBeforeTuiReady`).
   * A resize applied to a RUNNING child reliably reaches it (verified live:
   * a hand-resize healed a stuck frame mid-turn), so the whole question is
   * WHEN the child is demonstrably up. Two triggers fire this, at most one
   * jiggle each: the adapter's first-output latch (which a shell preamble
   * can trip early - it disarms only when the output provably came from the
   * TUI) and the stream's first alt-screen entry (which nothing but the TUI
   * can produce, and which always disarms). Task #573's live recurrence
   * (2026-08-30) is the case the second trigger exists for: pwsh's preamble
   * tripped first-output ~80ms after spawn, the fit resize then read as
   * post-first-output and never armed under the old criterion, and the
   * agent booting seconds later composed at the spawn width all turn.
   *
   * The re-assert is a jiggle - cols-1, then cols back - because a same-dims
   * delivery can be deduplicated anywhere in the chain (our own resize() would
   * noop it, and ConPTY/terminals may too); two genuine changes cannot. It
   * calls `session.pty.resize()` directly, NOT this.resize(): the ladder's
   * same-dims short-circuit would eat the restore leg, and its side effects
   * (pty-resize broadcasts burning the renderer's echo re-assert budget and
   * re-seeding phone frames, bufferManager.onResize stacking a repaint-settle
   * upgrade) are churn for a net-unchanged geometry that was already clamped
   * and policy-approved when it was first applied. cols-1 rather than cols+1
   * so the transient never exceeds the mounted xterm's grid. Back-to-back legs
   * are safe even if the chain coalesces them: the coalesced final size still
   * differs from the child's stale belief.
   *
   * Unconditional across platforms on purpose: the lost-resize window is
   * ConPTY-specific (a POSIX pty's winsize is kernel state the child reads at
   * TUI init), but on POSIX the jiggle costs only one extra SIGWINCH repaint
   * at first output, and one ungated code path means CI's Linux unit tests
   * exercise exactly what Windows ships.
   */
  private reassertGeometryForBootingChild(
    sessionId: string,
    { trigger, disarm }: { trigger: 'first-output' | 'alt-screen-enter'; disarm: boolean },
  ): void {
    const session = this.registry.get(sessionId);
    if (!session?.pty || !session.resizeAppliedBeforeTuiReady) return;
    if (disarm) session.resizeAppliedBeforeTuiReady = false;
    const { cols, rows } = session.pty;
    const jiggleCols = Math.max(2, cols - 1);
    if (jiggleCols === cols) return;
    try {
      session.pty.resize(jiggleCols, rows);
    } catch (error) {
      // node-pty can throw on a just-died ConPTY; the exit path owns cleanup.
      // Nothing landed, so the child still holds `cols`.
      traceTerminal(sessionId, 'resize-reassert-failed', { trigger, leg: 'jiggle', message: String(error) });
      return;
    }
    try {
      session.pty.resize(cols, rows);
      traceTerminal(sessionId, 'resize-reassert', { trigger, cols, rows, jiggleCols });
    } catch (error) {
      // The narrow leg landed but the restore did not: node-pty caches dims
      // only on a successful resize, so the child sits at cols-1 until the
      // next real resize. The leg field lets forensics tell this stranded
      // case from the harmless jiggle-leg failure above.
      traceTerminal(sessionId, 'resize-reassert-failed', { trigger, leg: 'restore', message: String(error) });
    }
  }

  setMaxConcurrent(max: number): void {
    this.sessionQueue.setMaxConcurrent(max);
  }

  setIdleTimeout(minutes: number): void {
    this.telemetry.setIdleTimeout(minutes);
  }

  /**
   * Hydrate known context windows from persisted metrics
   * (config `discoveredContextWindowsByAgent`), relayed from
   * `applyRuntimeConfig`. See `SessionTelemetry.hydrateKnownWindows`.
   */
  hydrateDiscoveredContextWindows(entries: Array<{ modelId: string; contextWindowSize: number }>): void {
    this.telemetry.hydrateKnownWindows(entries);
  }

  /**
   * Enable transcript capture, once at startup: `sinkFor` is where a project's
   * transcripts are written. Each session writes to its own project's sink
   * (see `TranscriptWriter`). Without this, PTY output is not persisted (only
   * kept in the in-memory ring buffer).
   */
  enableTranscripts(sinkFor: (projectId: string) => TranscriptSink | null): void {
    // Read only by an in-process host. The utility process opens each
    // project's database itself and writes there, so the pieces never cross
    // main (sending them to another process measured at 13 times main's
    // major-GC time).
    this.transcriptSinkFor = sinkFor;
  }

  dispose(): void {
    this.telemetry.dispose();
    // Flush every transcript. A utility host then exits once every PTY's exit
    // callback has landed (killAll posted the kills, a young one's after its
    // grace), within the bound killAll worked out from the drain's deadline.
    this.host.shutdown(this.hostExitWaitMs);
    for (const sessionId of [...this.restingGridTimers.keys()]) this.cancelRestingGridRestore(sessionId);
  }

  /**
   * Set which sessions a RENDERER currently has visible (terminal panel, command
   * bar overlay, task-detail windows).
   *
   * Keyed by renderer, not global, because more than one renderer can host a
   * terminal: the detached Agent Monitor is its own window with its own visible
   * set. A single shared set meant last-writer-wins, so two renderers publishing
   * focus would silently starve each other's terminals of PTY data.
   *
   * The emit gate stays the UNION (`isSessionFocused`), so nothing about when
   * data is produced changes; what the per-renderer split buys is knowing WHERE
   * to send it.
   */
  setFocusedSessions(sessionIds: string[], rendererId = SHARED_RENDERER_ID): void {
    const previousForRenderer = this.focusedByRenderer.get(rendererId);
    if (sessionIds.length === 0) this.focusedByRenderer.delete(rendererId);
    else this.focusedByRenderer.set(rendererId, new Set(sessionIds));
    this.recomputeFocusedUnion();
    // Prior in-flight accounting is stale for the sessions THIS renderer just
    // changed: one leaving its visible set would otherwise stay paused forever,
    // because that renderer no longer acks its data. Resume those and clear
    // their counters; backpressure rebuilds from zero as fresh data flows to the
    // now-focused terminals (the scrollback replay catches them up).
    //
    // Scoped to the caller's own sessions on purpose. This used to be a blanket
    // `backpressure.reset()`, which was safe only while a single renderer
    // published focus. The detached Agent Monitor is a second publisher, and its
    // effect re-runs on any session-list change, so a blanket reset would
    // force-resume a PTY the OTHER window is still actively throttling and zero
    // its unacked byte count, defeating backpressure for a session this renderer
    // has no relationship to.
    const affectedSessionIds = new Set(previousForRenderer);
    for (const sessionId of sessionIds) affectedSessionIds.add(sessionId);
    this.host.post({ type: 'releaseBackpressure', sessionIds: [...affectedSessionIds] });
    for (const sessionId of affectedSessionIds) this.reconsiderRestingGrid(sessionId);
  }

  /**
   * Set which sessions a RENDERER has an xterm mounted for. Same whole-set
   * replace, keyed by renderer, as setFocusedSessions - and published by the
   * terminals themselves rather than derived from view state, because "is a
   * grid held" is a mount fact, not a visibility one.
   */
  setMountedSessions(sessionIds: string[], rendererId = SHARED_RENDERER_ID): void {
    const previousForRenderer = this.mountedByRenderer.get(rendererId);
    if (sessionIds.length === 0) this.mountedByRenderer.delete(rendererId);
    else this.mountedByRenderer.set(rendererId, new Set(sessionIds));
    this.recomputeMountedUnion();
    const affectedSessionIds = new Set(previousForRenderer);
    for (const sessionId of sessionIds) affectedSessionIds.add(sessionId);
    for (const sessionId of affectedSessionIds) this.reconsiderRestingGrid(sessionId);
  }

  /** Sessions some renderer still has an xterm mounted for. */
  getMountedSessions(): Set<string> {
    return this.mountedSessionIds;
  }

  /** A session is HELD while any renderer shows it or holds a grid for it. */
  private isSessionHeld(sessionId: string): boolean {
    return this.focusedSessionIds.has(sessionId) || this.mountedSessionIds.has(sessionId);
  }

  private reconsiderRestingGrid(sessionId: string): void {
    if (this.isSessionHeld(sessionId)) this.cancelRestingGridRestore(sessionId);
    else this.scheduleRestingGridRestore(sessionId);
  }

  /**
   * Park a session's grid at the resting grid once NO renderer is
   * showing it.
   *
   * A PTY has exactly one grid, and every surface that displays a session fits
   * that grid to its own box. The bottom panel is a wide, short strip, so a
   * session last shown there is left at something like 306x14 - and nothing
   * gave it back, so the agent kept working in a 14-row window and any other
   * reader inherited one. That is worst on a phone, which mirrors the grid 1:1
   * and cannot fill its screen from 14 rows, but a 14-row TUI is a poor frame
   * for the agent itself too.
   *
   * Fires only when NOTHING holds the session: no renderer shows it and none
   * has an xterm mounted for it (see mountedByRenderer - a parked terminal
   * still holds its grid, and reshaping under one is unrecoverable).
   *
   * Deliberately debounced rather than fired on unfocus: switching surfaces
   * unfocuses and refocuses within a frame or two, and a restore in that gap
   * would add two reflows to every switch. Waiting means only a session that
   * STAYS unwatched is reshaped.
   *
   * Cost when it does fire: the next open of that session pays a marker settle
   * (~20-40ms, measured in the rows-only-settle work) because the grid changed
   * while it was away. That is the same cost any surface switch already pays.
   */
  private scheduleRestingGridRestore(sessionId: string): void {
    if (this.restingGridTimers.has(sessionId)) return;
    const timer = setTimeout(() => {
      this.restingGridTimers.delete(sessionId);
      this.restoreRestingGrid(sessionId);
    }, this.restingGridDelayMs);
    // Never hold the process open for housekeeping.
    if (typeof timer.unref === 'function') timer.unref();
    this.restingGridTimers.set(sessionId, timer);
  }

  private cancelRestingGridRestore(sessionId: string): void {
    const timer = this.restingGridTimers.get(sessionId);
    if (timer === undefined) return;
    clearTimeout(timer);
    this.restingGridTimers.delete(sessionId);
  }

  private restoreRestingGrid(sessionId: string): void {
    // The debounced path additionally requires a phone actually streaming
    // this session: the park is a mobile feature, and a desktop with no
    // watcher must never pay its reflow.
    this.parkRestingGrid(sessionId, { requireStreamSubscriber: true });
  }

  private parkRestingGrid(
    sessionId: string,
    options: { requireStreamSubscriber: boolean; overrideHoldBelowFloor?: boolean },
  ): void {
    // Re-check everything at fire time: a session can be shown again, gone,
    // or handed to a phone during the wait.
    const session = this.registry.get(sessionId);
    if (!session?.pty) return;
    // A desktop surface holding the grid normally blocks the park outright.
    // The subscribe-time caller overrides that for a grid below the phone
    // floor: the only surface that holds a sub-floor grid is the bottom
    // panel's strip, and a phone subscribing to it would otherwise be stuck
    // in a sliver view it cannot escape from away from the desk. The panel
    // then renders the resting grid clipped - the same state it is in
    // whenever a task detail owns the grid.
    if (this.isSessionHeld(sessionId)) {
      const belowFloor = session.pty.rows < MOBILE_USABLE_MIN_ROWS;
      if (!(options.overrideHoldBelowFloor === true && belowFloor)) return;
    }
    // No probe means no bridge attached, which means no paired phone exists:
    // the park never fires and an unpaired desktop behaves exactly as it did
    // before the park existed.
    const probe = this.mobileTerminalProbe;
    if (!probe) return;
    // An armed size guard is a live phone hold. Asked of the guard registry,
    // never a last-writer origin: a desktop resize makes itself the last
    // writer while the guard stays armed, and parking then would reshape the
    // PTY out from under the still-holding phone.
    if (probe.isSizeHeld(sessionId)) return;
    if (options.requireStreamSubscriber && !probe.hasStreamSubscriber(sessionId)) return;
    if (session.pty.cols === RESTING_GRID_COLS && session.pty.rows === RESTING_GRID_ROWS) return;
    this.resize(sessionId, RESTING_GRID_COLS, RESTING_GRID_ROWS, 'park');
  }

  /**
   * Immediate park on behalf of a phone whose read-stream subscribe is being
   * served RIGHT NOW: the subscription is not registered yet (the snapshot is
   * built first), so the caller vouches for the interest the probe cannot see
   * and skips the debounce so the one seed already carries the resting grid.
   * Every other fire-time check still applies - held sessions and phone-held
   * grids are never touched.
   */
  parkRestingGridForMobileSubscriber(sessionId: string): void {
    this.cancelRestingGridRestore(sessionId);
    this.parkRestingGrid(sessionId, { requireStreamSubscriber: false, overrideHoldBelowFloor: true });
  }

  /**
   * Re-run the resting-grid decision after a mobile size-guard release: the
   * guard restored the desktop grid, and if nothing else holds the session it
   * should park again after the usual debounce (which is what lets the phone
   * see park dims and re-request its grid on its next visit).
   */
  reconsiderRestingGridAfterMobileRelease(sessionId: string): void {
    this.reconsiderRestingGrid(sessionId);
  }

  /** See MobileTerminalProbe. Called once by the mobile bridge when it attaches. */
  setMobileTerminalProbe(probe: MobileTerminalProbe): void {
    this.mobileTerminalProbe = probe;
  }

  /**
   * The renderer reports that it has consumed `bytes` of this session's output
   * (written to xterm or deliberately dropped during scrollback replay), which
   * drops the in-flight count and resumes a paused PTY once it has caught up.
   * Acking dropped bytes too is essential: otherwise a session whose data is
   * dropped (overlay / scrollback reload) would never resume.
   */
  acknowledgeDrain(sessionId: string, bytes: number): void {
    this.host.post({ type: 'ack', sessionId, bytes });
  }

  /**
   * User pressed Ctrl+C in the terminal. Forwarded to telemetry's
   * `UserInterruptCoordinator`, which arms a settle timer; if the
   * agent's own hooks don't recover the engine state within the
   * window, telemetry synthesizes an Interrupted event. The renderer
   * has already sent \x03 to the PTY via the normal `write` path -
   * this is purely a parallel signal for engine recovery.
   *
   * Named `signalUserInterrupt` (not `notifyUserInterrupt`) to convey
   * "fire-and-forget signal to a downstream coordinator" rather than
   * "telemetry call". The IPC handler invokes this; the actual
   * coordinator method is `UserInterruptCoordinator.notify`.
   */
  signalUserInterrupt(sessionId: string): void {
    this.telemetry.notifyUserInterrupt(sessionId);
  }

  /** Return the union of every renderer's focused session IDs. */
  getFocusedSessions(): Set<string> {
    return this.focusedSessionIds;
  }

  /**
   * The renderers that currently have this session visible. The IPC layer sends
   * that session's data to exactly these, instead of blanket-sending to the main
   * window - which is both correct for a detached host and strictly less IPC
   * than before for everyone else.
   */
  getRenderersFocusedOn(sessionId: string): number[] {
    const renderers: number[] = [];
    for (const [rendererId, sessionIds] of this.focusedByRenderer) {
      if (sessionIds.has(sessionId)) renderers.push(rendererId);
    }
    return renderers;
  }

  /**
   * Drop a renderer's claims when its window goes away - BOTH its focus set
   * and its mounted set (kept under the original name because it is the one
   * teardown call site, wired once per renderer in the session IPC handlers).
   * Its terminals died with it, so neither claim can be renewed.
   */
  clearFocusedSessionsFor(rendererId: number): void {
    const departingSessionIds = this.focusedByRenderer.get(rendererId);
    const departingMountedIds = this.mountedByRenderer.get(rendererId);
    const hadMounted = this.mountedByRenderer.delete(rendererId);
    if (hadMounted) this.recomputeMountedUnion();
    if (!this.focusedByRenderer.delete(rendererId)) {
      // Nothing focused, but its terminals still died with it.
      for (const sessionId of departingMountedIds ?? []) this.reconsiderRestingGrid(sessionId);
      return;
    }
    this.recomputeFocusedUnion();
    // A closed window leaves its sessions unwatched exactly as an unfocus
    // does; park their grids on the same delay.
    for (const sessionId of new Set([...(departingSessionIds ?? []), ...(departingMountedIds ?? [])])) {
      this.reconsiderRestingGrid(sessionId);
    }
    // Rescue only the sessions this renderer was the LAST consumer of. Their
    // in-flight bytes can never be acked (the window that was reading them is
    // gone), so without this a session that crossed the high-water mark just as
    // its sole renderer died would stay paused forever and the agent would
    // stall. A session another renderer still has visible keeps its accounting,
    // which the blanket reset this replaces would have wrongly zeroed.
    const orphanedSessionIds = [...(departingSessionIds ?? [])].filter((sessionId) => !this.focusedSessionIds.has(sessionId));
    if (orphanedSessionIds.length > 0) this.host.post({ type: 'releaseBackpressure', sessionIds: orphanedSessionIds });
  }

  private recomputeFocusedUnion(): void {
    const union = new Set<string>();
    for (const sessionIds of this.focusedByRenderer.values()) {
      for (const sessionId of sessionIds) union.add(sessionId);
    }
    // Trace the EDGES of the emit gate. This union is what decides whether a
    // session's PTY data reaches any renderer at all, so a session silently
    // leaving it is the difference between "the terminal is stale" and "the
    // terminal is broken" - and until now it produced no trace on either side,
    // which is why a gap in a session's byte stream was unattributable.
    //
    // Gated at the BLOCK, not left to traceTerminal's own early return: the
    // detail objects are built by the caller, so an ungated block allocates one
    // per changed session in production to hand to a no-op. Same reason the
    // renderer's hot trace sites pass thunks.
    if (__KANGENTIC_DEV__) {
      for (const sessionId of union) {
        if (!this.focusedSessionIds.has(sessionId)) {
          traceTerminal(sessionId, 'focus-union-gained', { renderers: this.focusedByRenderer.size });
        }
      }
      for (const sessionId of this.focusedSessionIds) {
        if (!union.has(sessionId)) {
          traceTerminal(sessionId, 'focus-union-lost', { renderers: this.focusedByRenderer.size });
        }
      }
    }
    this.focusedSessionIds = union;
    // The host emits output only for these, so an unwatched session's bytes
    // never reach this process.
    this.host.post({ type: 'setFocused', sessionIds: [...union] });
  }

  private recomputeMountedUnion(): void {
    const union = new Set<string>();
    for (const sessionIds of this.mountedByRenderer.values()) {
      for (const sessionId of sessionIds) union.add(sessionId);
    }
    this.mountedSessionIds = union;
  }

  setShell(shell: string | null): void {
    this.configuredShell = shell;
  }

  /** Return the resolved shell name (configured or system default). */
  async getShell(): Promise<string> {
    return this.configuredShell || await this.shellResolver.getDefaultShell();
  }

  // Tracks sessions currently inside doSpawn() but not yet stored in the
  // sessions map. Included in activeCount so shouldQueue() sees the true load.
  private spawningCount = 0;

  private get activeCount(): number {
    return this.spawningCount + this.registry.countRunning();
  }

  /**
   * Every spawn inside doSpawn(), by session id. A spawn waits on the shell
   * and then on the pty host's round trip, and a teardown can land in either
   * wait: a To Do move that kills and removes a queued task's placeholder while
   * its promotion spawns, a suspend, a task delete. kill(), suspend() and the
   * task-wide teardowns mark the matching spawn cancelled, and the spawn flow
   * then stops what the host started instead of registering it
   * (`abandonCancelledSpawn`).
   */
  private readonly spawnsInFlight = new Map<string, InFlightSpawn>();

  /**
   * Wait for spawns to settle, at most as long as awaitExit waits for a PTY.
   * A teardown that removes a working directory waits here for a spawn it
   * cancelled, whose PTY holds that directory until it exits.
   */
  private awaitSpawnsSettled(spawns: InFlightSpawn[]): Promise<void> {
    if (spawns.length === 0) return Promise.resolve();
    return new Promise<void>((resolve) => {
      const safetyTimeout = setTimeout(() => {
        console.warn('[SessionManager] a cancelled spawn did not settle in time; its PTY may still hold the working directory');
        resolve();
      }, SPAWN_SETTLE_TIMEOUT_MS);
      void Promise.all(spawns.map((spawn) => spawn.settled)).then(() => {
        clearTimeout(safetyTimeout);
        resolve();
      });
    });
  }

  private cancelSpawnInFlight(sessionId: string): void {
    const inFlight = this.spawnsInFlight.get(sessionId);
    if (inFlight) inFlight.cancelled = true;
  }

  private cancelTaskSpawnsInFlight(taskId: string): void {
    for (const inFlight of this.spawnsInFlight.values()) {
      if (inFlight.taskId === taskId) inFlight.cancelled = true;
    }
  }

  get queuedCount(): number {
    return this.sessionQueue.length;
  }

  /** Lightweight session counts without allocating mapped Session objects. */
  getSessionCounts(): { active: number; suspended: number; total: number } {
    return this.registry.getSessionCounts();
  }

  async spawn(input: SpawnSessionInput): Promise<Session> {
    if (isShuttingDown()) {
      throw new Error('Cannot spawn session during shutdown');
    }

    if (this.sessionQueue.shouldQueue()) {
      // Return a queued placeholder immediately (don't block the caller).
      // SessionQueue will promote it to a running PTY when a slot opens.
      const id = input.id ?? uuidv4();
      const inputWithId = { ...input, id };
      const session: ManagedSession = {
        id,
        taskId: input.taskId,
        projectId: input.projectId,
        pty: null,
        status: 'queued',
        shell: '',
        cwd: input.cwd,
        startedAt: new Date().toISOString(),
        exitCode: null,
        resuming: input.resuming ?? false,
        transient: input.transient ?? false,
        commandTerminalSlot: input.commandTerminalSlot ?? null,
        commandTerminalBranch: input.commandTerminalBranch ?? null,
        isolatedSwimlaneId: input.isolatedSwimlaneId,
        exitSequence: input.exitSequence ?? ['\x03'],
        agentParser: input.agentParser,
      };
      this.registry.set(id, session);
      this.sessionQueue.enqueue(inputWithId);
      this.emit('session-changed', id, toSession(session));
      return toSession(session);
    }

    // Reserve a slot so concurrent spawn() calls see the correct count
    this.spawningCount++;
    try {
      return await this.doSpawn(input);
    } finally {
      this.spawningCount--;
      // Essential on failure path (doSpawn throws before onExit is registered).
      // On success path this is a no-op absorbed by the reentrancy guard -
      // the real promotion happens later in onExit when the PTY exits.
      this.sessionQueue.notifySlotFreed();
    }
  }

  private async doSpawn(input: SpawnSessionInput): Promise<Session> {
    // The id is fixed here rather than in the spawn flow, so a teardown that
    // lands before the host answers can find this spawn by it.
    const id = input.id ?? uuidv4();
    let markSettled: () => void = () => undefined;
    const inFlight: InFlightSpawn = {
      taskId: input.taskId,
      cancelled: false,
      abandonedPtyExit: null,
      settled: new Promise<void>((resolve) => { markSettled = resolve; }),
    };
    this.spawnsInFlight.set(id, inFlight);
    const settle = (): void => {
      if (this.spawnsInFlight.get(id) === inFlight) this.spawnsInFlight.delete(id);
      markSettled();
    };
    try {
      return await this.performTrackedSpawn({ ...input, id });
    } finally {
      // An abandoned spawn settles once the PTY the host started has exited;
      // until then it is still in flight for a teardown waiting on it.
      if (inFlight.abandonedPtyExit) void inFlight.abandonedPtyExit.then(settle);
      else settle();
    }
  }

  private performTrackedSpawn(input: SpawnSessionInput): Promise<Session> {
    return performSpawn(input, {
      registry: this.registry,
      host: this.host,
      telemetry: this.telemetry,
      sessionIdManager: this.sessionIdManager,
      sessionFiles: this.sessionFiles,
      statusFileReader: this.statusFileReader,
      sessionHistoryReader: this.sessionHistoryReader,
      sessionQueue: this.sessionQueue,
      firstOutputTracker: this.firstOutputTracker,
      setBufferCols: (sessionId, cols) => {
        this.bufferCols.set(sessionId, cols);
        this.inAltScreen.delete(sessionId);
      },
      getShell: () => this.getShell(),
      takePendingResize: (sessionId) => {
        const dims = this.pendingResizes.get(sessionId);
        this.pendingResizes.delete(sessionId);
        return dims;
      },
      emit: (event, ...args) => this.emit(event, ...args),
      isSpawnCancelled: (sessionId) => this.spawnsInFlight.get(sessionId)?.cancelled === true,
      onSpawnAbandoned: (sessionId, ptyExited) => {
        const inFlight = this.spawnsInFlight.get(sessionId);
        if (inFlight) inFlight.abandonedPtyExit = ptyExited;
      },
    });
  }

  /**
   * True when the session has a live PTY that `write()` will actually deliver
   * to (as opposed to a suspended/queued/exited session still in the registry
   * with a null pty, whose writes `write()` silently drops). Lets a caller
   * distinguish "delivered" from "dropped" instead of assuming existence means
   * writability.
   */
  isWritable(sessionId: string): boolean {
    return !!this.registry.get(sessionId)?.pty;
  }

  /**
   * Enqueue bytes for the session's PTY.
   *
   * `origin` tells the prompt-draft ledger whether these bytes are something a
   * human typed. It defaults to `'system'` so an unmarked caller can never be
   * mistaken for user input; the human-facing entry points (the renderer's
   * SESSION_WRITE, dictation, the mobile bridge's interactive terminal and
   * permission-prompt answers) pass `'user'` explicitly.
   */
  write(sessionId: string, data: string, origin: WriteOrigin = 'system'): void {
    const session = this.registry.get(sessionId);
    if (!session?.pty || data.length === 0) return;

    this.promptDrafts.record(sessionId, data, origin);

    let queue = this.writeQueues.get(sessionId);
    if (!queue) {
      queue = createWriteQueue(
        () => this.registry.get(sessionId)?.pty ?? null,
        undefined,
        { onAutoDispose: () => this.writeQueues.delete(sessionId) },
      );
      this.writeQueues.set(sessionId, queue);
    }
    queue.enqueue(data);
  }

  /**
   * Resolve once the session's write queue has flushed all enqueued bytes
   * to the PTY. Used by callers that need to sequence follow-up keystrokes
   * after a large paste (e.g. the embedded browser pane sends payload ->
   * await drain -> Escape -> Enter so the submit keystrokes don't race the
   * chunked drain loop and split the paste mid-stream).
   * Resolves immediately if there is no active queue or it is already idle.
   */
  drain(sessionId: string): Promise<void> {
    const queue = this.writeQueues.get(sessionId);
    if (!queue) return Promise.resolve();
    return queue.drained();
  }

  /**
   * Text the user has typed into this session's prompt and not yet sent, or
   * null when the prompt looks empty. Used by keystroke injection to decide
   * whether a clear is needed and to report what it discarded.
   */
  getPendingDraft(sessionId: string): string | null {
    return this.promptDrafts.get(sessionId);
  }

  /**
   * Write `data` to the session's PTY in a single, un-chunked `pty.write`
   * call. This BYPASSES the per-session FIFO write queue and the 4KB
   * chunking that the queue enforces.
   *
   * Use this only when atomicity matters more than backpressure-friendly
   * chunking, e.g. for the bracketed-paste-and-submit packet
   * (`\e[200~ ... \e[201~\r`) where chunking can split the close marker
   * and the trailing Enter across separate kernel reads, causing the TUI
   * to see them as racing events. Empirically reproduced via
   * `scripts/paste-harness.js` `split-cr`: 4/5 success vs `combined-cr`
   * 10/10 success.
   *
   * Caller responsibility: await `drain(sessionId)` first if the queue
   * may have pending bytes; otherwise `writeRaw` can interleave with
   * still-draining chunks.
   */
  writeRaw(sessionId: string, data: string): void {
    const session = this.registry.get(sessionId);
    if (!session?.pty || data.length === 0) return;
    session.pty.write(data);
  }

  resize(
    sessionId: string,
    cols: number,
    rows: number,
    // 'spawn' is excluded: the spawn grid is announced by performSpawn's own
    // pty-resize emit, never passed through resize(). Deriving from the shared
    // type keeps the two unions linked when PtyResizeOrigin grows.
    origin: Exclude<PtyResizeOrigin, 'spawn'> = 'desktop',
  ): SessionResizeResult {
    const session = this.registry.get(sessionId);

    // Guard against NaN/Infinity from layout edge cases (e.g. getComputedStyle
    // returning "" during unmount, yielding parseInt -> NaN)
    if (!Number.isFinite(cols) || !Number.isFinite(rows)) {
      traceTerminal(sessionId, 'resize-invalid', { origin, cols, rows });
      return { colsChanged: false };
    }

    // Clamp to valid dimensions (node-pty throws on 0 or negative)
    const clampedCols = Math.max(2, Math.floor(cols));
    const clampedRows = Math.max(1, Math.floor(rows));

    // A queued or suspended session stashes the dims instead of reshaping. A
    // resize can beat the auto-resume spawn (the renderer mounts and fits
    // before the main-process spawn lands), arrive while a session awaits
    // (re)spawn, or land in suspend's marked-but-alive window: suspend() sets
    // status BEFORE gracefulPtyShutdown resolves, so `session.pty` can still be
    // non-null for up to ~3s of teardown, and reshaping that dying PTY would
    // SIGWINCH a mid-exit agent and re-broadcast an echo that arms further
    // re-asserts on other mounted terminals. Stashing records the INTENT so
    // performSpawn spawns the respawned PTY at the real size, closing the
    // stale-geometry race at the source.
    if (session && (session.status === 'queued' || session.status === 'suspended')) {
      // The floor applies to the stash too: a sub-floor desktop fit landing
      // in the suspended window (mid-suspend, pre-respawn) would otherwise
      // respawn the PTY at the strip while a phone streams it, and pair the
      // seed's ptyDimensions with a frame serialized at the old grid. The
      // desktop's INTENT is still recorded below, exactly like the live
      // refusal.
      const subFloorForStreamingPhone =
        origin === 'desktop' &&
        clampedRows < MOBILE_USABLE_MIN_ROWS &&
        this.mobileTerminalProbe?.hasStreamSubscriber(sessionId) === true;
      if (!subFloorForStreamingPhone) {
        this.pendingResizes.set(sessionId, { cols: clampedCols, rows: clampedRows });
      }
      if (origin === 'desktop') {
        this.lastDesktopDimensions.set(sessionId, { cols: clampedCols, rows: clampedRows });
      }
      traceTerminal(sessionId, 'resize-stash', {
        origin,
        cols: clampedCols,
        rows: clampedRows,
        status: session.status,
        stashed: !subFloorForStreamingPhone,
      });
      return { colsChanged: false };
    }

    if (!session?.pty) {
      // No session, or an exited/killed one. Never stash here - the session is
      // not coming back, and xterm never re-sends unchanged dims, so a
      // resurrected 120x30 would stick forever. Distinct trace event from
      // 'resize-stash' so the merged trace separates "nothing to resize" from
      // "deferred to the respawn".
      traceTerminal(sessionId, 'resize-ignored', {
        origin,
        cols: clampedCols,
        rows: clampedRows,
        status: session?.status ?? 'unknown',
      });
      return { colsChanged: false };
    }

    // Someone is sizing this session again, so the pending park is moot -
    // whatever fired the resize is either showing it or holding its grid.
    this.cancelRestingGridRestore(sessionId);

    if (origin === 'desktop') {
      // Only a REAL desktop resize may set the restore target. The park
      // resizes through this same method (it must - the buffer settle, the
      // activity suppression, and the pty-resize emit below all matter), and
      // recording ITS 120x30 here is exactly the clobber that made a later
      // release-size "restore" a phone to the park instead of the desktop.
      this.lastDesktopDimensions.set(sessionId, { cols: clampedCols, rows: clampedRows });
    } else if (!this.lastDesktopDimensions.has(sessionId)) {
      // First mobile- or park-origin resize for a session the desktop never
      // resized: snapshot the current grid as the restore target before
      // changing it.
      this.lastDesktopDimensions.set(sessionId, { cols: session.pty.cols, rows: session.pty.rows });
    }

    if (
      origin === 'desktop' &&
      clampedRows < MOBILE_USABLE_MIN_ROWS &&
      this.mobileTerminalProbe?.hasStreamSubscriber(sessionId) === true
    ) {
      // A phone mirrors this grid 1:1 and cannot make a strip taller, so a
      // sub-floor grid renders a sliver of the phone screen with no way to
      // recover away from the desktop. The bottom terminal panel is the case
      // that hits this: its wide short strip (~306x14) grabs the grid
      // whenever it becomes the surviving surface (user decision 2026-08-02:
      // that view must never reach a phone). Refusing here leaves the panel
      // rendering the taller grid clipped - exactly what it already does
      // while a task detail owns the grid - and it self-heals: the next
      // panel-layout fit after the phone unsubscribes goes through, and the
      // restore target above already records what the desktop wanted. The
      // refusal happens BEFORE bufferManager.onResize so the headless
      // parser's grid never diverges from the real PTY. Desktops with no
      // streaming phone never take this branch.
      //
      // The cancel above assumed the resize would be honored; a REFUSED
      // resize must not eat a pending park, or a sub-floor session whose
      // rescue was mid-debounce would strand on the sliver. Re-running the
      // decision re-checks everything at fire time, so this is free when no
      // park is actually due.
      this.reconsiderRestingGrid(sessionId);
      traceTerminal(sessionId, 'resize-refused', {
        origin,
        cols: clampedCols,
        rows: clampedRows,
        ptyCols: session.pty.cols,
        ptyRows: session.pty.rows,
        reason: 'sub-floor-mobile-hold',
      });
      // `refused` tells the echo re-assert (the width-drift self-heal) that
      // main is deliberately holding this grid, so it stops immediately
      // instead of burning its retry budget against the floor. `held` names
      // the grid kept, so the refused terminal can conform to it (resize its
      // own grid to the PTY's and scale its font to fit) instead of showing
      // the taller frame clipped.
      return { colsChanged: false, refused: true, held: { cols: session.pty.cols, rows: session.pty.rows } };
    }

    // The host's buffer keeps its headless parser on the new grid and arms the
    // repaint settle; colsChanged reports against main's mirror of the width
    // that buffer last had, which only this method and the spawn change.
    const previousBufferCols = this.bufferCols.get(sessionId);
    const colsChanged = previousBufferCols !== undefined && clampedCols !== previousBufferCols;
    if (previousBufferCols !== undefined) this.bufferCols.set(sessionId, clampedCols);
    this.host.post({ type: 'resizeBuffer', sessionId, cols: clampedCols, rows: clampedRows });
    if (clampedCols === session.pty.cols && clampedRows === session.pty.rows) {
      // The grid is not changing, so reshaping the PTY, suppressing activity
      // transitions, and emitting pty-resize would all be pure churn - the
      // emit especially: a task-detail remount re-sends its unchanged fit
      // (xterm only skips re-sending within one instance's lifetime), and
      // broadcasting it made every subscribed phone re-seed a byte-identical
      // frame over the relay (measured live 2026-08-02). The bookkeeping
      // above still ran: the park cancel and the desktop restore target
      // record INTENT, and the buffer manager saw the call so its
      // initial-resize-establishes-dimensions semantics hold.
      traceTerminal(sessionId, 'resize-noop', { origin, cols: clampedCols, rows: clampedRows });
      return { colsChanged };
    }
    try {
      session.pty.resize(clampedCols, clampedRows);
    } catch (error) {
      // node-pty throws a plain Error once the child has exited but before
      // onExit has nulled session.pty (up to ~1s on Windows, where the exit
      // event waits on the conout flush). Same hazard the jiggle ladder in
      // reassertGeometryForBootingChild guards; the exit path owns the
      // cleanup, so record it and return instead of rejecting the renderer's
      // resize invoke.
      traceTerminal(sessionId, 'resize-failed', {
        origin,
        cols: clampedCols,
        rows: clampedRows,
        message: String(error),
      });
      return { colsChanged };
    }
    // A resize applied while the agent is still booting can be lost: ConPTY
    // only delivers a resize to a connected client, and in the spawn window
    // the child is still starting behind the shell (and, under WSL, two
    // interop hops). Arm the post-boot re-assert so the geometry is
    // re-delivered once the child demonstrably exists. The criterion is
    // "the stream has not entered the alt buffer yet", NOT the first-output
    // latch: pwsh 7.6's startup preamble carries the cursor-hide escape that
    // adapter first-output detectors match (src/shared/paths.ts,
    // buildSpawnClearPrelude), so on that shell the latch reads "agent up"
    // within tens of ms of spawn while the agent is seconds away - exactly
    // the window whose resize is lost (task #573's live recurrence,
    // 2026-08-30). No shell enters the alt buffer, so a pre-alt-screen
    // resize always arms.
    //
    // This reads the CURRENT alt-screen state, not a once-ever latch, so a
    // booted TUI that drops to the normal buffer (`\x1b[?1049l`, or an RIS
    // `\x1bc`) and is resized during that excursion re-arms too, and its
    // next re-entry jiggles a child that was never booting. Deliberate: the
    // cost is one redundant re-delivery of geometry the child already has,
    // and a running child absorbs it, so it is not worth a second piece of
    // sticky per-session state to suppress.
    //
    // An inline-mode session's mid-turn resize arms a flag no remaining
    // trigger consumes - a dormant boolean that dies with the session, not a
    // jiggle. Any origin arms - the loss is about timing, not who asked.
    const preTuiReady = this.inAltScreen.get(sessionId) !== true;
    if (preTuiReady) {
      session.resizeAppliedBeforeTuiReady = true;
    }
    traceTerminal(sessionId, 'resize-applied', {
      origin,
      cols: clampedCols,
      rows: clampedRows,
      preTuiReady,
    });
    // Mark resize time so the host's redraw filter can suppress idle->thinking
    // transitions during the redraw burst that follows.
    this.host.post({ type: 'markResized', sessionId });
    // The mobile bridge's seam onto grid changes, mirroring 'data-tap':
    // read-stream forwards this to subscribed phones as a terminal-resize
    // event so their renderer matches the grid before the repaint bytes land.
    // The IPC handler also forwards it to renderers (SESSION_PTY_RESIZED) so
    // the mounted owner xterm can detect and heal a width divergence; the
    // origin lets it leave phone- and park-held grids alone.
    this.emit('pty-resize', sessionId, clampedCols, clampedRows, origin);
    return { colsChanged };
  }

  /**
   * The grid the session's terminal bytes are currently laid out for: the
   * live PTY's dimensions, or for a queued/suspended session the stashed
   * pre-spawn resize, falling back to the spawn defaults. Null only when
   * the session does not exist.
   */
  getDimensions(sessionId: string): { cols: number; rows: number } | null {
    const session = this.registry.get(sessionId);
    if (!session) return null;
    if (session.pty) return { cols: session.pty.cols, rows: session.pty.rows };
    const pending = this.pendingResizes.get(sessionId);
    if (pending) return { ...pending };
    return { cols: DEFAULT_PTY_COLS, rows: DEFAULT_PTY_ROWS };
  }

  /**
   * The restore target for a phone-held grid: the last desktop-origin
   * dimensions (see lastDesktopDimensions). Null when nothing was recorded,
   * i.e. no resize of either origin has touched the session.
   */
  getLastDesktopDimensions(sessionId: string): { cols: number; rows: number } | null {
    const dims = this.lastDesktopDimensions.get(sessionId);
    return dims ? { ...dims } : null;
  }

  /**
   * Fully remove a session from all internal maps: kill the PTY, clean up
   * session files, and delete from sessions/usage/activity caches.
   * Used during project deletion to prevent cross-project bleed.
   */
  remove(sessionId: string): void {
    // kill() may emit 'exit' events that depend on the session still being
    // in the map (the exit handler looks up the session by ID). Delete AFTER.
    const session = this.registry.get(sessionId);
    this.sessionIdManager.removeSession(sessionId);
    if (session) disposeAdapterAttachment(session);
    this.kill(sessionId);
    // Full cleanup including file deletion - the session is not coming back.
    this.sessionFiles.detachAndDelete(sessionId);
    // Announce the removal as its OWN fact, before the row disappears, so the
    // payload still carries taskId / projectId.
    //
    // kill() nulls session.pty synchronously but never touches status for a
    // PTY-backed session (a young session's real exit can still be up to
    // KILL_GRACE_MS away), and the renderer's SESSION_EXIT handler
    // deliberately ignores an intentional exit (App.tsx) so it never
    // self-corrects. Without a push a caller that reaches remove() before the
    // natural 'exit' - or a syncSessions() that lands mid-grace - leaves the
    // renderer holding a 'running' row for a session that no longer exists
    // anywhere in main: the board keeps painting a spinner and the bottom
    // panel keeps a tab for an agent that is gone.
    //
    // This used to be a 'session-changed' emit carrying a forced 'exited'
    // status. That channel's only renderer handler is an UPSERT, so for a task
    // moved to To Do (whose rows the renderer evicts optimistically the moment
    // the move starts) the removal announcement re-inserted an exited row for
    // a PTY, worktree, and session directory that no longer existed, and its
    // usage entry filled a context bar under a black terminal (#661). A
    // removal and a status change cannot share one channel: the renderer
    // drops this id, and every per-session map entry keyed on it, on
    // 'session-removed' (SESSION_REMOVED). Covers the awaited-exit case and
    // the direct-remove case (project deletion, SESSION_RESET) alike.
    if (session) {
      this.emit('session-removed', sessionId, toSession(session));
    }
    this.registry.delete(sessionId);
    this.clearSessionCaches(sessionId);
  }

  /**
   * Drop what the auxiliary modules hold for a session id once its registry
   * row is gone: buffer, transcript, telemetry, first-output latch, and resize
   * bookkeeping. The tail shared by `remove()` and the exited-row eviction in
   * `registerSuspendedPlaceholder`, which differ only in what happens to the
   * PTY and the on-disk session files before this runs.
   */
  private clearSessionCaches(sessionId: string): void {
    // The host drops the ring, the transcript (flushing what is pending), its
    // first-output latch and the redraw filter's state.
    this.host.post({ type: 'removeSession', sessionId });
    this.telemetry.removeSession(sessionId);
    this.firstOutputTracker.removeSession(sessionId);
    this.inAltScreen.delete(sessionId);
    this.bufferCols.delete(sessionId);
  }

  /**
   * Kill every PTY session belonging to a task, regardless of whether the
   * task's session_id field has been written to the DB yet. This handles
   * the race where a concurrent handleTaskMove spawned a session but
   * hasn't updated the task record.
   *
   * Every row, not the first match: while a respawn is queued the task
   * transiently holds `[suspended, queued]`, and a first-match kill left the
   * queued row to be promoted into a task the caller had just torn down.
   */
  killByTaskId(taskId: string): void {
    // A spawn for the task still in flight has no row yet; it is cancelled too.
    this.cancelTaskSpawnsInFlight(taskId);
    for (const session of this.registry.listByTaskId(taskId)) this.kill(session.id);
  }

  /**
   * Fully remove every PTY session belonging to a task from all internal
   * maps. Like killByTaskId but also cleans up caches and session files.
   *
   * The removal itself is synchronous. The promise resolves once every spawn
   * for the task that was still in flight has settled, and every row it
   * removed has exited: one the host had started holds the working directory
   * until its PTY exits, and it had no row for a kill-and-awaitExit to wait
   * on. A caller about to remove that directory awaits it; one that is not can
   * ignore it. It never rejects (each wait is bounded by a safety timeout).
   */
  removeByTaskId(taskId: string): Promise<void> {
    this.cancelTaskSpawnsInFlight(taskId);
    // Each row's exit, captured while the row still exists (an exit wait made
    // after the remove finds no row and resolves at once): a young session's
    // kill waits out its exit-sequence grace, and its PTY holds the working
    // directory until then (.claude/rules/pty-teardown-grace.md).
    const rowExits: Promise<void>[] = [];
    for (const session of this.registry.listByTaskId(taskId)) {
      rowExits.push(this.awaitRowExit(session.id));
      this.remove(session.id);
    }
    // Read after the loop, and cancelled again: each remove frees a slot, and
    // the queue can start a promotion of this task's next row inside it. A
    // cancelled spawn stays tracked until it settles, so none is missed.
    this.cancelTaskSpawnsInFlight(taskId);
    const inFlightForTask = [...this.spawnsInFlight.values()].filter((inFlight) => inFlight.taskId === taskId);
    return Promise.all([this.awaitSpawnsSettled(inFlightForTask), ...rowExits]).then(() => undefined);
  }

  /**
   * Announce a session a caller ended with `kill()` + `awaitExit()` and is
   * KEEPING in the registry (no `remove()`, no `suspend()`): re-emit the row
   * on 'session-changed' with its resolved status. The PTY's natural exit
   * emits only 'exit', which the renderer ignores for an intentional end (it
   * cannot tell a suspend from a hard end without racing the suspended status
   * push), so without this the renderer's replica stays at 'running' for a
   * session main knows is finished: the card keeps its spinner and the bottom
   * panel its tab. `remove()` and `suspend()` announce themselves, and
   * `retireAgentlessSession` does the same inline; the cleanup_worktree
   * transition action is the caller here. Every kill site is classified by
   * `tests/unit/session-kill-followup.test.ts`. See
   * .claude/rules/session-replica-contract.md.
   */
  announceSessionEnded(sessionId: string): void {
    const session = this.registry.get(sessionId);
    if (!session) return;
    if (session.status === 'running' || session.status === 'queued') {
      // awaitExit resolved without onExit stamping the row (its safety
      // timeout, or a PTY-less row): the session is ended either way.
      session.status = 'exited';
      if (session.exitCode === null) session.exitCode = -1;
    }
    this.emit('session-changed', sessionId, toSession(session));
  }

  /**
   * Kill what the given tasks left running: every process carrying a task's
   * `KANGENTIC_TASK_ID` tag and working inside that task's project or worktree
   * (see `process-tag/reap-plan.ts` for what is spared: shared processes,
   * visible apps, tmux servers). The pty host scans and kills, and protects
   * this process's own tree and every PTY it still holds. When the configured
   * shell is WSL, the same reap also runs inside the distro.
   *
   * Call it only after every session of these tasks has exited. With `stop`
   * false (the user turned stopping off) nothing is killed and the report
   * lists what is still running. Returns what the user is told: the processes
   * stopped, not stopped, and left running, each under a short label. Never
   * throws.
   */
  async reapTaskProcesses(
    projectPath: string | null,
    tasks: ReadonlyArray<{ id: string; worktreePath: string | null }>,
    options: { stop: boolean },
  ): Promise<LeftoverProcessEntry[]> {
    const validTasks = tasks.filter((task) => isValidTaskTagValue(task.id));
    if (validTasks.length === 0) return [];
    // A young session that kill() tore down moments ago is still running: its
    // PTY is parked for the exit grace before the force-kill
    // (pty-teardown-grace.md). Until it exits the host protects it and
    // everything under it, so a reap now would leave the agent's children
    // running. That happens on a Done move whose session was stopped just
    // before, where suspend() has no PTY left to wait for.
    const parkedSessionIds = this.deferredKills.sessionsAwaitingExit(new Set(validTasks.map((task) => task.id)));
    if (parkedSessionIds.length > 0) {
      await Promise.all(parkedSessionIds.map((sessionId) => awaitSessionExit(this, sessionId, PARKED_EXIT_WAIT_MS)));
    }
    const killedPids: number[] = [];
    const entries: LeftoverProcessEntry[] = [];
    // A task with no usable directory can have nothing killed or reported, so
    // it costs no scan of every process's environment.
    const reapTasks = (await Promise.all(validTasks.map(async (task) => ({
      taskId: task.id,
      directories: await resolveTaskDirectories(projectPath, task.worktreePath),
      worktreePath: task.worktreePath ? await fsPromises.realpath(task.worktreePath).catch(() => task.worktreePath) : null,
    })))).filter((task) => task.directories.length > 0);
    if (reapTasks.length === 0) return [];
    try {
      const result = await this.host.reapTaggedProcesses(
        { tasks: reapTasks, mainPid: process.pid, stop: options.stop },
        TASK_REAP_TIMEOUT_MS,
      );
      killedPids.push(...result.killedPids);
      entries.push(...result.entries);
      if (result.failureReason) {
        console.warn(`[TASK-REAP] reap failed (non-fatal): ${result.failureReason}`);
        const code = result.failureCode ?? 'reap_error';
        reportTaskReapFailure('reap', code, code === 'reader_load' ? result.failureReason : null);
      }
      // Processes whose environment could not be read (elevated on Windows,
      // non-dumpable on Linux, CS_RESTRICT under SIP on macOS) may carry the
      // tag unseen. A count only: never which ones, never their contents.
      if (result.unreadableCount > 0) {
        console.log(`[TASK-REAP] ${result.unreadableCount} same-user process(es) had an unreadable environment and were not checked`);
      }
    } catch (error) {
      console.warn('[TASK-REAP] host reap failed (non-fatal):', error);
      reportTaskReapFailure('reap', 'host_error');
    }
    // The distro's reap kills and reports nothing back by name, so it runs only
    // while stopping is on.
    if (process.platform === 'win32' && options.stop) {
      const wslSpec = parseWslShellSpec(await this.getShell().catch(() => ''));
      if (wslSpec) {
        killedPids.push(...await reapTaggedProcessesInWsl(wslSpec, reapTasks, async (file, args, options) => {
          const output = await execFileAsync(file, args, {
            timeout: options.timeoutMs,
            env: { ...process.env, ...options.env },
            windowsHide: true,
          });
          return output.stdout;
        }, (error) => {
          // The error's text can name task directories: local log only.
          console.warn('[TASK-REAP] WSL reap failed (non-fatal):', error);
          reportTaskReapFailure('reap', 'wsl_error');
        }));
      }
    }
    if (killedPids.length > 0) {
      console.log(`[TASK-REAP] killed ${killedPids.length} leftover process(es) for ${validTasks.length} task(s): ${killedPids.join(', ')}`);
    }
    return entries;
  }

  /**
   * Stop one process a reap reported, with everything under it, after the
   * user asked for it from the leftover list. The pty host re-checks its
   * identity and keeps Kangentic's tree and every held PTY out of reach.
   * Never throws: a host failure reads as `failed`.
   */
  async stopReportedProcess(pid: number, startKey: string): Promise<StopProcessOutcome> {
    try {
      return await this.host.stopReportedProcess({ pid, startKey, mainPid: process.pid }, TASK_REAP_TIMEOUT_MS);
    } catch (error) {
      console.warn('[TASK-REAP] stop failed (non-fatal):', error);
      reportTaskReapFailure('stop', 'host_error');
      return 'failed';
    }
  }

  /**
   * May the bg-shell watcher's agent-absence sweep judge this session?
   *
   * The watcher owns only the process-tree question ("is anything running under
   * this PTY?"); every session-shaped arm lives here. Each one excludes a case
   * where "no agent process under the shell" is NOT a fault:
   *
   * - `transient`: a Command Terminal IS a bare shell. It has no agent by
   *   design, and it is registered with the watcher exactly like a task agent,
   *   so without this arm the sweep would retire every one on open. This is the
   *   highest-cost false positive in the design.
   * - no `agentParser`: nothing was ever meant to run an agent CLI under this
   *   PTY (a `run_script` session, a bare-shell spawn).
   * - a WSL shell: the premise "the agent is a Win32 descendant of the PTY
   *   root" does not hold there, so the tree signal is unreadable rather than
   *   merely empty. See the guard below.
   * - not `running`, or no live `pty`: a queued, suspended or already-exited
   *   session has no live tree to judge, and an ordinary exit is not a phantom.
   * - inside the spawn grace: the shell starts FIRST and Kangentic writes the
   *   CLI command to its stdin ~100ms later (+200ms more behind a Windows cwd
   *   fixup), then the process still has to start - and a heavy shell profile
   *   can stall even that. This is the one window where "no agent yet" is
   *   genuinely expected. A SLOW-STARTING agent is not in it: its process
   *   exists, it just has not drawn its first frame.
   */
  private isAgentAbsenceCandidate(sessionId: string): boolean {
    const session = this.registry.get(sessionId);
    if (!session) return false;
    if (session.transient) return false;
    if (!session.agentParser) return false;
    // A WSL session's PTY root is `wsl.exe`, and the agent is NOT a Win32
    // descendant of it either way: a distro-native CLI is a Linux process in
    // another PID namespace, and the interop path Kangentic actually uses (see
    // docs/cross-platform.md) launches the Windows binary through WSL's binfmt
    // host rather than under this `wsl.exe`. The Windows probe enumerates
    // `Win32_Process`, so a perfectly healthy WSL agent presents an EMPTY
    // descendant set - indistinguishable from a phantom, and every guard above
    // passes. Judging one would force-kill live work, which is the severe
    // failure direction; refusing to judge it only leaves the pre-existing
    // phantom, which is the status quo. Detection mirrors `resolveShellArgs`
    // (pty-spawn.ts), the single owner of the `wsl -d <distro>` spec form.
    const shellSpec = session.shell.toLowerCase();
    if (shellSpec.startsWith('wsl ') || shellSpec.startsWith('wsl.exe ')) return false;
    if (session.status !== 'running' || session.pty === null) return false;
    const startedAtMs = Date.parse(session.startedAt);
    if (!Number.isFinite(startedAtMs)) return false;
    return Date.now() - startedAtMs >= AGENT_SPAWN_GRACE_MS;
  }

  /**
   * Retire a `running` session whose agent CLI exited while its shell PTY
   * survived, so nothing ever marked the session finished.
   *
   * Routed through `kill()` deliberately: that path already does the entire job
   * (record marked exited, panel tab dropped, phantom count corrected, queue
   * slot freed, hooks stripped, transcript flushed) and its `intentionalExit`
   * flag suppresses the renderer's "Session crashed" toast - the agent's own
   * exit was the event, and Kangentic is only noticing it late. Because that
   * flag also silences the exit listener's startup-failure read, the
   * retirement first emits `agent-absent` so the IPC layer can read the CLI's
   * last words and raise a notice when they name a failure.
   *
   * The reported exit code is forced to 0 because this WAS a normal end. A
   * force-kill reports an abnormal code on every platform, and
   * `SessionRepository.getInterruptedExited` resumes exactly those on the next
   * launch - so leaving the real code would resurrect the very conversation the
   * user `/exit`-ed, contradicting that query's "clean exit 0 is excluded".
   *
   * The candidate guard is re-checked here: the watcher decides asynchronously,
   * and the session may have been suspended or killed during that gap.
   */
  private retireAgentlessSession(sessionId: string): void {
    if (!this.isAgentAbsenceCandidate(sessionId)) return;
    const session = this.registry.get(sessionId);
    if (!session) return;
    // Say WHY the agent is gone while its last words are still readable. The
    // kill below arrives at the exit listener as INTENTIONAL (the CLI's own
    // end was the event; the sweep only noticed it late), and that listener
    // rightly treats an intentional exit as carrying no failure, so an agent
    // that ended at boot with its own account of why (a `--resume` whose
    // conversation the CLI could not find) reached the user as a card that
    // went quiet. The IPC layer asks the adapter to read the raw ring and
    // raises the notice; the ring survives the kill, so ordering here is for
    // clarity rather than correctness.
    this.emit('agent-absent', sessionId, toSession(session));
    session.overrideExitCode = 0;
    // Immediate: the agent is already gone, so the exit-sequence grace would
    // only type `/exit` into a bare shell, and the `exited` stamp below would
    // let a later awaitExit resolve while that shell still held the cwd.
    this.kill(sessionId, { immediate: true });
    // Announce the retirement as a STATUS change, not just an exit.
    //
    // Measured in a live preview: without this, main and the DB were correct
    // (`exited`, code 0) while the board kept counting the agent and the bottom
    // panel kept its tab - the two symptoms this sweep exists to remove. The
    // renderer's SESSION_EXIT handler deliberately returns early on an
    // INTENTIONAL exit (App.tsx) because it cannot tell a suspend from a hard
    // end without racing the suspended status push, so it never runs its own
    // `updateSessionStatus`. `session-changed` is the authoritative channel
    // (broadcast as SESSION_STATUS) and carries the resolved status, so it has
    // no such ambiguity.
    //
    // Set here rather than waiting for the PTY's async onExit: the emit must
    // carry the final status, and onExit's own assignment is the same value
    // (it only skips when the status is already 'suspended', which a candidate
    // never is).
    session.status = 'exited';
    session.exitCode = 0;
    this.emit('session-changed', sessionId, toSession(session));
  }

  /**
   * End a session deliberately. Synchronous and never resumable (that is
   * `suspend()`); the registry row survives until the PTY's onExit or a
   * `remove()`, which is what lets `kill` -> `awaitExit` -> `remove` wait for
   * the process before touching its cwd.
   *
   * A YOUNG session (inside Claude Code's fullscreen boot-canary window, see
   * lifecycle/deferred-kill.ts) gets the adapter's exit sequence and a 1500 ms
   * grace before the force-kill, exactly as `suspend()` gives every session; a
   * mature one is killed at once as before. Either way `session.pty` is nulled
   * synchronously, so `write()` / `resize()` no-op and a respawn cannot find the
   * old PTY. `options.immediate` skips the grace for a caller that KNOWS the
   * agent is already gone (the agent-absence sweep), where the exit sequence
   * would only be typed into a bare shell and the caller stamps `exited` at
   * once, which would let `awaitExit` resolve before the shell dies.
   */
  kill(sessionId: string, options?: { immediate?: boolean }): void {
    // A promotion of this session still waiting on the host must not register
    // it afterwards (remove() comes through here too).
    this.cancelSpawnInFlight(sessionId);
    const session = this.registry.get(sessionId);
    // Every kill() is a deliberate Kangentic-initiated teardown (user kill,
    // session reset, task delete, worktree cleanup, move-to-To-Do/Backlog,
    // project relocate, shutdown), never a crash. Mark the session BEFORE the
    // force-kill so the async onExit handler (session-spawn-flow.ts) and the
    // queued-session direct emit below tag the 'exit' event intentional, so the
    // renderer suppresses the false "Session crashed" notification. A genuine
    // crash never calls kill() - the PTY's onExit fires on its own with
    // intentionalExit unset. Unlike suspend(), kill() does not set
    // status='suspended' (a hard reset is 'exited', not resumable), so this
    // orthogonal marker carries the intent.
    if (session) session.intentionalExit = true;
    // Drop any queued pre-spawn resize: a killed session will not respawn to
    // consume it, and a stale entry keyed by this id must not survive. The
    // desktop-dims restore target dies with the session for the same reason.
    this.pendingResizes.delete(sessionId);
    this.lastDesktopDimensions.delete(sessionId);
    this.cancelRestingGridRestore(sessionId);
    // Release backpressure BEFORE the kill so a paused session is resumed
    // (lets any buffered output flush) and its accounting entry is dropped
    // immediately, rather than waiting for the exit. Posted ahead of the kill,
    // so the host applies it first; the exit's own release is a no-op.
    this.host.post({ type: 'releaseBackpressure', sessionIds: [sessionId] });
    if (session?.pty) {
      const ptyRef = session.pty;
      // Read before nulling: the quit drain probes the child pid, not the wrapper.
      const childPid = ptyRef.pid;
      session.pty = null; // prevent double-kill (conpty heap corruption on Windows)
      if (options?.immediate !== true && isYoungSession(session)) {
        // Written straight to the PTY, not through the write queue: the queue
        // is disposed below and drains through `session.pty`, which is already
        // null. The onData / onExit disposables move to the parked entry so the
        // quit path can still detach them after remove() has deleted this row;
        // they stay attached until then, because the onExit they carry is what
        // emits 'exit' (awaitExit) and cancels the timer on a natural exit.
        writeExitSequence(ptyRef, session.exitSequence);
        const ptyDisposables = session.ptyDisposables;
        session.ptyDisposables = undefined;
        this.deferredKills.schedule({ sessionId, taskId: session.taskId, ptyRef, pid: childPid, ptyDisposables });
      } else {
        safeKillPty(ptyRef);
      }
    }
    // Drop pending bytes; a stale drain loop scheduled via setImmediate will
    // observe the disposed flag on its next tick and exit cleanly.
    const writeQueue = this.writeQueues.get(sessionId);
    if (writeQueue) {
      writeQueue.dispose();
      this.writeQueues.delete(sessionId);
    }
    // Remove from queue if queued, and mark as exited.
    // Queued sessions have no PTY, so onExit never fires. Emit the exit
    // event explicitly so the DB listener marks the record as exited. A
    // promotion still spawning has left the queue but has not started, so it
    // is the same case; emitted here, before a remove() deletes the row the
    // listener reads its project from, or the record would stay 'queued'.
    const dequeued = this.sessionQueue.remove(sessionId);
    const promotionInFlight = session?.status === 'queued' && this.spawnsInFlight.has(sessionId);
    if ((dequeued || promotionInFlight) && session) {
      session.status = 'exited';
      session.exitCode = -1;
      // Queued sessions never spawn a PTY, so onExit (which reads
      // intentionalExit) never runs; forward the flag on this direct emit.
      this.emit('exit', sessionId, -1, true);
    }
    // A slot may have opened - let the queue promote
    this.sessionQueue.notifySlotFreed();
  }

  /**
   * Wait for a session's PTY process to exit. Returns immediately if the
   * process is already dead (pty is null) or the session doesn't exist.
   *
   * Uses the 'exit' event emitted by onExit (line 368) as the signal.
   * Safety timeout (10s) prevents hanging if onExit never fires (conpty bug).
   *
   * A spawn of this session still in flight (a promotion the caller's kill
   * just cancelled) is waited for first: the PTY its host may have started
   * holds the working directory until it exits, and has no row to wait on.
   */
  awaitExit(sessionId: string): Promise<void> {
    const inFlight = this.spawnsInFlight.get(sessionId);
    if (inFlight) return this.awaitSpawnsSettled([inFlight]).then(() => this.awaitRowExit(sessionId));
    return this.awaitRowExit(sessionId);
  }

  private awaitRowExit(sessionId: string): Promise<void> {
    const session = this.registry.get(sessionId);
    // Session doesn't exist, already exited, or suspended - resolve immediately.
    // IMPORTANT: Do NOT check session.pty here. kill() sets pty=null before
    // the process actually dies (to prevent double-kill on Windows conpty).
    // Checking pty would cause awaitExit to resolve before file handles are
    // released, leading to EPERM/hang during worktree removal on Windows.
    if (!session || session.status === 'exited' || session.status === 'suspended' || session.status === 'queued') {
      return Promise.resolve();
    }

    return new Promise<void>((resolve) => {
      const safetyTimeout = setTimeout(() => {
        this.removeListener('exit', onExit);
        console.warn(`[SessionManager] awaitExit safety timeout for session ${sessionId.slice(0, 8)} - process may still hold handles`);
        resolve();
      }, 10_000);

      const onExit = (exitedSessionId: string) => {
        if (exitedSessionId === sessionId) {
          clearTimeout(safetyTimeout);
          this.removeListener('exit', onExit);
          resolve();
        }
      };

      this.on('exit', onExit);

      // Re-check after subscribing (process may have exited between the
      // initial check and event registration)
      const currentSession = this.registry.get(sessionId);
      if (!currentSession || currentSession.status === 'exited' || currentSession.status === 'suspended' || currentSession.status === 'queued') {
        clearTimeout(safetyTimeout);
        this.removeListener('exit', onExit);
        resolve();
      }
    });
  }

  /**
   * Suspend a session: gracefully exit the agent, then kill the PTY.
   * Preserves session files on disk so the session can be resumed later.
   *
   * Sends the agent's exit sequence (e.g. Ctrl+C + /exit for Claude Code)
   * and waits up to 1500ms for the process to exit naturally. This gives
   * the agent time to flush its conversation transcript (JSONL) to disk,
   * which is required for --resume to work. Force-kills if still alive.
   *
   * Unlike kill(), the onExit handler will NOT clean up files because
   * file paths are nulled before the PTY is destroyed.
   */
  async suspend(sessionId: string): Promise<void> {
    // A promotion still waiting on the host would otherwise come back running.
    // Its settle is waited for below, as the PTY's exit is: a Done move removes
    // the worktree once the suspend resolves.
    this.cancelSpawnInFlight(sessionId);
    const inFlight = this.spawnsInFlight.get(sessionId);
    const session = this.registry.get(sessionId);
    if (!session) {
      // A direct spawn has no row until its host round trip returns, but the
      // PTY the host started for it may already hold the working directory.
      if (inFlight) await this.awaitSpawnsSettled([inFlight]);
      return;
    }

    // Strip agent hooks from the project's settings file before
    // closing down. Prevents hook accumulation across sessions. Both
    // this path and the onExit handler call removeAdapterHooks;
    // adapters key on taskId so the duplicate call is idempotent.
    removeAdapterHooks(session);

    // Close watchers and detach telemetry readers WITHOUT deleting
    // files - they persist for resume. Null out paths so the onExit
    // handler's cleanup skips settings.json deletion. See
    // SessionFileManager.detachPreservingFiles.
    this.sessionFiles.detachPreservingFiles(sessionId);

    // Flush transcript to DB before killing PTY
    this.host.post({ type: 'finalizeTranscript', sessionId });

    // Synthetic session_end before we kill - Claude Code's hook won't fire
    this.telemetry.emitSessionEnd(sessionId);

    // Clear subagent depth - session is no longer active
    this.telemetry.clearSessionTracking(sessionId);

    // Mark suspended BEFORE killing so the async onExit handler preserves it
    session.status = 'suspended';

    // ...and TELL the renderer now, not after the shutdown below. That await is
    // up to 1500ms for a natural exit plus another 1500ms for kill propagation,
    // and the bottom panel's tab set is `status === 'running'`
    // (derivePanelSessions), so emitting only at the end left a tab for a
    // session the user had already watched leave the board - the card gone, the
    // agent gone, a dead terminal still tabbed for seconds. A user-initiated
    // Pause never showed it because the store writes that status optimistically;
    // a main-driven suspend (move to Done, idle timeout, settings restart) had
    // no such write and wore the full delay.
    //
    // The trailing emit stays: it carries the post-shutdown session, including
    // an agent session id recovered from the final scrollback scan below.
    this.emit('session-changed', sessionId, toSession(session));

    // Resume a backpressure-paused PTY so the agent's exit-sequence output is
    // not held back during the graceful shutdown window.
    this.host.post({ type: 'releaseBackpressure', sessionIds: [sessionId] });

    if (session.pty) {
      // Send exit sequence, wait up to 1500ms for natural exit, then
      // force-kill and wait another 1500ms for kill propagation so
      // callers that immediately delete the CWD (worktree removal on
      // move-to-Done) don't race Windows ConPTY still holding handles.
      // See session-suspend.gracefulPtyShutdown.
      await gracefulPtyShutdown({
        ptyRef: session.pty,
        exitSequence: session.exitSequence,
        emitter: this,
        sessionId,
        clearPty: () => { session.pty = null; },
        killPty: safeKillPty,
      });
    }

    // Last-resort: scan full scrollback for agent session ID if not yet
    // captured. Handles Gemini printing session ID at shutdown, Codex
    // startup header missed by streaming handler, etc. Uses raw (pre-TUI)
    // scrollback so startup headers remain in scope. Skipped once the id is
    // known, and bounded otherwise: a host that is down or restarting would
    // hold the caller's task lock, and the queue's freed slot, for the
    // transport's whole request timeout.
    if (!this.telemetry.hasAgentSessionId(sessionId)) {
      const rawScrollback = await this.host.getRawScrollback(sessionId, SUSPEND_SCROLLBACK_SCAN_TIMEOUT_MS).catch(() => '');
      this.sessionIdManager.scanScrollback(sessionId, session.agentParser, rawScrollback);
    }

    this.emit('session-changed', sessionId, toSession(session));

    // Remove from queue (queued sessions have no PTY yet) and promote
    this.sessionQueue.remove(sessionId);
    this.sessionQueue.notifySlotFreed();

    if (inFlight) await this.awaitSpawnsSettled([inFlight]);
  }

  async getScrollback(sessionId: string): Promise<string> {
    // If a geometry-changing resize just fired, the host waits for the agent
    // TUI's async repaint to land before sampling, so the replay shows the
    // frame at the fitted geometry rather than the stale pre-resize one (see
    // PtyBufferManager.waitForResizeRepaint). Skipped when the session has no
    // live PTY (suspended/killed, or queued pre-spawn): no process means no
    // SIGWINCH repaint can ever arrive, so a wait armed just before teardown
    // would only burn its deadline against a repaint that cannot come.
    // Alt-screen sessions and sessions whose byte ring spans a geometry change
    // get the parsed-grid frame, everything else the raw byte replay (see
    // PtyBufferManager.getReplaySnapshot). The reply rides the same ordered
    // channel as the session's output, so no flushed slice overtakes it.
    return this.host.getScrollback(sessionId, !!this.registry.get(sessionId)?.pty);
  }

  /**
   * The MOBILE seed frame: a snapshot of the PARSED grid from the per-session
   * headless xterm, serialized as a self-contained escape-sequence frame the
   * phone cold-replays into a fresh terminal. Unlike a raw 512KB byte replay,
   * this never drops a fullscreen TUI's write-once static cells whose drawing
   * bytes have aged out of the byte window (getScrollback serves the same
   * frame to the desktop when the session is in the alt screen).
   *
   * Keeps the same repaint settle as getScrollback, skipped likewise when no
   * live PTY can deliver a repaint, so the grid is never serialized
   * mid-repaint at a stale geometry.
   */
  async getSerializedFrame(sessionId: string): Promise<string> {
    return this.host.getSerializedFrame(sessionId, !!this.registry.get(sessionId)?.pty);
  }

  /**
   * The UNPROCESSED byte ring, exactly as it arrived from the PTY.
   *
   * The forensics read, and the only one that can answer "did these bytes ever
   * exist?". Every other view is downstream of a parser: the transcript is
   * ANSI-stripped, the serialized frame is a re-render of the parsed grid, and
   * the renderer's xterm is a second parse of the same stream. When rows are
   * missing from a frame, all of those agree with each other whether the agent
   * omitted the rows or something here dropped them - the raw ring is what
   * separates the two.
   *
   * No settle and no slicing: a diagnostic wants the bytes as they are, not a
   * replay-shaped view of them. The exit listener reads it for the same reason
   * when it asks an adapter whether the CLI's last words name a startup
   * failure: at exit there is no process left to repaint, and what matters is
   * what the CLI wrote. Async because the ring lives in the pty host.
   */
  getRawScrollback(sessionId: string): Promise<string> {
    return this.host.getRawScrollback(sessionId);
  }

  /**
   * The Agent Monitor's output peek: the last few meaningful rendered lines.
   *
   * Deliberately does NOT wait for a resize repaint, unlike the two readers
   * above. That settle exists so a REPLAY is never captured mid-repaint at a
   * stale width, which matters when the captured frame becomes the terminal the
   * user then looks at. The peek is a few lines of throwaway text resampled on a
   * timer, so a mid-repaint sample self-corrects on the next tick.
   */
  getOutputPeek(sessionId: string): Promise<string[]> {
    return this.host.getOutputPeek(sessionId);
  }

  /**
   * Dev diagnostics: per-session terminal output-pipeline stats - the pending
   * (un-flushed) buffer and scrollback sizes, backpressure state (paused +
   * in-flight bytes), and whether the session is currently emitting to the
   * renderer (focused). Surfaced by the inspection server's terminal-pipeline
   * route to diagnose terminal-driven lag: a paused session with high in-flight
   * bytes, or a ballooning pending buffer, points straight at a flooding agent.
   */
  async getPipelineStats(): Promise<SessionPipelineStats[]> {
    const diagnostics = await this.host.getDiagnostics();
    const bySession = new Map(diagnostics.pipeline.map((entry) => [entry.sessionId, entry]));
    const stats: SessionPipelineStats[] = [];
    for (const session of this.registry.values()) {
      const buffer = bySession.get(session.id);
      stats.push({
        sessionId: session.id,
        taskId: session.taskId,
        status: session.status,
        focused: this.focusedSessionIds.has(session.id),
        pendingBytes: buffer?.pendingBytes ?? 0,
        scrollbackBytes: buffer?.scrollbackBytes ?? 0,
        paused: buffer?.paused ?? false,
        inFlightBytes: buffer?.inFlightBytes ?? 0,
      });
    }
    return stats;
  }

  /**
   * Dev diagnostics: every dimension main and the host know for each session's
   * terminal.
   *
   * The renderer can only see its own xterm's grid, so a PTY whose geometry has
   * drifted from the grid showing it is invisible from there - and that
   * divergence is exactly the failure where a terminal opens with its content
   * wrapped or clipped and no refit ever corrects it (xterm only re-sends
   * dimensions when ITS OWN size changes, so a mismatch has no path back).
   *
   * `ptyCols`/`ptyRows` is the live PTY grid. `lastCols`/`lastRows` is the
   * geometry the bytes now in the scrollback were drawn at.
   * `lastDesktopDimensions` is the size the desktop last asked for, and
   * `pendingResize` a size stashed for a session with no PTY yet. Comparing
   * them against the renderer's grid (see the `dims` section of the
   * terminal-state route) localizes a drift to a specific layer instead of
   * leaving it to be inferred from pixels.
   */
  async getTerminalDimensions(): Promise<SessionTerminalDimensions[]> {
    const diagnostics = await this.host.getDiagnostics();
    const bySession = new Map(diagnostics.dimensions.map((entry) => [entry.sessionId, entry]));
    const rows: SessionTerminalDimensions[] = [];
    for (const session of this.registry.values()) {
      const buffer = bySession.get(session.id);
      const desktop = this.lastDesktopDimensions.get(session.id) ?? null;
      const pending = this.pendingResizes.get(session.id) ?? null;
      rows.push({
        sessionId: session.id,
        taskId: session.taskId,
        status: session.status,
        ptyCols: session.pty?.cols ?? null,
        ptyRows: session.pty?.rows ?? null,
        lastCols: buffer?.lastCols ?? null,
        lastRows: buffer?.lastRows ?? null,
        lastDesktopCols: desktop?.cols ?? null,
        lastDesktopRows: desktop?.rows ?? null,
        pendingResizeCols: pending?.cols ?? null,
        pendingResizeRows: pending?.rows ?? null,
        pendingRepaintAt: buffer?.pendingRepaintAt ?? null,
        pendingRepaintStacked: buffer?.pendingRepaintStacked ?? false,
        inAltScreen: buffer?.inAltScreen ?? false,
        geometryChangedAtRingIndex: buffer?.geometryChangedAtRingIndex ?? null,
      });
    }
    return rows;
  }

  getSession(sessionId: string): Session | undefined {
    return this.registry.getSession(sessionId);
  }

  listSessions(): Session[] {
    return this.registry.listSessions();
  }

  /** Registry rows carrying `agentName`, for the cross-project Agent Monitor.
   *  See SessionRegistry.listManagedSummaries for why this is separate from listSessions. */
  listManagedSummaries(): ManagedSessionSummary[] {
    return this.registry.listManagedSummaries();
  }

  /** Return cached usage data for all sessions (survives renderer reloads). */
  getUsageCache(): Record<string, SessionUsage> {
    return this.telemetry.getUsageCache();
  }

  /**
   * Upsert a partial SessionUsage entry for a session. Thin wrapper
   * around SessionTelemetry.setSessionUsage for external callers.
   */
  setSessionUsage(sessionId: string, partial: Partial<SessionUsage>): void {
    this.telemetry.setSessionUsage(sessionId, partial);
  }

  /**
   * Record a Command Terminal's auto-derived name so it outlives the renderer.
   *
   * Main is a passive holder here: the renderer derives the name and has already
   * applied it locally, and nothing in main reads it back except `toSession`,
   * which hands it to the next renderer that has to rebuild the pairing map.
   * First write wins, matching the renderer's own first-prompt-wins rule, so a
   * later re-derivation cannot silently rename a terminal the user already knows
   * by name. Unknown or non-transient sessions are ignored.
   */
  setCommandTerminalLabel(sessionId: string, label: string): void {
    const session = this.registry.get(sessionId);
    if (!session?.transient || session.commandTerminalLabel) return;
    const trimmed = label.trim();
    if (!trimmed) return;
    session.commandTerminalLabel = trimmed;
  }

  /**
   * Record where a Command Terminal's checkout actually sits now.
   *
   * The spawn stamps the branch it checked out, but the main checkout's HEAD is
   * shared with the user's own git usage, non-worktree task spawns, and every
   * other terminal, so that stamp goes stale the moment any of them moves it.
   * The renderer re-derives the branch from live HEAD (on reattach and on every
   * watcher fire) and mirrors it here, so the Monitor row and a post-reload
   * adopt name the branch the repo is on. LAST write wins, the opposite of the
   * label: HEAD moves, and the newest reading is the true one. Blank values and
   * unknown or non-transient sessions are ignored.
   */
  setCommandTerminalBranch(sessionId: string, branch: string): void {
    const session = this.registry.get(sessionId);
    if (!session?.transient) return;
    const trimmed = branch.trim();
    if (!trimmed) return;
    session.commandTerminalBranch = trimmed;
  }

  /** Return cached activity state for all sessions (survives renderer reloads). */
  getActivityCache(): Record<string, ActivityState> {
    return this.telemetry.getActivityCache();
  }

  /** Return the latest ActivityReason for a session, or null if unknown. */
  getActivityReason(sessionId: string): ActivityReason | null {
    return this.telemetry.getActivityReason(sessionId);
  }

  /**
   * Assert that this session's current idle is authoritative - the caller knows
   * from outside the hook stream that the agent is parked and started no work.
   * Used by the settings-change restart, whose resumed session sends no prompt
   * but whose `--resume` context reload would otherwise trip the status
   * heartbeat's force-thinking recovery. See `ActivityEngine.markIdleAuthoritative`.
   */
  markIdleAuthoritative(sessionId: string): void {
    this.telemetry.markIdleAuthoritative(sessionId);
  }

  /** Return cached ActivityReason for all sessions (HMR/full-reload reconcile). */
  getActivityReasonsCache(): Record<string, ActivityReason> {
    return this.telemetry.getActivityReasonsCache();
  }

  /**
   * Rich activity stats snapshot for the debug overlay (Developer tab).
   * Returns null for unknown sessions.
   */
  getActivityStatsSnapshot(sessionId: string): ActivityStatsSnapshot | null {
    return this.telemetry.getActivityStatsSnapshot(sessionId);
  }

  /** Return cached events for a specific session (survives renderer reloads). */
  getEventsForSession(sessionId: string): SessionEvent[] {
    return this.telemetry.getEventsForSession(sessionId);
  }

  /**
   * Cumulative ToolEnd count for a session. Tracked independently of the
   * bounded event cache so captureSessionMetrics can write a faithful
   * tool_call_count even after the cache has rolled past 500 events.
   */
  getToolCallCount(sessionId: string): number {
    return this.telemetry.getToolCallCount(sessionId);
  }

  /**
   * Per-tool aggregate snapshot for a session. Used by captureSessionMetrics
   * to persist a JSON breakdown so the Session Summary panel can render a
   * "By tool" section for archived tasks.
   */
  getToolBreakdown(sessionId: string): PerToolStat[] {
    return this.telemetry.getToolBreakdown(sessionId);
  }

  /**
   * Context-compaction count for a session's current run (Claude PreCompact
   * hook). Per-run; captureSessionMetrics persists it so the per-task lifetime
   * rollup can SUM it across the task's session records.
   */
  getCompactionCount(sessionId: string): number {
    return this.telemetry.getCompactionCount(sessionId);
  }

  /** Return cached events for all sessions (survives renderer reloads). */
  getEventsCache(): Record<string, SessionEvent[]> {
    return this.telemetry.getEventsCache();
  }

  /**
   * Map of sessionId -> true for every session that has emitted first output.
   * Unscoped (the set is tiny). Lets the renderer rebuild `sessionFirstOutput`
   * after an HMR reload so a running session that already produced output is
   * not flashed back to its "Starting agent..." boot state.
   */
  getFirstOutputCache(): Record<string, boolean> {
    const result: Record<string, boolean> = {};
    for (const sessionId of this.firstOutputTracker.snapshot()) {
      result[sessionId] = true;
    }
    return result;
  }

  /** Return cached usage data filtered to a specific project. */
  getUsageCacheForProject(projectId: string): Record<string, SessionUsage> {
    return filterCacheByProject(
      this.telemetry.getUsageCache(),
      (sessionId) => this.registry.getSessionProjectId(sessionId),
      projectId,
    );
  }

  /** Return cached activity state filtered to a specific project. */
  getActivityCacheForProject(projectId: string): Record<string, ActivityState> {
    return filterCacheByProject(
      this.telemetry.getActivityCache(),
      (sessionId) => this.registry.getSessionProjectId(sessionId),
      projectId,
    );
  }

  /** Return cached ActivityReason filtered to a specific project. */
  getActivityReasonsCacheForProject(projectId: string): Record<string, ActivityReason> {
    return filterCacheByProject(
      this.telemetry.getActivityReasonsCache(),
      (sessionId) => this.registry.getSessionProjectId(sessionId),
      projectId,
    );
  }

  /** Return cached events filtered to a specific project. */
  getEventsCacheForProject(projectId: string): Record<string, SessionEvent[]> {
    return filterCacheByProject(
      this.telemetry.getEventsCache(),
      (sessionId) => this.registry.getSessionProjectId(sessionId),
      projectId,
    );
  }

  /** Return the projectId for a given session, or undefined if not found. */
  getSessionProjectId(sessionId: string): string | undefined {
    return this.registry.getSessionProjectId(sessionId);
  }

  /** Return the taskId for a given session, or undefined if not found. */
  getSessionTaskId(sessionId: string): string | undefined {
    return this.registry.getSessionTaskId(sessionId);
  }

  /** Return the adapter name (e.g. "claude", "codex") for a given session,
   *  or undefined if not found or the spawn predates agentName tracking. */
  getSessionAgentName(sessionId: string): string | undefined {
    return this.registry.getSessionAgentName(sessionId);
  }

  /**
   * Register a suspended placeholder session for a task that was user-paused
   * before app restart. The placeholder has no PTY but makes the renderer
   * show "Paused" state and the "Resume session" button.
   *
   * Idempotent per task: returns null, inserting and emitting nothing, when
   * the task already holds a live or suspended row (see
   * `SessionRegistry.registerSuspendedPlaceholder` for the contract). An
   * exited row is replaced, and its per-session caches are cleared here the
   * way `remove()` clears them, minus the kill and the on-disk file deletion
   * the row no longer needs.
   *
   * Emits `session-changed` so the renderer's onStatus listener evicts any
   * stale prior session entry for the same taskId immediately. Without this
   * push the renderer would only learn about the placeholder via the next
   * syncSessions(), leaving a window where stale sessions[] entries from
   * before a project switch can mask the real placeholder state.
   */
  registerSuspendedPlaceholder(input: { taskId: string; projectId: string; cwd: string }): Session | null {
    const exitedRows = this.registry.listByTaskId(input.taskId).filter((row) => row.status === 'exited');
    const session = this.registry.registerSuspendedPlaceholder(input);
    if (!session) return null;
    // The registry inserted, so every pre-existing row was exited and is gone
    // from the map; drop what the other modules still hold for those ids.
    for (const exitedRow of exitedRows) {
      this.sessionIdManager.removeSession(exitedRow.id);
      disposeAdapterAttachment(exitedRow);
      this.sessionFiles.removeSession(exitedRow.id);
      this.clearSessionCaches(exitedRow.id);
      // A row that leaves the registry announces it, here as in remove(): the
      // placeholder's own status push below makes it the task's only row in the
      // renderer, but only a removal push drops the evicted id's per-session
      // map entries (usage, activity, events) with it.
      this.emit('session-removed', exitedRow.id, toSession(exitedRow));
    }
    this.emit('session-changed', session.id, session);
    return session;
  }

  /** Check whether a session (any status) already exists for a given task. */
  hasSessionForTask(taskId: string): boolean {
    return this.registry.hasSessionForTask(taskId);
  }

  /**
   * Find the first live (running/queued) Session for a task. Used by
   * reconcileTaskSessionRef to heal `task.session_id` drift when the
   * registry still holds a live PTY for the task but the DB pointer was
   * cleared (or points at a now-suspended id).
   */
  findLiveSessionByTaskId(taskId: string): Session | undefined {
    return this.registry.findLiveSessionByTaskId(taskId);
  }

  /**
   * Whether the task has an agent worth preserving state for: a live session
   * that is NOT already being killed. See `SessionRegistry.hasLiveSessionForTask`.
   */
  hasLiveSessionForTask(taskId: string): boolean {
    return this.registry.hasLiveSessionForTask(taskId);
  }

  /**
   * Whether this session's teardown is already under way (suspend()'s or
   * kill()'s exit-sequence write, possibly followed by a force-kill). See
   * `SessionRegistry.isSessionTeardownInFlight`.
   */
  isSessionTeardownInFlight(sessionId: string): boolean {
    return this.registry.isSessionTeardownInFlight(sessionId);
  }

  /**
   * Synchronously kill every PTY and clean up. Runs from Electron's
   * `before-quit` handler. Must NOT become async - see
   * session-shutdown.killAllSessions and
   * .claude/rules/synchronous-shutdown.md. Returns the PtyKillReport the
   * before-quit exit-callback drain waits on.
   *
   * `allowGrace` lets a young session's force-kill ride the drain's own timer
   * instead of landing now; pass it only on a route where the drain WILL run.
   * Default false, so a caller that does not say so gets the instant kill and
   * every previously deferred PTY flushed. `dispose()` deliberately leaves the
   * deferred registry alone: it runs one statement after this, and a flush
   * there would undo the deferral the drain is about to wait on.
   */
  killAll(options?: { allowGrace?: boolean }): PtyKillReport {
    const report = killAllSessions(this.shutdownContext(), {
      allowGrace: options?.allowGrace === true,
      deferredKills: this.deferredKills,
    });
    // The PTYs' exit callbacks land in the pty host, which exits itself once
    // they have (or at its own deadline), after `dispose()` posts its shutdown.
    // The drain waits for that process too, so the quit never tears the host
    // down while one of those callbacks is in flight (Sentry DESKTOP-C, now
    // in the host). Counted as one more kill so the blind count stays right.
    // The host's own wait ends inside the drain's deadline, which a deferred
    // kill extends by its grace.
    this.hostExitWaitMs = PTY_EXIT_DRAIN_DEADLINE_MS
      + (report.deferredCount > 0 ? KILL_GRACE_MS : 0)
      - HOST_EXIT_MARGIN_MS;
    const hostPid = this.host.hostPid;
    // A spawn still in its host round trip counts too: the host may have
    // started its PTY, which the spawn flow kills when its reply lands.
    if (hostPid === null || (report.killedCount === 0 && this.spawnsInFlight.size === 0)) return report;
    return { ...report, pids: [...report.pids, hostPid], killedCount: report.killedCount + 1 };
  }

  private shutdownContext() {
    return {
      sessions: this.registry.raw(),
      sessionQueue: this.sessionQueue,
      sessionFiles: this.sessionFiles,
      firstOutputTracker: this.firstOutputTracker,
      killPty: safeKillPty,
    };
  }
}
