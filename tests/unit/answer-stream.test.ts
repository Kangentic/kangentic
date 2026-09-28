/**
 * The answer stream: what reaches the screen while an answer is in flight.
 *
 * Three pure pieces, and each must DEGRADE rather than throw. A stream that
 * drops an event shows the user slightly less progress; a stream that throws
 * on one costs the whole answer. And the settled answer must be the LAST
 * turn's text: a tool-calling answer narrates its own search first ("Let me
 * look that up"), the live stream shows that as progress, and repeating it
 * under the real answer is the bug the extractor guards against.
 *
 * The one deliberate throw: a run the CLI itself reports as FAILED
 * (`is_error: true` on its result line). That is not a stream to degrade, it is
 * an error message, and returned as text it read as the agent's reply.
 */

import { describe, it, expect } from 'vitest';
import {
  parseAnswerStreamLine,
  extractStreamedAnswer,
  extractLastTurnAnswer,
  createAnswerStreamReducer,
} from '../../src/main/agent/shared/auto-name';

/** One `assistant` line of stream-json, as the CLI emits it. */
function assistantLine(content: unknown[]): string {
  return JSON.stringify({ type: 'assistant', message: { content } });
}

/** One partial-message line, as `--include-partial-messages` emits it. */
function streamEventLine(event: Record<string, unknown>): string {
  return JSON.stringify({ type: 'stream_event', event, session_id: 's', parent_tool_use_id: null });
}

const textDelta = (text: string) => streamEventLine({
  type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text },
});

describe('parseAnswerStreamLine', () => {
  it('yields the text the assistant wrote', () => {
    expect(parseAnswerStreamLine(assistantLine([{ type: 'text', text: 'The sphere ' }])))
      .toEqual([{ kind: 'text', text: 'The sphere ' }]);
  });

  it('yields a tool call by name, so the rail can say it is searching', () => {
    expect(parseAnswerStreamLine(assistantLine([
      { type: 'tool_use', id: 'toolu_1', name: 'mcp__kangentic__kangentic_search', input: { query: 'sphere fit' } },
    ]))).toEqual([{ kind: 'tool', name: 'mcp__kangentic__kangentic_search' }]);
  });

  it('yields every block of a mixed turn, in order', () => {
    expect(parseAnswerStreamLine(assistantLine([
      { type: 'text', text: 'Let me check.' },
      { type: 'tool_use', name: 'mcp__kangentic__kangentic_search', input: {} },
    ]))).toEqual([
      { kind: 'text', text: 'Let me check.' },
      { kind: 'tool', name: 'mcp__kangentic__kangentic_search' },
    ]);
  });

  it('degrades to nothing on a line it cannot read', () => {
    // A chunk boundary can split a line, and a CLI update can change a shape.
    // Neither is allowed to cost the answer.
    expect(parseAnswerStreamLine('{"type":"assistant","message":{"content":[{"type":"te')).toEqual([]);
    expect(parseAnswerStreamLine('')).toEqual([]);
    expect(parseAnswerStreamLine('not json at all')).toEqual([]);
    expect(parseAnswerStreamLine('{"type":"assistant","message":"a string, not an object"}')).toEqual([]);
    expect(parseAnswerStreamLine('{"type":"assistant","message":{"content":"not an array"}}')).toEqual([]);
  });

  it('ignores every line that is not an assistant turn', () => {
    expect(parseAnswerStreamLine(JSON.stringify({ type: 'system', subtype: 'init', tools: [] }))).toEqual([]);
    expect(parseAnswerStreamLine(JSON.stringify({ type: 'result', result: 'Done.' }))).toEqual([]);
    expect(parseAnswerStreamLine(JSON.stringify({
      type: 'user', message: { content: [{ type: 'tool_result', content: 'hits' }] },
    }))).toEqual([]);
  });

  it('skips an empty text block rather than emitting an empty delta', () => {
    expect(parseAnswerStreamLine(assistantLine([{ type: 'text', text: '' }]))).toEqual([]);
  });

  it('yields a text delta from a partial message, as the model writes it', () => {
    // Captured from the CLI: "hello world" arrived as "h" then "ello world".
    expect(parseAnswerStreamLine(textDelta('h'))).toEqual([{ kind: 'text', text: 'h' }]);
    expect(parseAnswerStreamLine(textDelta('ello world'))).toEqual([{ kind: 'text', text: 'ello world' }]);
  });

  it('yields a tool call the moment its block opens', () => {
    expect(parseAnswerStreamLine(streamEventLine({
      type: 'content_block_start',
      index: 1,
      content_block: { type: 'tool_use', id: 'toolu_1', name: 'mcp__kangentic__kangentic_search', input: {} },
    }))).toEqual([{ kind: 'tool', name: 'mcp__kangentic__kangentic_search' }]);
  });

  it('yields nothing for the partial-message machinery around the deltas', () => {
    expect(parseAnswerStreamLine(streamEventLine({ type: 'message_start', message: { content: [] } }))).toEqual([]);
    expect(parseAnswerStreamLine(streamEventLine({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }))).toEqual([]);
    expect(parseAnswerStreamLine(streamEventLine({ type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"q' } }))).toEqual([]);
    expect(parseAnswerStreamLine(streamEventLine({ type: 'content_block_stop', index: 0 }))).toEqual([]);
    expect(parseAnswerStreamLine(streamEventLine({ type: 'message_delta', delta: { stop_reason: 'end_turn' } }))).toEqual([]);
    expect(parseAnswerStreamLine(streamEventLine({ type: 'message_stop' }))).toEqual([]);
    expect(parseAnswerStreamLine('{"type":"stream_event","event":"not an object"}')).toEqual([]);
  });
});

describe('createAnswerStreamReducer', () => {
  it('drops the complete turn once its deltas have been shown', () => {
    // The CLI emits each turn twice with partials on. Forwarding both would
    // show "hello world" and then "hello world" again.
    const reduce = createAnswerStreamReducer();
    const events = [
      streamEventLine({ type: 'message_start', message: { content: [] } }),
      textDelta('hello '),
      textDelta('world'),
      assistantLine([{ type: 'text', text: 'hello world' }]),
      streamEventLine({ type: 'message_stop' }),
    ].flatMap((line) => reduce(line));
    expect(events).toEqual([{ kind: 'text', text: 'hello ' }, { kind: 'text', text: 'world' }]);
  });

  it('drops a tool turn\'s complete line too, since the block start already named it', () => {
    const reduce = createAnswerStreamReducer();
    const events = [
      streamEventLine({ type: 'content_block_start', index: 0, content_block: { type: 'tool_use', name: 'mcp__kangentic__kangentic_search' } }),
      assistantLine([{ type: 'tool_use', name: 'mcp__kangentic__kangentic_search' }]),
    ].flatMap((line) => reduce(line));
    expect(events).toEqual([{ kind: 'tool', name: 'mcp__kangentic__kangentic_search' }]);
  });

  it('passes complete turns through when no partial ever arrived', () => {
    // An older CLI, or a caller that did not ask for partials: the assistant
    // lines are the only stream there is.
    const reduce = createAnswerStreamReducer();
    const events = [
      assistantLine([{ type: 'text', text: 'Let me search.' }]),
      assistantLine([{ type: 'text', text: 'The answer.' }]),
    ].flatMap((line) => reduce(line));
    expect(events).toEqual([{ kind: 'text', text: 'Let me search.' }, { kind: 'text', text: 'The answer.' }]);
  });
});

describe('extractStreamedAnswer', () => {
  const searchNarration = assistantLine([{ type: 'text', text: 'Let me search for that.' }]);
  const searchCall = assistantLine([{ type: 'tool_use', name: 'mcp__kangentic__kangentic_search', input: {} }]);
  const finalTurn = assistantLine([{ type: 'text', text: 'The sphere fit circumscribes.' }]);

  it('returns the result line when the CLI wrote one', () => {
    const stdout = [searchNarration, finalTurn, JSON.stringify({ type: 'result', result: 'Final, as the CLI settled it.' })].join('\n');
    expect(extractStreamedAnswer(stdout)).toBe('Final, as the CLI settled it.');
  });

  it("returns the LAST turn's text, not the search narration, when the result line carries none", () => {
    const stdout = [searchNarration, searchCall, finalTurn, JSON.stringify({ type: 'result', subtype: 'success' })].join('\n');
    expect(extractStreamedAnswer(stdout)).toBe('The sphere fit circumscribes.');
  });

  it('joins every turn when the stream was cut before a result line', () => {
    // An output-budget cut lands mid-stream, and the partial answer is still
    // worth more than nothing.
    const stdout = [searchNarration, searchCall, finalTurn].join('\n');
    // On their own lines: run together the narration read as one sentence.
    expect(extractStreamedAnswer(stdout)).toBe('Let me search for that.\nThe sphere fit circumscribes.');
  });

  it('tolerates CRLF, blank lines, and noise between the lines', () => {
    const stdout = ['', searchNarration, 'stray stderr-ish text', finalTurn, '', JSON.stringify({ type: 'result', result: 'Final.' }), ''].join('\r\n');
    expect(extractStreamedAnswer(stdout)).toBe('Final.');
  });

  it('returns nothing for an empty stream', () => {
    expect(extractStreamedAnswer('')).toBe('');
  });

  it('throws the CLI\'s own message when it reports the run as failed', () => {
    // Captured shape from an unknown model: the run ends on a result line with
    // `is_error: true` whose text is the error. Returned, it read as the agent's
    // reply, "Run --model to pick a different model" and all; thrown, the chat
    // shows its failed turn with this message as the reason and Try again.
    const failedRun = [
      JSON.stringify({ type: 'system', subtype: 'init' }),
      JSON.stringify({
        type: 'result', subtype: 'success', is_error: true,
        result: 'There\'s an issue with the selected model (claude-no-such-model-9).',
      }),
    ].join('\n');
    expect(() => extractStreamedAnswer(failedRun)).toThrow(/issue with the selected model/);
    expect(() => extractLastTurnAnswer(failedRun)).toThrow(/issue with the selected model/);
  });

  it('still fails, with a generic message, when a failed result carries no text', () => {
    const failedRun = JSON.stringify({ type: 'result', subtype: 'error_during_execution', is_error: true });
    expect(() => extractStreamedAnswer(failedRun)).toThrow('the agent reported an error');
  });

  it('treats is_error: false as an ordinary answer', () => {
    const stdout = JSON.stringify({ type: 'result', is_error: false, result: 'Fine.' });
    expect(extractStreamedAnswer(stdout)).toBe('Fine.');
  });

  it('reads complete turns only, never the deltas that spelled them', () => {
    // With partials on, every turn is on the wire twice. Counting the deltas
    // would double the fallback text and make the last "turn" a fragment.
    const stdout = [
      textDelta('The sphere '),
      textDelta('fit circumscribes.'),
      finalTurn,
    ].join('\n');
    expect(extractStreamedAnswer(stdout)).toBe('The sphere fit circumscribes.');
  });
});
