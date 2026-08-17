import fs from 'node:fs';
import path from 'node:path';
import {
  Activity,
  type SessionHistoryParseResult,
  type SessionUsage,
} from '../../../../shared/types';
import { grokHomeDir, locateGrokUpdatesFile } from './session-paths';

/**
 * Parser for Grok Build's native session history (`updates.jsonl`).
 *
 * File format (verified against grok 1.0.0 session files on disk):
 * append-only JSONL of ACP JSON-RPC notifications:
 *
 *   {"timestamp":<unix-sec>,"method":"session/update"|"_x.ai/session/update",
 *    "params":{"sessionId":"...","update":{"sessionUpdate":"<type>",...},
 *              "_meta":{"totalTokens":N,"agentTimestampMs":...}}}
 *
 * Observed `sessionUpdate` types: `user_message_chunk`,
 * `agent_message_chunk`, `agent_thought_chunk`, `tool_call`,
 * `tool_call_update`, `turn_completed`, `retry_state`, `hook_execution`,
 * `task_backgrounded`.
 *
 * WHAT THIS PARSER DELIBERATELY DOES NOT EMIT: SessionEvents. Grok's
 * activity events flow through the hook pipeline (hook-manager.ts ->
 * event-bridge -> events.jsonl), and the activity engine counts
 * ToolStart/ToolEnd pairs - a second emitter for the same underlying tool
 * calls would double-count starts and wedge the session at "thinking".
 * This parser owns TELEMETRY (model, context occupancy, cost) plus
 * idempotent ACTIVITY HINTS (`turn_completed` -> Idle, streaming chunks ->
 * Thinking) that back up the hook pipeline if hooks fail to load (e.g. an
 * untrusted folder silently skips project hooks).
 *
 * Token semantics (measured, and they differ by field - do not "simplify"):
 * - `params._meta.totalTokens` on streaming/tool updates is the RUNNING
 *   CONTEXT TOTAL (observed growing 49_869 -> 59_972 across one turn).
 *   That is the context-occupancy number the ContextBar wants.
 * - `turn_completed.usage.*` (`inputTokens`, `cachedReadTokens`, ...) is
 *   CUMULATIVE across the whole session (observed `numTurns: 8`,
 *   `inputTokens: 541_054`), the same trap Codex's `total_token_usage` set:
 *   using it for occupancy sends the context bar past 100%. It feeds the
 *   lifetime rollup via `transcriptUsage` (transcript-parser.ts), not this
 *   snapshot - except `costUsdTicks` / `apiDurationMs`, which ARE the
 *   session-cumulative cost figures `SessionUsage.cost` wants.
 * - `costUsdTicks` unit: 1e-10 USD. Pinned empirically: a headless
 *   `--output-format json` run reports both fields side by side
 *   (`total_cost_usd: 0.023672`, `total_cost_usd_ticks: 236720000`).
 *
 * The model id rides `update._meta.modelId` on `user_message_chunk` (and
 * the per-model breakdown keys of `turn_completed.usage.modelUsage`); the
 * context window size is not in the stream at all, so it is resolved from
 * grok's own `~/.grok/models_cache.json` (`context_window` per model id).
 */
export class GrokSessionHistoryParser {
  static async locate(options: {
    agentSessionId: string;
    cwd: string;
  }): Promise<string | null> {
    return locateGrokUpdatesFile(options);
  }

  static parse(content: string, _mode: 'full' | 'append'): SessionHistoryParseResult {
    let modelId: string | undefined;
    let contextTotalTokens: number | undefined;
    let cumulativeOutputTokens: number | undefined;
    let costUsd: number | undefined;
    let apiDurationMs: number | undefined;
    let activity: Activity | null = null;

    const lines = content.split(/\r?\n/).filter((line) => line.length > 0);

    for (const line of lines) {
      let entry: unknown;
      try {
        entry = JSON.parse(line);
      } catch {
        continue; // partial write mid-flush
      }
      if (!isRecord(entry)) continue;
      const params = entry.params;
      if (!isRecord(params)) continue;
      // Running context total: present in `params._meta.totalTokens` on
      // streaming and tool updates. Harvested BEFORE the dispatch-type guard
      // (it is a sibling of `update`, not type-specific), so an unknown
      // update type like hook_execution still contributes its total instead
      // of leaving the ContextBar stale at the last dispatch-type line.
      const paramsMeta = params._meta;
      if (isRecord(paramsMeta) && typeof paramsMeta.totalTokens === 'number') {
        contextTotalTokens = paramsMeta.totalTokens;
      }

      const update = params.update;
      if (!isRecord(update)) continue;

      const rawType = update.sessionUpdate;
      if (!isGrokDispatchType(rawType)) continue;
      const updateType: GrokDispatchType = rawType;

      if (updateType === 'user_message_chunk') {
        const updateMeta = update._meta;
        if (isRecord(updateMeta) && typeof updateMeta.modelId === 'string' && updateMeta.modelId.length > 0) {
          modelId = updateMeta.modelId;
        }
        activity = Activity.Thinking;
      } else if (
        updateType === 'agent_message_chunk'
        || updateType === 'agent_thought_chunk'
        || updateType === 'tool_call'
        || updateType === 'tool_call_update'
      ) {
        activity = Activity.Thinking;
      } else if (updateType === 'turn_completed') {
        activity = Activity.Idle;
        const usage = update.usage;
        if (isRecord(usage)) {
          if (typeof usage.outputTokens === 'number') {
            cumulativeOutputTokens = usage.outputTokens;
          }
          if (typeof usage.costUsdTicks === 'number') {
            // 1e-10 USD per tick, pinned by a headless json run that reports
            // total_cost_usd and total_cost_usd_ticks side by side.
            costUsd = usage.costUsdTicks * 1e-10;
          }
          if (typeof usage.apiDurationMs === 'number') {
            apiDurationMs = usage.apiDurationMs;
          }
          const modelUsage = usage.modelUsage;
          if (!modelId && isRecord(modelUsage)) {
            const modelKeys = Object.keys(modelUsage);
            if (modelKeys.length > 0) modelId = modelKeys[modelKeys.length - 1];
          }
        }
      } else if (updateType === 'retry_state') {
        // A live retry backoff means the turn is still alive - hold
        // Thinking. A terminal `type: "failed"` is followed by its own
        // `turn_completed` (observed with `stop_reason: "error"`), which
        // settles the state; no transition is forced here.
        if (update.type !== 'failed') {
          activity = Activity.Thinking;
        }
      }
    }

    const usage = buildUsage({
      modelId,
      contextTotalTokens,
      cumulativeOutputTokens,
      costUsd,
      apiDurationMs,
    });

    return { usage, events: [], activity };
  }
}

/**
 * Update types this parser dispatches on. Unknown types (hook_execution,
 * task_backgrounded, future additions) are skipped silently, though their
 * `params._meta.totalTokens` is still harvested above the dispatch.
 */
const GROK_DISPATCH_TYPES = [
  'user_message_chunk',
  'agent_message_chunk',
  'agent_thought_chunk',
  'tool_call',
  'tool_call_update',
  'turn_completed',
  'retry_state',
] as const;

type GrokDispatchType = typeof GROK_DISPATCH_TYPES[number];

function isGrokDispatchType(value: unknown): value is GrokDispatchType {
  return typeof value === 'string'
    && (GROK_DISPATCH_TYPES as readonly string[]).includes(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Resolve model metadata from grok's own models cache
 * (`~/.grok/models_cache.json`, written by the CLI; carries
 * `models.<id>.info.context_window` and `models.<id>.info.name`). Cached
 * per (grokHome, mtime) so the common parse path costs one statSync -
 * `buildUsage` runs on every session-history tail parse, so both lookups
 * below MUST read through this memo, never re-read the file per call.
 */
let modelsCacheMemo: {
  path: string;
  mtimeMs: number;
  windows: Map<string, number>;
  displayNames: Map<string, string>;
} | null = null;

function loadModelsCacheMemo(): NonNullable<typeof modelsCacheMemo> | null {
  const cachePath = path.join(grokHomeDir(), 'models_cache.json');
  try {
    const stat = fs.statSync(cachePath);
    if (!modelsCacheMemo || modelsCacheMemo.path !== cachePath || modelsCacheMemo.mtimeMs !== stat.mtimeMs) {
      const windows = new Map<string, number>();
      const displayNames = new Map<string, string>();
      const parsed: unknown = JSON.parse(fs.readFileSync(cachePath, 'utf-8'));
      if (isRecord(parsed) && isRecord(parsed.models)) {
        for (const [id, entry] of Object.entries(parsed.models)) {
          if (!isRecord(entry) || !isRecord(entry.info)) continue;
          const window = entry.info.context_window;
          if (typeof window === 'number' && window > 0) windows.set(id, window);
          const name = entry.info.name;
          if (typeof name === 'string' && name.length > 0) displayNames.set(id, name);
        }
      }
      modelsCacheMemo = { path: cachePath, mtimeMs: stat.mtimeMs, windows, displayNames };
    }
    return modelsCacheMemo;
  } catch {
    return null;
  }
}

export function grokModelContextWindow(modelId: string): number | undefined {
  return loadModelsCacheMemo()?.windows.get(modelId);
}

/** Test hook: drop the models-cache memo so a redirected GROK_HOME is re-read. */
export function clearGrokModelsCacheMemo(): void {
  modelsCacheMemo = null;
}

/**
 * Build a sparse SessionUsage from what this chunk actually carried.
 * Uncaptured fields are omitted entirely (never defaulted to 0) so the
 * shallow spread merge in `UsageAccumulator.setSessionUsage()` cannot
 * overwrite good values from earlier chunks - the Codex parser's
 * load-bearing sparse-merge rule.
 */
function buildUsage(captured: {
  modelId: string | undefined;
  contextTotalTokens: number | undefined;
  cumulativeOutputTokens: number | undefined;
  costUsd: number | undefined;
  apiDurationMs: number | undefined;
}): SessionUsage | null {
  const { modelId, contextTotalTokens, cumulativeOutputTokens, costUsd, apiDurationMs } = captured;

  if (
    modelId === undefined
    && contextTotalTokens === undefined
    && costUsd === undefined
  ) {
    return null;
  }

  const contextWindow: Record<string, number> = {};
  if (contextTotalTokens !== undefined) {
    contextWindow.usedTokens = contextTotalTokens;
    contextWindow.totalInputTokens = contextTotalTokens;
  }
  if (cumulativeOutputTokens !== undefined) {
    contextWindow.totalOutputTokens = cumulativeOutputTokens;
  }
  const windowSize = modelId !== undefined ? grokModelContextWindow(modelId) : undefined;
  if (windowSize !== undefined) {
    contextWindow.contextWindowSize = windowSize;
    if (contextTotalTokens !== undefined && windowSize > 0) {
      contextWindow.usedPercentage = (contextTotalTokens / windowSize) * 100;
    }
  }

  const cost: Record<string, number> = {};
  if (costUsd !== undefined) cost.totalCostUsd = costUsd;
  if (apiDurationMs !== undefined) cost.totalDurationMs = apiDurationMs;

  const result: Record<string, unknown> = {};
  if (Object.keys(contextWindow).length > 0) result.contextWindow = contextWindow;
  if (Object.keys(cost).length > 0) result.cost = cost;
  if (modelId !== undefined) {
    result.model = { id: modelId, displayName: grokModelDisplayName(modelId), reportedByAgent: true };
  }

  return result as unknown as SessionUsage;
}

/**
 * Friendly display name for a grok model id, from the models cache when
 * available (`models.<id>.info.name`, e.g. `grok-4.6` -> "Grok 4.6"), else
 * the raw id.
 */
export function grokModelDisplayName(modelId: string): string {
  return loadModelsCacheMemo()?.displayNames.get(modelId) ?? modelId;
}
