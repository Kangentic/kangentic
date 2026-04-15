import {
  EventType,
  type SessionEvent,
  type SessionUsage,
  type StreamOutputParser,
} from '../../../../shared/types';

/**
 * Parses Cursor CLI's `--output-format stream-json` NDJSON stream as it
 * arrives over the PTY. Each session gets its own instance via
 * `CursorAdapter.runtime.streamOutput.createParser()`.
 *
 * Event shapes are documented at:
 * https://cursor.com/docs/cli/reference/output-format
 *
 * Init event (the only line we strictly need to populate the model pill):
 *   {"type":"system","subtype":"init","session_id":"<uuid>",
 *    "model":"<display name>","permissionMode":"default",...}
 *
 * Tool events drive Thinking/Idle through the activity state machine:
 *   {"type":"tool_call","subtype":"started","call_id":"...","tool_call":{...}}
 *   {"type":"tool_call","subtype":"completed","call_id":"...","tool_call":{...}}
 *
 * Terminal result event (carries duration; optional cost surface):
 *   {"type":"result","subtype":"success","duration_ms":5234,...}
 *
 * Cursor uses a single `model` string (e.g. "Claude 4 Sonnet") with no
 * separate id/displayName split, so we mirror it into both fields of
 * `SessionUsage.model`.
 */
export class CursorStreamParser implements StreamOutputParser {
  /**
   * Cap on the rolling partial-line buffer. Cursor's init event runs
   * well under 1KB; 8KB matches `SessionIdScanner.bufferMax` and is two
   * ConPTY flush boundaries. Without this cap, a producer that emits
   * data with no newlines (raw TUI output in interactive mode, a
   * malformed unbroken stream) would grow `carry` without bound.
   */
  private static readonly MAX_CARRY = 8192;

  /**
   * Trailing partial line carried into the next parse pass. Cursor's
   * init event is well under ConPTY's ~4KB flush boundary so it almost
   * always arrives intact, but a chunk boundary can land mid-line at
   * any point and a buffered carry-over keeps us safe.
   */
  private carry = '';

  parseTelemetry(data: string): {
    usage?: Partial<SessionUsage>;
    events?: SessionEvent[];
  } | null {
    const combined = this.carry + data;
    const lines = combined.split(/\r?\n/);
    // The last element is whatever followed the final newline (or the
    // entire chunk if no newline appeared) - hold it back as carry.
    const tail = lines.pop() ?? '';
    this.carry = tail.length > CursorStreamParser.MAX_CARRY
      ? tail.slice(tail.length - CursorStreamParser.MAX_CARRY)
      : tail;

    let usage: Partial<SessionUsage> | undefined;
    let events: SessionEvent[] | undefined;

    for (const line of lines) {
      if (line.length === 0) continue;
      let entry: unknown;
      try {
        entry = JSON.parse(line);
      } catch {
        continue;
      }
      if (!isRecord(entry)) continue;
      const type = entry.type;
      const subtype = entry.subtype;

      if (type === 'system' && subtype === 'init') {
        const model = entry.model;
        if (typeof model === 'string' && model.length > 0) {
          usage = { ...usage, model: { id: model, displayName: model } };
        }
      } else if (type === 'tool_call' && subtype === 'started') {
        const toolName = extractToolName(entry.tool_call);
        events = events ?? [];
        events.push({
          ts: Date.now(),
          type: EventType.ToolStart,
          tool: toolName,
          detail: toolName,
        });
      } else if (type === 'tool_call' && subtype === 'completed') {
        const toolName = extractToolName(entry.tool_call);
        events = events ?? [];
        events.push({
          ts: Date.now(),
          type: EventType.ToolEnd,
          tool: toolName,
          detail: toolName,
        });
      } else if (type === 'result' && subtype === 'success') {
        const durationMs = entry.duration_ms;
        if (typeof durationMs === 'number' && durationMs > 0) {
          usage = {
            ...usage,
            cost: { totalCostUsd: 0, totalDurationMs: durationMs },
          };
        }
      }
    }

    if (!usage && !events) return null;
    return { usage, events };
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Cursor wraps each tool call in a single-key object whose key is the
 * tool name (`readToolCall`, `writeToolCall`, ...). Strip the trailing
 * `ToolCall` to get the bare tool name; fall back to `'tool'` when the
 * shape doesn't match. Activity tracking only reads ToolStart/ToolEnd
 * transitions, so an opaque label is fine when extraction fails.
 */
function extractToolName(toolCall: unknown): string {
  if (!isRecord(toolCall)) return 'tool';
  const keys = Object.keys(toolCall);
  if (keys.length === 0) return 'tool';
  const key = keys[0];
  return key.endsWith('ToolCall') ? key.slice(0, -'ToolCall'.length) : key;
}
