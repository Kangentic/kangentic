/**
 * Unit tests for CursorStreamParser - parses Cursor's
 * `--output-format stream-json` NDJSON over the PTY into model + events.
 *
 * Pure logic; no Electron, no IPC, no filesystem.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { CursorStreamParser } from '../../src/main/agent/adapters/cursor/stream-parser';
import { resetCursorCapabilityCacheForTests } from '../../src/main/agent/adapters/cursor/capability-discovery';
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
  beforeEach(() => {
    resetCursorCapabilityCacheForTests();
  });

  it('extracts model from the init event', () => {
    const parser = new CursorStreamParser();
    const result = parser.parseTelemetry(`${initLine}\n`);
    // No `--list-models` catalog is cached in this file, so the display
    // name is kept as the id rather than inventing a lowercase slug.
    expect(result?.usage?.model).toEqual({
      id: 'Claude 4 Sonnet',
      displayName: 'Claude 4 Sonnet',
      reportedByAgent: true,
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

  it('parses init line prefixed with real-world ConPTY init escapes', () => {
    // Captured from scripts/verify-copilot-cursor-stall.js -> cursor-bypass-ptyout.log
    // on Windows, 2026-04-15. Cursor's first chunk under a ConPTY is:
    //   `\x1b[?9001h\x1b[?1004h\x1b[?25l\x1b[2J\x1b[m\x1b[H{"type":"system",...}\n`
    // Without ANSI-tolerant parsing, JSON.parse rejects this line and the
    // init event is silently dropped -> ContextBar stays on the spinner.
    const parser = new CursorStreamParser();
    const prefixedInit =
      '\x1b[?9001h\x1b[?1004h\x1b[?25l\x1b[2J\x1b[m\x1b[H' + initLine + '\n';
    const result = parser.parseTelemetry(prefixedInit);
    expect(result?.usage?.model?.displayName).toBe('Claude 4 Sonnet');
  });

  it('skips interleaved OSC title updates between JSON events', () => {
    // On Windows, Cursor writes `\x1b]0;C:\\WINDOWS\\system32\\cmd.exe\x07`
    // title-change sequences between JSON lines. The parser must tolerate
    // those prefixes on later lines too, not just the first one.
    const parser = new CursorStreamParser();
    const interleaved =
      initLine + '\n' +
      '\x1b]0;C:\\WINDOWS\\system32\\cmd.exe\x07' + toolStartLine + '\n';
    const result = parser.parseTelemetry(interleaved);
    expect(result?.usage?.model?.displayName).toBe('Claude 4 Sonnet');
    expect(result?.events).toHaveLength(1);
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

  it('reads occupancy and the live model from the interactive TUI status bar', () => {
    const parser = new CursorStreamParser();
    const result = parser.parseTelemetry('Composer 2.5 · 7.8%\n');
    expect(result?.usage?.contextWindow?.usedPercentage).toBe(7.8);
    expect(result?.usage?.model).toEqual({
      id: 'Composer 2.5',
      displayName: 'Composer 2.5',
      reportedByAgent: true,
    });
  });

  it('reads occupancy and model through ANSI wrapping and extra status segments', () => {
    const parser = new CursorStreamParser();
    const framed =
      '\x1b[6;1H\x1b[2mAuto\x1b[0m \u00b7 8.3% \u00b7 1 file edited\x1b[?25l';
    const result = parser.parseTelemetry(framed);
    expect(result?.usage?.contextWindow?.usedPercentage).toBe(8.3);
    expect(result?.usage?.model).toEqual({
      id: 'Auto',
      displayName: 'Auto',
      reportedByAgent: true,
    });
  });

  it('keeps the model name after trailing punctuation on the same line', () => {
    const parser = new CursorStreamParser();
    const result = parser.parseTelemetry('done. Composer 2.5 · 7.8%\n');
    expect(result?.usage?.model?.displayName).toBe('Composer 2.5');
  });

  it('does not treat a tool duration or a hidden-output hint as occupancy', () => {
    const parser = new CursorStreamParser();
    expect(parser.parseTelemetry('\x1b[2m7.8s\x1b[22m\n')).toBeNull();
    expect(parser.parseTelemetry('12 output lines hidden · ctrl+o to expand\n')).toBeNull();
    expect(parser.parseTelemetry('Claude 4 Sonnet · ready\x1b[?25l')).toBeNull();
  });

  it('skips identical TUI redraws and emits again when the percent changes', () => {
    const parser = new CursorStreamParser();
    const first = parser.parseTelemetry('Composer 2.5 · 7.8%\n');
    expect(first?.usage?.contextWindow?.usedPercentage).toBe(7.8);
    expect(parser.parseTelemetry('Composer 2.5 · 7.8%\n')).toBeNull();
    const next = parser.parseTelemetry('Composer 2.5 · 9.1%\n');
    expect(next?.usage?.contextWindow?.usedPercentage).toBe(9.1);
    expect(next?.usage?.model?.displayName).toBe('Composer 2.5');
  });

  it('emits again when the TUI model changes at the same percent', () => {
    const parser = new CursorStreamParser();
    const first = parser.parseTelemetry('Composer 2.5 · 7.8%\n');
    expect(first?.usage?.model?.displayName).toBe('Composer 2.5');
    const switched = parser.parseTelemetry('Auto · 7.8%\n');
    expect(switched?.usage?.model?.displayName).toBe('Auto');
    expect(switched?.usage?.contextWindow?.usedPercentage).toBe(7.8);
  });

  it('reassembles occupancy split across a ConPTY flush', () => {
    const parser = new CursorStreamParser();
    expect(parser.parseTelemetry('Composer 2.5 · 7.')).toBeNull();
    const second = parser.parseTelemetry('8%\n');
    expect(second?.usage?.contextWindow?.usedPercentage).toBe(7.8);
    expect(second?.usage?.model?.displayName).toBe('Composer 2.5');
  });
});
