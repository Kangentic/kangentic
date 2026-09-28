/**
 * Cursor's stream-json answer, from lines captured on cursor-agent 2026.09.23
 * with `--stream-partial-output` (trimmed to the fields read). The partial
 * lines are assistant lines carrying `timestamp_ms`; the one complete line at
 * the end is the final turn alone; the result line fuses every turn.
 */

import { describe, it, expect } from 'vitest';
import {
  createCursorAnswerReducer,
  cursorInitSessionId,
  extractCursorAnswer,
} from '../../src/main/agent/adapters/cursor/answer-stream';

const delta = (text: string) => ({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text }] }, session_id: 's', timestamp_ms: 1790572139706 });

const CAPTURED = [
  { type: 'system', subtype: 'init', session_id: '0be67127-e43c-49ca-959b-5ec0742ab328', model: 'Auto' },
  { type: 'thinking', subtype: 'delta', text: 'Running a hybrid search' },
  delta('I\'ll look up'),
  delta(' the tool.'),
  { type: 'tool_call', subtype: 'started', tool_call: { mcpToolCall: { args: { name: 'kangentic-kangentic_search', toolName: 'kangentic_search', args: { query: 'relay' } } } } },
  { type: 'tool_call', subtype: 'completed', tool_call: { mcpToolCall: { result: { success: {} } } } },
  delta('Hybrid search returned'),
  delta(' 13 hits.\n\nSELECTED: none'),
  { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'Hybrid search returned 13 hits.\n\nSELECTED: none' }] }, session_id: 's' },
  { type: 'result', subtype: 'success', is_error: false, result: 'I\'ll look up the tool.Hybrid search returned 13 hits.\n\nSELECTED: none' },
].map((record) => JSON.stringify(record));

describe('createCursorAnswerReducer', () => {
  it('streams the partial lines and the tool call, never the thinking or the repeated final turn', () => {
    const reduce = createCursorAnswerReducer();
    expect(CAPTURED.flatMap((line) => reduce(line))).toEqual([
      { kind: 'text', text: 'I\'ll look up' },
      { kind: 'text', text: ' the tool.' },
      { kind: 'tool', name: 'kangentic_search' },
      { kind: 'text', text: 'Hybrid search returned' },
      { kind: 'text', text: ' 13 hits.\n\nSELECTED: none' },
    ]);
  });
});

describe('extractCursorAnswer', () => {
  it('returns the final turn alone, not the result line that fuses the narration onto it', () => {
    expect(extractCursorAnswer(CAPTURED.join('\n'))).toBe('Hybrid search returned 13 hits.\n\nSELECTED: none');
  });

  it('falls back to the text written after the last tool call when the stream was cut', () => {
    const cut = CAPTURED.slice(0, 8).join('\n');
    expect(extractCursorAnswer(cut)).toBe('Hybrid search returned 13 hits.\n\nSELECTED: none');
  });

  it('throws the CLI\'s message for a failed run', () => {
    const failed = JSON.stringify({ type: 'result', subtype: 'error', is_error: true, result: 'Rate limit reached' });
    expect(() => extractCursorAnswer(failed)).toThrow('Rate limit reached');
  });
});

describe('cursorInitSessionId', () => {
  it('reads the chat id off the init line only', () => {
    expect(cursorInitSessionId(CAPTURED[0])).toBe('0be67127-e43c-49ca-959b-5ec0742ab328');
    expect(cursorInitSessionId(CAPTURED[2])).toBeNull();
  });
});
