import path from 'node:path';
import type { TranscriptEntry, TranscriptBlock } from '../../../../shared/types';
import type { TranscriptPageReadRequest, TranscriptPageReadResult } from '../../agent-adapter';
import { readJsonlWindow } from '../../shared/history-scan';
import { jsonlEarlierHistory, readJsonlHistoryPage, splitJsonlLines, stampOrigin, type JsonlLine } from '../../shared/jsonl-history-page';
import { parseWindowBytes, prependTruncationMarker } from '../../shared/transcript-truncation';
import { droidSessionsDirForCwd } from './session-id-capture';
import type { CliPlace } from '../../shared/cli-target';

/** A Droid record without its own id is named by its line, so the tail, its notice and every page count lines. */
const UUIDS_NUMBER_LINES = true;

/**
 * Parse Factory Droid's native session JSONL into a list of full transcript
 * entries (user prompts, assistant turns with text/tool_use blocks, and tool
 * results). Runs on demand from the renderer's Transcript tab.
 *
 * Schema (empirically verified against Droid 0.109.1; see
 * `tests/fixtures/droid-real-session.jsonl`):
 *
 *   - `session_start`: per-session metadata (id, title, owner, cwd, version).
 *     Skipped by the parser; the dialog-tab caller already knows the cwd.
 *
 *   - `message`: the only event that carries conversational content. Outer
 *     envelope is `{ type: 'message', id, timestamp, parentId?, message: {...} }`
 *     where `message.role` is `'user' | 'assistant'` and `message.content` is
 *     ALWAYS an array of Anthropic-shaped blocks: `text`, `tool_use`, and
 *     `tool_result`. Tool calls and tool results are inline content blocks.
 *     Droid does NOT emit separate top-level `tool_call`/`tool_result` events,
 *     contrary to the original task brief.
 *
 *   - Other top-level types (`system`, `completion`, `todo_state`,
 *     `compaction_state`, ...): bookkeeping. Skipped silently for v1, matching
 *     the Claude parser's tolerant treatment of unknown entry types.
 *
 * Live telemetry (tokens, cost, model, activity) is explicitly out of scope
 * here. This parser feeds the on-demand structured Transcript tab via
 * `handleGetTranscript`, not the SessionHistoryReader pipeline.
 *
 * Model is intentionally not extracted: Droid does not put the model id in
 * the JSONL structurally. It only appears inside human-readable
 * `<system-reminder>` text blocks (e.g. "Model: Sonnet 4.5 [BYOK]"), which is
 * too fragile to scrape. Assistant entries therefore carry no `model` field;
 * the markdown formatter falls back to a plain `## Assistant` header.
 */
export async function parseDroidTranscript(
  agentSessionId: string,
  filePath: string,
): Promise<TranscriptEntry[]> {
  // Bounded tail read rather than a whole-file one: a transcript has no size
  // ceiling (it grows for as long as the user keeps working), and reading one
  // whole is what OOM'd the main process.
  const window = await readJsonlWindow(filePath, {
    maxBytes: parseWindowBytes(),
    countOmittedLines: UUIDS_NUMBER_LINES,
  });
  if (window.totalBytes === 0) return [];

  // The line count is only used when a record turns out to lack its own `id`.
  // See the Qwen parser for why this is resolved up front rather than lazily.
  const entries = parseDroidLines(agentSessionId, splitJsonlLines(window.text, window.startByte, window.omittedLineCount));
  // The notice carries the cursor the Conversation viewer pages the left-out
  // history from (`readDroidTranscriptPage`), with the line count the uuids need.
  return prependTruncationMarker(entries, window.omittedBytes, window.totalBytes, jsonlEarlierHistory(agentSessionId, window, UUIDS_NUMBER_LINES));
}

/**
 * One page of a Droid transcript's history for the Conversation viewer
 * (`AgentAdapter.readTranscriptPage`). A record without its own id is named
 * by its line, so cursors carry a line count.
 */
export function readDroidTranscriptPage(
  agentSessionId: string,
  filePath: string,
  request: TranscriptPageReadRequest,
): Promise<TranscriptPageReadResult> {
  return readJsonlHistoryPage({
    filePath,
    request,
    countLines: UUIDS_NUMBER_LINES,
    parseLines: (lines) => parseDroidLines(agentSessionId, lines),
  });
}

/** Parse whole lines into entries, each stamped with the byte its line starts at. */
function parseDroidLines(agentSessionId: string, lines: ReadonlyArray<JsonlLine>): TranscriptEntry[] {
  const entries: TranscriptEntry[] = [];
  for (const { text: line, byte, line: lineNumber } of lines) {
    if (line.length === 0) continue;
    const firstNew = entries.length;
    parseDroidRecord(agentSessionId, line, lineNumber ?? 0, entries);
    stampOrigin(entries, firstNew, agentSessionId, byte);
  }
  return entries;
}

/** Parse one JSONL record, appending what it yields. */
function parseDroidRecord(agentSessionId: string, line: string, lineNumber: number, entries: TranscriptEntry[]): void {
  let raw: unknown;
  try {
    raw = JSON.parse(line);
  } catch {
    return;
  }
  if (!isRecord(raw)) return;

  if (raw.type !== 'message') return;

  // An id-less record used to fall back to `''`, which is not an absent uuid
  // but a SHARED one: `resolveTaskTranscript` dedups by uuid keeping the
  // first, so every such entry after the first vanished from the stitched
  // Conversation tab. Fall back to the session-scoped absolute line index
  // instead (the Codex/Kimi shape) so the entry keeps a real identity.
  const uuid = typeof raw.id === 'string' && raw.id.length > 0
    ? raw.id
    : `${agentSessionId}:${lineNumber}`;
  const ts = parseTimestamp(raw.timestamp);
  const message = raw.message;
  if (!isRecord(message)) return;

  const role = message.role;
  const messageContent = message.content;
  if (!Array.isArray(messageContent)) return;

  if (role === 'user') {
    const textParts: string[] = [];
    for (const block of messageContent) {
      if (!isRecord(block)) continue;
      if (block.type === 'tool_result') {
        entries.push({
          kind: 'tool_result',
          uuid,
          ts,
          toolUseId: typeof block.tool_use_id === 'string' ? block.tool_use_id : '',
          content: stringifyToolResultContent(block.content),
          isError: block.is_error === true,
        });
      } else if (block.type === 'text' && typeof block.text === 'string') {
        textParts.push(block.text);
      }
    }
    if (textParts.length > 0) {
      entries.push({ kind: 'user', uuid, ts, text: textParts.join('\n') });
    }
    return;
  }

  if (role === 'assistant') {
    const blocks: TranscriptBlock[] = [];
    for (const block of messageContent) {
      if (!isRecord(block)) continue;
      if (block.type === 'text' && typeof block.text === 'string') {
        blocks.push({ type: 'text', text: block.text });
      } else if (block.type === 'thinking') {
        // Forward-compat: Droid 0.109 has not been observed emitting
        // thinking blocks, but reasoning-capable models could surface
        // them in a future version. Match Claude's behavior: keep
        // non-empty thinking, drop empty signature-only stubs.
        if (typeof block.thinking === 'string' && block.thinking.length > 0) {
          blocks.push({ type: 'thinking', text: block.thinking });
        }
      } else if (block.type === 'tool_use') {
        blocks.push({
          type: 'tool_use',
          id: typeof block.id === 'string' ? block.id : '',
          name: typeof block.name === 'string' ? block.name : 'tool',
          input: block.input,
        });
      }
    }
    if (blocks.length === 0) return;
    entries.push({ kind: 'assistant', uuid, ts, blocks });
  }
}

/**
 * Build the absolute path to Droid's session JSONL for a known agent
 * session id and original cwd. Synchronous and existence-agnostic;
 * mirrors `locateClaudeTranscriptFile`. The parser handles missing files
 * by returning `[]`.
 *
 * Note: the polling variant `locateSessionFile` in `session-id-capture.ts`
 * is intended for the post-spawn capture window; this on-demand path is
 * called long after the file has been written, so polling would only add
 * latency to the negative case.
 */
export function droidTranscriptFilePath(agentSessionId: string, cwd: string, place: CliPlace | null = null): string {
  return path.join(droidSessionsDirForCwd(cwd, place), `${agentSessionId}.jsonl`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseTimestamp(value: unknown): number {
  if (typeof value !== 'string') return Date.now();
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : Date.now();
}

/**
 * Tool result content can be a plain string or an array of content blocks.
 * Real Droid sessions overwhelmingly use the plain-string form (e.g. file
 * contents, command output), but the array form is part of the underlying
 * Anthropic content-block schema and may appear for richer tools.
 *
 * Anything else collapses to an empty string. Unknown block types are
 * elided rather than silently dropped so the user can see something
 * happened.
 */
function stringifyToolResultContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const block of content) {
      if (typeof block === 'string') {
        parts.push(block);
      } else if (isRecord(block)) {
        if (block.type === 'text' && typeof block.text === 'string') {
          parts.push(block.text);
        } else if (block.type === 'image') {
          parts.push('[image]');
        }
      }
    }
    return parts.join('\n');
  }
  return '';
}
