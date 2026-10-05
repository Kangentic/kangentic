import { EventType, IdleReason } from '../../shared/types';
import type { SessionUsage, SessionEvent, PerToolStat } from '../../shared/types';

/**
 * Per-session token, cost, and per-tool aggregator. Pure logic - no
 * timers, no I/O. Owned by `SessionTelemetry`, which routes events and
 * status updates through here.
 *
 * Why this is its own module:
 *   - The merge in `setSessionUsage` is non-trivial (Codex/Gemini
 *     emit usage in chunks across separate JSONL events; we have to
 *     recompute `usedPercentage` after every merge).
 *   - The per-tool pairing in `recordToolEvent` matches each end to its
 *     own start by `toolId`, falling back to FIFO by tool name only for
 *     adapters that send no id.
 *   - Both are pure transformations of already-parsed events, so the
 *     logic earns isolation under unit tests without touching the
 *     orchestrator.
 */

interface ToolAccumulator {
  callCount: number;
  interruptedCount: number;
  /** Run time of the calls that did not wait on the user (see `waitedCount`). */
  totalDurationMs: number;
  /** Calls that paused for the user's answer or approval; their time is left out. */
  waitedCount: number;
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
  hasCost: boolean;
  hasInputTokens: boolean;
  hasOutputTokens: boolean;
  /**
   * FIFO of unmatched starts that carried NO `toolId`, paired by tool name.
   * Starts with an id live in `SessionToolState.pendingById`.
   */
  pendingStarts: PendingToolStart[];
}

interface PendingToolStart {
  startTs: number;
  toolName: string;
  /** Set when a permission Idle arrived while this was the newest pending call. */
  waited: boolean;
}

interface SessionToolState {
  byTool: Map<string, ToolAccumulator>;
  /**
   * Unmatched starts keyed by `toolId`. A start the agent never ends (a
   * PreToolUse a hook denied, a cancelled parallel sibling) stays here and
   * pairs with nothing, so it cannot shift any later call's duration.
   * Bounded by `MAX_PENDING_BY_ID`.
   */
  pendingById: Map<string, PendingToolStart>;
  /**
   * Timestamp of the last turn-ending Idle. A permission prompt is credited
   * only to a call started since then, because the engine's pending stack,
   * whose top `permissionAwaitedToolId` reads, is emptied at that same Idle.
   */
  turnStartTs: number;
}

/**
 * Cap on a session's unmatched id-keyed starts. Far above any real number of
 * calls in flight at once, so only orphans (denied or cancelled starts) are
 * ever dropped, oldest first.
 */
const MAX_PENDING_BY_ID = 512;

function newAccumulator(): ToolAccumulator {
  return {
    callCount: 0,
    interruptedCount: 0,
    totalDurationMs: 0,
    waitedCount: 0,
    costUsd: 0,
    inputTokens: 0,
    outputTokens: 0,
    hasCost: false,
    hasInputTokens: false,
    hasOutputTokens: false,
    pendingStarts: [],
  };
}

function emptyUsage(): SessionUsage {
  return {
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
}

/**
 * Strip a trailing bracketed variant tag (e.g. `[1m]`) and lowercase, so a plain
 * model id and its 1M-context variant map to one key. The effective context
 * window is an account+model constant (a plain `claude-opus-4-8` runs 1M on a
 * 1M-entitled account, the same as `claude-opus-4-8[1m]`), so keying the known
 * window by base id lets a status.json from any session of the model fill the
 * window for every other session of that model.
 */
function baseModelId(modelId: string): string {
  return modelId.toLowerCase().replace(/\[[^\]]+\]$/, '');
}

export class UsageAccumulator {
  private usageCache = new Map<string, SessionUsage>();
  private toolStats = new Map<string, SessionToolState>();
  /** Per-session count of context compactions (PreCompact -> Compact events). */
  private compactionCounts = new Map<string, number>();
  /**
   * The authoritative context-window size observed for each base model id,
   * learned from any live status.json seen this run OR hydrated at
   * project-open from persisted metrics (see `hydrateKnownWindows`, called via
   * `SessionTelemetry.hydrateKnownWindows` from `applyRuntimeConfig`). Used to
   * fill the window for a session whose only telemetry is the Claude
   * transcript fallback (tokens + model, no window) - so a background/parked
   * session, whose statusLine never painted and thus never wrote status.json,
   * still shows a correct percentage on the board without being opened.
   */
  private knownWindowByModel = new Map<string, number>();

  /** Latest cached usage for a session, or undefined if none recorded yet. */
  getSessionUsage(sessionId: string): SessionUsage | undefined {
    return this.usageCache.get(sessionId);
  }

  /**
   * Remember an authoritative context window observed for a model. Called with
   * the window from any live status.json this run
   * (SessionTelemetry.processStatusUpdate) or from persisted metrics hydrated
   * at project-open (SessionTelemetry.hydrateKnownWindows, one call per entry).
   * Keyed by base model id so a plain id and its `[1m]` variant share.
   *
   * RETROACTIVELY fills any already-cached session of this model that has tokens
   * but no window - a background transcript-fallback session that emitted BEFORE
   * the window was learned (e.g. an idle card whose sibling just painted, or a
   * parked card that emitted before boot hydration ran). Their usage is updated
   * in place and their ids are returned so the caller can re-emit them to the
   * renderer; without this, an idle background card would stay on the model
   * name until it happened to emit usage again. Sessions whose tokens exceed
   * the (possibly stale) window are left at the 0 sentinel.
   */
  recordKnownWindow(modelId: string | undefined, contextWindowSize: number): string[] {
    if (!modelId || contextWindowSize <= 0) return [];
    const base = baseModelId(modelId);
    this.knownWindowByModel.set(base, contextWindowSize);

    const refilled: string[] = [];
    for (const [sessionId, usage] of this.usageCache) {
      const mergedContext = usage.contextWindow;
      if (
        mergedContext.contextWindowSize <= 0
        && mergedContext.usedTokens > 0
        && mergedContext.usedTokens <= contextWindowSize
        && usage.model.id
        && baseModelId(usage.model.id) === base
      ) {
        mergedContext.contextWindowSize = contextWindowSize;
        mergedContext.usedPercentage = (mergedContext.usedTokens / contextWindowSize) * 100;
        refilled.push(sessionId);
      }
    }
    return refilled;
  }

  /** The known authoritative window for a model, or undefined if none observed. */
  getKnownWindow(modelId: string | undefined): number | undefined {
    if (!modelId) return undefined;
    return this.knownWindowByModel.get(baseModelId(modelId));
  }

  /**
   * Hydrate the known-window map at project-open from persisted metrics
   * (config `discoveredContextWindowsByAgent`, flattened by the caller). Each
   * entry runs through `recordKnownWindow`, so it gets the same
   * set-and-retroactively-refill behavior as a live status.json - a parked
   * session cached earlier this run with window 0 is corrected in place.
   * Returns the union of every entry's refilled session ids.
   */
  hydrateKnownWindows(entries: Array<{ modelId: string; contextWindowSize: number }>): string[] {
    const refilled: string[] = [];
    for (const entry of entries) {
      refilled.push(...this.recordKnownWindow(entry.modelId, entry.contextWindowSize));
    }
    return refilled;
  }

  /**
   * Upsert a partial SessionUsage entry for a session. Used by agents
   * that derive usage from native log files (Codex, Gemini) rather than
   * a streamed status.json (Claude). Merges with any existing entry,
   * seeding a zeroed base if none exists. Returns the merged shape so
   * callers can forward it to the renderer.
   */
  setSessionUsage(sessionId: string, partial: Partial<SessionUsage>): SessionUsage {
    const base: SessionUsage = this.usageCache.get(sessionId) ?? emptyUsage();
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
    // after merge ensures consistency across chunks. This is the single
    // place a context percentage is computed for the merge path.
    const mergedContext = next.contextWindow;
    // Fill a missing window from the account's known window for this model. The
    // Claude transcript fallback emits tokens + model but NO window (it is not
    // derivable from a model id); when the session's own status.json never
    // flowed (a parked background session), pairing those tokens with the
    // known account+model window - observed from any other session's
    // status.json - yields a correct percentage without opening the card.
    if (mergedContext.contextWindowSize <= 0 && mergedContext.usedTokens > 0) {
      const knownWindow = this.getKnownWindow(next.model.id);
      if (knownWindow && knownWindow > 0) {
        mergedContext.contextWindowSize = knownWindow;
      }
    }
    if (mergedContext.contextWindowSize > 0 && mergedContext.usedTokens > mergedContext.contextWindowSize) {
      // usedTokens > window is physically impossible (auto-compaction fires far
      // below a full window), so the WINDOW is wrong, not the tokens. This
      // happens when fresh transcript occupancy pairs with a stale or mismatched
      // window seed. Degrade to the 0 "unknown size" sentinel (model name only,
      // no bar) rather than clamping to 100 and rendering a confident-but-wrong
      // bar. Sticky by construction: later token-only merges see window 0.
      mergedContext.contextWindowSize = 0;
      mergedContext.usedPercentage = 0;
    } else if (mergedContext.contextWindowSize > 0 && mergedContext.usedTokens > 0) {
      mergedContext.usedPercentage = (mergedContext.usedTokens / mergedContext.contextWindowSize) * 100;
    }
    this.usageCache.set(sessionId, next);
    return next;
  }

  /**
   * Replace the cached usage for a session outright (no merge). Used
   * by Claude's status.json reader where each parse already carries the
   * complete usage payload.
   *
   * Fills a zero/missing window from the account's known window for this
   * model, mirroring setSessionUsage's merge-path fill: a status.json can
   * omit `context_window_size` (or report 0) while still carrying real usage,
   * which would otherwise blank the bar with no recovery until a later
   * nonzero status. Reads the map as it stood BEFORE this call, since the
   * caller (SessionTelemetry.processStatusUpdate) teaches the map from this
   * same usage AFTER replacing. Unlike the merge path, an over-budget pairing
   * (usedTokens > window) is left as-is: this snapshot is authoritative, so
   * usedTokens > window is a legitimate critical state, not a stale seed.
   */
  replaceSessionUsage(sessionId: string, usage: SessionUsage): void {
    const context = usage.contextWindow;
    if (context.contextWindowSize <= 0 && context.usedTokens > 0) {
      const knownWindow = this.getKnownWindow(usage.model.id);
      if (knownWindow && knownWindow > 0) {
        context.contextWindowSize = knownWindow;
        context.usedPercentage = (context.usedTokens / knownWindow) * 100;
      }
    }
    // Recording the authoritative window for this model (and re-emitting any
    // sibling background sessions it back-fills) is done by the caller
    // (SessionTelemetry.processStatusUpdate) so it can push the re-emits.
    this.usageCache.set(sessionId, usage);
  }

  /**
   * Update the per-tool aggregator for one event. ToolStart records a
   * pending start; ToolEnd/Interrupted takes its matching start and
   * accumulates the duration. Optional cost/tokens on the end event are
   * summed when present.
   *
   * Pairing is by `toolId` whenever the event carries one (Claude sets it
   * on start, end and interrupt alike). An end with an id looks up ONLY its
   * own start: a miss adds nothing, and it never borrows an id-less start.
   * Only an end with no id falls back to FIFO by tool name, for adapters
   * that send no correlation id. Name-FIFO pairing alone was wrong: one
   * start that never ends (a PreToolUse the bash-guard hook denied fires
   * our tool_start and nothing after it) shifted that tool's queue for the
   * rest of the session, so every later call reported the gap since the
   * previous call as its duration.
   *
   * An unmatched end still increments the count but contributes zero
   * duration, so the counter stays faithful even if the start was dropped
   * before this session began capturing. A turn-ending Idle drops the
   * pending id-less starts, which is what keeps an unended id-less start
   * from poisoning the next turn.
   *
   * Time spent waiting on the user is left out. A permission Idle (the agent
   * asked for approval, or AskUserQuestion is waiting for an answer) marks the
   * newest pending call as waited, the same attribution the activity engine
   * uses for `permissionAwaitedToolId`. When that call ends it is counted and
   * tallied in `waitedCount`, but its time is not added: nothing marks the
   * moment the user answers, so the wait cannot be split from the run, and
   * leaving the call out is the honest measure of the tool's own run time.
   */
  recordToolEvent(sessionId: string, event: SessionEvent): void {
    if (event.type === EventType.Idle) {
      const state = this.toolStats.get(sessionId);
      if (!state) return;
      if (event.detail === IdleReason.Permission) {
        const awaited = this.newestPendingStart(state);
        if (awaited) awaited.waited = true;
        return;
      }
      // A turn-ending Idle drops the id-less FIFOs, where one unended start
      // would shift every later pairing (the rule `updateCounters` in
      // engine/event-handlers.ts applies to its own stack). Permission idles
      // are handled above: that tool resumes after approval. The id map is
      // NOT cleared: a background subagent's calls keep running past the main
      // turn's Stop (about 750 of them in this repo's own session logs), and
      // an orphaned id pairs with nothing, so keeping it costs memory only,
      // which `MAX_PENDING_BY_ID` bounds.
      for (const accumulator of state.byTool.values()) accumulator.pendingStarts.length = 0;
      state.turnStartTs = event.ts;
      return;
    }
    if (event.type === EventType.BackgroundShellStart) {
      // A foreground tool promoted to the background: its ToolEnd never
      // comes, so release the start. Handled before any row lookup so it
      // never creates one.
      if (event.toolId) this.toolStats.get(sessionId)?.pendingById.delete(event.toolId);
      return;
    }
    if (event.type !== EventType.ToolStart
        && event.type !== EventType.ToolEnd
        && event.type !== EventType.Interrupted) {
      return;
    }
    let state = this.toolStats.get(sessionId);
    if (!state) {
      state = {
        byTool: new Map<string, ToolAccumulator>(),
        pendingById: new Map<string, PendingToolStart>(),
        turnStartTs: Number.NEGATIVE_INFINITY,
      };
      this.toolStats.set(sessionId, state);
    }

    if (event.type === EventType.ToolStart) {
      const startName = event.tool ?? 'unknown';
      const pendingStart: PendingToolStart = { startTs: event.ts, toolName: startName, waited: false };
      if (event.toolId) {
        state.pendingById.set(event.toolId, pendingStart);
        if (state.pendingById.size > MAX_PENDING_BY_ID) {
          // Map iteration is insertion order, so the first key is the oldest.
          const oldest = state.pendingById.keys().next();
          if (!oldest.done) state.pendingById.delete(oldest.value);
        }
      } else {
        this.accumulatorFor(state, startName).pendingStarts.push(pendingStart);
      }
      return;
    }

    let matched: PendingToolStart | undefined;
    let toolName = event.tool;
    if (event.toolId) {
      matched = state.pendingById.get(event.toolId);
      if (matched) {
        state.pendingById.delete(event.toolId);
        // An interrupt can carry the id without the name; the start knows it.
        toolName ??= matched.toolName;
      }
    }
    const accumulator = this.accumulatorFor(state, toolName ?? 'unknown');
    if (!event.toolId) matched = accumulator.pendingStarts.shift();
    if (matched?.waited) {
      accumulator.waitedCount += 1;
    } else if (matched) {
      accumulator.totalDurationMs += Math.max(0, event.ts - matched.startTs);
    }
    if (event.type === EventType.ToolEnd) {
      accumulator.callCount += 1;
    } else {
      accumulator.interruptedCount += 1;
    }
    if (typeof event.costUsd === 'number') {
      accumulator.costUsd += event.costUsd;
      accumulator.hasCost = true;
    }
    if (typeof event.inputTokens === 'number') {
      accumulator.inputTokens += event.inputTokens;
      accumulator.hasInputTokens = true;
    }
    if (typeof event.outputTokens === 'number') {
      accumulator.outputTokens += event.outputTokens;
      accumulator.hasOutputTokens = true;
    }
  }

  /**
   * Cumulative ToolEnd count for a session, tracked independently of
   * the MAX_EVENTS_PER_SESSION cap on the orchestrator's eventCache.
   * Used by captureSessionMetrics so long sessions don't undercount
   * once the event cache rolls.
   */
  getToolCallCount(sessionId: string): number {
    const state = this.toolStats.get(sessionId);
    if (!state) return 0;
    let total = 0;
    for (const accumulator of state.byTool.values()) {
      total += accumulator.callCount;
    }
    return total;
  }

  /**
   * Snapshot of per-tool aggregates for a session. Sorted by call count
   * descending, tie broken by tool name, which is also the table's default
   * order (`ByToolTable` re-sorts on its own headers). Returns an empty
   * array when the session has produced no tool events.
   */
  getToolBreakdown(sessionId: string): PerToolStat[] {
    const state = this.toolStats.get(sessionId);
    if (!state) return [];
    const rows: PerToolStat[] = [];
    for (const [toolName, accumulator] of state.byTool) {
      if (accumulator.callCount === 0 && accumulator.interruptedCount === 0) continue;
      const stat: PerToolStat = {
        toolName,
        callCount: accumulator.callCount,
        totalDurationMs: accumulator.totalDurationMs,
        interruptedCount: accumulator.interruptedCount,
      };
      if (accumulator.waitedCount > 0) stat.waitedCount = accumulator.waitedCount;
      if (accumulator.hasCost) stat.costUsd = accumulator.costUsd;
      if (accumulator.hasInputTokens) stat.inputTokens = accumulator.inputTokens;
      if (accumulator.hasOutputTokens) stat.outputTokens = accumulator.outputTokens;
      rows.push(stat);
    }
    rows.sort((a, b) => (b.callCount - a.callCount) || a.toolName.localeCompare(b.toolName));
    return rows;
  }

  /**
   * The most recently started call still waiting for its end, among calls
   * started this turn: the last id start (Map order is insertion order) or the
   * last id-less one, whichever began later. This is the call a permission
   * prompt belongs to, since the prompt fires between a call's PreToolUse and
   * its execution. Undefined when nothing started this turn is pending, which
   * is when the engine's own stack is empty too.
   */
  private newestPendingStart(state: SessionToolState): PendingToolStart | undefined {
    let newest: PendingToolStart | undefined;
    for (const pending of state.pendingById.values()) newest = pending;
    for (const accumulator of state.byTool.values()) {
      const last = accumulator.pendingStarts[accumulator.pendingStarts.length - 1];
      if (last && (!newest || last.startTs > newest.startTs)) newest = last;
    }
    return newest && newest.startTs >= state.turnStartTs ? newest : undefined;
  }

  private accumulatorFor(state: SessionToolState, toolName: string): ToolAccumulator {
    let accumulator = state.byTool.get(toolName);
    if (!accumulator) {
      accumulator = newAccumulator();
      state.byTool.set(toolName, accumulator);
    }
    return accumulator;
  }

  /**
   * Record one context compaction for a session (driven by the Claude
   * PreCompact hook -> EventType.Compact). Per CLI run: a `--resume` after a
   * restart is a new session record whose count starts at 0, so the per-task
   * lifetime total is the SUM across the task's records (mirrors tool calls).
   */
  recordCompaction(sessionId: string): void {
    this.compactionCounts.set(sessionId, (this.compactionCounts.get(sessionId) ?? 0) + 1);
  }

  /** Compaction count for this session's current run, or 0 if none recorded. */
  getCompactionCount(sessionId: string): number {
    return this.compactionCounts.get(sessionId) ?? 0;
  }

  /** Snapshot of all cached usage entries. Used by IPC getters. */
  getUsageCache(): Record<string, SessionUsage> {
    const result: Record<string, SessionUsage> = {};
    for (const [id, usage] of this.usageCache) {
      result[id] = usage;
    }
    return result;
  }

  /** Drop all cached state for a session (full removal). */
  removeSession(sessionId: string): void {
    this.usageCache.delete(sessionId);
    this.toolStats.delete(sessionId);
    this.compactionCounts.delete(sessionId);
  }
}
