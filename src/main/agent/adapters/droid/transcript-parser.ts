import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { TranscriptEntry, TranscriptBlock } from '../../../../shared/types';
import { cwdToSessionSlug } from './session-id-capture';

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
export async function parseDroidTranscript(filePath: string): Promise<TranscriptEntry[]> {
  let content: string;
  try {
    content = await fs.readFile(filePath, 'utf-8');
  } catch {
    return [];
  }

  const entries: TranscriptEntry[] = [];
  const lines = content.split(/\r?\n/);

  for (const line of lines) {
    if (line.length === 0) continue;
    let raw: unknown;
    try {
      raw = JSON.parse(line);
    } catch {
      continue;
    }
    if (!isRecord(raw)) continue;

    if (raw.type !== 'message') continue;

    const uuid = typeof raw.id === 'string' ? raw.id : '';
    const ts = parseTimestamp(raw.timestamp);
    const message = raw.message;
    if (!isRecord(message)) continue;

    const role = message.role;
    const messageContent = message.content;
    if (!Array.isArray(messageContent)) continue;

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
      continue;
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
      if (blocks.length === 0) continue;
      entries.push({ kind: 'assistant', uuid, ts, blocks });
    }
  }

  return entries;
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
export function droidTranscriptFilePath(agentSessionId: string, cwd: string): string {
  return path.join(
    os.homedir(),
    '.factory',
    'sessions',
    cwdToSessionSlug(cwd),
    `${agentSessionId}.jsonl`,
  );
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
