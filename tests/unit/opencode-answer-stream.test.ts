/**
 * OpenCode's `run --format json` answer, from events captured on opencode
 * 1.18.31 (trimmed to the fields read): a narration step that calls the
 * search, then the answer step.
 */

import { describe, it, expect } from 'vitest';
import {
  extractOpenCodeAnswer,
  openCodeAnswerEvents,
  openCodeSessionId,
} from '../../src/main/agent/adapters/opencode/answer-stream';

const SESSION = 'ses_f19901e1fffekSE4Do8fuQuTEb';
const CAPTURED = [
  { type: 'step_start', sessionID: SESSION, part: { type: 'step-start' } },
  { type: 'text', sessionID: SESSION, part: { type: 'text', text: 'I\'ll run the search now.' } },
  { type: 'tool_use', sessionID: SESSION, part: { type: 'tool', tool: 'kangentic_kangentic_search', state: { status: 'completed', output: 'Found 12 hit(s)' } } },
  { type: 'step_finish', sessionID: SESSION, part: { type: 'step-finish', reason: 'tool-calls' } },
  { type: 'step_start', sessionID: SESSION, part: { type: 'step-start' } },
  { type: 'text', sessionID: SESSION, part: { type: 'text', text: 'The search found 12 conversation hits.\n\nSELECTED: none' } },
  { type: 'step_finish', sessionID: SESSION, part: { type: 'step-finish', reason: 'stop' } },
].map((record) => JSON.stringify(record));

describe('openCodeAnswerEvents', () => {
  it('passes each text part and each tool use as it lands', () => {
    expect(CAPTURED.flatMap(openCodeAnswerEvents)).toEqual([
      { kind: 'text', text: 'I\'ll run the search now.' },
      { kind: 'tool', name: 'kangentic_kangentic_search' },
      { kind: 'text', text: 'The search found 12 conversation hits.\n\nSELECTED: none' },
    ]);
  });
});

describe('extractOpenCodeAnswer', () => {
  it('returns the text written after the last tool use, without the narration', () => {
    expect(extractOpenCodeAnswer(CAPTURED.join('\n'))).toBe('The search found 12 conversation hits.\n\nSELECTED: none');
  });

  it('returns every text part of a run that searched nothing', () => {
    const plain = [CAPTURED[1], CAPTURED[5]].join('\n');
    expect(extractOpenCodeAnswer(plain)).toBe('I\'ll run the search now.\nThe search found 12 conversation hits.\n\nSELECTED: none');
  });

  it('throws the CLI\'s error when a run failed without an answer', () => {
    const failed = JSON.stringify({ type: 'error', sessionID: SESSION, error: { name: 'APIError', data: { message: 'Model not found' } } });
    expect(() => extractOpenCodeAnswer(failed)).toThrow('Model not found');
  });

  const sessionError = JSON.stringify({ type: 'error', sessionID: SESSION, error: { name: 'APIError', data: { message: 'Rate limited' } } });

  it('fails a run that ended on an error after part of an answer, rather than passing the part off as whole', () => {
    const partial = [CAPTURED[0], CAPTURED[1], sessionError].join('\n');
    expect(() => extractOpenCodeAnswer(partial)).toThrow('Rate limited');
  });

  it('answers when text came after the error, which the run recovered from', () => {
    const recovered = [sessionError, ...CAPTURED].join('\n');
    expect(extractOpenCodeAnswer(recovered)).toBe('The search found 12 conversation hits.\n\nSELECTED: none');
  });
});

describe('openCodeSessionId', () => {
  it('reads the session id any event carries', () => {
    expect(openCodeSessionId(CAPTURED[0])).toBe(SESSION);
    expect(openCodeSessionId('not json')).toBeNull();
  });
});
