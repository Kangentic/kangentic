import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { TranscriptEntry, TranscriptBlock } from '../../../../shared/types';
import { readJsonlWindow } from '../../shared/history-scan';
import { parseWindowBytes, prependTruncationMarker } from '../../shared/transcript-truncation';
import { computeGeminiProjectDirName } from './session-history-parser';

/**
 * Parse Gemini CLI's native chat session file into agent-agnostic
 * `TranscriptEntry[]` for the MCP `get_transcript` structured format.
 *
 * Format (empirically verified against real Gemini CLI sessions, 2026-06):
 * the current CLI writes append-only JSONL, NOT the single-object `.json` the
 * telemetry-side `GeminiSessionHistoryParser` still assumes. Lines are:
 *   - a header line `{ sessionId, projectHash, startTime, lastUpdated, kind }`;
 *   - `$set` patch lines. The FIRST `$set` seeds `messages[]` (carrying the
 *     opening user turn); later `$set`s touch only `lastUpdated`. So `$set`
 *     payloads can carry a `messages[]` array we must fold in;
 *   - standalone message lines `{ id, timestamp, type: 'user'|'gemini',
 *     content, thoughts?, tokens?, model?, toolCalls? }`.
 *
 * Critical: Gemini RE-EMITS a message with the SAME `id` as it streams (first
 * without `toolCalls`, then again with them). We dedupe by `id`, last emission
 * wins, preserving first-seen order, or every turn renders twice.
 *
 * Mapping:
 *   - `user`: `content[].text` joined -> user entry. The CLI's injected
 *     `<session_context>` opening turn is skipped (not authored by the user).
 *   - `gemini`: assistant entry with `model`; `thoughts[]` ->
 *     thinking blocks (`subject: description`), non-empty `content` -> text,
 *     `toolCalls[]` -> tool_use blocks plus synthesized tool_result entries
 *     from each call's embedded `result[].functionResponse.response`.
 *
 * Also tolerates the legacy single-JSON-object form (`{ messages: [...] }`) so
 * older sessions still parse. Defensive throughout: malformed lines skipped.
 */
export async function parseGeminiTranscript(
  agentSessionId: string,
  filePath: string,
): Promise<TranscriptEntry[]> {
  // Bounded tail read rather than a whole-file one: a transcript has no size
  // ceiling, and reading one whole is what OOM'd the main process.
  const window = await readJsonlWindow(filePath, {
    maxBytes: parseWindowBytes(),
    countOmittedLines: true,
  });
  if (window.totalBytes === 0) return [];
  const content = window.text;

  // Only used when a message lacks its own `id`. See the Qwen parser for why
  // this is resolved up front rather than lazily.
  const lineIndexBase = window.omittedLineCount;

  // Dedupe by message id, last-wins, first-seen order preserved.
  //
  // The map KEY is the entry uuid. Deriving both from one value is the point:
  // the key used to fall back to `gemini-${messagesById.size}` while the uuid
  // fell back to `''`, so an id-less message was keyed distinctly but then
  // emitted with a uuid shared by every other id-less message - and
  // `resolveTaskTranscript` dedups by uuid keeping the first, so all but one
  // vanished from the stitched Conversation tab. The fallback is now the
  // session-scoped absolute line index used by the Codex and Kimi parsers.
  const messagesById = new Map<string, Record<string, unknown>>();
  const addMessage = (message: unknown, lineIndex: number, indexWithinLine: number | null): void => {
    if (!isRecord(message)) return;
    const type = message.type;
    if (type !== 'user' && type !== 'gemini') return;
    let messageId = typeof message.id === 'string' && message.id.length > 0 ? message.id : null;
    if (messageId === null) {
      const absoluteLine = lineIndexBase + lineIndex;
      // A `$set` line seeds SEVERAL messages, so the line alone is not unique.
      messageId = indexWithinLine === null
        ? `${agentSessionId}:${absoluteLine}`
        : `${agentSessionId}:${absoluteLine}.${indexWithinLine}`;
    }
    messagesById.set(messageId, message);
  };

  const trimmed = content.trim();
  // `window.omittedBytes === 0` is load-bearing, not belt-and-braces. The legacy
  // form is ONE JSON object spanning the whole file, so it is detected by the
  // file containing no newlines - but a tail window of a legacy document larger
  // than the cap also contains no newline, while being a fragment whose opening
  // brace was cut off. Without this guard it would fall through to the JSONL
  // loop and silently yield zero entries instead of the conversation.
  // Both ends checked, not just the head: `omittedBytes === 0` alone only means
  // the window started at byte 0, which would still be true of a document read
  // from the start and cut short at the cap.
  const isWholeFile = window.omittedBytes === 0 && window.nextByteOffset >= window.totalBytes;
  if (isWholeFile && trimmed.startsWith('{') && trimmed.endsWith('}') && !trimmed.includes('\n')) {
    // Legacy single-object form: one JSON object with a messages[] array.
    const parsed = tryParseJson(trimmed);
    if (isRecord(parsed) && Array.isArray(parsed.messages)) {
      // The legacy form is one object on one line, so every message shares
      // line 0 and is distinguished by its index within the array.
      for (const [index, message] of parsed.messages.entries()) addMessage(message, 0, index);
    }
  } else {
    const lines = content.split(/\r?\n/);
    for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
      const line = lines[lineIndex];
      if (line.length === 0) continue;
      const parsed = tryParseJson(line);
      if (!isRecord(parsed)) continue;
      // `$set` patch line: fold in any seeded messages, ignore other keys.
      if (isRecord(parsed.$set)) {
        if (Array.isArray(parsed.$set.messages)) {
          for (const [index, message] of parsed.$set.messages.entries()) {
            addMessage(message, lineIndex, index);
          }
        }
        continue;
      }
      addMessage(parsed, lineIndex, null);
    }
  }

  const entries: TranscriptEntry[] = [];
  // The key IS the uuid (see `addMessage`).
  for (const [uuid, message] of messagesById) {
    const ts = parseTimestamp(message.timestamp);

    if (message.type === 'user') {
      const text = joinContentText(message.content);
      if (text.length === 0) continue;
      // Skip the CLI's injected opening context turn.
      if (text.startsWith('<session_context>')) continue;
      entries.push({ kind: 'user', uuid, ts, text });
      continue;
    }

    // gemini (assistant)
    const model = typeof message.model === 'string' ? message.model : undefined;
    const blocks: TranscriptBlock[] = [];
    const toolResults: TranscriptEntry[] = [];

    if (Array.isArray(message.thoughts)) {
      for (const thought of message.thoughts) {
        if (!isRecord(thought)) continue;
        const subject = typeof thought.subject === 'string' ? thought.subject.trim() : '';
        const description = typeof thought.description === 'string' ? thought.description.trim() : '';
        const text = subject && description ? `${subject}: ${description}` : subject || description;
        if (text.length > 0) blocks.push({ type: 'thinking', text });
      }
    }

    const contentText = typeof message.content === 'string'
      ? message.content
      : joinContentText(message.content);
    if (contentText.trim().length > 0) blocks.push({ type: 'text', text: contentText });

    if (Array.isArray(message.toolCalls)) {
      for (const call of message.toolCalls) {
        if (!isRecord(call)) continue;
        const id = typeof call.id === 'string' ? call.id : '';
        const name = typeof call.name === 'string' ? call.name : 'tool';
        blocks.push({ type: 'tool_use', id, name, input: call.args });
        toolResults.push({
          kind: 'tool_result',
          uuid,
          ts,
          toolUseId: id,
          content: extractToolCallOutput(call),
          isError: call.status === 'error',
        });
      }
    }

    if (blocks.length > 0) entries.push({ kind: 'assistant', uuid, ts, model, blocks });
    for (const result of toolResults) entries.push(result);
  }

  return prependTruncationMarker(entries, window.omittedBytes, window.totalBytes);
}

/**
 * Locate the Gemini chat session file for a known session id. Matches both
 * the current `.jsonl` form and the legacy `.json` form (the filename embeds
 * the first 8 chars of the session UUID). Non-polling single readdir.
 */
export function locateGeminiTranscriptFile(agentSessionId: string, cwd: string): string | null {
  const projectDirName = computeGeminiProjectDirName(cwd);
  const directory = path.join(os.homedir(), '.gemini', 'tmp', projectDirName, 'chats');
  const shortId = agentSessionId.slice(0, 8).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(`^session-.*${shortId}\\.jsonl?$`, 'i');
  let names: string[];
  try {
    names = fs.readdirSync(directory);
  } catch {
    return null;
  }
  const match = names.find((name) => pattern.test(name));
  return match ? path.join(directory, match) : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseTimestamp(value: unknown): number {
  if (typeof value !== 'string') return Date.now();
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : Date.now();
}

function tryParseJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

/** Join the `text` fields of a Gemini `content[]` array (or pass a string through). */
function joinContentText(content: unknown): string {
  if (typeof content === 'string') return content.trim();
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const block of content) {
    if (isRecord(block) && typeof block.text === 'string') parts.push(block.text);
  }
  return parts.join('').trim();
}

/**
 * Pull readable output text out of a Gemini toolCall's embedded result. The
 * shape is `result[].functionResponse.response.output`; fall back to
 * `resultDisplay`, then to a JSON dump.
 */
function extractToolCallOutput(call: Record<string, unknown>): string {
  if (Array.isArray(call.result)) {
    const parts: string[] = [];
    for (const item of call.result) {
      if (!isRecord(item)) continue;
      const functionResponse = item.functionResponse;
      if (isRecord(functionResponse) && isRecord(functionResponse.response)) {
        const output = functionResponse.response.output;
        if (typeof output === 'string') parts.push(output);
        else if (output !== undefined) parts.push(safeJson(output));
      }
    }
    if (parts.length > 0) return parts.join('\n');
  }
  if (typeof call.resultDisplay === 'string') return call.resultDisplay;
  if (call.resultDisplay !== undefined) return safeJson(call.resultDisplay);
  return '';
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}
