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

export class UsageAccumulator {
  private usageCache = new Map<string, SessionUsage>();
  private toolStats = new Map<string, Map<string, ToolAccumulator>>();

  /** Latest cached usage for a session, or undefined if none recorded yet. */
  getSessionUsage(sessionId: string): SessionUsage | undefined {
    return this.usageCache.get(sessionId);
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
    // after merge ensures consistency across chunks.
    const mergedContext = next.contextWindow;
    if (mergedContext.contextWindowSize > 0 && mergedContext.usedTokens > 0) {
      mergedContext.usedPercentage = (mergedContext.usedTokens / mergedContext.contextWindowSize) * 100;
    }
    this.usageCache.set(sessionId, next);
    return next;
  }

  /**
   * Replace the cached usage for a session outright (no merge). Used
   * by Claude's status.json reader where each parse already carries the
   * complete usage payload.
   */
  replaceSessionUsage(sessionId: string, usage: SessionUsage): void {
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
  }
}
