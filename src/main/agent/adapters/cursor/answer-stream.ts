/**
 * Cursor's `--output-format stream-json` stream, read for a Knowledge Graph answer.
 *
 * Claude-like lines with two differences, captured on cursor-agent
 * 2026.09.23 with `--stream-partial-output`:
 *
 *   assistant (with timestamp_ms)     a text DELTA: the partial lines are the
 *                                     assistant lines themselves, a few characters each
 *   assistant (no timestamp_ms)       the final turn's complete text, once, at the end
 *   thinking { subtype: delta }       reasoning, not shown
 *   tool_call { subtype: started, tool_call: { mcpToolCall: { args: { toolName } } } }
 *   result { result, is_error }       every turn's text FUSED with no separator
 *                                     ("...run that query once.Hybrid search returned...")
 *
 * So the answer is the complete assistant line, never `result`: the result
 * carries the narration of the turn that called the tool.
 */

import type { AnswerStreamEvent } from '../../shared/auto-name';

interface CursorRecord {
  type?: unknown;
  subtype?: unknown;
  timestamp_ms?: unknown;
  message?: { content?: Array<{ type?: unknown; text?: unknown }> };
  tool_call?: Record<string, { args?: { toolName?: unknown; name?: unknown } }>;
  result?: unknown;
  is_error?: unknown;
  session_id?: unknown;
}

function parse(line: string): CursorRecord | null {
  if (!line.startsWith('{')) return null;
  try {
    const record = JSON.parse(line) as unknown;
    return record && typeof record === 'object' ? record as CursorRecord : null;
  } catch {
    return null;
  }
}

function messageText(record: CursorRecord): string {
  return (record.message?.content ?? [])
    .map((block) => (block.type === 'text' && typeof block.text === 'string' ? block.text : ''))
    .join('');
}

function isDelta(record: CursorRecord): boolean {
  return typeof record.timestamp_ms === 'number';
}

/** Text as it is written, and each tool call as it starts. */
export function createCursorAnswerReducer(): (line: string) => AnswerStreamEvent[] {
  let sawDelta = false;
  return (line) => {
    const record = parse(line);
    if (!record) return [];
    if (record.type === 'assistant') {
      const text = messageText(record);
      if (isDelta(record)) {
        sawDelta = true;
        return text ? [{ kind: 'text', text }] : [];
      }
      // The complete final turn: already shown as deltas, unless the run did
      // not stream them.
      return !sawDelta && text ? [{ kind: 'text', text }] : [];
    }
    if (record.type === 'tool_call' && record.subtype === 'started') {
      const call = Object.values(record.tool_call ?? {})[0];
      const name = call?.args?.toolName ?? call?.args?.name;
      return typeof name === 'string' && name ? [{ kind: 'tool', name }] : [];
    }
    return [];
  };
}

/**
 * The answer: the last complete assistant line. Without one (a stream cut
 * short), the text written after the last tool call. Throws the CLI's own
 * message for a run it reports as failed.
 */
export function extractCursorAnswer(stdout: string): string {
  let complete = '';
  let sinceLastTool = '';
  let failure: string | null = null;
  for (const line of stdout.split(/\r?\n/)) {
    const record = parse(line);
    if (!record) continue;
    if (record.type === 'assistant') {
      const text = messageText(record);
      if (isDelta(record)) sinceLastTool += text;
      else if (text.trim()) complete = text;
    } else if (record.type === 'tool_call' && record.subtype === 'started') {
      sinceLastTool = '';
    } else if (record.type === 'result' && record.is_error === true) {
      failure = typeof record.result === 'string' && record.result.trim() ? record.result.trim() : 'the agent reported an error';
    }
  }
  if (complete.trim()) return complete.trim();
  if (failure) throw new Error(failure);
  return sinceLastTool.trim();
}

/** The chat id on the stream's init line, or null. */
export function cursorInitSessionId(line: string): string | null {
  if (!line.includes('"init"')) return null;
  const record = parse(line);
  return record?.type === 'system' && record.subtype === 'init' && typeof record.session_id === 'string'
    ? record.session_id
    : null;
}
