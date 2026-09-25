import { describe, expect, it } from 'vitest';
import type { TranscriptEntry } from '../../src/shared/types';
import {
  MESSAGE_PREVIEW_MAX_CHARS,
  assistantMessagePreviews,
  lastAssistantPreview,
} from '../../src/main/agent/shared/message-preview';

function assistant(text: string, uuid = 'a1', ts = 1): TranscriptEntry {
  return { kind: 'assistant', uuid, ts, blocks: [{ type: 'text', text }] };
}

describe('lastAssistantPreview', () => {
  it('returns the newest assistant text', () => {
    const entries: TranscriptEntry[] = [
      assistant('older message', 'a1'),
      { kind: 'user', uuid: 'u1', ts: 2, text: 'a question' },
      assistant('newest message', 'a2'),
    ];
    expect(lastAssistantPreview(entries)).toBe('newest message');
  });

  it('skips tool_use-only assistant entries and keeps looking back', () => {
    const entries: TranscriptEntry[] = [
      assistant('the last thing actually said', 'a1'),
      { kind: 'assistant', uuid: 'a2', ts: 2, blocks: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'ls' } }] },
      { kind: 'tool_result', uuid: 'r1', ts: 3, toolUseId: 't1', content: 'output' },
    ];
    expect(lastAssistantPreview(entries)).toBe('the last thing actually said');
  });

  it('collapses markdown structure to one plain line', () => {
    expect(lastAssistantPreview([assistant('## Heading\n\n- first point\n- second point')])).toBe(
      'Heading first point second point',
    );
  });

  it('drops decoration-only content and code fences', () => {
    expect(lastAssistantPreview([assistant('```ts\nconst x = 1;\n```')])).toBe('const x = 1;');
    expect(lastAssistantPreview([assistant('Done.\n\n---')])).toBe('Done.');
  });

  /**
   * The phone has no glyph for the agent TUI's status indicators, so they
   * render as tofu boxes on a card. Seen live on a Pixel.
   */
  it('drops glyphs a phone cannot render, keeping arrows and bullets', () => {
    expect(lastAssistantPreview([assistant('⏵⏵ auto mode on')])).toBe('auto mode on');
    expect(lastAssistantPreview([assistant('← back · done')])).toBe('← back · done');
  });

  it('caps the preview so a card never carries a whole message', () => {
    const preview = lastAssistantPreview([assistant('x'.repeat(MESSAGE_PREVIEW_MAX_CHARS + 500))]);
    expect(preview).toHaveLength(MESSAGE_PREVIEW_MAX_CHARS);
  });

  /**
   * Null, not empty string: the caller sends nothing rather than blanking a
   * preview the phone is already showing.
   */
  it('returns null when nothing was actually said', () => {
    expect(lastAssistantPreview([])).toBeNull();
    expect(lastAssistantPreview([assistant('   \n\n---\n')])).toBeNull();
    expect(lastAssistantPreview([{ kind: 'user', uuid: 'u1', ts: 1, text: 'only a user turn' }])).toBeNull();
  });
});

/**
 * The board card's trail reads the same function as the phone's one-liner, so
 * the two can never disagree about what the agent last said. These cases pin
 * what the multi-line form adds: how many, in which order, and what rides on
 * each line.
 */
describe('assistantMessagePreviews', () => {
  const entries: TranscriptEntry[] = [
    assistant('first', 'a1', 10),
    { kind: 'user', uuid: 'u1', ts: 11, text: 'a question' },
    assistant('second', 'a2', 12),
    { kind: 'assistant', uuid: 'a3', ts: 13, blocks: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'ls' } }] },
    assistant('---\n\n', 'a4', 14),
    assistant('third', 'a5', 15),
  ];

  it('returns the newest `count` prose entries, oldest first', () => {
    expect(assistantMessagePreviews(entries, { count: 2, maxChars: 200 }).map((entry) => entry.text))
      .toEqual(['second', 'third']);
    expect(assistantMessagePreviews(entries, { count: 10, maxChars: 200 }).map((entry) => entry.text))
      .toEqual(['first', 'second', 'third']);
  });

  it('carries the entry uuid and ts on each line', () => {
    expect(assistantMessagePreviews(entries, { count: 1, maxChars: 200 })).toEqual([
      { uuid: 'a5', ts: 15, text: 'third' },
    ]);
  });

  it('skips a tool-use-only or decoration-only entry without spending a slot', () => {
    // a4 (decoration) and a3 (tool use) sit between second and third; two
    // slots still reach back to 'second'.
    expect(assistantMessagePreviews(entries, { count: 2, maxChars: 200 }).map((entry) => entry.uuid))
      .toEqual(['a2', 'a5']);
  });

  it('caps each line independently', () => {
    const long = [assistant('y'.repeat(50), 'b1'), assistant('x'.repeat(50), 'b2')];
    const lines = assistantMessagePreviews(long, { count: 2, maxChars: 20 });
    expect(lines.map((entry) => entry.text.length)).toEqual([20, 20]);
  });

  it('returns nothing for a non-positive count or no prose', () => {
    expect(assistantMessagePreviews(entries, { count: 0, maxChars: 200 })).toEqual([]);
    expect(assistantMessagePreviews([], { count: 3, maxChars: 200 })).toEqual([]);
  });

  it('is what the one-line preview is built on', () => {
    expect(lastAssistantPreview(entries)).toBe(
      assistantMessagePreviews(entries, { count: 1, maxChars: MESSAGE_PREVIEW_MAX_CHARS })[0]?.text,
    );
  });
});
