import fs from 'node:fs';
import { EventType, EventTypeActivity, AgentTool, IdleReason, PromptReason } from '../../shared/types';
import type { SessionUsage, ActivityState, SessionEvent, AgentParser } from '../../shared/types';
import { matchesPRCommand } from './pr-connectors';
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
        // If tools are in-flight, the agent is busy (not stale). Reset the
        // timer and re-check later instead of transitioning to idle.
        if (state.pendingToolCount > 0) {
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
   * Read and emit usage data from a session's status output file.
   * Shared by both the fs.watch callback and polling fallback.
   */
  readAndEmitUsage(sessionId: string, statusOutputPath: string): void {
    try {
      const raw = fs.readFileSync(statusOutputPath, 'utf-8');
      const parser = this.sessionParsers.get(sessionId);
      const usage = parser?.parseStatus(raw) ?? null;
      if (!usage) return;

      // Extract agent-reported session_id from raw status.json for stale ID recovery.
      // Only check once per session - after the first status update the DB is corrected
      // and subsequent calls would be no-op lookups.
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

      // Heartbeat recovery: if tokens increased while idle for >1s, agent resumed work.
      // During any true idle, the model is blocked and token counts are frozen.
      // Only when work genuinely resumes do tokens climb. The 1-second grace period
      // prevents race conditions from status updates arriving slightly after an idle event.
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
    } catch {
      // File may not exist yet - ignore
    }
  }

  /**
   * Read new lines from a session's events JSONL file and process them.
   * Uses eventsFileOffset as cursor - safe to call from multiple triggers.
   * Returns the new file offset.
   */
  readAndProcessEvents(sessionId: string, eventsOutputPath: string, fileOffset: number): number {
    try {
      const stat = fs.statSync(eventsOutputPath);
      if (stat.size <= fileOffset) return fileOffset;

      const fd = fs.openSync(eventsOutputPath, 'r');
      const buf = Buffer.alloc(stat.size - fileOffset);
      fs.readSync(fd, buf, 0, buf.length, fileOffset);
      fs.closeSync(fd);
      const newOffset = stat.size;

      const chunk = buf.toString('utf-8');
      const lines = chunk.split('\n').filter(Boolean);

      // Get or create event cache for this session
      let events = this.eventCache.get(sessionId);
      if (!events) {
        events = [];
        this.eventCache.set(sessionId, events);
      }

      const parser = this.sessionParsers.get(sessionId);
      for (const line of lines) {
        this.tryCaptureAgentSessionId(sessionId, line, parser);

        const event = parser?.parseEvent(line) ?? null;
        if (!event) continue;

        events.push(event);
        this.callbacks.onEvent(sessionId, event);

        this.maybeSuppressPtyTracker(sessionId, event, parser);
        this.detectExitPlanMode(sessionId, event);
        this.detectPRCommand(sessionId, event);

        // All activity state transitions (guards, counters, timestamps)
        // happen inside the state machine.
        this.activityStateMachine.processEvent(sessionId, event);
      }

      // Cap cached events per session
      if (events.length > MAX_EVENTS_PER_SESSION) {
        const trimmed = events.slice(-MAX_EVENTS_PER_SESSION);
        this.eventCache.set(sessionId, trimmed);
      }

      return newOffset;
    } catch {
      // File may not exist yet, or be partially written - ignore
      return fileOffset;
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
