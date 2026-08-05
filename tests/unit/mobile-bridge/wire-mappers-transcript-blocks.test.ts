/**
 * Unit test for toTranscriptEntryWire's block-count/size clamp
 * (src/main/mobile-bridge/handlers/wire-mappers.ts's clampBlocks).
 *
 * clampToolInput bounds a single tool_use input's serialized size, but
 * nothing previously bounded how many blocks one assistant entry could
 * carry - an entry with enough blocks (hundreds of small tool_use calls in
 * one turn) could still exceed the wire cap even though every individual
 * block was within budget, and transcript-sync's chunkUpserts only splits
 * BETWEEN upserts, never within one entry. This pins that a pathological
 * entry is truncated to a bounded serialized size, with a trailing text
 * block marking what was dropped, rather than shipped unbounded.
 */
import { describe, it, expect } from 'vitest';
import { MAX_ENTRY_BLOCKS_CHARS, toTranscriptEntryWire } from '../../../src/main/mobile-bridge/handlers/wire-mappers';
import { DELTA_CHUNK_BUDGET_CHARS } from '../../../src/main/mobile-bridge/handlers/transcript-sync';
import type { TranscriptBlock, TranscriptEntry } from '../../../src/shared/types';

/** A `text` block whose serialized size is exactly `totalSerializedChars`. The
 *  JSON overhead is measured rather than hardcoded so the boundary cases below
 *  stay exact if the wire block shape ever gains a field. `toTranscriptBlockWire`
 *  maps a text block to the identical shape, so the size survives mapping. */
function textBlockOfSerializedSize(totalSerializedChars: number): TranscriptBlock {
  const overheadChars = JSON.stringify({ type: 'text', text: '' }).length;
  return { type: 'text', text: 'x'.repeat(totalSerializedChars - overheadChars) };
}

describe('toTranscriptEntryWire block clamping', () => {
  it('keeps the per-entry budget under the chunker budget it is documented to fit inside', () => {
    // wire-mappers.ts's comment says MAX_ENTRY_BLOCKS_CHARS stays "comfortably
    // under transcript-sync's DELTA_CHUNK_BUDGET_CHARS" so a clamped entry fits
    // in one chunk instead of becoming an oversized singleton. That relationship
    // lived only in prose across two files: raising the per-entry budget would
    // silently void it with nothing failing. Assert it mechanically instead.
    expect(MAX_ENTRY_BLOCKS_CHARS).toBeLessThan(DELTA_CHUNK_BUDGET_CHARS);
  });

  it('passes a normal assistant entry through unchanged', () => {
    const entry: TranscriptEntry = {
      kind: 'assistant',
      uuid: 'u1',
      ts: 1700000000000,
      blocks: [
        { type: 'text', text: 'hello' },
        { type: 'tool_use', id: 't1', name: 'Read', input: { path: '/a.ts' } },
      ],
    };
    const wire = toTranscriptEntryWire(entry);
    expect(wire.kind).toBe('assistant');
    if (wire.kind !== 'assistant') throw new Error('unreachable');
    expect(wire.blocks).toHaveLength(2);
  });

  it('truncates an entry with hundreds of small tool_use blocks and appends a marker', () => {
    const blocks: TranscriptBlock[] = Array.from(
      { length: 2000 },
      (_unused, index) => ({ type: 'tool_use' as const, id: `t${index}`, name: 'Read', input: { path: `/file-${index}.ts` } }),
    );
    const entry: TranscriptEntry = { kind: 'assistant', uuid: 'u2', ts: 1700000000000, blocks };

    const wire = toTranscriptEntryWire(entry);
    if (wire.kind !== 'assistant') throw new Error('unreachable');

    // Fewer blocks made it through than were on the desktop side.
    expect(wire.blocks.length).toBeLessThan(2000);
    // The last block is the truncation marker, not a real tool_use block.
    const lastBlock = wire.blocks[wire.blocks.length - 1];
    expect(lastBlock.type).toBe('text');
    if (lastBlock.type !== 'text') throw new Error('unreachable');
    expect(lastBlock.text).toContain('more block(s) omitted');

    // The clamped output's total serialized size stays bounded - the
    // load-bearing guarantee that keeps one entry inside a single
    // transcript-sync chunk instead of threatening the 1 MiB frame cap. A
    // generous multiple of the budget (rather than an exact byte count)
    // tolerates the marker block's own size and JSON array overhead without
    // making the test brittle to either.
    const serializedChars = JSON.stringify(wire.blocks).length;
    expect(serializedChars).toBeLessThan(MAX_ENTRY_BLOCKS_CHARS * 1.5);
  });

  it('truncates an entry with a handful of large-but-individually-legal blocks once their sum crosses budget', () => {
    // Each input sits just under clampToolInput's own 32 KiB per-block cap,
    // so this exercises clampBlocks's size accumulation specifically - not
    // clampToolInput's independent per-block truncation.
    const nearCapInput = { data: 'x'.repeat(29 * 1024) };
    const blocks: TranscriptBlock[] = Array.from({ length: 6 }, (_unused, index) => ({
      type: 'tool_use' as const,
      id: `t${index}`,
      name: 'Write',
      input: nearCapInput,
    }));
    const entry: TranscriptEntry = { kind: 'assistant', uuid: 'u3', ts: 1700000000000, blocks };

    const wire = toTranscriptEntryWire(entry);
    if (wire.kind !== 'assistant') throw new Error('unreachable');

    expect(wire.blocks.length).toBeLessThan(6);
    const lastBlock = wire.blocks[wire.blocks.length - 1];
    expect(lastBlock.type).toBe('text');
  });

  // The two cases below pin the comparison itself (`>` vs `>=`) at the exact
  // budget boundary. Every case above sits either well under or well over it,
  // so an off-by-one flip would pass all of them.
  it('does not truncate an entry sitting exactly at the budget', () => {
    const entry: TranscriptEntry = {
      kind: 'assistant',
      uuid: 'u4',
      ts: 1700000000000,
      blocks: [textBlockOfSerializedSize(MAX_ENTRY_BLOCKS_CHARS)],
    };

    const wire = toTranscriptEntryWire(entry);
    if (wire.kind !== 'assistant') throw new Error('unreachable');

    expect(wire.blocks).toHaveLength(1);
    const onlyBlock = wire.blocks[0];
    if (onlyBlock.type !== 'text') throw new Error('unreachable');
    expect(onlyBlock.text).not.toContain('more block(s) omitted');
  });

  it('truncates a single first block that is one char over the budget, keeping only the marker', () => {
    // Also the "one oversized block" path: `text` and `thinking` blocks are not
    // bounded by clampToolInput (only tool_use inputs are), so clampBlocks is
    // the only thing standing between an unbounded text block and the wire. It
    // must drop the block rather than emit it alongside the marker.
    const entry: TranscriptEntry = {
      kind: 'assistant',
      uuid: 'u5',
      ts: 1700000000000,
      blocks: [textBlockOfSerializedSize(MAX_ENTRY_BLOCKS_CHARS + 1)],
    };

    const wire = toTranscriptEntryWire(entry);
    if (wire.kind !== 'assistant') throw new Error('unreachable');

    expect(wire.blocks).toHaveLength(1);
    const onlyBlock = wire.blocks[0];
    if (onlyBlock.type !== 'text') throw new Error('unreachable');
    expect(onlyBlock.text).toContain('1 more block(s) omitted');
    expect(JSON.stringify(wire.blocks).length).toBeLessThan(MAX_ENTRY_BLOCKS_CHARS);
  });
});
