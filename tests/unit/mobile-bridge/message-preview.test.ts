import { describe, expect, it } from 'vitest';
import type { TranscriptEntry } from '../../../src/shared/types';
import { MESSAGE_PREVIEW_MAX_CHARS, lastAssistantPreview } from '../../../src/main/mobile-bridge/message-preview';

function assistant(text: string, uuid = 'a1'): TranscriptEntry {
  return { kind: 'assistant', uuid, ts: 1, blocks: [{ type: 'text', text }] };
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
