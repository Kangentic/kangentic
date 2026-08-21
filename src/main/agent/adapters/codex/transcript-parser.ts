import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { TranscriptEntry, TranscriptBlock } from '../../../../shared/types';
import { readJsonlWindow } from '../../shared/history-scan';
import { parseWindowBytes, prependTruncationMarker } from '../../shared/transcript-truncation';

/**
 * Parse Codex CLI's native rollout JSONL into agent-agnostic
 * `TranscriptEntry[]` for the MCP `get_transcript` structured format.
 *
 * Schema (empirically verified against real Codex rollouts, 2026-06):
 * append-only JSONL, one object per line as `{ timestamp, type, payload }`.
 * The conversation lives in `type: "response_item"` entries; Codex also emits
 * a parallel `type: "event_msg"` stream that duplicates user/assistant text,
 * so we read `response_item` ONLY to avoid double-rendering every turn.
 *
 * `response_item` payload variants:
 *   - `message` with `role`:
 *       - `developer` / `system`: instruction wrappers - skipped.
 *       - `user`: `content[].input_text` joined. Codex injects an
 *         `<environment_context>` (and sometimes `<user_instructions>`)
 *         wrapper as a synthetic user turn; those are skipped.
 *       - `assistant`: `content[].output_text` joined -> assistant text.
 *   - `reasoning`: `summary[]` of `{ type: "summary_text", text }`. Real
 *     rollouts almost always carry an empty summary plus `encrypted_content`
 *     (no plaintext), so only non-empty summaries become thinking blocks.
 *   - `function_call`: `{ name, arguments (JSON string), call_id }` -> tool_use.
 *   - `function_call_output`: `{ call_id, output (string) }` -> tool_result.
 *
 * Model is tracked from `turn_context` entries (`payload.model`) and attached
 * to the assistant entries that follow.
 *
 * Defensive parsing throughout: a malformed line is skipped, never thrown.
 */
export async function parseCodexTranscript(filePath: string): Promise<TranscriptEntry[]> {
  // Bounded tail read rather than a whole-file one: a transcript has no size
  // ceiling, and reading one whole is what OOM'd the main process.
  const window = await readJsonlWindow(filePath, { maxBytes: parseWindowBytes() });
  if (window.totalBytes === 0) return [];

  const entries: TranscriptEntry[] = [];
  const lines = window.text.split(/\r?\n/);
  let currentModel: string | undefined;
  let entryIndex = 0;

  for (const line of lines) {
    if (line.length === 0) continue;
    let raw: unknown;
    try {
      raw = JSON.parse(line);
    } catch {
      continue;
    }
    if (!isRecord(raw)) continue;

    const ts = parseTimestamp(raw.timestamp);

    if (raw.type === 'turn_context' && isRecord(raw.payload)) {
      const model = raw.payload.model;
      if (typeof model === 'string' && model.length > 0) currentModel = model;
      continue;
    }

    if (raw.type !== 'response_item' || !isRecord(raw.payload)) continue;
    const payload = raw.payload;
    const uuid = `codex-${entryIndex++}`;

    if (payload.type === 'message') {
      const role = payload.role;
      if (role !== 'user' && role !== 'assistant') continue; // skip developer/system
      const text = joinContentText(payload.content);
      if (text.length === 0) continue;
      if (role === 'user') {
        // Skip Codex's injected context wrappers (not authored by the user).
        if (text.startsWith('<environment_context>') || text.startsWith('<user_instructions>')) {
          continue;
        }
        entries.push({ kind: 'user', uuid, ts, text });
      } else {
        entries.push({ kind: 'assistant', uuid, ts, model: currentModel, blocks: [{ type: 'text', text }] });
      }
      continue;
    }

    if (payload.type === 'reasoning') {
      const blocks: TranscriptBlock[] = [];
      if (Array.isArray(payload.summary)) {
        for (const item of payload.summary) {
          if (isRecord(item) && typeof item.text === 'string' && item.text.length > 0) {
            blocks.push({ type: 'thinking', text: item.text });
          }
        }
      }
      if (blocks.length > 0) {
        entries.push({ kind: 'assistant', uuid, ts, model: currentModel, blocks });
      }
      continue;
    }

    if (payload.type === 'function_call') {
      const callId = typeof payload.call_id === 'string' ? payload.call_id : '';
      const name = typeof payload.name === 'string' ? payload.name : 'function';
      const input = typeof payload.arguments === 'string'
        ? (tryParseJson(payload.arguments) ?? payload.arguments)
        : payload.arguments;
      entries.push({
        kind: 'assistant',
        uuid,
        ts,
        model: currentModel,
        blocks: [{ type: 'tool_use', id: callId, name, input }],
      });
      continue;
    }

    if (payload.type === 'function_call_output') {
      const callId = typeof payload.call_id === 'string' ? payload.call_id : '';
      entries.push({
        kind: 'tool_result',
        uuid,
        ts,
        toolUseId: callId,
        content: stringifyOutput(payload.output),
      });
      continue;
    }
  }

  return prependTruncationMarker(entries, window.omittedBytes, window.totalBytes);
}

/**
 * Locate the rollout JSONL for a known Codex session id. Unlike the
 * telemetry-side `CodexSessionHistoryParser.locate` (which polls only
 * today/yesterday for the post-spawn capture window), this walks the
 * `~/.codex/sessions/<YYYY>/<MM>/<DD>` tree newest-first so an older session
 * can be viewed on demand. Returns the absolute path, or null if not found.
 */
export function locateCodexTranscriptFile(agentSessionId: string): string | null {
  const root = path.join(os.homedir(), '.codex', 'sessions');
  const escapedId = agentSessionId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(`^rollout-.*-${escapedId}\\.jsonl$`);

  for (const year of listDescending(root)) {
    const yearDir = path.join(root, year);
    for (const month of listDescending(yearDir)) {
      const monthDir = path.join(yearDir, month);
      for (const day of listDescending(monthDir)) {
        const dayDir = path.join(monthDir, day);
        let names: string[];
        try {
          names = fs.readdirSync(dayDir);
        } catch {
          continue;
        }
        const match = names.find((name) => pattern.test(name));
        if (match) return path.join(dayDir, match);
      }
    }
  }
  return null;
}

function listDescending(directory: string): string[] {
  try {
    return fs.readdirSync(directory).sort((a, b) => (a < b ? 1 : a > b ? -1 : 0));
  } catch {
    return [];
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseTimestamp(value: unknown): number {
  if (typeof value !== 'string') return Date.now();
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : Date.now();
}

/** Join the `text` fields of a Codex message `content[]` (input_text/output_text/text). */
function joinContentText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const block of content) {
    if (isRecord(block) && typeof block.text === 'string') parts.push(block.text);
  }
  return parts.join('').trim();
}

function tryParseJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

/** A function_call_output `output` is usually a string; stringify other shapes. */
function stringifyOutput(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value === undefined || value === null) return '';
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}
