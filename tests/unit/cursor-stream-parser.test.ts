/**
 * Unit tests for CursorStreamParser - parses Cursor's
 * `--output-format stream-json` NDJSON over the PTY into model + events.
 *
 * Pure logic; no Electron, no IPC, no filesystem.
 */
import { describe, it, expect } from 'vitest';
import { CursorStreamParser } from '../../src/main/agent/adapters/cursor/stream-parser';
import { EventType } from '../../src/shared/types';

// Documented example sequence from
// https://cursor.com/docs/cli/reference/output-format
const initLine = JSON.stringify({
  type: 'system',
  subtype: 'init',
  apiKeySource: 'login',
  cwd: '/Users/user/project',
  session_id: 'c6b62c6f-7ead-4fd6-9922-e952131177ff',
  model: 'Claude 4 Sonnet',
  permissionMode: 'default',
});
const toolStartLine = JSON.stringify({
  type: 'tool_call',
  subtype: 'started',
  call_id: 'toolu_vrtx_01NnjaR886UcE8whekg2MGJd',
  tool_call: { readToolCall: { args: { path: 'README.md' } } },
  session_id: 'c6b62c6f-7ead-4fd6-9922-e952131177ff',
});
const toolEndLine = JSON.stringify({
  type: 'tool_call',
  subtype: 'completed',
  call_id: 'toolu_vrtx_01NnjaR886UcE8whekg2MGJd',
  tool_call: {
    readToolCall: {
      args: { path: 'README.md' },
      result: { success: { content: '# Project', isEmpty: false, totalLines: 1, totalChars: 9 } },
    },
  },
  session_id: 'c6b62c6f-7ead-4fd6-9922-e952131177ff',
});
const resultLine = JSON.stringify({
  type: 'result',
  subtype: 'success',
  duration_ms: 5234,
  duration_api_ms: 5234,
  is_error: false,
  result: 'Done!',
  session_id: 'c6b62c6f-7ead-4fd6-9922-e952131177ff',
  request_id: '10e11780-df2f-45dc-a1ff-4540af32e9c0',
});

describe('CursorStreamParser', () => {
  it('extracts model from the init event', () => {
    const parser = new CursorStreamParser();
    const result = parser.parseTelemetry(`${initLine}\n`);
    expect(result?.usage?.model).toEqual({
      id: 'Claude 4 Sonnet',
      displayName: 'Claude 4 Sonnet',
    });
  });

  it('emits ToolStart and ToolEnd events with the bare tool name', () => {
    const parser = new CursorStreamParser();
    const result = parser.parseTelemetry(`${toolStartLine}\n${toolEndLine}\n`);
    expect(result?.events).toHaveLength(2);
    expect(result?.events?.[0]).toMatchObject({ type: EventType.ToolStart, tool: 'read' });
    expect(result?.events?.[1]).toMatchObject({ type: EventType.ToolEnd, tool: 'read' });
  });

  it('captures duration_ms from the terminal result event', () => {
    const parser = new CursorStreamParser();
    const result = parser.parseTelemetry(`${resultLine}\n`);
    expect(result?.usage?.cost?.totalDurationMs).toBe(5234);
  });

  it('returns null for chunks with no recognized telemetry', () => {
    const parser = new CursorStreamParser();
    const userLine = JSON.stringify({
      type: 'user',
      message: { role: 'user', content: [{ type: 'text', text: 'hi' }] },
      session_id: 'x',
    });
    expect(parser.parseTelemetry(`${userLine}\n`)).toBeNull();
  });

  it('skips malformed lines without throwing', () => {
    const parser = new CursorStreamParser();
    const garbage = '{this is not json}\n';
    const partial = '{"type":"system","subtype":"init"';
    const chunk = `${garbage}${partial}\n${initLine}\n`;
    const result = parser.parseTelemetry(chunk);
    expect(result?.usage?.model?.displayName).toBe('Claude 4 Sonnet');
  });

  it('reassembles the init event across a mid-line chunk boundary', () => {
    const parser = new CursorStreamParser();
    const cutPoint = 30; // splits inside "session_id" value
    const first = parser.parseTelemetry(initLine.slice(0, cutPoint));
    expect(first).toBeNull();
    const second = parser.parseTelemetry(`${initLine.slice(cutPoint)}\n`);
    expect(second?.usage?.model?.displayName).toBe('Claude 4 Sonnet');
  });

  it('caps the carry buffer when input has no newlines', () => {
    const parser = new CursorStreamParser();
    // Feed 32KB without a single newline - simulates a hostile or raw
    // TUI stream that would otherwise grow carry unbounded.
    const noNewlines = 'x'.repeat(32 * 1024);
    expect(parser.parseTelemetry(noNewlines)).toBeNull();
    // Now send a complete init line; the cap must not have eaten so
    // much that we can no longer recover when newlines arrive again.
    const result = parser.parseTelemetry(`\n${initLine}\n`);
    expect(result?.usage?.model?.displayName).toBe('Claude 4 Sonnet');
  });

  it('handles \\r\\n line endings (Windows ConPTY)', () => {
    const parser = new CursorStreamParser();
    const result = parser.parseTelemetry(`${initLine}\r\n${toolStartLine}\r\n`);
    expect(result?.usage?.model?.displayName).toBe('Claude 4 Sonnet');
    expect(result?.events).toHaveLength(1);
    expect(result?.events?.[0].type).toBe(EventType.ToolStart);
  });

  it('processes the documented full-session sequence end-to-end', () => {
    const parser = new CursorStreamParser();
    const stream = [initLine, toolStartLine, toolEndLine, resultLine].join('\n') + '\n';
    const result = parser.parseTelemetry(stream);
    expect(result?.usage?.model?.displayName).toBe('Claude 4 Sonnet');
    expect(result?.usage?.cost?.totalDurationMs).toBe(5234);
    expect(result?.events?.map((event) => event.type)).toEqual([
      EventType.ToolStart,
      EventType.ToolEnd,
    ]);
  });

  it('falls back to "tool" when the tool_call shape is unknown', () => {
    const parser = new CursorStreamParser();
    const odd = JSON.stringify({ type: 'tool_call', subtype: 'started', tool_call: null });
    const result = parser.parseTelemetry(`${odd}\n`);
    expect(result?.events?.[0].tool).toBe('tool');
  });
});
