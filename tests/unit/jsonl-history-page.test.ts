import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  parseClaudeTranscript,
  parseClaudeTranscriptWindow,
  readClaudeTranscriptPage,
  resetIncrementalParseStateForTests,
} from '../../src/main/agent/adapters/claude/transcript-parser';
import { parseCodexTranscript, readCodexTranscriptPage } from '../../src/main/agent/adapters/codex/transcript-parser';
import { setParseWindowBytesForTests } from '../../src/main/agent/shared/transcript-truncation';
import {
  decodeJsonlCursor,
  PAGE_READ_BUDGET_MS,
  readJsonlHistoryPage,
  splitJsonlLines,
  type JsonlLine,
} from '../../src/main/agent/shared/jsonl-history-page';
import type { TranscriptEntry, TranscriptHistoryPage } from '../../src/shared/types';
import type { TranscriptPageReadRequest, TranscriptPageReadResult } from '../../src/main/agent/agent-adapter';
import { claudeTranscriptLines } from './helpers/claude-transcript-fixture';
import { lineStartsOf, walkHistoryPages } from './helpers/history-page-tiling';

/**
 * History pages for the Conversation viewer (`readJsonlHistoryPage`, through
 * Claude's `readClaudeTranscriptPage`). The property every page must keep:
 * walking backward from the tail's cursor, or forward from byte 0 up to the
 * tail, covers every byte exactly once and yields exactly the entries a
 * whole-file parse yields, with the same uuids and the same line-start origins.
 */

const AGENT_SESSION_ID = '11111111-2222-3333-4444-555555555555';
const PAGE_BYTES = 700;
const TAIL_BYTES = 1500;

let directory: string;
let filePath: string;

/** A deterministic pseudo-random sequence, so a failure reproduces. */
function seededRandom(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state * 1_103_515_245 + 12_345) % 2_147_483_648;
    return state / 2_147_483_648;
  };
}

function writeTranscript(options: { seed: number; turns: number; oversizedTurn?: number }): string {
  const lines = claudeTranscriptLines({ agentSessionId: AGENT_SESSION_ID, cwd: '/mock/project' });
  const random = seededRandom(options.seed);
  let text = '';
  for (let turn = 0; turn < options.turns; turn += 1) {
    // Multibyte text so a page seam can land inside a character's bytes.
    const filler = 'é漢字🙂'.repeat(Math.floor(random() * 20));
    text += lines.humanPrompt(`user-${turn}`, `Question ${turn} ${filler}`);
    if (turn === options.oversizedTurn) {
      text += lines.assistantText(`assistant-${turn}`, 'x'.repeat(PAGE_BYTES * 3));
    } else {
      text += lines.assistantText(`assistant-${turn}`, `Answer ${turn} ${filler}`);
    }
    text += lines.assistantTool(`tool-${turn}`, `toolu-${turn}`, 'Read');
    text += lines.toolResult(`result-${turn}`, `toolu-${turn}`, `content ${turn} ${filler}`);
    // Lines that yield no entry: a page made only of these walks on.
    text += lines.turnEnd(`end-${turn}`);
  }
  fs.writeFileSync(filePath, text);
  return text;
}

/** The byte each line of the file starts at. */
function lineStarts(text: string): number[] {
  const starts: number[] = [0];
  const bytes = Buffer.from(text, 'utf8');
  for (let index = 0; index < bytes.length; index += 1) {
    if (bytes[index] === 0x0a && index + 1 < bytes.length) starts.push(index + 1);
  }
  return starts;
}

async function wholeFileEntries(): Promise<TranscriptEntry[]> {
  const window = await parseClaudeTranscriptWindow(filePath, 0, 64 * 1024 * 1024);
  return window.entries;
}

function okPage(result: TranscriptPageReadResult): Omit<TranscriptHistoryPage, 'conversationId'> {
  if (result.status !== 'ok') throw new Error(`expected a page, got ${JSON.stringify(result)}`);
  return result.page;
}

async function tailOf(): Promise<{ entries: TranscriptEntry[]; cursor: string; tailStart: number }> {
  const entries = await parseClaudeTranscript(filePath);
  const marker = entries[0];
  if (marker.kind !== 'system' || marker.subtype !== 'truncated' || !marker.earlierHistory) {
    throw new Error('the tail should start with a pageable notice');
  }
  return { entries: entries.slice(1), cursor: marker.earlierHistory.cursor, tailStart: marker.earlierHistory.position };
}

beforeEach(() => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'kangentic-history-page-'));
  filePath = path.join(directory, `${AGENT_SESSION_ID}.jsonl`);
  setParseWindowBytesForTests(TAIL_BYTES);
  resetIncrementalParseStateForTests();
});

afterEach(() => {
  setParseWindowBytesForTests();
  resetIncrementalParseStateForTests();
  fs.rmSync(directory, { recursive: true, force: true });
});

describe('readJsonlHistoryPage', () => {
  it.each([1, 2, 3, 4, 5])('walking backward from the tail tiles the file and yields every entry once (seed %i)', async (seed) => {
    writeTranscript({ seed, turns: 18 });
    const whole = await wholeFileEntries();
    const tail = await tailOf();

    const pages: Array<Omit<TranscriptHistoryPage, 'conversationId'>> = [];
    let cursor = tail.cursor;
    let expectedEnd = tail.tailStart;
    for (let guard = 0; guard < 500; guard += 1) {
      const page = okPage(await readClaudeTranscriptPage(filePath, { direction: 'before', cursor, maxBytes: PAGE_BYTES }));
      expect(page.endPosition).toBe(expectedEnd);
      pages.unshift(page);
      if (page.reachedStart) break;
      expect(page.startPosition).toBeLessThan(page.endPosition);
      expectedEnd = page.startPosition;
      cursor = page.startCursor;
    }
    expect(pages[0].startPosition).toBe(0);

    const paged = pages.flatMap((page) => page.entries).concat(tail.entries);
    expect(paged.map((entry) => entry.uuid)).toEqual(whole.map((entry) => entry.uuid));
    expect(paged).toEqual(whole);
  });

  it('walking forward from byte 0 up to the tail tiles the same bytes', async () => {
    writeTranscript({ seed: 7, turns: 18 });
    const whole = await wholeFileEntries();
    const tail = await tailOf();

    const pages: Array<Omit<TranscriptHistoryPage, 'conversationId'>> = [];
    let cursor = 'j:0';
    let expectedStart = 0;
    for (let guard = 0; guard < 500; guard += 1) {
      const page = okPage(await readClaudeTranscriptPage(filePath, {
        direction: 'after', cursor, maxBytes: PAGE_BYTES, untilPosition: tail.tailStart,
      }));
      expect(page.startPosition).toBe(expectedStart);
      pages.push(page);
      if (page.reachedEnd) break;
      expectedStart = page.endPosition;
      cursor = page.endCursor;
    }
    expect(pages[pages.length - 1].endPosition).toBe(tail.tailStart);
    const paged = pages.flatMap((page) => page.entries).concat(tail.entries);
    expect(paged).toEqual(whole);
  });

  it('stamps every entry with the byte its line starts at', async () => {
    const text = writeTranscript({ seed: 11, turns: 6 });
    const starts = new Set(lineStarts(text));
    const page = okPage(await readClaudeTranscriptPage(filePath, { direction: 'after', cursor: 'j:0', maxBytes: 64 * 1024 }));
    expect(page.entries.length).toBeGreaterThan(0);
    for (const entry of page.entries) {
      expect(entry.origin?.conversationId).toBe(AGENT_SESSION_ID);
      expect(starts.has(entry.origin?.position ?? -1)).toBe(true);
    }
  });

  it('skips a line longer than a page without losing the lines around it', async () => {
    writeTranscript({ seed: 3, turns: 14, oversizedTurn: 6 });
    const whole = (await wholeFileEntries()).filter((entry) => entry.uuid !== 'assistant-6');
    const tail = await tailOf();

    const collected: TranscriptEntry[][] = [];
    let cursor = tail.cursor;
    for (let guard = 0; guard < 500; guard += 1) {
      const page = okPage(await readClaudeTranscriptPage(filePath, { direction: 'before', cursor, maxBytes: PAGE_BYTES }));
      collected.unshift(page.entries);
      if (page.reachedStart) break;
      cursor = page.startCursor;
    }
    const paged = collected.flat().concat(tail.entries.filter((entry) => entry.uuid !== 'assistant-6'));
    expect(paged.map((entry) => entry.uuid)).toEqual(whole.map((entry) => entry.uuid));
  });

  it('reads around a position as one contiguous run of whole lines', async () => {
    writeTranscript({ seed: 5, turns: 18 });
    const whole = await wholeFileEntries();
    const size = fs.statSync(filePath).size;
    const random = seededRandom(99);
    for (let probe = 0; probe < 20; probe += 1) {
      const position = Math.floor(random() * size);
      const page = okPage(await readClaudeTranscriptPage(filePath, { direction: 'around', position, maxBytes: PAGE_BYTES }));
      expect(page.startPosition).toBeLessThanOrEqual(page.endPosition);
      if (page.entries.length === 0) continue;
      const first = whole.findIndex((entry) => entry.uuid === page.entries[0].uuid);
      expect(first).toBeGreaterThanOrEqual(0);
      expect(page.entries.map((entry) => entry.uuid)).toEqual(
        whole.slice(first, first + page.entries.length).map((entry) => entry.uuid),
      );
    }
  });

  it('answers reset for a rewritten file and for a cursor past the end', async () => {
    writeTranscript({ seed: 1, turns: 8 });
    const first = okPage(await readClaudeTranscriptPage(filePath, { direction: 'after', cursor: 'j:0', maxBytes: PAGE_BYTES }));
    writeTranscript({ seed: 2, turns: 8 });
    expect(await readClaudeTranscriptPage(filePath, {
      direction: 'after', cursor: first.endCursor, maxBytes: PAGE_BYTES, sourceToken: first.sourceToken,
    })).toEqual({ status: 'reset' });
    const size = fs.statSync(filePath).size;
    expect(await readClaudeTranscriptPage(filePath, {
      direction: 'before', cursor: `j:${size + 10}`, maxBytes: PAGE_BYTES,
    })).toEqual({ status: 'reset' });
  });

  it('gives up on a page smaller than every line once it runs past its time budget', async () => {
    // A 1-byte page holds no whole line anywhere, so it skips one byte a window
    // to the end of the file. On a 97 MB transcript that ran for minutes and got
    // the worker killed; the budget answers instead.
    writeTranscript({ seed: 9, turns: 18 });
    let clock = 0;
    const nowSpy = vi.spyOn(Date, 'now').mockImplementation(() => {
      clock += 1000;
      return clock;
    });
    try {
      const result = await readClaudeTranscriptPage(filePath, { direction: 'around', position: 0, maxBytes: 1 });
      expect(result).toEqual({ status: 'unavailable', reason: 'record_too_large' });
      expect(clock).toBeLessThanOrEqual(PAGE_READ_BUDGET_MS + 3000);
    } finally {
      nowSpy.mockRestore();
    }
  });

  it('answers file_missing for a file that is gone', async () => {
    expect(await readClaudeTranscriptPage(path.join(directory, 'gone.jsonl'), {
      direction: 'before', cursor: 'j:10', maxBytes: PAGE_BYTES,
    })).toEqual({ status: 'unavailable', reason: 'file_missing' });
  });

  it('gives the tail a notice whose cursor and uuid name the conversation and its first line', async () => {
    const text = writeTranscript({ seed: 4, turns: 12 });
    const entries = await parseClaudeTranscript(filePath);
    const marker = entries[0];
    expect(marker.kind).toBe('system');
    if (marker.kind !== 'system' || !marker.earlierHistory) throw new Error('no notice');
    expect(marker.subtype).toBe('truncated');
    expect(marker.uuid).toBe(`kangentic-truncated:${AGENT_SESSION_ID}:${marker.earlierHistory.position}`);
    expect(decodeJsonlCursor(marker.earlierHistory.cursor)?.byte).toBe(marker.earlierHistory.position);
    expect(lineStarts(text)).toContain(marker.earlierHistory.position);
    // The first surviving entry starts exactly where the notice says.
    expect(entries[1].origin?.position).toBe(marker.earlierHistory.position);
  });

  it('keeps the notice uuid stable while the file grows by appends', async () => {
    writeTranscript({ seed: 6, turns: 12 });
    const before = await parseClaudeTranscript(filePath);
    const lines = claudeTranscriptLines({ agentSessionId: AGENT_SESSION_ID, cwd: '/mock/project' });
    const sizeBefore = fs.statSync(filePath).size;
    fs.appendFileSync(filePath, lines.humanPrompt('appended', 'one more'));
    const after = await parseClaudeTranscript(filePath);
    expect(after[0].uuid).toBe(before[0].uuid);
    // The incremental append stamps the new line where it starts.
    const appended = after.find((entry) => entry.uuid === 'appended');
    expect(appended?.origin?.position).toBe(sizeBefore);
  });

  it('pages a file with CRLF line ends as it pages the same file with LF, every origin a line start', async () => {
    const text = writeTranscript({ seed: 8, turns: 18 });
    // A fresh parse each time: the Claude reader remembers a file it has parsed.
    const walkOptions = {
      filePath,
      conversationId: AGENT_SESSION_ID,
      parseTail: () => {
        resetIncrementalParseStateForTests();
        return parseClaudeTranscript(filePath);
      },
      readPage: (request: TranscriptPageReadRequest) => readClaudeTranscriptPage(filePath, request),
      tailBytes: TAIL_BYTES,
      pageBytes: PAGE_BYTES,
    };
    const lf = await walkHistoryPages(walkOptions);

    fs.writeFileSync(filePath, text.replace(/\n/g, '\r\n'));
    expect(fs.readFileSync(filePath).includes(Buffer.from('\r\n'))).toBe(true);
    const crlf = await walkHistoryPages(walkOptions);
    const starts = lineStartsOf(filePath);

    // The same entries, each a CR further on for every line before it.
    expect(crlf.whole.map((entry) => entry.uuid)).toEqual(lf.whole.map((entry) => entry.uuid));
    expect(crlf.whole.length).toBeGreaterThan(40);
    const lastPosition = (entries: TranscriptEntry[]) => entries[entries.length - 1].origin?.position ?? -1;
    expect(lastPosition(crlf.whole)).toBeGreaterThan(lastPosition(lf.whole));

    for (const [direction, pages] of [['backward', crlf.backward], ['forward', crlf.forward]] as const) {
      const paged = pages.flatMap((page) => page.entries).concat(crlf.tail);
      expect(paged.map((entry) => entry.uuid), direction).toEqual(lf.whole.map((entry) => entry.uuid));
      expect(paged, direction).toEqual(crlf.whole);
      for (const entry of paged) expect(starts.has(entry.origin?.position ?? -1), `${direction} ${entry.uuid}`).toBe(true);
      // Every page edge is a line start too, so the next page reads from a whole line.
      for (const page of pages) {
        expect(starts.has(page.startPosition), `${direction} start ${page.startPosition}`).toBe(true);
        expect(page.endPosition === fs.statSync(filePath).size || starts.has(page.endPosition), `${direction} end ${page.endPosition}`).toBe(true);
      }
    }
  });
});

/** A Codex `response_item` user turn, which the Codex reader and the numbered fake below both read. */
function codexUserRecord(index: number, filler: string): object {
  return {
    type: 'response_item',
    timestamp: new Date(Date.UTC(2026, 5, 12, 10, 0, index)).toISOString(),
    payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: `turn ${index} ${filler}` }] },
  };
}

interface NumberedRecord {
  timestamp: string;
  payload: { content: Array<{ text: string }> };
}

/**
 * A parser whose uuids number lines, as Codex's do, in the smallest form: the
 * uuid is `line-<physical line index>`, so an entry parsed without its line
 * shows as `line-null` instead of passing for another line.
 */
function mintNumberedEntries(lines: JsonlLine[]): TranscriptEntry[] {
  const entries: TranscriptEntry[] = [];
  for (const line of lines) {
    if (line.text.length === 0) continue;
    const record = JSON.parse(line.text) as NumberedRecord;
    entries.push({
      kind: 'user',
      uuid: `line-${line.line}`,
      ts: Date.parse(record.timestamp),
      text: record.payload.content[0].text,
      origin: { conversationId: AGENT_SESSION_ID, position: line.byte },
    });
  }
  return entries;
}

describe('readJsonlHistoryPage for an adapter whose uuids number lines', () => {
  const LINE_COUNT = 60;
  /** The line a page cannot hold whole: three pages long. */
  const OVERSIZED_LINE = 25;
  const CODEX_SESSION_ID = 'codex-session-numbered';

  let text: string;
  let lineStartBytes: number[];
  let whole: TranscriptEntry[];

  function writeNumberedFile(oversizedLine?: number): void {
    text = '';
    for (let index = 0; index < LINE_COUNT; index += 1) {
      // Multibyte filler, so a line's bytes are not its characters.
      const filler = index === oversizedLine ? 'x'.repeat(PAGE_BYTES * 3) : 'é漢'.repeat(index % 4);
      text += `${JSON.stringify(codexUserRecord(index, filler))}\n`;
    }
    fs.writeFileSync(filePath, text);
    lineStartBytes = lineStarts(text);
    whole = mintNumberedEntries(splitJsonlLines(text, 0, 0));
    // The reference is the file's own lines, numbered from 0, each at its start byte.
    expect(lineStartBytes).toHaveLength(LINE_COUNT);
    expect(whole.map((entry) => entry.origin?.position)).toEqual(lineStartBytes);
  }

  function newlinesBefore(byte: number): number {
    let count = 0;
    for (const value of Buffer.from(text, 'utf8').subarray(0, byte)) {
      if (value === 0x0a) count += 1;
    }
    return count;
  }

  async function readNumbered(request: TranscriptPageReadRequest) {
    const parseLines = vi.fn(mintNumberedEntries);
    const page = okPage(await readJsonlHistoryPage({ filePath, request, countLines: true, parseLines }));
    return { page, parseLines };
  }

  /** The whole-file entries of the lines a page covers, less any line it skipped. */
  function wholeLinesOf(page: { startPosition: number; endPosition: number }, skippedLine?: number): TranscriptEntry[] {
    return whole.filter((entry, index) => {
      const position = entry.origin?.position ?? -1;
      return position >= page.startPosition && position < page.endPosition && index !== skippedLine;
    });
  }

  /** Every cursor of a page names the physical lines before its byte. */
  function expectCursorsCountLines(page: { startCursor: string; endCursor: string }): void {
    for (const cursorText of [page.startCursor, page.endCursor]) {
      const cursor = decodeJsonlCursor(cursorText);
      expect(cursor, cursorText).not.toBeNull();
      expect(cursor?.line, cursorText).toBe(newlinesBefore(cursor?.byte ?? 0));
    }
  }

  function lastParseWasNumbered(parseLines: { mock: { calls: JsonlLine[][][] } }): boolean {
    const calls = parseLines.mock.calls;
    return calls[calls.length - 1][0].every((line) => line.line !== null);
  }

  describe('a page with no line longer than itself', () => {
    beforeEach(() => writeNumberedFile());

    it.each([
      ['before', () => ({ direction: 'before' as const, cursor: `j:${lineStartBytes[40]}:40`, maxBytes: PAGE_BYTES })],
      ['after', () => ({ direction: 'after' as const, cursor: `j:${lineStartBytes[20]}:20`, maxBytes: PAGE_BYTES })],
      ['around', () => ({ direction: 'around' as const, position: lineStartBytes[30] + 20, maxBytes: PAGE_BYTES })],
    ])('parses the %s page numbered the first time, and once', async (_direction, makeRequest) => {
      const { page, parseLines } = await readNumbered(makeRequest());

      expect(page.entries.length).toBeGreaterThan(1);
      expect(page.entries).toEqual(wholeLinesOf(page));
      expectCursorsCountLines(page);
      // Every line reached the parser with its line known, so nothing was parsed over.
      expect(parseLines).toHaveBeenCalledTimes(1);
      expect(parseLines.mock.calls[0][0].every((line) => line.line !== null)).toBe(true);
    });

    it.each([
      ['before', () => ({ direction: 'before' as const, cursor: `j:${lineStartBytes[40]}`, maxBytes: PAGE_BYTES })],
      ['after', () => ({ direction: 'after' as const, cursor: `j:${lineStartBytes[20]}`, maxBytes: PAGE_BYTES })],
    ])('numbers the %s page from the start of the file when its cursor carries no line count', async (_direction, makeRequest) => {
      const { page, parseLines } = await readNumbered(makeRequest());

      expect(page.entries.length).toBeGreaterThan(1);
      expect(page.entries).toEqual(wholeLinesOf(page));
      expectCursorsCountLines(page);
      expect(lastParseWasNumbered(parseLines)).toBe(true);
    });
  });

  describe('a page whose walk passes a line longer than the page', () => {
    beforeEach(() => writeNumberedFile(OVERSIZED_LINE));

    it.each([
      ['before', () => ({ direction: 'before' as const, cursor: `j:${lineStartBytes[OVERSIZED_LINE + 1]}:${OVERSIZED_LINE + 1}`, maxBytes: PAGE_BYTES })],
      ['after', () => ({ direction: 'after' as const, cursor: `j:${lineStartBytes[OVERSIZED_LINE]}:${OVERSIZED_LINE}`, maxBytes: PAGE_BYTES })],
      // An `around` read starts half a page before its position, here 850 bytes before the
      // long line's end. Its first window sits wholly inside the line, and its second holds
      // the line's last 150 bytes and then 550 bytes of the normal lines after it.
      ['around', () => ({ direction: 'around' as const, position: lineStartBytes[OVERSIZED_LINE + 1] - 500, maxBytes: PAGE_BYTES })],
    ])('numbers the lines of the %s page after the skip as a whole-file parse does', async (direction, makeRequest) => {
      const { page, parseLines } = await readNumbered(makeRequest());

      // The long line is left out, and the lines on the far side of it are all
      // there: `before` reads the lines ahead of it, `after` and `around` those behind it.
      const uuids = page.entries.map((entry) => entry.uuid);
      expect(uuids).not.toContain(`line-${OVERSIZED_LINE}`);
      expect(uuids).not.toContain('line-null');
      expect(uuids).toContain(direction === 'before' ? `line-${OVERSIZED_LINE - 1}` : `line-${OVERSIZED_LINE + 1}`);
      expect(page.entries.length).toBeGreaterThan(1);
      expect(page.entries).toEqual(wholeLinesOf(page, OVERSIZED_LINE));
      expectCursorsCountLines(page);
      // The windows after the skip had no line to start from, so they were parsed again with one.
      expect(parseLines.mock.calls.length).toBeGreaterThan(1);
      expect(lastParseWasNumbered(parseLines)).toBe(true);
    });

    it('walks a Codex rollout through the long line, both ways, with the uuids of a whole-file parse', async () => {
      const walk = await walkHistoryPages({
        filePath,
        conversationId: CODEX_SESSION_ID,
        parseTail: () => parseCodexTranscript(CODEX_SESSION_ID, filePath),
        readPage: (request) => readCodexTranscriptPage(CODEX_SESSION_ID, filePath, request),
        tailBytes: TAIL_BYTES,
        pageBytes: PAGE_BYTES,
      });

      // Codex names an entry by its line, from the start of the file.
      expect(walk.whole.map((entry) => entry.uuid)).toEqual(Array.from({ length: LINE_COUNT }, (_, index) => `${CODEX_SESSION_ID}:${index}`));
      const expected = walk.whole.filter((entry) => entry.uuid !== `${CODEX_SESSION_ID}:${OVERSIZED_LINE}`);
      expect(expected).toHaveLength(LINE_COUNT - 1);
      expect(walk.backward.flatMap((page) => page.entries).concat(walk.tail)).toEqual(expected);
      expect(walk.forward.flatMap((page) => page.entries).concat(walk.tail)).toEqual(expected);
    });
  });

  describe('a timeline probe', () => {
    beforeEach(() => writeNumberedFile());

    it('leaves the line count out of its cursors and answers the entries a counted read does, with their positions and times', async () => {
      const request = { direction: 'around' as const, position: lineStartBytes[30] + 20, maxBytes: PAGE_BYTES };
      const counted = await readNumbered(request);
      const probed = await readNumbered({ ...request, probe: true });

      // A counted read numbers its cursors, which is what the probe saves.
      expect(decodeJsonlCursor(counted.page.startCursor)?.line).toBe(newlinesBefore(counted.page.startPosition));
      expect(decodeJsonlCursor(counted.page.endCursor)?.line).toBe(newlinesBefore(counted.page.endPosition));
      expect(decodeJsonlCursor(probed.page.startCursor)).toEqual({ byte: probed.page.startPosition, line: null });
      expect(decodeJsonlCursor(probed.page.endCursor)).toEqual({ byte: probed.page.endPosition, line: null });

      expect(probed.page.entries.length).toBeGreaterThan(1);
      expect(probed.page.startPosition).toBe(counted.page.startPosition);
      expect(probed.page.endPosition).toBe(counted.page.endPosition);
      expect(probed.page.entries.map((entry) => entry.origin?.position)).toEqual(wholeLinesOf(probed.page).map((entry) => entry.origin?.position));
      expect(probed.page.entries.map((entry) => entry.ts)).toEqual(wholeLinesOf(probed.page).map((entry) => entry.ts));
      expect(probed.page.entries.every((entry) => entry.ts > 0)).toBe(true);
    });

    it('answers a Codex probe with each entry at its line start and dated, and no line count in its cursors', async () => {
      const request = { direction: 'around' as const, position: lineStartBytes[30] + 20, maxBytes: PAGE_BYTES };
      const starts = lineStartsOf(filePath);
      const counted = okPage(await readCodexTranscriptPage(CODEX_SESSION_ID, filePath, request));
      const probed = okPage(await readCodexTranscriptPage(CODEX_SESSION_ID, filePath, { ...request, probe: true }));

      expect(decodeJsonlCursor(counted.startCursor)?.line).not.toBeNull();
      expect(decodeJsonlCursor(probed.startCursor)?.line).toBeNull();
      expect(decodeJsonlCursor(probed.endCursor)?.line).toBeNull();
      expect(probed.entries.length).toBeGreaterThan(1);
      for (const entry of probed.entries) {
        expect(starts.has(entry.origin?.position ?? -1)).toBe(true);
        expect(entry.ts).toBeGreaterThan(0);
      }
      expect(probed.entries.map((entry) => [entry.origin?.position, entry.ts]))
        .toEqual(counted.entries.map((entry) => [entry.origin?.position, entry.ts]));
    });
  });
});
