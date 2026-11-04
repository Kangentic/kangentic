import { streamJsonlRecords } from '../../shared/history-scan';
import type { PerToolStat, TranscriptToolCounts, TranscriptUsage } from '../../../../shared/types';
import { parseRecordTime } from './wire-parser';

/**
 * Lifetime token usage and tool-call counts read from Kimi Code CLI's
 * `agents/main/wire.jsonl`.
 *
 * Records (`packages/agent-core-v2/docs/wire-manifest.d.ts` and
 * `src/agent/contextMemory/loopEventFold.ts`, Kimi Code CLI 2.4.1, read
 * 2026-11-03): every model step ends with a `context.append_loop_event` whose
 * `event` is `step.end` with that step's `usage` (`TokenUsage`: `inputOther`,
 * `output`, `inputCacheRead`, `inputCacheCreation`), and every tool call is a
 * `tool.call` event with a unique `toolCallId` and the tool's `name`. Each
 * line carries its `time`. A resume appends to the same file, so the window
 * (`sinceMs`, `untilMs`) is what scopes a read to one run.
 *
 * The usage is the sum of each step's, the per-step counts the live context
 * bar shows, over the main agent's file only. Built from the source, not yet
 * checked against a real file.
 */
export async function kimiTranscriptUsage(filePath: string): Promise<TranscriptUsage | null> {
  let inputTokens = 0;
  let outputTokens = 0;
  let stepsWithUsage = 0;
  const readWholeFile = await streamJsonlRecords(filePath, (record) => {
    const loopEvent = loopEventOf(record);
    if (!loopEvent || loopEvent.type !== 'step.end' || !isRecord(loopEvent.usage)) return;
    const usage = loopEvent.usage;
    inputTokens += count(usage.inputOther) + count(usage.inputCacheRead) + count(usage.inputCacheCreation);
    outputTokens += count(usage.output);
    stepsWithUsage += 1;
  });
  // A partial read would write a too-small lifetime total as fact.
  if (!readWholeFile || stepsWithUsage === 0) return null;
  return { inputTokens, outputTokens };
}

/**
 * Distinct tool calls and their per-tool counts, from `tool.call` events whose
 * time falls in `[sinceMs, untilMs)`. A call with no time counts in an open
 * window and is left out of a closed one.
 */
export async function kimiTranscriptToolCounts(
  filePath: string,
  window: { sinceMs?: number | null; untilMs?: number | null } = {},
): Promise<TranscriptToolCounts | null> {
  const seenIds = new Set<string>();
  const countsByTool = new Map<string, number>();
  const readWholeFile = await streamJsonlRecords(filePath, (record) => {
    const loopEvent = loopEventOf(record);
    if (!loopEvent || loopEvent.type !== 'tool.call') return;
    const time = typeof record.time === 'number' && record.time > 0 ? parseRecordTime(record.time) : null;
    if (!inWindow(time, window)) return;
    const toolCallId = typeof loopEvent.toolCallId === 'string' && loopEvent.toolCallId.length > 0 ? loopEvent.toolCallId : null;
    if (toolCallId) {
      if (seenIds.has(toolCallId)) return;
      seenIds.add(toolCallId);
    }
    const toolName = typeof loopEvent.name === 'string' && loopEvent.name.length > 0 ? loopEvent.name : 'tool';
    countsByTool.set(toolName, (countsByTool.get(toolName) ?? 0) + 1);
  });
  // A partial read undercounts, so the caller keeps its live count.
  if (!readWholeFile || countsByTool.size === 0) return null;
  const toolBreakdown: PerToolStat[] = Array.from(countsByTool.entries())
    .map(([toolName, callCount]) => ({ toolName, callCount, totalDurationMs: 0, interruptedCount: 0 }))
    .sort((first, second) => second.callCount - first.callCount);
  const toolCallCount = toolBreakdown.reduce((sum, stat) => sum + stat.callCount, 0);
  return { toolCallCount, toolBreakdown };
}

function inWindow(time: number | null, window: { sinceMs?: number | null; untilMs?: number | null }): boolean {
  const closed = typeof window.untilMs === 'number';
  if (time === null) return !closed;
  if (typeof window.sinceMs === 'number' && time < window.sinceMs) return false;
  if (closed && time >= (window.untilMs as number)) return false;
  return true;
}

function loopEventOf(record: Record<string, unknown>): Record<string, unknown> | null {
  if (record.type !== 'context.append_loop_event' || !isRecord(record.event)) return null;
  return record.event;
}

function count(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
