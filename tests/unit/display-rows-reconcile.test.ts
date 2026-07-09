import { describe, it, expect } from 'vitest';
import { reconcileDisplayRows } from '../../src/renderer/components/conversation/display-rows';
import type { TranscriptEntry } from '../../src/shared/types';

/**
 * `reconcileDisplayRows` is what lets `MemoConversationRow`'s default
 * shallow-compare skip re-rendering rows a live-poll tick did not actually
 * change - it reuses a previous row's OBJECT REFERENCE whenever the row's
 * uuid and content signature both match. Covers: identity preservation
 * across an unchanged append, a growing last row NOT busting earlier rows, a
 * late tool_result busting only its OWNING assistant row, and basic
 * searchText/searchSegments construction.
 */

function userEntry(uuid: string, text: string, ts = 1): TranscriptEntry {
  return { kind: 'user', uuid, ts, text };
}

function assistantTextEntry(uuid: string, text: string, ts = 2): TranscriptEntry {
  return { kind: 'assistant', uuid, ts, blocks: [{ type: 'text', text }] };
}

function assistantToolUseEntry(uuid: string, toolUseId: string, ts = 3): TranscriptEntry {
  return {
    kind: 'assistant',
    uuid,
    ts,
    blocks: [{ type: 'tool_use', id: toolUseId, name: 'Bash', input: { command: 'ls' } }],
  };
}

function toolResultEntry(uuid: string, toolUseId: string, content: string, ts = 4): TranscriptEntry {
  return { kind: 'tool_result', uuid, ts, toolUseId, content };
}

describe('reconcileDisplayRows', () => {
  it('reuses row object references when entries are unchanged (identity preservation)', () => {
    const entries: TranscriptEntry[] = [userEntry('u1', 'hello'), assistantTextEntry('a1', 'hi there')];
    const first = reconcileDisplayRows([], entries);
    const second = reconcileDisplayRows(first, entries);

    expect(second[0]).toBe(first[0]);
    expect(second[1]).toBe(first[1]);
  });

  it('a genuine content change to one entry produces a NEW row for it, but does not disturb other unchanged rows', () => {
    const entries: TranscriptEntry[] = [userEntry('u1', 'hello'), assistantTextEntry('a1', 'hi there')];
    const first = reconcileDisplayRows([], entries);

    const changed: TranscriptEntry[] = [userEntry('u1', 'hello'), assistantTextEntry('a1', 'hi there - edited')];
    const second = reconcileDisplayRows(first, changed);

    expect(second[0]).toBe(first[0]); // u1 unchanged
    expect(second[1]).not.toBe(first[1]); // a1 changed
  });

  it('appending a new last entry produces a new row for it while ALL earlier rows keep their identity', () => {
    const entries: TranscriptEntry[] = [
      userEntry('u1', 'first'),
      assistantTextEntry('a1', 'reply one'),
      userEntry('u2', 'second'),
    ];
    const first = reconcileDisplayRows([], entries);

    const grown: TranscriptEntry[] = [...entries, assistantTextEntry('a2', 'reply two')];
    const second = reconcileDisplayRows(first, grown);

    expect(second).toHaveLength(4);
    expect(second[0]).toBe(first[0]);
    expect(second[1]).toBe(first[1]);
    expect(second[2]).toBe(first[2]);
    expect(second[3]).not.toBe(first[2]); // the new row, obviously distinct
  });

  it('a late tool_result landing for an existing tool_use busts ONLY the owning assistant row, not sibling rows', () => {
    const entries: TranscriptEntry[] = [
      userEntry('u1', 'run ls'),
      assistantToolUseEntry('a1', 'tool-1'),
      userEntry('u2', 'unrelated turn'),
    ];
    const first = reconcileDisplayRows([], entries);
    // Before the result lands, the tool_use row folds no result.
    expect(first[1].results.size).toBe(0);

    const withResult: TranscriptEntry[] = [
      ...entries,
      toolResultEntry('r1', 'tool-1', 'file1.txt\nfile2.txt'),
    ];
    const second = reconcileDisplayRows(first, withResult);

    // The tool_result entry is folded into its owner, not its own row.
    expect(second).toHaveLength(3);
    expect(second[0]).toBe(first[0]); // untouched
    expect(second[1]).not.toBe(first[1]); // owning row busted - now carries the result
    expect(second[1].results.get('tool-1')).toMatchObject({ content: 'file1.txt\nfile2.txt', isError: false });
    expect(second[2]).toBe(first[2]); // sibling row untouched
  });

  it('folds an owned tool_result into its owner and never emits it as a standalone row', () => {
    const entries: TranscriptEntry[] = [
      assistantToolUseEntry('a1', 'tool-1'),
      toolResultEntry('r1', 'tool-1', 'result body'),
    ];
    const rows = reconcileDisplayRows([], entries);

    expect(rows).toHaveLength(1);
    expect(rows[0].uuid).toBe('a1');
  });

  it('renders an UNOWNED tool_result (no matching tool_use in this parse) as its own standalone row', () => {
    const entries: TranscriptEntry[] = [toolResultEntry('r1', 'orphan-tool', 'orphaned output')];
    const rows = reconcileDisplayRows([], entries);

    expect(rows).toHaveLength(1);
    expect(rows[0].uuid).toBe('r1');
    expect(rows[0].entry.kind).toBe('tool_result');
  });

  it('dedupes a duplicate uuid, keeping only the first occurrence', () => {
    const entries: TranscriptEntry[] = [userEntry('u1', 'first'), userEntry('u1', 'duplicate')];
    const rows = reconcileDisplayRows([], entries);

    expect(rows).toHaveLength(1);
    expect(rows[0].entry.kind === 'user' && rows[0].entry.text).toBe('first');
  });

  it('builds searchText covering user text and assistant text blocks', () => {
    const entries: TranscriptEntry[] = [userEntry('u1', 'find this keyword')];
    const rows = reconcileDisplayRows([], entries);

    expect(rows[0].searchText.toLowerCase()).toContain('find this keyword');
    expect(rows[0].searchSegments.length).toBeGreaterThan(0);
    // A user turn's text is always visible - no fold key needed.
    expect(rows[0].searchSegments[0].expandKey).toBeNull();
  });

  it('gives a tool_use block segment an expandKey matching the id ConversationView uses to toggle it', () => {
    const entries: TranscriptEntry[] = [assistantToolUseEntry('a1', 'tool-xyz')];
    const rows = reconcileDisplayRows([], entries);

    const toolSegment = rows[0].searchSegments.find((segment) => segment.expandKey === 'tool-xyz');
    expect(toolSegment).toBeDefined();
  });

  it('gives a thinking block segment an expandKey in the "<uuid>:think:<index>" format ConversationView uses', () => {
    const entries: TranscriptEntry[] = [
      { kind: 'assistant', uuid: 'a1', ts: 1, blocks: [{ type: 'thinking', text: 'pondering the problem' }] },
    ];
    const rows = reconcileDisplayRows([], entries);

    const thinkingSegment = rows[0].searchSegments.find((segment) => segment.expandKey === 'a1:think:0');
    expect(thinkingSegment).toBeDefined();
  });

  it('estimates a taller row for longer text content than a short one', () => {
    const shortEntries: TranscriptEntry[] = [userEntry('u1', 'short')];
    const longEntries: TranscriptEntry[] = [userEntry('u1', 'x'.repeat(2000))];

    const shortRows = reconcileDisplayRows([], shortEntries);
    const longRows = reconcileDisplayRows([], longEntries);

    expect(longRows[0].estimatedHeight).toBeGreaterThan(shortRows[0].estimatedHeight);
  });
});
