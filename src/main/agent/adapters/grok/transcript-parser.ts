import type {
  TranscriptEntry,
  TranscriptBlock,
  TranscriptUsage,
  TranscriptToolCounts,
  PerToolStat,
} from '../../../../shared/types';
import { readJsonlWindow, streamJsonlRecords } from '../../shared/history-scan';
import { parseWindowBytes, prependTruncationMarker } from '../../shared/transcript-truncation';
import { grokChatHistoryPath, grokUpdatesJsonlPath } from './session-paths';

/**
 * Parse Grok Build's native session files into agent-agnostic structures.
 *
 * Two source files, two jobs (both under
 * `~/.grok/sessions/<encodeURIComponent(cwd)>/<sessionId>/`):
 *
 * - `chat_history.jsonl` -> `TranscriptEntry[]` for the Transcript tab and
 *   the MCP `get_transcript` structured format. Record schema (verified
 *   against real grok 1.0.0 sessions):
 *     { type: 'system' | 'user' | 'assistant' | 'reasoning' | 'tool_result',
 *       content: string | {type:'text',text} | blocks[],
 *       synthetic_reason?, tool_calls?, tool_call_id?, model_id?,
 *       reasoning_effort?, summary?, status? }
 *   Genuine user turns have NO `synthetic_reason` (synthetic records carry
 *   `project_instructions` / `system_reminder` and are injected context,
 *   not conversation) and wrap the typed text in `<user_query>` tags.
 *   Assistant tool calls ride `tool_calls: [{id, name, arguments}]` where
 *   `arguments` is a JSON-encoded string. Records carry NO timestamps -
 *   entries get a single parse-time stamp (the Droid fallback precedent)
 *   and synthesized `<sessionId>:<line>` uuids.
 *
 * - `updates.jsonl` -> `TranscriptUsage` / `TranscriptToolCounts` for the
 *   lifetime rollup (Claude-parity `transcriptUsage` /
 *   `transcriptToolCounts`). `turn_completed.usage` is CUMULATIVE across
 *   the session (verified: numTurns climbs, inputTokens climbs), which is
 *   exactly what the lifetime rollup wants - the LAST turn_completed wins.
 *   Tool calls are counted from distinct `tool_call` update ids.
 */
export async function parseGrokTranscript(
  agentSessionId: string,
  cwd: string,
): Promise<{ entries: TranscriptEntry[]; sourcePath: string | null }> {
  const filePath = grokChatHistoryPath(cwd, agentSessionId);
  // Bounded tail read rather than a whole-file one, and `countOmittedLines`
  // because Grok's uuids embed the ABSOLUTE physical line index (see below).
  const window = await readJsonlWindow(filePath, {
    maxBytes: parseWindowBytes(),
    countOmittedLines: true,
  });
  if (window.totalBytes === 0) {
    return { entries: [], sourcePath: null };
  }

  const entries: TranscriptEntry[] = [];
  const parseTimeTs = Date.now();
  const lines = window.text.split(/\r?\n/);
  // Line indices must stay absolute within the FILE, not relative to the
  // window: these uuids are the persisted citation anchors that
  // `sliceTranscriptAroundUuid` resolves against, so renumbering them when a
  // transcript grows past the cap would silently break every stored citation.
  const lineIndexBase = window.omittedLineCount;
  // Reasoning records precede the assistant record they belong to; buffer
  // their summaries and attach as thinking blocks on the next assistant.
  let pendingThinking: string[] = [];

  for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
    const line = lines[lineIndex];
    if (line.length === 0) continue;
    let raw: unknown;
    try {
      raw = JSON.parse(line);
    } catch {
      continue;
    }
    if (!isRecord(raw)) continue;
    const uuid = `${agentSessionId}:${lineIndexBase + lineIndex}`;

    if (raw.type === 'user') {
      if (typeof raw.synthetic_reason === 'string' && raw.synthetic_reason.length > 0) continue;
      const text = extractTextContent(raw.content);
      if (!text) continue;
      entries.push({ kind: 'user', uuid, ts: parseTimeTs, text: unwrapUserQuery(text) });
    } else if (raw.type === 'reasoning') {
      const summaryText = extractReasoningSummary(raw.summary);
      if (summaryText) pendingThinking.push(summaryText);
    } else if (raw.type === 'assistant') {
      const blocks: TranscriptBlock[] = [];
      for (const thinking of pendingThinking) {
        blocks.push({ type: 'thinking', text: thinking });
      }
      pendingThinking = [];
      const text = extractTextContent(raw.content);
      if (text) blocks.push({ type: 'text', text });
      if (Array.isArray(raw.tool_calls)) {
        for (const call of raw.tool_calls) {
          if (!isRecord(call)) continue;
          blocks.push({
            type: 'tool_use',
            id: typeof call.id === 'string' ? call.id : '',
            name: typeof call.name === 'string' ? call.name : 'tool',
            input: parseToolArguments(call.arguments),
          });
        }
      }
      if (blocks.length === 0) continue;
      const model = typeof raw.model_id === 'string' && raw.model_id.length > 0 ? raw.model_id : undefined;
      entries.push({ kind: 'assistant', uuid, ts: parseTimeTs, model, blocks });
    } else if (raw.type === 'tool_result') {
      entries.push({
        kind: 'tool_result',
        uuid,
        ts: parseTimeTs,
        toolUseId: typeof raw.tool_call_id === 'string' ? raw.tool_call_id : '',
        content: extractTextContent(raw.content) ?? '',
      });
    }
    // 'system' (the system prompt) is deliberately skipped: TranscriptEntry
    // has no system-prompt kind, and the viewer renders conversation.
  }

  return {
    entries: prependTruncationMarker(entries, window.omittedBytes, window.totalBytes),
    sourcePath: filePath,
  };
}

/**
 * Cumulative lifetime tokens from the LAST `turn_completed.usage` in
 * `updates.jsonl` (session-cumulative by measurement). Null when no turn
 * has completed yet or the file is missing/unreadable.
 */
export async function grokTranscriptUsage(
  agentSessionId: string,
  cwd: string,
): Promise<TranscriptUsage | null> {
  let latest: TranscriptUsage | null = null;
  const readWholeFile = await forEachUpdateRecord(agentSessionId, cwd, (update) => {
    if (update.sessionUpdate !== 'turn_completed') return;
    const usage = update.usage;
    if (!isRecord(usage)) return;
    const inputTokens = usage.inputTokens;
    const outputTokens = usage.outputTokens;
    if (typeof inputTokens !== 'number' || typeof outputTokens !== 'number') return;
    latest = { inputTokens, outputTokens };
  });
  // A truncated read can stop before the LAST turn_completed, which is the one
  // that carries the session's cumulative totals - so a partial read does not
  // under-report slightly, it reports an earlier turn's numbers as the latest.
  return readWholeFile ? latest : null;
}

/**
 * Distinct tool-call count + per-tool breakdown from `updates.jsonl`
 * `tool_call` events (each carries a unique `toolCallId` and the tool name
 * in `title` / `_meta['x.ai/tool'].name`). callCount-only breakdown, per
 * the TranscriptToolCounts contract.
 */
export async function grokTranscriptToolCounts(
  agentSessionId: string,
  cwd: string,
): Promise<TranscriptToolCounts | null> {
  const seenIds = new Set<string>();
  const countsByTool = new Map<string, number>();
  const readWholeFile = await forEachUpdateRecord(agentSessionId, cwd, (update) => {
    if (update.sessionUpdate !== 'tool_call') return;
    const toolCallId = typeof update.toolCallId === 'string' ? update.toolCallId : null;
    if (toolCallId) {
      if (seenIds.has(toolCallId)) return;
      seenIds.add(toolCallId);
    }
    const toolName = grokToolCallName(update);
    countsByTool.set(toolName, (countsByTool.get(toolName) ?? 0) + 1);
  });

  if (!readWholeFile) return null; // partial read undercounts; keep the live count
  if (seenIds.size === 0 && countsByTool.size === 0) return null;

  const toolBreakdown: PerToolStat[] = Array.from(countsByTool.entries())
    .map(([toolName, callCount]) => ({ toolName, callCount, totalDurationMs: 0, interruptedCount: 0 }))
    .sort((a, b) => b.callCount - a.callCount);
  const toolCallCount = toolBreakdown.reduce((sum, stat) => sum + stat.callCount, 0);
  return { toolCallCount, toolBreakdown };
}

// ---------- Internal helpers ----------

/**
 * Stream `updates.jsonl`, handing each `params.update` record to `onUpdate`.
 *
 * STREAMED and NOT windowed, deliberately. Both callers compute session-
 * CUMULATIVE aggregates (the last `turn_completed.usage`, distinct tool-call
 * ids), so a bounded tail read would under-report them - the same reason
 * Claude's usage and tool-count readers stream the whole file rather than
 * taking the parse cap. Streaming keeps the peak at one line instead of the
 * whole file plus an array of every record in it.
 *
 * A missing file simply yields no records. Both callers already return null
 * when they find nothing, so the previous explicit missing-file null is
 * behaviourally identical.
 *
 * Returns whether the file was read to the end, which a cumulative aggregate
 * must check: a partial read produces a plausible number rather than an
 * obviously absent one.
 */
async function forEachUpdateRecord(
  agentSessionId: string,
  cwd: string,
  onUpdate: (update: Record<string, unknown>) => void,
): Promise<boolean> {
  const filePath = grokUpdatesJsonlPath(cwd, agentSessionId);
  return streamJsonlRecords(filePath, (raw) => {
    if (!isRecord(raw.params) || !isRecord(raw.params.update)) return;
    onUpdate(raw.params.update);
  });
}

function grokToolCallName(update: Record<string, unknown>): string {
  const meta = update._meta;
  if (isRecord(meta)) {
    const toolMeta = meta['x.ai/tool'];
    if (isRecord(toolMeta) && typeof toolMeta.name === 'string' && toolMeta.name.length > 0) {
      return toolMeta.name;
    }
  }
  return typeof update.title === 'string' && update.title.length > 0 ? update.title : 'tool';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Content is a plain string, a single `{type:'text',text}` block, or an
 * array of blocks (whose items may themselves be plain strings). Exported
 * so `command-injection-verifier.ts` parses the same `chat_history.jsonl`
 * content shapes identically - a private copy there once diverged by
 * silently dropping plain-string array items.
 */
export function extractTextContent(content: unknown): string | null {
  if (typeof content === 'string') return content.length > 0 ? content : null;
  if (isRecord(content)) {
    return typeof content.text === 'string' && content.text.length > 0 ? content.text : null;
  }
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const block of content) {
      if (typeof block === 'string') parts.push(block);
      else if (isRecord(block) && typeof block.text === 'string') parts.push(block.text);
    }
    const joined = parts.join('\n');
    return joined.length > 0 ? joined : null;
  }
  return null;
}

/** Strip the `<user_query>` wrapper grok stores around the typed prompt. */
export function unwrapUserQuery(text: string): string {
  const match = text.match(/^\s*<user_query>\r?\n?([\s\S]*?)\r?\n?<\/user_query>\s*$/);
  return match ? match[1] : text;
}

/** Reasoning `summary` is a string or an array of strings / text blocks. */
function extractReasoningSummary(summary: unknown): string | null {
  if (typeof summary === 'string') return summary.length > 0 ? summary : null;
  if (Array.isArray(summary)) {
    const parts: string[] = [];
    for (const block of summary) {
      if (typeof block === 'string') parts.push(block);
      else if (isRecord(block) && typeof block.text === 'string') parts.push(block.text);
    }
    const joined = parts.join('\n');
    return joined.length > 0 ? joined : null;
  }
  return null;
}

/** `tool_calls[].arguments` is a JSON-encoded string; fall back to the raw string. */
function parseToolArguments(argumentsValue: unknown): unknown {
  if (typeof argumentsValue !== 'string') return argumentsValue ?? {};
  try {
    return JSON.parse(argumentsValue);
  } catch {
    return argumentsValue;
  }
}
