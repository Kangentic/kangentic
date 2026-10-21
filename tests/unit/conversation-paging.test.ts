import { describe, expect, it } from 'vitest';
import {
  buildPagingWindow,
  entryNearPosition,
  heldBytes,
  insertBlock,
  isPagingMode,
  pageFitsRequest,
  retainSeam,
  type HeldBlock,
  type PagingInput,
} from '../../src/renderer/components/conversation/conversation-paging';
import type { ConversationExtent, TranscriptEntry } from '../../src/shared/types';

/**
 * The Conversation viewer's paging model: what renders out of the polled tail
 * and the held pages, which page fills an edge, which page to drop, and where a
 * scrollbar position lands in the whole transcript.
 *
 * Fixtures are small synthetic conversations: each entry sits 100 bytes after
 * the previous one and a minute later, so positions and times are easy to read.
 */

const MINUTE = 60_000;
const BASE = Date.UTC(2026, 9, 1, 9, 0, 0);

function entry(conversationId: string, index: number, options: { ts?: number; position?: number } = {}): TranscriptEntry {
  return {
    kind: 'user',
    uuid: `${conversationId}-${index}`,
    ts: options.ts ?? BASE + index * MINUTE,
    text: `${conversationId} turn ${index}`,
    origin: { conversationId, position: options.position ?? index * 100 },
  };
}

function notice(conversationId: string, position: number, ts: number): TranscriptEntry {
  return {
    kind: 'system',
    uuid: `kangentic-truncated:${conversationId}:${position}`,
    ts,
    subtype: 'truncated',
    text: 'Earlier history is not shown.',
    earlierHistory: { conversationId, cursor: `j:${position}`, position },
  };
}

function extent(conversationId: string, totalPosition: number, tailStartPosition: number): ConversationExtent {
  return { conversationId, totalPosition, tailStartPosition, pageable: true, hasTimestamps: true };
}

/** A page of one conversation's entries `from` (inclusive) to `to` (exclusive), by index. */
function page(conversationId: string, from: number, to: number, options: { reachedStart?: boolean } = {}): HeldBlock {
  const entries: TranscriptEntry[] = [];
  for (let index = from; index < to; index += 1) entries.push(entry(conversationId, index));
  return {
    conversationId,
    sourceToken: 'jsonl:token',
    startCursor: `j:${from * 100}`,
    endCursor: `j:${to * 100}`,
    startPosition: from * 100,
    endPosition: to * 100,
    reachedStart: options.reachedStart ?? from === 0,
    entries,
  };
}

/** Conversation A: 50 turns, the tail holding turns 40..49 behind a notice at byte 4000. */
function singleConversation(blocks: HeldBlock[] = [], anchorTs = Infinity): PagingInput {
  const tail: TranscriptEntry[] = [notice('A', 4000, BASE + 40 * MINUTE)];
  for (let index = 40; index < 50; index += 1) tail.push(entry('A', index));
  return {
    tail,
    conversations: [extent('A', 5000, 4000)],
    blocks,
    timelines: new Map(),
    anchorTs,
  };
}

function uuids(entries: ReadonlyArray<TranscriptEntry>): string[] {
  return entries.map((item) => item.uuid);
}

describe('isPagingMode', () => {
  it('is off for a response with no extents or a whole tail, and on when a pageable tail starts past 0', () => {
    expect(isPagingMode(undefined)).toBe(false);
    expect(isPagingMode([{ ...extent('A', 100, 0) }])).toBe(false);
    expect(isPagingMode([{ ...extent('A', 100, 50), pageable: false }])).toBe(false);
    expect(isPagingMode([extent('A', 100, 50)])).toBe(true);
  });
});

describe('buildPagingWindow', () => {
  it('opens on the tail, without the notice, with the notice\'s cursor as the top edge', () => {
    const window = buildPagingWindow(singleConversation());
    expect(uuids(window.entries)).toEqual(Array.from({ length: 10 }, (_, offset) => `A-${40 + offset}`));
    expect(window.topHole).toMatchObject({ conversationId: 'A', startPosition: 0, endPosition: 4000, endCursor: 'j:4000' });
    expect(window.reachesTail).toBe(true);
    expect(window.requestFor('top')).toEqual({
      conversationId: 'A', direction: 'before', cursor: 'j:4000', untilPosition: 4000, sourceToken: undefined,
    });
    expect(window.requestFor('bottom')).toBeNull();
  });

  it('places each row at its byte position in the whole transcript', () => {
    const window = buildPagingWindow(singleConversation());
    expect(window.logicalTotal).toBe(5000);
    expect(window.logicalByUuid.get('A-40')).toBe(4000);
    expect(window.logicalByUuid.get('A-45')).toBe(4500);
    expect(window.logicalStart).toBe(4000);
    expect(window.logicalEnd).toBe(5000);
  });

  it('grows upward as pages land, and drops the top edge once a page reaches the start', () => {
    const one = buildPagingWindow(singleConversation([page('A', 30, 40)]));
    expect(uuids(one.entries)[0]).toBe('A-30');
    expect(one.topHole?.endCursor).toBe('j:3000');

    const whole = buildPagingWindow(singleConversation([page('A', 0, 20), page('A', 20, 40)]));
    expect(whole.entries).toHaveLength(50);
    expect(whole.topHole).toBeNull();
  });

  it('keeps the tail\'s own object when a page holds the same turn', () => {
    const input = singleConversation([page('A', 35, 41)]);
    const tailObject = input.tail.find((item) => item.uuid === 'A-40');
    const window = buildPagingWindow(input);
    expect(window.entries.filter((item) => item.uuid === 'A-40')).toHaveLength(1);
    expect(window.entries.find((item) => item.uuid === 'A-40')).toBe(tailObject);
  });

  it('shows a detached page around a jump with an edge on each side, and fills the bottom one forward', () => {
    const jumped = buildPagingWindow(singleConversation([page('A', 10, 20)], BASE + 15 * MINUTE));
    expect(uuids(jumped.entries)).toEqual(Array.from({ length: 10 }, (_, offset) => `A-${10 + offset}`));
    expect(jumped.reachesTail).toBe(false);
    expect(jumped.topHole).toMatchObject({ startPosition: 0, endPosition: 1000 });
    expect(jumped.bottomHole).toMatchObject({ startPosition: 2000, endPosition: 4000 });
    expect(jumped.requestFor('bottom')).toEqual({
      conversationId: 'A', direction: 'after', cursor: 'j:2000', untilPosition: 4000, sourceToken: 'jsonl:token',
    });
  });

  it('keeps an older complete session hidden until the big conversation\'s pages reach its time, then shows it in place', () => {
    // B is a small, whole session that ran between A's turns 20 and 21.
    const bEntries = [0, 1, 2].map((index) => entry('B', index, { ts: BASE + 20 * MINUTE + (index + 1) * 10_000, position: index * 50 }));
    const base = singleConversation();
    const input: PagingInput = {
      ...base,
      tail: [...bEntries, { kind: 'system', uuid: 'session-boundary-old', ts: 0, subtype: 'session_boundary', text: 'New session' }, ...base.tail],
      conversations: [{ ...extent('B', 150, 0) }, extent('A', 5000, 4000)],
    };

    const initial = buildPagingWindow(input);
    expect(uuids(initial.entries).some((uuid) => uuid.startsWith('B-'))).toBe(false);

    const reached = buildPagingWindow({ ...input, blocks: [page('A', 15, 40)] });
    const order = uuids(reached.entries);
    expect(order.indexOf('B-0')).toBeGreaterThan(order.indexOf('A-20'));
    expect(order.indexOf('B-2')).toBeLessThan(order.indexOf('A-21'));
    // No divider is invented for a crossing the stitch never drew, and the one
    // it drew before A-40 goes once A's own turns lead into A-40.
    expect(reached.entries.some((item) => item.kind === 'system' && item.subtype === 'session_boundary')).toBe(false);
  });

  it('keeps the stitch\'s own dividers, the same objects, where it drew them', () => {
    const divider = (uuid: string, text: string): TranscriptEntry => ({ kind: 'system', uuid, ts: 0, subtype: 'session_boundary', text });
    const intoC = divider('session-boundary-c', 'New session');
    const backToA = divider('session-boundary-a', 'Resumed session');
    const cEntries = [0, 1].map((index) => entry('C', index, { ts: BASE + 42 * MINUTE + (index + 1) * 10_000, position: index * 50 }));
    const tail: TranscriptEntry[] = [
      notice('A', 4000, BASE + 40 * MINUTE),
      entry('A', 40), entry('A', 41), entry('A', 42),
      intoC, ...cEntries,
      backToA, ...[43, 44, 45].map((index) => entry('A', index)),
    ];
    const window = buildPagingWindow({
      tail,
      conversations: [extent('A', 4600, 4000), { ...extent('C', 100, 0) }],
      blocks: [],
      timelines: new Map(),
      anchorTs: Infinity,
    });
    expect(uuids(window.entries)).toEqual(['A-40', 'A-41', 'A-42', 'session-boundary-c', 'C-0', 'C-1', 'session-boundary-a', 'A-43', 'A-44', 'A-45']);
    expect(window.entries[3]).toBe(intoC);
    expect(window.entries[6]).toBe(backToA);
  });

  it('keeps the reader\'s rows when a far scroll up evicts the page the reader jumped to', () => {
    // Jumped to A-25, then scrolled up through two pages; the cap holds two pages.
    const jumped = page('A', 20, 30);
    const readerTs = BASE + 12 * MINUTE;
    let blocks = insertBlock([jumped], page('A', 10, 20), readerTs, 2000);
    blocks = insertBlock(blocks, page('A', 0, 10), readerTs, 2000);
    expect(blocks).not.toContain(jumped);

    const window = buildPagingWindow(singleConversation(blocks, readerTs));
    expect(uuids(window.entries)).toContain('A-12');
    expect(window.entries[0].uuid).toBe('A-0');
    expect(window.bottomHole).toMatchObject({ startPosition: 2000, endPosition: 4000 });

    // The anchor from before the eviction now sits in the hole and would show
    // the tail instead, which is why every insert re-anchors on the reader.
    const stale = buildPagingWindow(singleConversation(blocks, BASE + 25 * MINUTE));
    expect(uuids(stale.entries)).not.toContain('A-12');
  });

  it('keeps the entries a re-windowed tail dropped, so no hole opens under the reader', () => {
    const previous = singleConversation([page('A', 30, 40)]);
    const nextTail: TranscriptEntry[] = [notice('A', 4500, BASE + 45 * MINUTE)];
    for (let index = 45; index < 53; index += 1) nextTail.push(entry('A', index));
    const readerTs = BASE + 41 * MINUTE;
    const blocks = retainSeam(previous.tail, nextTail, previous.blocks, readerTs);
    expect(blocks.map((block) => [block.startPosition, block.endPosition])).toContainEqual([4000, 4500]);

    const window = buildPagingWindow({
      tail: nextTail,
      conversations: [extent('A', 5300, 4500)],
      blocks,
      timelines: new Map(),
      anchorTs: readerTs,
    });
    expect(uuids(window.entries)).toEqual(Array.from({ length: 23 }, (_, offset) => `A-${30 + offset}`));
    expect(window.topHole).toMatchObject({ startPosition: 0, endPosition: 3000 });
    expect(window.bottomHole).toBeNull();
  });

  it('leaves a tail with no held pages to re-window as it always did', () => {
    const previous = singleConversation();
    const nextTail = [notice('A', 4500, BASE + 45 * MINUTE), entry('A', 45)];
    expect(retainSeam(previous.tail, nextTail, [], BASE)).toEqual([]);
  });

  it('keeps an ordinary conversation with no paging exactly as the tail stitched it', () => {
    const tail = [entry('C', 0), entry('C', 1)];
    const window = buildPagingWindow({
      tail, conversations: [extent('C', 200, 0)], blocks: [], timelines: new Map(), anchorTs: Infinity,
    });
    expect(window.entries).toEqual(tail);
    expect(window.topHole).toBeNull();
  });
});

describe('insertBlock', () => {
  it('drops the page farthest from the reader past the byte cap, never the reader\'s or the new one', () => {
    const blocks = [page('A', 0, 10), page('A', 10, 20), page('A', 20, 30)];
    const readerTs = BASE + 25 * MINUTE;
    const next = insertBlock(blocks, page('A', 30, 40), readerTs, 3000);
    expect(heldBytes(next)).toBeLessThanOrEqual(3000);
    expect(next.map((block) => block.startPosition)).toEqual([10 * 100, 20 * 100, 30 * 100]);
  });

  it('holds everything under the cap', () => {
    const next = insertBlock([page('A', 0, 10)], page('A', 10, 20), BASE, 10_000);
    expect(next).toHaveLength(2);
  });
});

describe('pageFitsRequest', () => {
  it('refuses a page for another conversation or one that makes no progress', () => {
    const request = { conversationId: 'A', direction: 'before' as const, cursor: 'j:4000', untilPosition: 4000 };
    expect(pageFitsRequest(request, page('A', 30, 40))).toBe(true);
    expect(pageFitsRequest(request, page('B', 30, 40))).toBe(false);
    expect(pageFitsRequest(request, { ...page('A', 30, 40), startPosition: 4000, endPosition: 4000, reachedStart: false })).toBe(false);
    expect(pageFitsRequest(request, { ...page('A', 0, 0), reachedStart: true })).toBe(true);
  });
});

/** A's timeline: a sample every ten turns, at the fixture's own positions and times. */
const TIMELINE = Array.from({ length: 5 }, (_, index) => ({ position: index * 1000, ts: BASE + index * 10 * MINUTE }));

describe('targetAt and timeAt', () => {
  it('lands a position in the unloaded head through the timeline, with its time', () => {
    const window = buildPagingWindow({ ...singleConversation(), timelines: new Map([['A', TIMELINE]]) });
    expect(window.targetAt(1500)).toMatchObject({ conversationId: 'A', position: 1500 });
    expect(window.timeAt(1500)).toBe(BASE + 15 * MINUTE);
  });

  it('lands the start of the transcript at position 0, with or without a timeline', () => {
    expect(buildPagingWindow(singleConversation()).targetAt(0)).toMatchObject({ conversationId: 'A', position: 0 });
    // A timeline sample at position 0 used to leave no growth to land in.
    const withTimeline = buildPagingWindow({ ...singleConversation(), timelines: new Map([['A', TIMELINE]]) });
    expect(withTimeline.targetAt(0)).toEqual({ conversationId: 'A', position: 0, ts: BASE });
  });

  it('gives no time for a conversation without timestamps', () => {
    const input = singleConversation();
    const window = buildPagingWindow({ ...input, conversations: [{ ...input.conversations[0], hasTimestamps: false }] });
    expect(window.timeAt(4500)).toBeNull();
  });

  it('asks for no page at a position or time the window already holds, and around one it does not', () => {
    const window = buildPagingWindow({ ...singleConversation(), timelines: new Map([['A', TIMELINE]]) });
    expect(window.requestForPosition('A', 4200)).toBeNull();
    expect(window.requestForPosition('A', 1500)).toMatchObject({ direction: 'around', position: 1500, untilPosition: 4000 });
    expect(window.requestForTime(BASE + 45 * MINUTE)).toBeNull();
    expect(window.requestForTime(BASE + 15 * MINUTE)).toMatchObject({ direction: 'around', position: 1500 });
  });
});

describe('column tabs (time ranges)', () => {
  // The column ran turns 5 to 9, and again from turn 42 on.
  const ranges = [
    { start: BASE + 5 * MINUTE, end: BASE + 10 * MINUTE },
    { start: BASE + 42 * MINUTE, end: Infinity },
  ];

  it('reads around its earlier stay instead of through the time other columns took', () => {
    const window = buildPagingWindow({ ...singleConversation(), timelines: new Map([['A', TIMELINE]]), timeRanges: ranges });
    expect(window.requestFor('top')).toMatchObject({ direction: 'around', position: 1000, untilPosition: 4000 });
  });

  it('ignores a hole wholly in another column\'s time, and reads on contiguously once the stay is reached', () => {
    const window = buildPagingWindow({
      ...singleConversation([page('A', 6, 16)]),
      timelines: new Map([['A', TIMELINE]]),
      timeRanges: ranges,
    });
    // The 1600 to 4000 hole is turns 15 to 40: no stay of the column.
    expect(window.bottomHole).toBeNull();
    expect(uuids(window.entries)).toContain('A-6');
    expect(window.requestFor('top')).toMatchObject({ direction: 'before', cursor: 'j:600' });
  });

  it('lays the stays end to end on the scrollbar', () => {
    const window = buildPagingWindow({ ...singleConversation(), timelines: new Map([['A', TIMELINE]]), timeRanges: ranges });
    // 500 bytes of the first stay plus 800 of the second.
    expect(window.logicalTotal).toBe(1300);
    expect(window.targetAt(250)).toMatchObject({ conversationId: 'A', position: 750 });
    expect(window.logicalByUuid.get('A-45')).toBe(500 + 300);
  });
});

describe('entryNearPosition', () => {
  it('picks the entry at or just before a position', () => {
    const entries = [entry('A', 10), entry('A', 11), entry('A', 12)];
    expect(entryNearPosition(entries, 1150)?.uuid).toBe('A-11');
    expect(entryNearPosition(entries, 500)?.uuid).toBe('A-10');
    expect(entryNearPosition(entries, 9999)?.uuid).toBe('A-12');
  });
});
