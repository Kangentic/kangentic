import { EventType, EventTypeActivity, AgentTool, IdleReason, PromptReason, Activity } from '../../../shared/types';
import type { SessionUsage, ActivityState, SessionEvent, AgentParser } from '../../../shared/types';
import { matchesPRCommand } from '../pr/pr-connectors';
import { PtyActivityTracker } from './pty-activity-tracker';
import { ActivityStateMachine } from './activity-state-machine';

const MAX_EVENTS_PER_SESSION = 500; // Cap rendered events in renderer
const STALE_THINKING_THRESHOLD_MS = 45_000;
const STALE_THINKING_CHECK_MS = 15_000;

/**
 * Safely extract the `hookContext` string from a raw JSONL line written
 * by event-bridge.js. Returns null for any parse failure or unexpected
 * shape. Type-safe alternative to `JSON.parse(line).hookContext` which
 * would be `any` and hide runtime errors.
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

interface UsageTrackerCallbacks {
  onUsageChange(sessionId: string, usage: SessionUsage): void;
  onActivityChange(sessionId: string, activity: ActivityState, permissionIdle: boolean): void;
  onEvent(sessionId: string, event: SessionEvent): void;
  onIdleTimeout(sessionId: string): void;
  onPlanExit(sessionId: string): void;
  onPRCandidate(sessionId: string): void;
  /** Called when the agent reports its own session_id (from status.json). */
  onAgentSessionId?(sessionId: string, agentReportedId: string): void;
  requestSuspend(sessionId: string): void;
  isSessionRunning(sessionId: string): boolean;
}

/**
 * Tracks per-session usage data, activity state machine, and event log.
 *
 * Owns the non-activity caches (usage, events) and timing logic (idle
 * timeouts, stale thinking detection). The activity state machine itself
 * lives in `ActivityStateMachine` and is delegated to here.
 *
 * SessionManager wires callbacks in its constructor.
 */
export class UsageTracker {
  private usageCache = new Map<string, SessionUsage>();
  private activityStateMachine: ActivityStateMachine;

  private sessionParsers = new Map<string, AgentParser>();
  private agentSessionIdChecked = new Set<string>();
  private eventCache = new Map<string, SessionEvent[]>();
  private _idleTimeoutMinutes = 0;
  private idleTimeoutInterval: ReturnType<typeof setInterval> | null = null;
  private staleThinkingInterval: ReturnType<typeof setInterval> | null = null;

  private callbacks: UsageTrackerCallbacks;
  private ptyTracker: PtyActivityTracker;

  constructor(callbacks: UsageTrackerCallbacks) {
    this.callbacks = callbacks;
    this.activityStateMachine = new ActivityStateMachine({
      onActivityChange: (sessionId, activity, permissionIdle) => {
        this.callbacks.onActivityChange(sessionId, activity, permissionIdle);
      },
    });
    this.ptyTracker = new PtyActivityTracker({
      onThinking: (sessionId) => this.handlePtyThinking(sessionId),
      onIdle: (sessionId, detail) => this.handlePtyIdle(sessionId, detail),
      getActivity: (sessionId) => this.activityStateMachine.getState(sessionId)?.activity,
      isSessionRunning: (sessionId) => callbacks.isSessionRunning(sessionId),
    });
    this.staleThinkingInterval = setInterval(
      () => this.checkStaleThinking(),
      STALE_THINKING_CHECK_MS,
    );
    this.staleThinkingInterval.unref();
  }

  get idleTimeoutMinutes(): number {
    return this._idleTimeoutMinutes;
  }

  setIdleTimeout(minutes: number): void {
    this._idleTimeoutMinutes = minutes;

    // Clear existing interval
    if (this.idleTimeoutInterval) {
      clearInterval(this.idleTimeoutInterval);
      this.idleTimeoutInterval = null;
    }

    // Start checking every 60s if timeout is enabled.
    // unref() ensures this interval doesn't keep the process alive during shutdown.
    if (minutes > 0) {
      this.idleTimeoutInterval = setInterval(() => this.checkIdleTimeouts(), 60_000);
      this.idleTimeoutInterval.unref();
    }
  }

  private checkIdleTimeouts(): void {
    if (this._idleTimeoutMinutes <= 0) return;

    const timeoutMs = this._idleTimeoutMinutes * 60_000;
    const now = Date.now();

    this.activityStateMachine.forEachState((sessionId, state) => {
      if (state.activity !== 'idle') return;
      if (!this.callbacks.isSessionRunning(sessionId)) return;

      const idleStart = state.idleTimestamp;
      if (idleStart && (now - idleStart) > timeoutMs) {
        this.callbacks.requestSuspend(sessionId);
        this.callbacks.onIdleTimeout(sessionId);
      }
    });
  }

  private checkStaleThinking(): void {
    const now = Date.now();
    this.activityStateMachine.forEachState((sessionId, state) => {
      if (state.activity !== 'thinking') return;
      if (!this.callbacks.isSessionRunning(sessionId)) return;

      // Skip sessions still in nucleation (first 45s after entering thinking).
      // During nucleation, agents read local context before making API calls.
      // No hooks fire initially, so the stale threshold doesn't apply yet.
      // Time-based guard works for all agents (not just Claude Code which has usageCache).
      const firstThinking = state.firstThinkingTimestamp;
      if (firstThinking && (now - firstThinking) < STALE_THINKING_THRESHOLD_MS) return;

      const lastSignal = state.lastThinkingSignal;
      if (lastSignal && (now - lastSignal) > STALE_THINKING_THRESHOLD_MS) {
        // If tools are in-flight OR a backgrounded Bash is still running,
        // the agent is busy (not stale). Reset the timer and re-check later
        // instead of force-idling, which would bypass Guard 3
        // (deferStopUntilBackgroundShellsFinish) and flip the state to idle
        // even though there is real detached work outstanding.
        if (state.pendingToolCount > 0 || state.activeBackgroundShells > 0) {
          this.activityStateMachine.markThinkingSignal(sessionId);
          return;
        }

        // Push the synthetic idle event FIRST so that listeners see the
        // activity log entry before the state transition callback fires.
        // This preserves the original tracker's callback ordering:
        // onEvent -> onActivityChange. Then force the transition without
        // going through the guards (stale-thinking recovery bypasses
        // Guard 2, matching the non-refactored behavior).
        const timeoutEvent: SessionEvent = { ts: Date.now(), type: EventType.Idle, detail: IdleReason.Timeout };
        this.pushEvent(sessionId, timeoutEvent);
        this.activityStateMachine.forceIdle(sessionId);
      }
    });
  }

  /**
   * Rich status-update ingestion for agents whose telemetry comes from
   * a streaming status file (Claude's statusline). Performs one-shot
   * agent session ID capture (from `usage.sessionId`), runs heartbeat
   * recovery (tokens increased while idle → force thinking), resets
   * the stale-thinking timer, and merges the usage into the cache.
   *
   * Called by `StatusFileReader`. For simpler telemetry sources that
   * only need the merge (Codex/Gemini session history), use
   * `setSessionUsage` instead.
   */
  processStatusUpdate(sessionId: string, usage: SessionUsage): void {
    // One-shot agent session ID capture from the status payload. This
    // is the status-file equivalent of fromHook / fromOutput scraping -
    // when the agent reports its own UUID in the status.json, use it
    // for stale ID recovery. Only runs once per session.
    if (this.callbacks.onAgentSessionId && !this.agentSessionIdChecked.has(sessionId)) {
      this.agentSessionIdChecked.add(sessionId);
      if (usage.sessionId && typeof usage.sessionId === 'string') {
        this.callbacks.onAgentSessionId(sessionId, usage.sessionId);
      }
    }

    const previousUsage = this.usageCache.get(sessionId);

    this.usageCache.set(sessionId, usage);
    this.callbacks.onUsageChange(sessionId, usage);

    const state = this.activityStateMachine.getOrCreateState(sessionId);

    // Usage update proves the agent is working. Reset stale thinking timer.
    if (state.activity === 'thinking') {
      this.activityStateMachine.markThinkingSignal(sessionId);
    }

    // Heartbeat recovery: if tokens increased while idle for >1s, the
    // agent resumed work. During true idle, the model is blocked and
    // token counts are frozen. Only when work genuinely resumes do
    // tokens climb. The 1-second grace period prevents race conditions
    // from status updates arriving slightly after an idle event.
    if (previousUsage && state.activity === 'idle') {
      const previousTokens = previousUsage.contextWindow.totalInputTokens
                           + previousUsage.contextWindow.totalOutputTokens;
      const currentTokens = usage.contextWindow.totalInputTokens
                          + usage.contextWindow.totalOutputTokens;
      const idleStart = state.idleTimestamp;
      if (currentTokens > previousTokens && idleStart && (Date.now() - idleStart) > 1000) {
        this.activityStateMachine.forceThinking(sessionId);
      }
    }
  }

  /**
   * One-shot hook-based agent session ID capture. Scans raw JSON lines
   * from an event-bridge-style source (event-bridge.js writes
   * `hookContext` alongside each parsed event) and calls the parser's
   * `runtime.sessionId.fromHook` to extract the agent-reported UUID.
   * Fires `onAgentSessionId` callback on the first successful capture.
   *
   * Separate from `ingestEvents` because this needs raw line JSON
   * (hookContext is not exposed on `SessionEvent`), while `ingestEvents`
   * works on parsed events alone.
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

  // ==== Per-event side detectors ====
  //
  // These run for each parsed event inside the main read loop. Each one
  // handles a single unrelated concern so that the loop body itself stays
  // a linear list of labeled steps.

  /**
   * One-shot capture of the agent's own session ID from the hook stdin
   * payload (event-bridge.js writes the raw hookContext alongside the
   * parsed event). The adapter's `runtime.sessionId.fromHook` extracts
   * an agent-specific field. Silently ignores malformed lines.
   */
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

  /**
   * For `hooks_and_pty` agents, suppress PTY-based activity detection
   * once hooks prove they are working (by delivering at least one
   * thinking event). Pure `pty` agents never get hook events; pure
   * `hooks` agents don't have PTY detection enabled. Must run before
   * processEvent so a thinking event suppresses PTY in the same tick
   * it transitions the state.
   */
  private maybeSuppressPtyTracker(sessionId: string, event: SessionEvent, parser: AgentParser | undefined): void {
    if (EventTypeActivity[event.type] !== 'thinking') return;
    if (parser?.runtime?.activity?.kind !== 'hooks_and_pty') return;
    this.ptyTracker.suppress(sessionId);
  }

  /**
   * Detect `ExitPlanMode` tool invocations. Uses ToolStart (PreToolUse)
   * because ExitPlanMode is a mode-transition tool that may not fire
   * PostToolUse (ToolEnd).
   */
  private detectExitPlanMode(sessionId: string, event: SessionEvent): void {
    if (event.type !== EventType.ToolStart) return;
    if (event.tool !== AgentTool.ExitPlanMode) return;
    this.callbacks.onPlanExit(sessionId);
  }

  /**
   * Detect GitHub PR commands so SessionManager can scan scrollback for
   * the printed PR URL on the corresponding ToolEnd. On ToolStart for a
   * Bash with a `gh pr ...` command, flip the flag; on the matching
   * ToolEnd, fire the callback.
   */
  private detectPRCommand(sessionId: string, event: SessionEvent): void {
    if (event.type === EventType.ToolStart
        && event.tool === AgentTool.Bash
        && event.detail
        && matchesPRCommand(event.detail)) {
      this.activityStateMachine.setPendingPRCommand(sessionId, true);
    } else if (event.type === EventType.ToolEnd
        && event.tool === AgentTool.Bash
        && this.activityStateMachine.hasPendingPRCommand(sessionId)) {
      this.activityStateMachine.setPendingPRCommand(sessionId, false);
      this.callbacks.onPRCandidate(sessionId);
    }
  }

  /**
   * Initialize tracking state for a new session.
   * Sets default activity to 'idle' and resets all per-session state.
   */
  initSession(sessionId: string, agentParser?: AgentParser): void {
    if (agentParser) {
      this.sessionParsers.set(sessionId, agentParser);
    }
    this.activityStateMachine.initSession(sessionId);
    this.ptyTracker.clearSession(sessionId);
  }

  /** True if an agent session ID has already been captured for this session. */
  hasAgentSessionId(sessionId: string): boolean {
    return this.agentSessionIdChecked.has(sessionId);
  }

  /**
   * Notify that an agent session ID was captured from PTY output.
   * Called by SessionManager when an adapter's runtime.sessionId.fromOutput
   * returns a non-null value. Delegates to the same callback used for
   * hook-based and status.json-based capture.
   */
  notifyAgentSessionId(sessionId: string, agentReportedId: string): void {
    if (!this.agentSessionIdChecked.has(sessionId)) {
      this.agentSessionIdChecked.add(sessionId);
      this.callbacks.onAgentSessionId?.(sessionId, agentReportedId);
    }
  }

  /**
   * Inject a synthetic session_end event into the event cache and emit it.
   * Claude Code's SessionEnd hook won't fire when we kill the PTY, so we
   * synthesize one ourselves so the activity log always shows session end.
   */
  emitSessionEnd(sessionId: string): void {
    let events = this.eventCache.get(sessionId);
    // Skip if the last event is already session_end (Claude Code may have fired it)
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

  /** Check if a PR command was flagged but ToolEnd was never processed. */
  hasPendingPRCommand(sessionId: string): boolean {
    return this.activityStateMachine.hasPendingPRCommand(sessionId);
  }

  /** Clear the pending PR command flag (used by fallback scan on exit). */
  clearPendingPRCommand(sessionId: string): void {
    this.activityStateMachine.setPendingPRCommand(sessionId, false);
  }

  /**
   * Clear all per-session tracking state (used by suspend). Keeps the
   * eventCache and sessionParsers entries because the session record may
   * be reused on resume.
   */
  clearSessionTracking(sessionId: string): void {
    this.activityStateMachine.deleteSession(sessionId);
    this.ptyTracker.clearSession(sessionId);
  }

  /** Delete all state for a session (full removal). */
  removeSession(sessionId: string): void {
    this.usageCache.delete(sessionId);
    this.activityStateMachine.deleteSession(sessionId);
    this.ptyTracker.clearSession(sessionId);
    this.eventCache.delete(sessionId);
    this.sessionParsers.delete(sessionId);
    this.agentSessionIdChecked.delete(sessionId);
  }

  // -- PTY-based activity detection (delegated to PtyActivityTracker) --------

  /** Forward PTY data to the tracker. Called by SessionManager for agents
   *  with 'pty' or 'hooks_and_pty' activity strategies. */
  notifyPtyData(sessionId: string): void {
    this.ptyTracker.onData(sessionId);
  }

  /** Forward definitive idle signal to the tracker. */
  notifyPtyIdle(sessionId: string): void {
    this.ptyTracker.onIdleDetected(sessionId);
  }

  /** Callback from PtyActivityTracker: PTY data indicates agent is working. */
  private handlePtyThinking(sessionId: string): void {
    // Preserve original ordering: push the synthetic event (onEvent) first,
    // then fire the activity transition (onActivityChange) via forceThinking.
    const event: SessionEvent = { ts: Date.now(), type: EventType.Prompt, detail: PromptReason.PtyActivity };
    this.pushEvent(sessionId, event);
    this.activityStateMachine.forceThinking(sessionId);
  }

  /** Callback from PtyActivityTracker: silence or prompt detected. */
  private handlePtyIdle(sessionId: string, detail: IdleReason): void {
    // Preserve original ordering: push the synthetic event (onEvent) first,
    // then fire the activity transition (onActivityChange) via forceIdle.
    const event: SessionEvent = { ts: Date.now(), type: EventType.Idle, detail };
    this.pushEvent(sessionId, event);
    this.activityStateMachine.forceIdle(sessionId);
  }

  /** Append an event to the session cache and notify listeners. */
  private pushEvent(sessionId: string, event: SessionEvent): void {
    let events = this.eventCache.get(sessionId);
    if (!events) { events = []; this.eventCache.set(sessionId, events); }
    events.push(event);
    this.callbacks.onEvent(sessionId, event);
  }

  dispose(): void {
    if (this.idleTimeoutInterval) {
      clearInterval(this.idleTimeoutInterval);
      this.idleTimeoutInterval = null;
    }
    if (this.staleThinkingInterval) {
      clearInterval(this.staleThinkingInterval);
      this.staleThinkingInterval = null;
    }
    this.ptyTracker.dispose();
  }

  /**
   * Upsert a partial SessionUsage entry for a session. Used by agents
   * that derive usage from native log files (Codex, Gemini) rather than
   * a streamed status.json (Claude). Merges with any existing entry,
   * seeding a zeroed base if none exists. Emits onUsageChange so the
   * renderer updates.
   */
  setSessionUsage(sessionId: string, partial: Partial<SessionUsage>): void {
    const base: SessionUsage = this.usageCache.get(sessionId) ?? {
      contextWindow: {
        usedPercentage: 0,
        usedTokens: 0,
        cacheTokens: 0,
        totalInputTokens: 0,
        totalOutputTokens: 0,
        contextWindowSize: 0,
      },
      cost: { totalCostUsd: 0, totalDurationMs: 0 },
      model: { id: '', displayName: '' },
    };
    const next: SessionUsage = {
      ...base,
      ...partial,
      contextWindow: { ...base.contextWindow, ...(partial.contextWindow ?? {}) },
      cost: { ...base.cost, ...(partial.cost ?? {}) },
      model: { ...base.model, ...(partial.model ?? {}) },
    };
    // Recalculate usedPercentage from merged values. Individual parse
    // chunks (Codex append-mode JSONL) may provide contextWindowSize
    // and usedTokens in separate updates; computing percentage only
    // after merge ensures consistency across chunks.
    const mergedContext = next.contextWindow;
    if (mergedContext.contextWindowSize > 0 && mergedContext.usedTokens > 0) {
      mergedContext.usedPercentage = (mergedContext.usedTokens / mergedContext.contextWindowSize) * 100;
    }
    this.usageCache.set(sessionId, next);
    this.callbacks.onUsageChange(sessionId, next);
  }

  /**
   * Ingest a batch of events into the session event log and run each
   * through the activity state machine. Generic primitive - any
   * subsystem producing events (native history readers, hook bridges,
   * future telemetry sources) can call this. Caps the per-session
   * event cache at MAX_EVENTS_PER_SESSION.
   *
   * Per-event detectors run for every event regardless of source:
   * - `maybeSuppressPtyTracker`: once hooks_and_pty agents deliver a
   *   thinking signal, PTY-based silence timers are suppressed.
   * - `detectExitPlanMode`: fires a plan-exit callback when an
   *   `ExitPlanMode` tool invocation is seen.
   * - `detectPRCommand`: tracks pending `gh pr ...` commands so the
   *   consumer can scan scrollback for the printed PR URL.
   *
   * These detectors are generic (keyed on EventType + adapter runtime
   * strategy) and safe to run regardless of whether the event came
   * from a hook pipeline or a native session-history file.
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

      this.maybeSuppressPtyTracker(sessionId, event, parser);
      this.detectExitPlanMode(sessionId, event);
      this.detectPRCommand(sessionId, event);

      this.activityStateMachine.processEvent(sessionId, event);
    }
    if (cached.length > MAX_EVENTS_PER_SESSION) {
      const trimmed = cached.slice(-MAX_EVENTS_PER_SESSION);
      this.eventCache.set(sessionId, trimmed);
    }
  }

  /**
   * Force the activity state machine to a specific state. Pushes a
   * synthetic event into the log (matching the PtyActivityTracker
   * callback pattern at handlePtyThinking/handlePtyIdle) and calls the
   * state machine's force* methods. Generic primitive callable by any
   * telemetry source that wants to override the default state machine
   * transitions.
   */
  forceActivity(sessionId: string, activity: Activity): void {
    if (activity === Activity.Thinking) {
      const event: SessionEvent = { ts: Date.now(), type: EventType.Prompt, detail: PromptReason.PtyActivity };
      this.pushEvent(sessionId, event);
      this.activityStateMachine.forceThinking(sessionId);
    } else if (activity === Activity.Idle) {
      const event: SessionEvent = { ts: Date.now(), type: EventType.Idle, detail: IdleReason.Prompt };
      this.pushEvent(sessionId, event);
      this.activityStateMachine.forceIdle(sessionId);
    }
  }

  /**
   * Suppress PTY-based activity tracking for a session. Called by
   * subsystems (native history readers, hook pipelines) once they
   * confirm authoritative telemetry is flowing, so PTY silence-timer
   * heuristics stop competing. Shares the same underlying mechanism
   * Claude's hooks use (maybeSuppressPtyTracker above).
   */
  suppressPty(sessionId: string): void {
    this.ptyTracker.suppress(sessionId);
  }

  /** Return cached usage data for all sessions. */
  getUsageCache(): Record<string, SessionUsage> {
    const result: Record<string, SessionUsage> = {};
    for (const [id, usage] of this.usageCache) {
      result[id] = usage;
    }
    return result;
  }

  /** Return cached activity state for all sessions. */
  getActivityCache(): Record<string, ActivityState> {
    return this.activityStateMachine.getActivityCache();
  }

  /** Return current activity for a single session (efficient O(1) lookup). */
  getSessionActivity(sessionId: string): ActivityState | undefined {
    return this.activityStateMachine.getState(sessionId)?.activity;
  }

  /** Return cached events for a specific session. */
  getEventsForSession(sessionId: string): SessionEvent[] {
    return this.eventCache.get(sessionId) || [];
  }

  /** Return cached events for all sessions. */
  getEventsCache(): Record<string, SessionEvent[]> {
    const result: Record<string, SessionEvent[]> = {};
    for (const [id, events] of this.eventCache) {
      result[id] = events;
    }
    return result;
  }
}
