/**
 * OpenCode 2 `session_message` records mapped to transcript entries: the REAL rows
 * captured from OpenCode 2.2.5 (sanitized), plus the shapes the capture lacks.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {
  openCodeV2CreatedMs,
  openCodeV2RowEntries,
  type OpenCodeV2MessageRow,
} from '../../src/main/agent/adapters/opencode/v2-messages';
import { mapOpenCodeRemoteEntries } from '../../src/main/agent/adapters/opencode/transcript-parser';

interface CapturedRow extends OpenCodeV2MessageRow {
  session_id: string;
  seq: number;
}

const capturedRows = JSON.parse(
  fs.readFileSync(path.join(__dirname, '..', 'fixtures', 'opencode-v2-session-message-rows.json'), 'utf-8'),
) as CapturedRow[];

function rowsOf(sessionId: string): CapturedRow[] {
  return capturedRows
    .filter((row) => row.session_id === sessionId)
    .sort((left, right) => left.seq - right.seq);
}

function rowOf(id: string, type: string, data: unknown): OpenCodeV2MessageRow {
  return { id, type, time_created: 1000, data: typeof data === 'string' ? data : JSON.stringify(data) };
}

describe('replaying captured OpenCode 2.2.5 rows', () => {
  it('keeps the user and assistant messages in order and skips agent-switched, synthetic and idle rows', () => {
    const entries = mapOpenCodeRemoteEntries(openCodeV2RowEntries(rowsOf('ses_e60032c8bfferWu10UkhIFtoX4')));
    expect(entries.map((entry) => entry.kind)).toEqual(['user', 'assistant', 'tool_result', 'assistant']);
    expect(entries[0]).toMatchObject({ kind: 'user', text: 'SHELLTEST v2 plugin' });
    expect(entries[3]).toMatchObject({
      kind: 'assistant',
      model: 'stub-model',
      blocks: [{ type: 'text', text: 'TOOL RESULT: (no output)' }],
    });

    const withSyntheticSession = mapOpenCodeRemoteEntries(openCodeV2RowEntries(rowsOf('ses_e600b00a9ffe66juGOEwP8ldrY')));
    expect(withSyntheticSession.map((entry) => entry.kind)).toEqual(['user', 'assistant', 'tool_result', 'assistant']);
    expect(withSyntheticSession.some((entry) => entry.kind === 'user' && entry.text.includes('system-reminder'))).toBe(false);
  });

  it('gives the shell tool its content text as the result, not an error', () => {
    const entries = mapOpenCodeRemoteEntries(openCodeV2RowEntries(rowsOf('ses_e60032c8bfferWu10UkhIFtoX4')));
    const assistant = entries[1];
    if (assistant.kind !== 'assistant') throw new Error('expected an assistant entry');
    expect(assistant.model).toBe('stub-model');
    expect(assistant.blocks).toMatchObject([{ type: 'tool_use', id: 'call_shell_1', name: 'shell' }]);
    expect(entries[2]).toMatchObject({ kind: 'tool_result', toolUseId: 'call_shell_1', content: '(no output)', isError: false });
  });

  it('turns a rejected read tool into an error result carrying the error message', () => {
    const entries = mapOpenCodeRemoteEntries(openCodeV2RowEntries(rowsOf('ses_e60042ee8ffeAy5Cq2RJH2s4gd')));
    expect(entries.map((entry) => entry.kind)).toEqual(['user', 'assistant', 'tool_result', 'assistant']);
    const result = entries[2];
    if (result.kind !== 'tool_result') throw new Error('expected a tool_result entry');
    expect(result.isError).toBe(true);
    expect(result.content.startsWith('This non-interactive run cannot ask the user for permission')).toBe(true);
  });
});

describe('hand-built OpenCode 2 records', () => {
  it('maps a reasoning block to a thinking block of the assistant entry', () => {
    const entries = mapOpenCodeRemoteEntries(openCodeV2RowEntries([
      rowOf('msg_a', 'assistant', {
        time: { created: 5 },
        model: { id: 'stub-model' },
        content: [{ type: 'reasoning', text: 'Weigh the options.' }, { type: 'text', text: 'Done.' }],
      }),
    ]));
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      kind: 'assistant',
      blocks: [{ type: 'thinking', text: 'Weigh the options.' }, { type: 'text', text: 'Done.' }],
    });
  });

  it('puts an assistant record\'s tokens on its entry as per-turn usage, and none when it has no tokens', () => {
    const entries = mapOpenCodeRemoteEntries(openCodeV2RowEntries([
      rowOf('msg_t1', 'assistant', {
        time: { created: 5 },
        content: [{ type: 'text', text: 'Answer.' }],
        tokens: { input: 100, output: 20, reasoning: 5, total: 1135, cache: { read: 1000, write: 10 } },
      }),
      rowOf('msg_t2', 'assistant', { time: { created: 6 }, content: [{ type: 'text', text: 'No usage.' }] }),
    ]));
    const usages = entries.map((entry) => (entry.kind === 'assistant' ? entry.usage : 'not assistant'));
    expect(usages).toEqual([
      { inputTokens: 100, outputTokens: 25, cacheCreationInputTokens: 10, cacheReadInputTokens: 1000 },
      undefined,
    ]);
  });

  it('joins two text content blocks of a tool result with a newline', () => {
    const entries = mapOpenCodeRemoteEntries(openCodeV2RowEntries([
      rowOf('msg_b', 'assistant', {
        content: [{
          type: 'tool',
          id: 'call_two',
          name: 'shell',
          state: { status: 'completed', input: {}, content: [{ type: 'text', text: 'first' }, { type: 'text', text: 'second' }] },
        }],
      }),
    ]));
    expect(entries.find((entry) => entry.kind === 'tool_result')).toMatchObject({ content: 'first\nsecond', isError: false });
  });

  it('skips a row whose data is not JSON and keeps its neighbours', () => {
    const entries = mapOpenCodeRemoteEntries(openCodeV2RowEntries([
      rowOf('msg_c', 'user', { text: 'before' }),
      rowOf('msg_d', 'user', 'this is not json {'),
      rowOf('msg_e', 'user', { text: 'after' }),
    ]));
    expect(entries.map((entry) => entry.uuid)).toEqual(['msg_c', 'msg_e']);
  });

  it('takes the record creation time, and the fallback when time.created is missing', () => {
    expect(openCodeV2CreatedMs({ time: { created: 42 } }, 7)).toBe(42);
    expect(openCodeV2CreatedMs({ time: {} }, 7)).toBe(7);
    expect(openCodeV2CreatedMs({}, 7)).toBe(7);
    expect(openCodeV2CreatedMs({ time: { created: '42' } }, 7)).toBe(7);
  });
});
