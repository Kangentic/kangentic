/*
 * Live telemetry for a local OpenCode session, read from the `status.json` its
 * activity plugin rewrites beside `events.jsonl`. OpenCode 1's plugin
 * (`createSessionTracker` in `plugin/kangentic-activity.mjs`) builds it from
 * `chat.params`'s `model` (`Model` in `@opencode-ai/sdk` at v1.18.31: `id`,
 * `providerID`, `name`, `limit.context`) and each assistant message's `tokens`
 * and `cost` from `message.updated` (`AssistantMessage`). OpenCode 2's
 * (`createV2SessionTracker` in `plugin/kangentic-activity-v2.mjs`) builds the
 * same shape from `session.step.started` and `session.step.ended`, with no
 * name or context limit. The model's `name` and `limit.context` and the
 * assistant `tokens` shape were checked against OpenCode 1.18.31's own output;
 * the hook payloads that carry them have not been captured from a live run.
 *
 * Remote mode runs no plugin, so a remote session writes no file and its card
 * keeps the adapter's `liveTelemetryUnsupported` label.
 */
import type { SessionUsage } from '../../../../shared/types';
import { isRecord, positiveNumber } from './transcript-parser';

interface OpenCodeStatusTokens {
  input: number;
  output: number;
  reasoning: number;
  cacheRead: number;
  cacheWrite: number;
}

function readTokens(value: unknown): OpenCodeStatusTokens {
  const tokens = isRecord(value) ? value : {};
  return {
    input: positiveNumber(tokens.input),
    output: positiveNumber(tokens.output),
    reasoning: positiveNumber(tokens.reasoning),
    cacheRead: positiveNumber(tokens.cacheRead),
    cacheWrite: positiveNumber(tokens.cacheWrite),
  };
}

/**
 * Map the plugin's status file to a `SessionUsage`. The context in use is what
 * the root session's newest answer sent: its `input` plus the cache it read
 * and wrote (output excluded, as for every agent's `usedTokens`). A model whose
 * context limit OpenCode did not give reports size 0, the unknown sentinel,
 * and 0 percent. No session id is reported: the plugin's file holds none, and
 * a subagent's child session must never read as a conversation switch.
 * Returns null for an empty or unreadable file, or one from another writer.
 */
export function parseOpenCodeStatus(raw: string): SessionUsage | null {
  if (!raw.trim()) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isRecord(parsed) || parsed.kangenticOpenCodeStatus !== 1) return null;
  const model = isRecord(parsed.model) ? parsed.model : null;
  const modelId = model && typeof model.id === 'string' ? model.id.trim() : '';
  if (!modelId) return null;
  const modelName = model && typeof model.name === 'string' && model.name.trim() ? model.name.trim() : modelId;

  const context = readTokens(parsed.context);
  const totals = readTokens(parsed.totals);
  const contextWindowSize = positiveNumber(parsed.contextLimit);
  const cacheTokens = context.cacheRead + context.cacheWrite;
  const usedTokens = context.input + cacheTokens;
  const usedPercentage = contextWindowSize > 0 ? Math.min(100, (usedTokens / contextWindowSize) * 100) : 0;

  return {
    contextWindow: {
      usedPercentage,
      usedTokens,
      cacheTokens,
      totalInputTokens: totals.input + totals.cacheRead + totals.cacheWrite,
      totalOutputTokens: totals.output + totals.reasoning,
      contextWindowSize,
    },
    cost: {
      totalCostUsd: positiveNumber(parsed.costUsd),
      totalDurationMs: 0,
    },
    model: {
      id: modelId,
      displayName: modelName,
      reportedByAgent: true,
    },
  };
}
