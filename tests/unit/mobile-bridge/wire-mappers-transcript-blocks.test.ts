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
import type { TranscriptBlock, TranscriptEntry } from '../../../src/shared/types';

describe('toTranscriptEntryWire block clamping', () => {
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
});
