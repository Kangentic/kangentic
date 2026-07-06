import { describe, it, expect } from 'vitest';
import { sliceTranscriptAroundUuid } from '../../src/shared/transcript-format';
import type { TranscriptEntry } from '../../src/shared/types';

/**
 * sliceTranscriptAroundUuid is the pure window function behind citation-first
 * recall: recall cites a turnUuid, then get_transcript fetches a neighborhood of
 * `context` entries either side of that uuid. These lock its contract - window
 * sizing, both-end clamping, the uuid-not-found passthrough, a negative context
 * treated as zero, and contiguity/order preservation across a paired
 * assistant/tool_result window.
 */

function userEntry(uuid: string, text: string): TranscriptEntry {
  return { kind: 'user', uuid, ts: 0, text };
}

/** Seven simple user entries u0..u6, indices matching their uuid suffix. */
function buildEntries(): TranscriptEntry[] {
  return Array.from({ length: 7 }, (_, index) => userEntry(`u${index}`, `message ${index}`));
}

function uuids(entries: TranscriptEntry[]): string[] {
  return entries.map((entry) => entry.uuid);
}

describe('sliceTranscriptAroundUuid window sizing', () => {
  it('context 0 returns only the matching entry', () => {
    const entries = buildEntries();
    const result = sliceTranscriptAroundUuid(entries, 'u3', 0);
    expect(uuids(result)).toEqual(['u3']);
  });

  it('context 1 returns the match plus one entry on each side', () => {
    const entries = buildEntries();
    const result = sliceTranscriptAroundUuid(entries, 'u3', 1);
    expect(uuids(result)).toEqual(['u2', 'u3', 'u4']);
  });

  it('context 3 returns three entries on each side when they exist', () => {
    const entries = buildEntries();
    // Match at index 3 with radius 3 spans exactly the full 7-entry array.
    const result = sliceTranscriptAroundUuid(entries, 'u3', 3);
    expect(uuids(result)).toEqual(['u0', 'u1', 'u2', 'u3', 'u4', 'u5', 'u6']);
  });
});

describe('sliceTranscriptAroundUuid clamping', () => {
  it('clamps at the start of the array (no entries before the match)', () => {
    const entries = buildEntries();
    // Match at index 0, radius 2: start clamps to 0, end is index+radius+1 = 3.
    const result = sliceTranscriptAroundUuid(entries, 'u0', 2);
    expect(uuids(result)).toEqual(['u0', 'u1', 'u2']);
  });

  it('clamps at the end of the array (no entries after the match)', () => {
    const entries = buildEntries();
    // Match at index 6, radius 2: start is 4, end clamps to length 7.
    const result = sliceTranscriptAroundUuid(entries, 'u6', 2);
    expect(uuids(result)).toEqual(['u4', 'u5', 'u6']);
  });

  it('a radius wider than the array returns every entry once, not duplicated', () => {
    const entries = buildEntries();
    const result = sliceTranscriptAroundUuid(entries, 'u3', 100);
    expect(uuids(result)).toEqual(uuids(entries));
    expect(result).toHaveLength(entries.length);
  });
});

describe('sliceTranscriptAroundUuid edge cases', () => {
  it('returns the input unchanged when the uuid is absent (same length, same reference)', () => {
    const entries = buildEntries();
    const result = sliceTranscriptAroundUuid(entries, 'does-not-exist', 2);
    expect(result).toBe(entries);
    expect(result).toHaveLength(entries.length);
  });

  it('treats a negative context as 0 (returns only the match)', () => {
    const entries = buildEntries();
    const result = sliceTranscriptAroundUuid(entries, 'u3', -5);
    expect(uuids(result)).toEqual(['u3']);
  });

  it('returns an empty window for an empty input regardless of context', () => {
    expect(sliceTranscriptAroundUuid([], 'anything', 3)).toEqual([]);
  });
});

describe('sliceTranscriptAroundUuid contiguity', () => {
  it('returns a contiguous, in-order subarray equal to the raw slice', () => {
    const entries = buildEntries();
    const result = sliceTranscriptAroundUuid(entries, 'u4', 1);
    // Contiguity: identical to a manual slice around the match index.
    expect(result).toEqual(entries.slice(3, 6));
    // And the entries themselves are consecutive (u3, u4, u5).
    expect(uuids(result)).toEqual(['u3', 'u4', 'u5']);
  });

  it('keeps a paired assistant/tool_result adjacent and ordered inside the window', () => {
    const entries: TranscriptEntry[] = [
      userEntry('u0', 'before'),
      {
        kind: 'assistant',
        uuid: 'assistant-1',
        ts: 1,
        blocks: [{ type: 'tool_use', id: 'call-1', name: 'Bash', input: { cmd: 'ls' } }],
      },
      { kind: 'tool_result', uuid: 'result-1', ts: 2, toolUseId: 'call-1', content: 'file.txt' },
      userEntry('u3', 'after'),
    ];

    // Anchor on the assistant turn with radius 1: the paired result stays right
    // after it, in original order.
    const result = sliceTranscriptAroundUuid(entries, 'assistant-1', 1);
    expect(uuids(result)).toEqual(['u0', 'assistant-1', 'result-1']);
    expect(result[1].kind).toBe('assistant');
    expect(result[2].kind).toBe('tool_result');
  });
});
