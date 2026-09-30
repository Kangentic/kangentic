/**
 * Copilot's JSONL answer stream, from lines captured on CLI 1.0.88 (trimmed to
 * the fields read). A tool-calling answer: a first turn whose message has no
 * content and one tool request, the tool's execution, then the final answer
 * streamed as deltas and repeated whole.
 */

import { describe, it, expect } from 'vitest';
import { createCopilotAnswerReducer, extractCopilotAnswer } from '../../src/main/agent/adapters/copilot/answer-stream';

const CAPTURED = [
  { type: 'session.mcp_servers_loaded', data: { servers: [{ name: 'kangentic', status: 'connected' }] } },
  { type: 'assistant.message', data: { messageId: 'm1', content: '', toolRequests: [{ name: 'kangentic-kangentic_search' }] } },
  { type: 'tool.execution_start', data: { toolName: 'kangentic-kangentic_search', mcpToolName: 'kangentic_search', arguments: { query: 'relay' } } },
  { type: 'tool.execution_complete', data: { success: true, result: { content: 'Found 13 hit(s)' } } },
  { type: 'assistant.reasoning_delta', data: { deltaContent: 'Thinking about it' } },
  { type: 'assistant.message_start', data: { messageId: 'm2', phase: 'final_answer' } },
  { type: 'assistant.message_delta', data: { messageId: 'm2', deltaContent: 'It found ' } },
  { type: 'assistant.message_delta', data: { messageId: 'm2', deltaContent: 'a half-open socket.' } },
  { type: 'assistant.message', data: { messageId: 'm2', content: 'It found a half-open socket.\nSELECTED: none', phase: 'final_answer' } },
  { type: 'result', sessionId: 'session-1', exitCode: 0, usage: { premiumRequests: 1 } },
].map((record) => JSON.stringify(record));

describe('createCopilotAnswerReducer', () => {
  it('streams the deltas and the tool call, and never shows a streamed message twice or the reasoning', () => {
    const reduce = createCopilotAnswerReducer();
    expect(CAPTURED.flatMap((line) => reduce(line))).toEqual([
      { kind: 'tool', name: 'kangentic_search' },
      { kind: 'text', text: 'It found ' },
      { kind: 'text', text: 'a half-open socket.' },
    ]);
  });

  it('shows a whole message when the run did not stream it', () => {
    const reduce = createCopilotAnswerReducer();
    const unstreamed = JSON.stringify({ type: 'assistant.message', data: { messageId: 'm9', content: 'Whole answer.' } });
    expect(reduce(unstreamed)).toEqual([{ kind: 'text', text: 'Whole answer.' }]);
  });
});

describe('extractCopilotAnswer', () => {
  it('returns the last message with content', () => {
    expect(extractCopilotAnswer(CAPTURED.join('\n'))).toBe('It found a half-open socket.\nSELECTED: none');
  });

  it('throws the CLI\'s error, or its exit code, when the run failed without an answer', () => {
    const errored = [
      JSON.stringify({ type: 'session.error', data: { message: 'Quota exceeded for premium requests' } }),
      JSON.stringify({ type: 'result', exitCode: 1 }),
    ].join('\n');
    expect(() => extractCopilotAnswer(errored)).toThrow('Quota exceeded for premium requests');
    expect(() => extractCopilotAnswer(JSON.stringify({ type: 'result', exitCode: 2 }))).toThrow('the agent exited 2');
  });

  it('returns nothing, for the runner to report, when a clean run wrote no answer', () => {
    expect(extractCopilotAnswer(JSON.stringify({ type: 'result', exitCode: 0 }))).toBe('');
  });

  it('fails a run that exited non-zero after an answer, rather than passing a partial answer off as whole', () => {
    const exitedAfterAnswer = [
      ...CAPTURED.slice(0, -1),
      JSON.stringify({ type: 'session.error', data: { message: 'Connection reset mid-reply' } }),
      JSON.stringify({ type: 'result', sessionId: 'session-1', exitCode: 1 }),
    ].join('\n');
    expect(() => extractCopilotAnswer(exitedAfterAnswer)).toThrow('Connection reset mid-reply');
  });

  it('keeps the answer of a run that exited 0 after a failed tool call it recovered from', () => {
    const recovered = [
      ...CAPTURED.slice(0, 3),
      JSON.stringify({ type: 'tool.execution_error', data: { message: 'search timed out' } }),
      ...CAPTURED.slice(3),
    ].join('\n');
    expect(extractCopilotAnswer(recovered)).toBe('It found a half-open socket.\nSELECTED: none');
  });
});
