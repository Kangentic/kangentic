/**
 * Direct unit coverage for buildMessageTrail (tests/captures/helpers/message-trail-extract.ts).
 *
 * extractMessageTrail's own tests (message-trail-extract-opencode-candidates.test.ts) drive
 * candidate selection through a SQLite fixture; buildMessageTrail is the pure half of the same
 * module, taking an already-parsed TranscriptEntry[] plus a clock window, and needs none of that.
 * This file constructs TranscriptEntry literals directly and never touches the filesystem.
 */
import { describe, expect, it } from 'vitest';
import type { TranscriptEntry } from '../../src/shared/types';
import { MESSAGE_TRAIL_ENTRY_MAX_CHARS } from '../../src/main/agent/message-trail-tracker';
import { buildMessageTrail } from '../captures/helpers/message-trail-extract';

/** An assistant entry carrying one text block, the shape assistantMessagePreviews reads. */
function assistantText(uuid: string, ts: number, text: string): TranscriptEntry {
  return { kind: 'assistant', uuid, ts, blocks: [{ type: 'text', text }] };
}

describe('buildMessageTrail', () => {
  const startMs = 1_000_000;
  const durationMs = 60_000;

  it('computes each offset as preview.ts - startMs, rounded', () => {
    const entries: TranscriptEntry[] = [
      assistantText('rounds-down', startMs + 100.4, 'rounds down to the nearest millisecond'),
      assistantText('rounds-up', startMs + 100.6, 'rounds up to the nearest millisecond'),
    ];

    const trail = buildMessageTrail(entries, startMs, durationMs);

    expect(trail.map((entry) => entry.t)).toEqual([100, 101]);
  });

  it('drops an entry whose offset falls before the recording started, rather than clamping it to 0', () => {
    const entries: TranscriptEntry[] = [
      assistantText('before-start', startMs - 1, 'said before the recording started'),
      assistantText('at-start', startMs, 'said at the first millisecond'),
    ];

    const trail = buildMessageTrail(entries, startMs, durationMs);

    expect(trail.map((entry) => entry.uuid)).toEqual(['at-start']);
  });

  it('drops an entry whose offset falls after the recording ended, rather than clamping it to the last millisecond', () => {
    const entries: TranscriptEntry[] = [
      assistantText('at-end', startMs + durationMs, 'said at the last millisecond'),
      assistantText('after-end', startMs + durationMs + 1, 'kept talking after the capture was cut'),
    ];

    const trail = buildMessageTrail(entries, startMs, durationMs);

    expect(trail.map((entry) => entry.uuid)).toEqual(['at-end']);
  });

  it('preserves the oldest-first order of the entries it was given', () => {
    const entries: TranscriptEntry[] = [
      assistantText('first', startMs + 100, 'first message'),
      assistantText('second', startMs + 200, 'second message'),
      assistantText('third', startMs + 300, 'third message'),
    ];

    const trail = buildMessageTrail(entries, startMs, durationMs);

    expect(trail.map((entry) => entry.uuid)).toEqual(['first', 'second', 'third']);
  });

  it('contributes nothing for a thinking-only or tool-only assistant entry, or for a non-assistant entry', () => {
    const entries: TranscriptEntry[] = [
      { kind: 'user', uuid: 'user-turn', ts: startMs + 10, text: 'do the thing' },
      {
        kind: 'assistant',
        uuid: 'thinking-only',
        ts: startMs + 20,
        blocks: [{ type: 'thinking', text: 'let me think about this' }],
      },
      {
        kind: 'assistant',
        uuid: 'tool-only',
        ts: startMs + 30,
        blocks: [{ type: 'tool_use', id: 'tool-1', name: 'Read', input: {} }],
      },
      assistantText('has-text', startMs + 40, 'here is my answer'),
    ];

    const trail = buildMessageTrail(entries, startMs, durationMs);

    expect(trail.map((entry) => entry.uuid)).toEqual(['has-text']);
  });

  it('caps each line at MESSAGE_TRAIL_ENTRY_MAX_CHARS, imported from message-trail-tracker rather than hardcoded', () => {
    const longText = 'x'.repeat(MESSAGE_TRAIL_ENTRY_MAX_CHARS + 50);
    const entries: TranscriptEntry[] = [assistantText('long-line', startMs + 10, longText)];

    const trail = buildMessageTrail(entries, startMs, durationMs);

    expect(trail).toHaveLength(1);
    expect(trail[0].text).toHaveLength(MESSAGE_TRAIL_ENTRY_MAX_CHARS);
    expect(trail[0].text).toBe(longText.slice(0, MESSAGE_TRAIL_ENTRY_MAX_CHARS));
  });
});
