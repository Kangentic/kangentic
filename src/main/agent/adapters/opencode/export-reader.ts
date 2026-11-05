import fs from 'node:fs';
import type { PerToolStat, TranscriptToolCounts, TranscriptUsage } from '../../../../shared/types';
import { parseOpenCodeExport } from './distro-sessions';
import type { OpenCodeRemoteMessageEntry } from './remote-client';
import { assistantUsage, CHARS_PER_TOKEN, toolResultText } from './transcript-usage';

/**
 * A conversation on an SSH host, read from the copy of its `export` on this computer. The host keeps it in a
 * database every session shares, so the CLI's own export is what crosses the link
 * (`RemoteSessionRelay`), and it lands here as one file, whole. `parseOpenCodeExport` turns both majors'
 * exports into `{ info, parts }` entries, so everything here reads one shape.
 *
 * Totals are always of the whole file. An export is replaced, never appended to, so nothing can be added to
 * what an earlier read counted. Child sessions are not in a parent's export (measured on 1.19.5), so a
 * subagent's tokens are not here.
 */

export interface ExportTimeWindow {
  sinceMs?: number | null;
  untilMs?: number | null;
}

/** The messages in a copy, or none for a copy that has not arrived or cannot be read. Never proof of anything. */
export function readOpenCodeExportFile(filePath: string): OpenCodeRemoteMessageEntry[] {
  try {
    return parseOpenCodeExport(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return [];
  }
}

/** Lifetime tokens, the way a local session's are counted. Null with no message that has usage yet. */
export function openCodeExportUsage(messages: readonly OpenCodeRemoteMessageEntry[]): TranscriptUsage | null {
  let messagesWithUsage = 0;
  const total: TranscriptUsage = { inputTokens: 0, outputTokens: 0 };
  for (const { info } of messages) {
    if (info.role !== 'assistant') continue;
    const usage = assistantUsage(info.tokens);
    if (!usage || usage.inputTokens + usage.outputTokens === 0) continue;
    messagesWithUsage += 1;
    total.inputTokens += usage.inputTokens;
    total.outputTokens += usage.outputTokens;
  }
  return messagesWithUsage > 0 ? total : null;
}

/** Each tool call in the window, in order, by its message's creation time. */
function toolCallsIn(messages: readonly OpenCodeRemoteMessageEntry[], timeWindow: ExportTimeWindow): Array<{ id: string; name: string; state: unknown }> {
  const calls: Array<{ id: string; name: string; state: unknown }> = [];
  for (const { info, parts } of messages) {
    const created = info.time?.created;
    if (typeof timeWindow.sinceMs === 'number' && (typeof created !== 'number' || created < timeWindow.sinceMs)) continue;
    if (typeof timeWindow.untilMs === 'number' && (typeof created !== 'number' || created >= timeWindow.untilMs)) continue;
    for (const part of parts) {
      if (part.type === 'tool' && typeof part.callID === 'string' && typeof part.tool === 'string') {
        calls.push({ id: part.callID, name: part.tool, state: part.state });
      }
    }
  }
  return calls;
}

/** Distinct tool calls by name. Null when there are none, so the caller keeps its live count. */
export function openCodeExportToolCounts(messages: readonly OpenCodeRemoteMessageEntry[], timeWindow: ExportTimeWindow = {}): TranscriptToolCounts | null {
  const seen = new Set<string>();
  const countsByName = new Map<string, number>();
  for (const call of toolCallsIn(messages, timeWindow)) {
    if (seen.has(call.id)) continue;
    seen.add(call.id);
    countsByName.set(call.name, (countsByName.get(call.name) ?? 0) + 1);
  }
  if (seen.size === 0) return null;
  const toolBreakdown: PerToolStat[] = [...countsByName]
    .map(([toolName, callCount]) => ({ toolName, callCount, totalDurationMs: 0, interruptedCount: 0 }))
    .sort((first, second) => second.callCount - first.callCount || first.toolName.localeCompare(second.toolName));
  return { toolCallCount: seen.size, toolBreakdown };
}

/** Estimated result tokens per tool name. A call seen twice counts once, at its last result. */
export function openCodeExportToolResultTokens(messages: readonly OpenCodeRemoteMessageEntry[], timeWindow: ExportTimeWindow = {}): Record<string, number> {
  const resultByCall = new Map<string, { name: string; characters: number }>();
  for (const call of toolCallsIn(messages, timeWindow)) {
    resultByCall.set(call.id, { name: call.name, characters: toolResultText(call.state).length });
  }
  const tokensByName: Record<string, number> = {};
  for (const { name, characters } of resultByCall.values()) {
    tokensByName[name] = (tokensByName[name] ?? 0) + Math.ceil(characters / CHARS_PER_TOKEN);
  }
  return tokensByName;
}
