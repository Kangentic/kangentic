import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  parseClaudeTranscript,
  parseClaudeTranscriptWindow,
  readClaudeTranscriptPage,
  resetIncrementalParseStateForTests,
} from '../../src/main/agent/adapters/claude/transcript-parser';
import { setParseWindowBytesForTests } from '../../src/main/agent/shared/transcript-truncation';
import { decodeJsonlCursor } from '../../src/main/agent/shared/jsonl-history-page';
import type { TranscriptEntry, TranscriptHistoryPage } from '../../src/shared/types';
import type { TranscriptPageReadResult } from '../../src/main/agent/agent-adapter';
import { claudeTranscriptLines } from './helpers/claude-transcript-fixture';

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
});
