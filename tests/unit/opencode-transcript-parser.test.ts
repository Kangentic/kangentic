/**
 * Unit test for the OpenCode SQLite transcript parser.
 *
 * The SQLite I/O (`parseOpenCodeTranscriptAtPath`) reads rows through
 * better-sqlite3. The row-to-entry mapping is extracted into the pure
 * `mapOpenCodeRows`, which this test exercises directly with the verified
 * `message` / `part` row shapes, so no database is needed. The `tool` part
 * shape is schema-derived (no real tool parts were available locally).
 */
import { describe, it, expect } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import {
  mapOpenCodeRows,
  parseOpenCodeTranscriptAtPath,
  type OpenCodeMessageRow,
  type OpenCodePartRow,
} from '../../src/main/agent/adapters/opencode/transcript-parser';

function messageRow(id: string, timeCreated: number, data: object): OpenCodeMessageRow {
  return { id, time_created: timeCreated, data: JSON.stringify(data) };
}
function partRow(messageId: string, data: object): OpenCodePartRow {
  return { message_id: messageId, data: JSON.stringify(data) };
}

describe('mapOpenCodeRows', () => {
  it('maps user text, assistant reasoning/text/tool, and a paired tool_result', () => {
    const messages: OpenCodeMessageRow[] = [
      messageRow('m_user', 1000, { role: 'user' }),
      messageRow('m_asst', 2000, { role: 'assistant', modelID: 'big-pickle' }),
    ];
    const parts: OpenCodePartRow[] = [
      partRow('m_user', { type: 'text', text: 'List the files.' }),
      partRow('m_asst', { type: 'step-start' }),
      partRow('m_asst', { type: 'reasoning', text: 'I should list files.' }),
      partRow('m_asst', { type: 'text', text: 'Here are the files.' }),
      partRow('m_asst', { type: 'tool', callID: 'call_1', tool: 'bash', state: { status: 'completed', input: { command: 'ls' }, output: 'file1.txt' } }),
      partRow('m_asst', { type: 'step-finish' }),
    ];

    const entries = mapOpenCodeRows(messages, parts);
    expect(entries.map((entry) => entry.kind)).toEqual(['user', 'assistant', 'tool_result']);
    expect(entries[0]).toMatchObject({ kind: 'user', uuid: 'm_user', ts: 1000, text: 'List the files.' });
    expect(entries[1]).toMatchObject({
      kind: 'assistant',
      model: 'big-pickle',
      blocks: [
        { type: 'thinking', text: 'I should list files.' },
        { type: 'text', text: 'Here are the files.' },
        { type: 'tool_use', id: 'call_1', name: 'bash', input: { command: 'ls' } },
      ],
    });
    expect(entries[2]).toMatchObject({ kind: 'tool_result', toolUseId: 'call_1', content: 'file1.txt', isError: false });
  });

  it('flags an error tool part via state.status', () => {
    const entries = mapOpenCodeRows(
      [messageRow('m', 1, { role: 'assistant' })],
      [partRow('m', { type: 'tool', callID: 'c', tool: 'bash', state: { status: 'error', output: 'failed' } })],
    );
    expect(entries.find((entry) => entry.kind === 'tool_result')).toMatchObject({ isError: true, content: 'failed' });
  });

  it('skips messages with no renderable parts', () => {
    const entries = mapOpenCodeRows(
      [messageRow('m', 1, { role: 'assistant' })],
      [partRow('m', { type: 'step-start' }), partRow('m', { type: 'step-finish' })],
    );
    expect(entries).toEqual([]);
  });
});

describe('parseOpenCodeTranscriptAtPath', () => {
  it('returns [] when the database file does not exist', () => {
    expect(parseOpenCodeTranscriptAtPath(path.join(os.tmpdir(), 'no-such-opencode.db'), 'ses_x')).toEqual([]);
  });
});
