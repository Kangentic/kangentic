import fs from 'node:fs';
import { expect } from 'vitest';
import { setParseWindowBytesForTests } from '../../../src/main/agent/shared/transcript-truncation';
import type { TranscriptPageReadRequest, TranscriptPageReadResult } from '../../../src/main/agent/agent-adapter';
import type { TranscriptEntry, TranscriptHistoryPage } from '../../../src/shared/types';

/**
 * The property every JSONL adapter's history pages keep
 * (`AgentAdapter.readTranscriptPage` over `readJsonlHistoryPage`): walking
 * backward from the tail's notice cursor, or forward from byte 0 up to the
 * tail, covers every line once and yields exactly what a whole-file parse
 * yields, the same entries with the same uuids and the same line-start origins.
 * Shared so each adapter's test pins the same thing.
 */

export type Page = Omit<TranscriptHistoryPage, 'conversationId'>;

function okPage(result: TranscriptPageReadResult): Page {
  if (result.status !== 'ok') throw new Error(`expected a page, got ${JSON.stringify(result)}`);
  return result.page;
}

/** The byte each line of a file starts at. */
export function lineStartsOf(filePath: string): Set<number> {
  const bytes = fs.readFileSync(filePath);
  const starts = new Set<number>([0]);
  for (let index = 0; index < bytes.length; index += 1) {
    if (bytes[index] === 0x0a && index + 1 < bytes.length) starts.add(index + 1);
  }
  return starts;
}

export interface TilingOptions {
  filePath: string;
  conversationId: string;
  /** The adapter's tail parse, which reads at most `parseWindowBytes()`. */
  parseTail: () => Promise<TranscriptEntry[]>;
  readPage: (request: TranscriptPageReadRequest) => Promise<TranscriptPageReadResult>;
  tailBytes: number;
  pageBytes: number;
}

/** The tail's entries after its pageable notice, and the notice's cursor and position. */
async function pagedTail(options: TilingOptions): Promise<{ entries: TranscriptEntry[]; cursor: string; tailStart: number }> {
  setParseWindowBytesForTests(options.tailBytes);
  try {
    const entries = await options.parseTail();
    const marker = entries[0];
    if (marker?.kind !== 'system' || marker.subtype !== 'truncated' || !marker.earlierHistory) {
      throw new Error('the tail should start with a pageable notice');
    }
    expect(marker.earlierHistory.conversationId).toBe(options.conversationId);
    expect(marker.uuid).toBe(`kangentic-truncated:${options.conversationId}:${marker.earlierHistory.position}`);
    // At or after, not at: the tail's first line can be a record that yields no
    // entry (a Codex `turn_context`, a Kimi `StatusUpdate`). The comparison with
    // the whole-file parse pins exactly where it is.
    expect(entries[1]?.origin?.position).toBeGreaterThanOrEqual(marker.earlierHistory.position);
    return { entries: entries.slice(1), cursor: marker.earlierHistory.cursor, tailStart: marker.earlierHistory.position };
  } finally {
    setParseWindowBytesForTests();
  }
}

/** What `walkHistoryPages` read: the whole file, the tail, and the pages both ways. */
export interface HistoryPageWalk {
  /** A whole-file parse. */
  whole: TranscriptEntry[];
  /** The tail's entries after its notice. */
  tail: TranscriptEntry[];
  /** The byte the tail starts at, where the last page each way ends. */
  tailStart: number;
  /** Pages read backward from the notice's cursor to byte 0, oldest first. */
  backward: Page[];
  /** Pages read forward from byte 0 up to the tail. */
  forward: Page[];
}

/**
 * Walk the pages both ways, asserting their edges tile the file's bytes and
 * every whole-file entry's origin sits at a line start. Leaves comparing the
 * entries to the caller: `expectPagesTile` for an adapter whose pages parse
 * exactly what the whole file does, its own comparison for one whose state
 * crosses lines.
 */
export async function walkHistoryPages(options: TilingOptions): Promise<HistoryPageWalk> {
  setParseWindowBytesForTests(64 * 1024 * 1024);
  let whole: TranscriptEntry[];
  try {
    whole = await options.parseTail();
  } finally {
    setParseWindowBytesForTests();
  }
  expect(whole.length).toBeGreaterThan(0);
  const starts = lineStartsOf(options.filePath);
  for (const entry of whole) {
    expect(entry.origin?.conversationId).toBe(options.conversationId);
    expect(starts.has(entry.origin?.position ?? -1)).toBe(true);
  }

  const tail = await pagedTail(options);

  const backward: Page[] = [];
  let cursor = tail.cursor;
  let expectedEnd = tail.tailStart;
  for (let guard = 0; guard < 1000; guard += 1) {
    const page = okPage(await options.readPage({ direction: 'before', cursor, maxBytes: options.pageBytes }));
    expect(page.endPosition).toBe(expectedEnd);
    backward.unshift(page);
    if (page.reachedStart) break;
    expect(page.startPosition).toBeLessThan(page.endPosition);
    expectedEnd = page.startPosition;
    cursor = page.startCursor;
  }
  expect(backward[0].startPosition).toBe(0);

  const forward: Page[] = [];
  cursor = 'j:0';
  let expectedStart = 0;
  for (let guard = 0; guard < 1000; guard += 1) {
    const page = okPage(await options.readPage({ direction: 'after', cursor, maxBytes: options.pageBytes, untilPosition: tail.tailStart }));
    expect(page.startPosition).toBe(expectedStart);
    forward.push(page);
    if (page.reachedEnd) break;
    expectedStart = page.endPosition;
    cursor = page.endCursor;
  }
  expect(forward[forward.length - 1].endPosition).toBe(tail.tailStart);
  return { whole, tail: tail.entries, tailStart: tail.tailStart, backward, forward };
}

/** Assert the pages tile the file both ways, and return the whole-file entries. */
export async function expectPagesTile(options: TilingOptions): Promise<TranscriptEntry[]> {
  const walk = await walkHistoryPages(options);
  expect(walk.backward.flatMap((page) => page.entries).concat(walk.tail)).toEqual(walk.whole);
  expect(walk.forward.flatMap((page) => page.entries).concat(walk.tail)).toEqual(walk.whole);
  return walk.whole;
}
