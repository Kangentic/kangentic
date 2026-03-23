import fs from 'node:fs';
import { ClaudeStatusParser } from '../agent/claude-status-parser';
import { EventType, EventTypeActivity, ClaudeTool } from '../../shared/types';
import type { SessionUsage, ActivityState, SessionEvent } from '../../shared/types';
import { matchesPRCommand } from './pr-connectors';

const MAX_EVENTS_PER_SESSION = 500; // Cap rendered events in renderer
const STALE_THINKING_THRESHOLD_MS = 45_000;
const STALE_THINKING_CHECK_MS = 15_000;

interface UsageTrackerCallbacks {
  onUsageChange(sessionId: string, usage: SessionUsage): void;
  onActivityChange(sessionId: string, activity: ActivityState, permissionIdle: boolean): void;
  onEvent(sessionId: string, event: SessionEvent): void;
  onIdleTimeout(sessionId: string): void;
  onPlanExit(sessionId: string): void;
  onPRCandidate(sessionId: string): void;
  requestSuspend(sessionId: string): void;
  isSessionRunning(sessionId: string): boolean;
}

/**
 * Tracks per-session usage data, activity state machine, and event log.
 *
 * Owns all caches (usage, activity, events) and timing logic (idle timeouts,
 * stale thinking detection). SessionManager wires callbacks in its constructor.
 */
export class UsageTracker {
  private usageCache = new Map<string, SessionUsage>();
  private activityCache = new Map<string, ActivityState>();
  private subagentDepth = new Map<string, number>();
  private pendingToolCount = new Map<string, number>();
  private pendingIdleWhileSubagent = new Map<string, boolean>();
  private pendingPRCommand = new Map<string, boolean>();
  private permissionIdle = new Map<string, boolean>();
  private idleTimestamp = new Map<string, number>();
  private lastThinkingSignal = new Map<string, number>();

  private eventCache = new Map<string, SessionEvent[]>();
  private _idleTimeoutMinutes = 0;
  private idleTimeoutInterval: ReturnType<typeof setInterval> | null = null;
  private staleThinkingInterval: ReturnType<typeof setInterval> | null = null;

  private callbacks: UsageTrackerCallbacks;

  constructor(callbacks: UsageTrackerCallbacks) {
    this.callbacks = callbacks;
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

    for (const [sessionId, activity] of this.activityCache) {
      if (activity !== 'idle') continue;
      if (!this.callbacks.isSessionRunning(sessionId)) continue;

      const idleStart = this.idleTimestamp.get(sessionId);
      if (idleStart && (now - idleStart) > timeoutMs) {
        this.callbacks.requestSuspend(sessionId);
        this.callbacks.onIdleTimeout(sessionId);
      }
    }
  }

  private checkStaleThinking(): void {
    const now = Date.now();
    for (const [sessionId, activity] of this.activityCache) {
      if (activity !== 'thinking') continue;
      if (!this.callbacks.isSessionRunning(sessionId)) continue;

      // Skip sessions that haven't received usage data yet (still nucleating).
      // During nucleation, Claude Code reads local context before making API calls.
      // No hooks fire and no status.json exists, so the 45s threshold doesn't apply.
      if (!this.usageCache.has(sessionId)) continue;

      const lastSignal = this.lastThinkingSignal.get(sessionId);
      if (lastSignal && (now - lastSignal) > STALE_THINKING_THRESHOLD_MS) {
        // If tools are in-flight, the agent is busy (not stale). Reset the
        // timer and re-check later instead of transitioning to idle.
        if ((this.pendingToolCount.get(sessionId) || 0) > 0) {
          this.lastThinkingSignal.set(sessionId, now);
          continue;
        }

        this.activityCache.set(sessionId, 'idle');
        this.permissionIdle.set(sessionId, false);
        this.idleTimestamp.set(sessionId, Date.now());
        this.lastThinkingSignal.delete(sessionId);

        // Emit a synthetic idle event so the activity log shows why it went idle
        const timeoutEvent: SessionEvent = { ts: Date.now(), type: EventType.Idle, detail: 'timeout' };
        let events = this.eventCache.get(sessionId);
        if (!events) {
          events = [];
          this.eventCache.set(sessionId, events);
        }
        events.push(timeoutEvent);
        this.callbacks.onEvent(sessionId, timeoutEvent);

        this.callbacks.onActivityChange(sessionId, 'idle', false);
      }
    }
  }

  /**
   * Read and emit usage data from a session's status output file.
   * Shared by both the fs.watch callback and polling fallback.
   */
  readAndEmitUsage(sessionId: string, statusOutputPath: string): void {
    try {
      const raw = fs.readFileSync(statusOutputPath, 'utf-8');
      const usage = ClaudeStatusParser.parseStatus(raw);
      if (!usage) return;

      const previousUsage = this.usageCache.get(sessionId);

      this.usageCache.set(sessionId, usage);
      this.callbacks.onUsageChange(sessionId, usage);

      // Usage update proves the agent is working. Reset stale thinking timer.
      if (this.activityCache.get(sessionId) === 'thinking') {
        this.lastThinkingSignal.set(sessionId, Date.now());
      }

      // Heartbeat recovery: if tokens increased while idle for >1s, agent resumed work.
      // During any true idle, the model is blocked and token counts are frozen.
      // Only when work genuinely resumes do tokens climb. The 1-second grace period
      // prevents race conditions from status updates arriving slightly after an idle event.
      if (previousUsage && this.activityCache.get(sessionId) === 'idle') {
        const previousTokens = previousUsage.contextWindow.totalInputTokens
                             + previousUsage.contextWindow.totalOutputTokens;
        const currentTokens = usage.contextWindow.totalInputTokens
                            + usage.contextWindow.totalOutputTokens;
        const idleStart = this.idleTimestamp.get(sessionId);
        if (currentTokens > previousTokens && idleStart && (Date.now() - idleStart) > 1000) {
          this.activityCache.set(sessionId, 'thinking');
          this.lastThinkingSignal.set(sessionId, Date.now());
          this.idleTimestamp.delete(sessionId);
          this.permissionIdle.delete(sessionId);
          this.callbacks.onActivityChange(sessionId, 'thinking', false);
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

      for (const line of lines) {
        const event = ClaudeStatusParser.parseEvent(line);
        if (event) {
          // Any event proves the agent is alive. Reset stale thinking timer.
          if (this.activityCache.get(sessionId) === 'thinking') {
            this.lastThinkingSignal.set(sessionId, Date.now());
          }

          events.push(event);
          this.callbacks.onEvent(sessionId, event);

          // Track pending tool count so checkStaleThinking() knows when
          // a long-running tool (e.g. npm run build) is legitimately active.
          if (event.type === EventType.ToolStart) {
            const currentCount = this.pendingToolCount.get(sessionId) || 0;
            this.pendingToolCount.set(sessionId, currentCount + 1);
          } else if (event.type === EventType.ToolEnd || event.type === EventType.Interrupted) {
            const currentCount = this.pendingToolCount.get(sessionId) || 0;
            this.pendingToolCount.set(sessionId, Math.max(0, currentCount - 1));
          }

          // Detect ExitPlanMode -> emit plan-exit
          // Uses ToolStart (PreToolUse) because ExitPlanMode is a mode-transition
          // tool that may not fire PostToolUse (ToolEnd).
          if (event.type === EventType.ToolStart && event.tool === ClaudeTool.ExitPlanMode) {
            this.callbacks.onPlanExit(sessionId);
          }

          // Detect GitHub PR commands -> scan scrollback on tool_end.
          // On tool_start for Bash with a gh pr command, set a flag.
          // On the corresponding tool_end, fire the callback so the
          // session manager can scan scrollback for PR URLs.
          if (event.type === EventType.ToolStart
              && event.tool === ClaudeTool.Bash
              && event.detail
              && matchesPRCommand(event.detail)) {
            this.pendingPRCommand.set(sessionId, true);
          } else if (event.type === EventType.ToolEnd
              && event.tool === ClaudeTool.Bash
              && this.pendingPRCommand.get(sessionId)) {
            this.pendingPRCommand.delete(sessionId);
            this.callbacks.onPRCandidate(sessionId);
          }

          // Track subagent nesting depth so we can distinguish main-agent
          // tool events from subagent tool events during idle state.
          if (event.type === EventType.SubagentStart) {
            const currentDepth = this.subagentDepth.get(sessionId) || 0;
            this.subagentDepth.set(sessionId, currentDepth + 1);
          } else if (event.type === EventType.SubagentStop) {
            const currentDepth = this.subagentDepth.get(sessionId) || 0;
            const newDepth = Math.max(0, currentDepth - 1);
            this.subagentDepth.set(sessionId, newDepth);

            // Emit deferred idle when the last subagent finishes
            if (newDepth === 0 && this.pendingIdleWhileSubagent.get(sessionId)) {
              this.pendingIdleWhileSubagent.delete(sessionId);
              if (this.activityCache.get(sessionId) !== 'idle') {
                this.activityCache.set(sessionId, 'idle');
                this.callbacks.onActivityChange(sessionId, 'idle', false);
              }
            }
          }

          // Derive activity state from events via declarative lookup.
          // Only emit when state actually changes (dedup defense-in-depth
          // against multiple hooks firing the same state).
          const newActivity = EventTypeActivity[event.type];

          // Clear pending idle flag when the main agent resumes thinking
          // (prompt or subagent_start), even if deduped.
          if (newActivity === 'thinking'
              && (event.type === EventType.Prompt
                  || event.type === EventType.SubagentStart
                  || (this.subagentDepth.get(sessionId) || 0) === 0)) {
            this.pendingIdleWhileSubagent.delete(sessionId);
          }

          if (newActivity && this.activityCache.get(sessionId) !== newActivity) {
            // Subagent-aware transition guard: when transitioning from
            // idle -> thinking, suppress the transition if it's caused by
            // a subagent's tool event (not the main agent resuming).
            const currentActivity = this.activityCache.get(sessionId);
            const depth = this.subagentDepth.get(sessionId) || 0;
            if (currentActivity === 'idle' && newActivity === 'thinking'
                && event.type !== EventType.Prompt
                && event.type !== EventType.SubagentStart
                && depth > 0) {
              // Suppress: subagent tool event while main agent is idle
              continue;
            }

            // Guard 2: thinking -> idle suppression while subagents are active.
            if (currentActivity === 'thinking' && newActivity === 'idle'
                && event.type !== EventType.Interrupted
                && event.detail !== 'permission'
                && depth > 0) {
              this.pendingIdleWhileSubagent.set(sessionId, true);
              continue;
            }

            // Clear stale pending idle when permission idle bypasses Guard 2
            if (newActivity === 'idle' && event.detail === 'permission') {
              this.pendingIdleWhileSubagent.delete(sessionId);
            }

            this.activityCache.set(sessionId, newActivity);

            // Track permission-idle flag and idle timestamp for recovery
            if (newActivity === 'idle') {
              this.lastThinkingSignal.delete(sessionId);
              this.permissionIdle.set(sessionId, event.detail === 'permission');
              this.idleTimestamp.set(sessionId, Date.now());
            } else if (newActivity === 'thinking') {
              this.lastThinkingSignal.set(sessionId, Date.now());
              this.permissionIdle.delete(sessionId);
              this.idleTimestamp.delete(sessionId);
            }

            this.callbacks.onActivityChange(sessionId, newActivity, newActivity === 'idle' && event.detail === 'permission');
          }
        }
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

  /**
   * Initialize tracking state for a new session.
   * Sets default activity to 'idle' and clears all tracking maps.
   */
  initSession(sessionId: string): void {
    this.activityCache.set(sessionId, 'idle');
    this.subagentDepth.delete(sessionId);
    this.pendingToolCount.delete(sessionId);
    this.pendingIdleWhileSubagent.delete(sessionId);
    this.permissionIdle.delete(sessionId);
    this.idleTimestamp.set(sessionId, Date.now());
    this.lastThinkingSignal.delete(sessionId);
    this.callbacks.onActivityChange(sessionId, 'idle', false);
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

  /** Clear subagent depth and pending state (used by suspend). */
  clearSessionTracking(sessionId: string): void {
    this.subagentDepth.delete(sessionId);
    this.pendingToolCount.delete(sessionId);
    this.pendingIdleWhileSubagent.delete(sessionId);
    this.pendingPRCommand.delete(sessionId);
    this.permissionIdle.delete(sessionId);
    this.idleTimestamp.delete(sessionId);
    this.lastThinkingSignal.delete(sessionId);
  }

  /** Delete all maps for a session (full removal). */
  removeSession(sessionId: string): void {
    this.usageCache.delete(sessionId);
    this.activityCache.delete(sessionId);
    this.subagentDepth.delete(sessionId);
    this.pendingToolCount.delete(sessionId);
    this.pendingIdleWhileSubagent.delete(sessionId);
    this.permissionIdle.delete(sessionId);
    this.idleTimestamp.delete(sessionId);
    this.lastThinkingSignal.delete(sessionId);
    this.eventCache.delete(sessionId);
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
    const result: Record<string, ActivityState> = {};
    for (const [id, state] of this.activityCache) {
      result[id] = state;
    }
    return result;
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
