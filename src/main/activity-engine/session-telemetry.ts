import { EventType, AgentTool, IdleReason, PromptReason, Activity } from '../../shared/types';
import type { SessionUsage, ActivityState, ActivityReason, SessionEvent, AgentParser, PerToolStat } from '../../shared/types';
import { PtyActivityTracker } from './pty-activity-tracker';
import { ActivityEngine, ActivitySnapshotWriter, type ActivityEngineOptions, type ActivityStatsSnapshot } from './engine';
import { BgShellWatcher } from './background-shell/watcher';
import { createProcessTreeProbe, type ProcessTreeProbe } from './background-shell/process-tree';
import { looksLikeShellId } from './background-shell/looks-like-shell-id';
import { UsageAccumulator } from './usage-accumulator';
import { PRCommandDetector } from './pr-command-detector';
import { UserInterruptCoordinator } from './user-interrupt-coordinator';

const MAX_EVENTS_PER_SESSION = 500;

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
  onEvent(sessionId: string, event: SessionEvent): void;
  onIdleTimeout(sessionId: string): void;
  onPlanExit(sessionId: string): void;
  onPRCandidate(sessionId: string): void;
  /** Called when the agent reports its own session_id (from status.json). */
  onAgentSessionId?(sessionId: string, agentReportedId: string): void;
  requestSuspend(sessionId: string): void;
  isSessionRunning(sessionId: string): boolean;
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
  private readonly eventCache = new Map<string, SessionEvent[]>();
  private _idleTimeoutMinutes = 0;
  private idleTimeoutInterval: ReturnType<typeof setInterval> | null = null;

  private readonly callbacks: SessionTelemetryCallbacks;

  constructor(
    callbacks: SessionTelemetryCallbacks,
    options: SessionTelemetryOptions = {},
  ) {
    this.callbacks = callbacks;
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
      },
      onSyntheticEvent: (sessionId, event) => {
        // Push the engine-originated synthetic event (e.g. watchdog-driven
        // Idle/Timeout) into the activity log so the renderer can render
        // a "why did this go idle?" entry. Fired BEFORE the matching
        // onActivityChange so the log entry appears before the state
        // change in any listener that observes both streams.
        this.pushEvent(sessionId, event);
      },
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
          getActiveShellCount: (sessionId) => {
            const state = this.activityEngine.getState(sessionId);
            if (!state) return 0;
            return state.activeBackgroundShellIds.size + state.anonymousBackgroundShellCount;
          },
          getNamedShellIds: (sessionId) => {
            const state = this.activityEngine.getState(sessionId);
            if (!state) return [];
            return Array.from(state.activeBackgroundShellIds);
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
          },
          onNamedShellLikelyExited: (sessionId, shellId) => {
            // Watcher reclaimed a PID-less named bg shell whose output file has
            // been quiescent past the threshold while the OS process tree shows
            // a persistent deficit (its `background_shell_end` hook was dropped).
            // Drain it by id, same as a Tier A PID exit - the engine's named
            // drain is identity-aware.
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
      const idleStart = state.idleTimestamp;
      if (idleStart && (now - idleStart) > timeoutMs) {
        this.callbacks.requestSuspend(sessionId);
        this.callbacks.onIdleTimeout(sessionId);
      }
    });
  }

  // ==== Status-update ingest (Claude statusline) ====

  /**
   * Rich status-update ingestion for agents whose telemetry comes from
   * a streaming status file (Claude's statusline). Performs one-shot
   * agent session ID capture, runs heartbeat recovery (tokens increased
   * while idle → force thinking), resets the stale-thinking timer, and
   * replaces the cached usage. Called by `StatusFileReader`.
   */
  processStatusUpdate(sessionId: string, usage: SessionUsage): void {
    if (this.callbacks.onAgentSessionId && !this.agentSessionIdChecked.has(sessionId)) {
      this.agentSessionIdChecked.add(sessionId);
      if (usage.sessionId && typeof usage.sessionId === 'string') {
        this.callbacks.onAgentSessionId(sessionId, usage.sessionId);
      }
    }

    const previousUsage = this.usage.getSessionUsage(sessionId);

    // Stamp the authoritative cumulative tool-call count onto the payload.
    // It lives in the accumulator and survives the bounded event cache, so the
    // renderer cannot derive it from `sessionEvents`. Stamping before the cache
    // write means snapshot reads (getUsageCache) carry it too.
    usage.toolCallCount = this.usage.getToolCallCount(sessionId);
    this.usage.replaceSessionUsage(sessionId, usage);
    this.callbacks.onUsageChange(sessionId, usage);

    const state = this.activityEngine.getOrCreateState(sessionId);

    if (state.activity === 'thinking') {
      this.activityEngine.markThinkingSignal(sessionId);
    }

    // Heartbeat recovery: if tokens increased while idle for >1s, the
    // agent resumed work. The 1-second grace prevents races between
    // status updates and an idle event landing in the same tick.
    if (previousUsage && state.activity === 'idle') {
      const previousTokens = previousUsage.contextWindow.totalInputTokens
                           + previousUsage.contextWindow.totalOutputTokens;
      const currentTokens = usage.contextWindow.totalInputTokens
                          + usage.contextWindow.totalOutputTokens;
      const idleStart = state.idleTimestamp;
      if (currentTokens > previousTokens && idleStart && (Date.now() - idleStart) > 1000) {
        this.activityEngine.forceThinking(sessionId);
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
    this.callbacks.onAgentSessionId?.(sessionId, capturedId);
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
   * Clear all per-session tracking state (used by suspend). Keeps the
   * eventCache and sessionParsers entries because the session record
   * may be reused on resume.
   */
  clearSessionTracking(sessionId: string): void {
    this.activityEngine.deleteSession(sessionId);
    this.ptyTracker.clearSession(sessionId);
    this.notifySessionEnded(sessionId);
  }

  /** Delete all state for a session (full removal). */
  removeSession(sessionId: string): void {
    this.usage.removeSession(sessionId);
    this.activityEngine.deleteSession(sessionId);
    this.ptyTracker.clearSession(sessionId);
    this.eventCache.delete(sessionId);
    this.sessionParsers.delete(sessionId);
    this.agentSessionIdChecked.delete(sessionId);
    this.prCommandDetector.removeSession(sessionId);
    this.notifySessionEnded(sessionId);
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
    this.userInterrupts.dispose();
    this.ptyTracker.dispose();
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
    this.activityEngine.forceIdle(sessionId);
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
  setSessionUsage(sessionId: string, partial: Partial<SessionUsage>): void {
    const merged = this.usage.setSessionUsage(sessionId, partial);
    // `merged` is the cached object, so stamping the live tool-call count here
    // keeps both the renderer push and snapshot reads consistent (see
    // processStatusUpdate).
    merged.toolCallCount = this.usage.getToolCallCount(sessionId);
    this.callbacks.onUsageChange(sessionId, merged);
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
   *   - `maybeSuppressPtyTracker` once a hooks_and_pty agent delivers a
   *     thinking signal
   *   - `detectExitPlanMode` fires plan-exit when ExitPlanMode tool
   *     completes (user approved the plan)
   *   - activity engine processes the event (counters + predicate)
   *   - bg-shell watcher baseline re-anchors on BackgroundShellStart
   */
  ingestEvents(sessionId: string, events: SessionEvent[]): void {
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

      this.usage.recordToolEvent(sessionId, event);

      this.maybeSuppressPtyTracker(sessionId, event, parser);
      this.detectExitPlanMode(sessionId, event);

      const prResult = this.prCommandDetector.detect(sessionId, event);
      if (prResult.fireCandidate) {
        this.callbacks.onPRCandidate(sessionId);
      }

      this.activityEngine.processEvent(sessionId, event);

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
      this.pushEvent(sessionId, event);
      this.activityEngine.forceIdle(sessionId);
    }
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

  getActivityCache(): Record<string, ActivityState> {
    return this.activityEngine.getActivityCache();
  }

  getSessionActivity(sessionId: string): ActivityState | undefined {
    return this.activityEngine.getState(sessionId)?.activity;
  }

  getActivityReason(sessionId: string): ActivityReason | null {
    return this.activityEngine.getActivityReason(sessionId);
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

  getToolCallCount(sessionId: string): number {
    return this.usage.getToolCallCount(sessionId);
  }

  getToolBreakdown(sessionId: string): PerToolStat[] {
    return this.usage.getToolBreakdown(sessionId);
  }

  // ==== Internal ====

  /** Append an event to the session cache and notify listeners. */
  private pushEvent(sessionId: string, event: SessionEvent): void {
    let events = this.eventCache.get(sessionId);
    if (!events) { events = []; this.eventCache.set(sessionId, events); }
    events.push(event);
    this.callbacks.onEvent(sessionId, event);
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
