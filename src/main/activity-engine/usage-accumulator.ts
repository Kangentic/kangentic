import { EventType } from '../../shared/types';
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
 *   - The per-tool FIFO pairing in `recordToolEvent` matches
 *     interleaved Bash + Read calls correctly by tool name.
 *   - Both are pure transformations of already-parsed events, so the
 *     logic earns isolation under unit tests without touching the
 *     orchestrator.
 */

interface ToolAccumulator {
  callCount: number;
  interruptedCount: number;
  totalDurationMs: number;
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
  hasCost: boolean;
  hasInputTokens: boolean;
  hasOutputTokens: boolean;
  /** FIFO of unmatched ToolStart timestamps, paired by tool name. */
  pendingStarts: number[];
}

function newAccumulator(): ToolAccumulator {
  return {
    callCount: 0,
    interruptedCount: 0,
    totalDurationMs: 0,
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
  private toolStats = new Map<string, Map<string, ToolAccumulator>>();
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
   * pending start timestamp; ToolEnd/Interrupted pops the matching
   * start and accumulates duration. Optional cost/tokens on the
   * ToolEnd event are summed when present.
   *
   * Pairing is keyed by tool name with a FIFO queue, so interleaved
   * tool calls (parallel Bash + Read) match correctly. An unmatched
   * ToolEnd still increments the count but contributes zero duration,
   * so the counter stays faithful even if the start was dropped before
   * this session began capturing.
   */
  recordToolEvent(sessionId: string, event: SessionEvent): void {
    if (event.type !== EventType.ToolStart
        && event.type !== EventType.ToolEnd
        && event.type !== EventType.Interrupted) {
      return;
    }
    const toolName = event.tool ?? 'unknown';
    let perSession = this.toolStats.get(sessionId);
    if (!perSession) {
      perSession = new Map<string, ToolAccumulator>();
      this.toolStats.set(sessionId, perSession);
    }
    let accumulator = perSession.get(toolName);
    if (!accumulator) {
      accumulator = newAccumulator();
      perSession.set(toolName, accumulator);
    }

    if (event.type === EventType.ToolStart) {
      accumulator.pendingStarts.push(event.ts);
      return;
    }

    const startTs = accumulator.pendingStarts.shift();
    if (startTs !== undefined) {
      accumulator.totalDurationMs += Math.max(0, event.ts - startTs);
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
    const perSession = this.toolStats.get(sessionId);
    if (!perSession) return 0;
    let total = 0;
    for (const accumulator of perSession.values()) {
      total += accumulator.callCount;
    }
    return total;
  }

  /**
   * Snapshot of per-tool aggregates for a session. Sorted by total
   * duration descending (cost descending when any row carries cost
   * data, matching the survey spec). Returns an empty array when the
   * session has produced no tool events.
   */
  getToolBreakdown(sessionId: string): PerToolStat[] {
    const perSession = this.toolStats.get(sessionId);
    if (!perSession) return [];
    const rows: PerToolStat[] = [];
    let anyCost = false;
    for (const [toolName, accumulator] of perSession) {
      if (accumulator.callCount === 0 && accumulator.interruptedCount === 0) continue;
      const stat: PerToolStat = {
        toolName,
        callCount: accumulator.callCount,
        totalDurationMs: accumulator.totalDurationMs,
        interruptedCount: accumulator.interruptedCount,
      };
      if (accumulator.hasCost) {
        stat.costUsd = accumulator.costUsd;
        anyCost = true;
      }
      if (accumulator.hasInputTokens) stat.inputTokens = accumulator.inputTokens;
      if (accumulator.hasOutputTokens) stat.outputTokens = accumulator.outputTokens;
      rows.push(stat);
    }
    rows.sort((a, b) => {
      if (anyCost) return (b.costUsd ?? 0) - (a.costUsd ?? 0);
      return b.totalDurationMs - a.totalDurationMs;
    });
    return rows;
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
