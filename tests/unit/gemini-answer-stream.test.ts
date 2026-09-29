/**
 * Gemini CLI's stream-json, read for a Knowledge Graph answer. The lines are the
 * shapes captured from gemini 0.61.0 on 2026-09-28.
 */

import { describe, it, expect } from 'vitest';
import { extractGeminiAnswer, geminiAnswerEvents } from '../../src/main/agent/adapters/gemini/answer-stream';

const line = (record: Record<string, unknown>): string => JSON.stringify(record);

const INIT = line({ type: 'init', session_id: 'b19dead8-e02c-48c9-b7df-ab38685ea826', model: 'gemini-3-flash-preview' });
const USER = line({ type: 'message', role: 'user', content: 'Count from one to five.' });
const RESULT = line({ type: 'result', status: 'success', stats: { total_tokens: 9873 } });

describe('Gemini answer stream', () => {
  it('turns assistant deltas into text and a tool call into a tool event, and nothing else', () => {
    expect(geminiAnswerEvents(INIT)).toEqual([]);
    expect(geminiAnswerEvents(USER)).toEqual([]);
    expect(geminiAnswerEvents(line({ type: 'message', role: 'assistant', content: 'One\nTwo', delta: true })))
      .toEqual([{ kind: 'text', text: 'One\nTwo' }]);
    expect(geminiAnswerEvents(line({ type: 'tool_use', tool_name: 'read_file', tool_id: 'read_file__call_1', parameters: {} })))
      .toEqual([{ kind: 'tool', name: 'read_file' }]);
    expect(geminiAnswerEvents(RESULT)).toEqual([]);
    expect(geminiAnswerEvents('not json')).toEqual([]);
  });

  it('answers with the text after the last tool call, not the narration before it', () => {
    const stdout = [
      INIT,
      USER,
      line({ type: 'message', role: 'assistant', content: 'I will look first.\n', delta: true }),
      line({ type: 'tool_use', tool_name: 'read_file', tool_id: 'call-1', parameters: {} }),
      line({ type: 'tool_result', tool_id: 'call-1', status: 'success', output: '' }),
      line({ type: 'message', role: 'assistant', content: 'Five tasks ', delta: true }),
      line({ type: 'message', role: 'assistant', content: 'did that.', delta: true }),
      RESULT,
    ].join('\n');
    expect(extractGeminiAnswer(stdout)).toBe('Five tasks did that.');
  });

  it('shows the CLI\'s own error when the run failed with no answer', () => {
    const stdout = [INIT, USER, line({ type: 'result', status: 'error', error: { type: 'FatalError', message: 'quota exhausted' } })].join('\n');
    expect(() => extractGeminiAnswer(stdout)).toThrow('quota exhausted');
  });
});
