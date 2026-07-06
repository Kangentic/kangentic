import { describe, it, expect } from 'vitest';
import { normalizeTranscript, CONVERSATION_EVENT_SCHEMA_VERSION } from '../../src/shared/conversation-event';
import type { TranscriptEntry } from '../../src/shared/types';

describe('normalizeTranscript', () => {
  it('exposes a schema version', () => {
    expect(CONVERSATION_EVENT_SCHEMA_VERSION).toBe(1);
  });

  it('flattens a turn into discrete events and inlines the tool result', () => {
    const entries: TranscriptEntry[] = [
      { kind: 'user', uuid: 'u1', ts: 1, text: 'do it' },
      {
        kind: 'assistant', uuid: 'a1', ts: 2, model: 'claude-opus-4-8',
        blocks: [
          { type: 'text', text: 'on it' },
          { type: 'thinking', text: 'hmm' },
          { type: 'tool_use', id: 't1', name: 'Read', input: { file: 'x' } },
        ],
      },
      { kind: 'tool_result', uuid: 'r1', ts: 3, toolUseId: 't1', content: 'contents', isError: false },
    ];

    const events = normalizeTranscript(entries);
    expect(events.map((event) => event.type)).toEqual(['message', 'message', 'thinking', 'tool_call']);
    const toolCall = events[3];
    expect(toolCall.type).toBe('tool_call');
    if (toolCall.type === 'tool_call') {
      expect(toolCall.name).toBe('Read');
      expect(toolCall.result).toEqual({ content: 'contents', isError: false });
    }
  });

  it('lifts an Edit tool into a typed file_edit event', () => {
    const entries: TranscriptEntry[] = [
      {
        kind: 'assistant', uuid: 'a1', ts: 1,
        blocks: [{ type: 'tool_use', id: 't1', name: 'Edit', input: { file_path: '/a.ts', old_string: 'x', new_string: 'y' } }],
      },
    ];

    const events = normalizeTranscript(entries);
    expect(events).toHaveLength(1);
    const fileEdit = events[0];
    expect(fileEdit.type).toBe('file_edit');
    if (fileEdit.type === 'file_edit') {
      expect(fileEdit.edit.filePath).toBe('/a.ts');
      expect(fileEdit.edit.hunks).toEqual([{ oldText: 'x', newText: 'y' }]);
    }
  });

  it('drops empty assistant text blocks', () => {
    const entries: TranscriptEntry[] = [
      { kind: 'assistant', uuid: 'a1', ts: 1, blocks: [{ type: 'text', text: '   ' }, { type: 'text', text: 'real' }] },
    ];
    expect(normalizeTranscript(entries).map((event) => event.type)).toEqual(['message']);
  });

  it('surfaces an orphan tool_result as its own tool_call', () => {
    const entries: TranscriptEntry[] = [
      { kind: 'tool_result', uuid: 'r1', ts: 1, toolUseId: 'gone', content: 'orphaned', isError: true },
    ];
    const events = normalizeTranscript(entries);
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('tool_call');
    if (events[0].type === 'tool_call') {
      expect(events[0].result).toEqual({ content: 'orphaned', isError: true });
    }
  });

  it('passes system entries through unchanged', () => {
    const entries: TranscriptEntry[] = [
      { kind: 'system', uuid: 's1', ts: 1, subtype: 'compaction', text: 'compacted' },
    ];
    expect(normalizeTranscript(entries)[0]).toEqual({
      type: 'system', uuid: 's1', ts: 1, subtype: 'compaction', text: 'compacted',
    });
  });
});
