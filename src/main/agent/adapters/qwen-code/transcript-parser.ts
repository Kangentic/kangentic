import path from 'node:path';
import type { TranscriptEntry, TranscriptBlock } from '../../../../shared/types';
import { readJsonlWindow } from '../../shared/history-scan';
import { parseWindowBytes, prependTruncationMarker } from '../../shared/transcript-truncation';
import { qwenChatsDir } from './session-history-parser';

/**
 * Parse Qwen Code's native session JSONL into agent-agnostic
 * `TranscriptEntry[]` for the MCP `get_transcript` structured format.
 *
 * Path: `~/.qwen/projects/<sanitized-cwd>/chats/<sessionId>.jsonl` (see
 * `qwenChatsDir`). Append-only JSONL; each line is one event:
 *   - `type: 'user'`   -> `message: { role: 'user', parts: [...] }`
 *   - `type: 'assistant'` -> `message: { role: 'model', parts: [...] }`,
 *      plus model + usage telemetry (read elsewhere).
 *   - `type: 'system'` (ui_telemetry) -> skipped.
 *
 * `parts[]` shapes (Gemini/GenAI lineage):
 *   - `{ text }`                       -> text block
 *   - `{ text, thought: true }`        -> thinking block (verified on disk)
 *   - `{ functionCall: { id?, name, args } }`     -> tool_use     (schema-derived)
 *   - `{ functionResponse: { id?, response } }`   -> tool_result  (schema-derived)
 *
 * The functionCall/functionResponse shapes are inferred from the upstream
 * GenAI part schema (no real tool-call sessions were available locally to
 * pin them); they are handled defensively and degrade to text if absent.
 */
export async function parseQwenTranscript(filePath: string): Promise<TranscriptEntry[]> {
  // Bounded tail read rather than a whole-file one: a transcript has no size
  // ceiling, and reading one whole is what OOM'd the main process.
  const window = await readJsonlWindow(filePath, { maxBytes: parseWindowBytes() });
  if (window.totalBytes === 0) return [];

  const entries: TranscriptEntry[] = [];
  let entryIndex = 0;

  for (const line of window.text.split(/\r?\n/)) {
    if (line.length === 0) continue;
    let raw: unknown;
    try {
      raw = JSON.parse(line);
    } catch {
      continue;
    }
    if (!isRecord(raw)) continue;

    const type = raw.type;
    if (type !== 'user' && type !== 'assistant') continue; // skip system/ui_telemetry
    const message = raw.message;
    if (!isRecord(message)) continue;
    const parts = message.parts;
    if (!Array.isArray(parts)) continue;

    const uuid = `qwen-${entryIndex++}`;
    const ts = parseTimestamp(raw.timestamp);

    if (type === 'user') {
      const textParts: string[] = [];
      for (const part of parts) {
        if (!isRecord(part)) continue;
        if (isRecord(part.functionResponse)) {
          const response = part.functionResponse;
          entries.push({
            kind: 'tool_result',
            uuid,
            ts,
            toolUseId: typeof response.id === 'string' ? response.id : '',
            content: stringifyResponse(response.response),
          });
        } else if (typeof part.text === 'string') {
          textParts.push(part.text);
        }
      }
      const text = textParts.join('').trim();
      if (text.length > 0) entries.push({ kind: 'user', uuid, ts, text });
      continue;
    }

    // assistant
    const model = typeof raw.model === 'string' ? raw.model : undefined;
    const blocks: TranscriptBlock[] = [];
    for (const part of parts) {
      if (!isRecord(part)) continue;
      if (isRecord(part.functionCall)) {
        const call = part.functionCall;
        blocks.push({
          type: 'tool_use',
          id: typeof call.id === 'string' ? call.id : '',
          name: typeof call.name === 'string' ? call.name : 'tool',
          input: call.args,
        });
      } else if (part.thought === true && typeof part.text === 'string') {
        if (part.text.trim().length > 0) blocks.push({ type: 'thinking', text: part.text });
      } else if (typeof part.text === 'string') {
        if (part.text.trim().length > 0) blocks.push({ type: 'text', text: part.text });
      }
    }
    if (blocks.length > 0) entries.push({ kind: 'assistant', uuid, ts, model, blocks });
  }

  return prependTruncationMarker(entries, window.omittedBytes, window.totalBytes);
}

/**
 * Build the absolute path to Qwen's session JSONL for a known session id and
 * cwd. The filename is exactly `<sessionId>.jsonl` (the adapter owns the id
 * via `--session-id`). Non-polling; the parser tolerates a missing file.
 */
export function locateQwenTranscriptFile(agentSessionId: string, cwd: string): string {
  return path.join(qwenChatsDir(cwd), `${agentSessionId}.jsonl`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseTimestamp(value: unknown): number {
  if (typeof value !== 'string') return Date.now();
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : Date.now();
}

/** Stringify a functionResponse `response` (often `{ output }` or a string). */
function stringifyResponse(value: unknown): string {
  if (typeof value === 'string') return value;
  if (isRecord(value) && typeof value.output === 'string') return value.output;
  if (value === undefined || value === null) return '';
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}
