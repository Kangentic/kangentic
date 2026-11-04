import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseKimiTranscript, parseKimiTranscriptWindow, readKimiTranscriptPage } from '../../src/main/agent/adapters/kimi/transcript-parser';
import { setParseWindowBytesForTests } from '../../src/main/agent/shared/transcript-truncation';
import type { TranscriptEntry } from '../../src/shared/types';
import { walkHistoryPages, type Page } from './helpers/history-page-tiling';

// Shaped to Kimi Code CLI 2.4.1's `wire-manifest.d.ts` and `loopEventFold.ts`.
// No real session was available, so these pin our reading of the source.

const SESSION_ID = 'session_4f1c0b2a-8d3e-4a91-9c77-2b5e6f0a1d34';
const METADATA = { type: 'metadata', protocol_version: '1.5', created_at: 1_792_000_000_000 };
const BASE_TIME = 1_792_000_000_000;

const prompt = (text: string, time = BASE_TIME): object => ({ type: 'turn.prompt', agentId: 'main', input: [{ type: 'text', text }], origin: 'user', time });
const loop = (event: object, time = BASE_TIME): object => ({ type: 'context.append_loop_event', agentId: 'main', event, time });
const textPart = (text: string, time = BASE_TIME): object => loop({ type: 'content.part', stepUuid: 'step-1', part: { type: 'text', text } }, time);
const toolCall = (id: string, name: string, args: object, time = BASE_TIME): object => loop({ type: 'tool.call', stepUuid: 'step-1', toolCallId: id, name, args }, time);
const toolResult = (id: string, output: unknown, isError = false, time = BASE_TIME): object => loop({ type: 'tool.result', toolCallId: id, result: { output, isError } }, time);

function writeFixture(lines: object[]): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kimi-transcript-'));
  const file = path.join(dir, 'wire.jsonl');
  fs.writeFileSync(file, lines.map((line) => JSON.stringify(line)).join('\n'));
  return file;
}

/** The one entry Kimi builds from several records: a run of text parts, flushed as text. */
function isTextRun(entry: TranscriptEntry): boolean {
  return entry.kind === 'assistant' && entry.blocks.length === 1 && entry.blocks[0].type === 'text';
}

function textOf(entry: TranscriptEntry): string {
  if (entry.kind !== 'assistant') return '';
  return entry.blocks.map((block) => (block.type === 'text' ? block.text : '')).join('');
}

/** Where reads meet: each page's start after the first, and the tail's start. */
function seamsOf(pages: Page[], tailStart: number): number[] {
  return pages.slice(1).map((page) => page.startPosition).concat(tailStart);
}

/**
 * Compare a paged read (the pages, then the tail) to the whole-file parse.
 * Every entry one record builds matches exactly. A text run matches exactly
 * unless a seam cut it. A cut run comes back in pieces: the first keeps the
 * run's uuid, ts and origin, each later one starts past a seam the one before
 * it does not, and together they hold the run's text. Each piece is trimmed on
 * its own, so the text is compared without whitespace. Counts the runs cut and
 * the runs kept whole.
 */
function expectRunsSplitOnlyAtSeams(
  paged: TranscriptEntry[],
  whole: TranscriptEntry[],
  seams: number[],
): { cut: number; kept: number } {
  const withoutWhitespace = (text: string): string => text.replace(/\s+/g, '');
  let pagedIndex = 0;
  let cut = 0;
  let kept = 0;
  for (let wholeIndex = 0; wholeIndex < whole.length; wholeIndex += 1) {
    const wholeEntry = whole[wholeIndex];
    const first = paged[pagedIndex];
    pagedIndex += 1;
    if (!isTextRun(wholeEntry)) {
      expect(first).toEqual(wholeEntry);
      continue;
    }
    // A later piece of this run is a run the whole file never names: it ends
    // where the whole file's next entry begins.
    const nextUuid = whole[wholeIndex + 1]?.uuid;
    const pieces = [first];
    while (pagedIndex < paged.length && isTextRun(paged[pagedIndex]) && paged[pagedIndex].uuid !== nextUuid) {
      pieces.push(paged[pagedIndex]);
      pagedIndex += 1;
    }
    if (pieces.length === 1) {
      expect(first).toEqual(wholeEntry);
      kept += 1;
      continue;
    }
    cut += 1;
    expect({ uuid: first.uuid, ts: first.ts, origin: first.origin })
      .toEqual({ uuid: wholeEntry.uuid, ts: wholeEntry.ts, origin: wholeEntry.origin });
    for (let pieceIndex = 1; pieceIndex < pieces.length; pieceIndex += 1) {
      const previousStart = pieces[pieceIndex - 1].origin?.position ?? -1;
      const pieceStart = pieces[pieceIndex].origin?.position ?? -1;
      expect(seams.some((seam) => previousStart < seam && seam <= pieceStart)).toBe(true);
    }
    expect(withoutWhitespace(pieces.map(textOf).join(''))).toBe(withoutWhitespace(textOf(wholeEntry)));
  }
  expect(pagedIndex).toBe(paged.length);
  return { cut, kept };
}

/** Turns of `q`-padded prompts, past three times `cap`, ready to tail. */
function linesPastCap(cap: number): { lines: object[]; lastTurn: number } {
  const lines: object[] = [METADATA];
  let written = Buffer.byteLength(JSON.stringify(METADATA), 'utf-8') + 1;
  let turn = 0;
  while (written <= cap * 3) {
    const line = prompt(`turn ${turn} ${'q'.repeat(200)}`, BASE_TIME + turn);
    lines.push(line);
    written += Buffer.byteLength(JSON.stringify(line), 'utf-8') + 1;
    turn += 1;
  }
  return { lines, lastTurn: turn - 1 };
}

describe('parseKimiTranscript', () => {
  let tmpFile: string | null = null;
  afterEach(() => {
    if (tmpFile) {
      try { fs.rmSync(path.dirname(tmpFile), { recursive: true, force: true }); } catch { /* ignore */ }
      tmpFile = null;
    }
  });

  it('returns [] for a missing file', async () => {
    const entries = await parseKimiTranscript(SESSION_ID, path.join(os.tmpdir(), 'kimi-missing.jsonl'));
    expect(entries).toEqual([]);
  });

  it('builds a turn from its prompt, text parts, tool call and result', async () => {
    tmpFile = writeFixture([
      METADATA,
      prompt('List the files in this directory.'),
      loop({ type: 'step.begin', uuid: 'step-1' }),
      textPart('Here are '),
      textPart('the files.'),
      toolCall('tc-1', 'Bash', { command: 'ls' }),
      toolResult('tc-1', 'file1.txt\nfile2.txt\n'),
    ]);
    const entries = await parseKimiTranscript(SESSION_ID, tmpFile);
    expect(entries.map((entry) => entry.kind)).toEqual(['user', 'assistant', 'assistant', 'tool_result']);
    expect(entries[0]).toMatchObject({ kind: 'user', text: 'List the files in this directory.', ts: BASE_TIME });
    expect(entries[1]).toMatchObject({ kind: 'assistant', blocks: [{ type: 'text', text: 'Here are the files.' }] });
    expect(entries[2]).toMatchObject({ kind: 'assistant', blocks: [{ type: 'tool_use', id: 'tc-1', name: 'Bash', input: { command: 'ls' } }] });
    expect(entries[3]).toMatchObject({ kind: 'tool_result', toolUseId: 'tc-1', content: 'file1.txt\nfile2.txt\n', isError: false });

    // The exact strings are the contract (persisted citation anchors): every
    // uuid is the PHYSICAL line (line 0 is the metadata), and flushed text is
    // named by the line its FIRST part arrived on, not the one that flushed it.
    expect(entries.map((entry) => entry.uuid)).toEqual([
      `${SESSION_ID}:1`,
      `${SESSION_ID}:3`,
      `${SESSION_ID}:5`,
      `${SESSION_ID}:6`,
    ]);
  });

  it('skips thinking parts, and reads a result held as content parts', async () => {
    tmpFile = writeFixture([
      METADATA,
      loop({ type: 'content.part', stepUuid: 's', part: { type: 'think', think: 'hmm' } }),
      textPart('Answer'),
      loop({ type: 'step.end', uuid: 's' }),
      toolResult('tc-1', [{ type: 'text', text: 'from parts' }]),
    ]);
    const entries = await parseKimiTranscript(SESSION_ID, tmpFile);
    expect(entries[0]).toMatchObject({ blocks: [{ type: 'text', text: 'Answer' }] });
    expect(entries[1]).toMatchObject({ kind: 'tool_result', content: 'from parts' });
  });

  it('flags an error tool result', async () => {
    tmpFile = writeFixture([METADATA, toolResult('tc-2', 'boom', true)]);
    const entries = await parseKimiTranscript(SESSION_ID, tmpFile);
    expect(entries).toEqual([{
      kind: 'tool_result', uuid: expect.any(String), ts: BASE_TIME, toolUseId: 'tc-2', content: 'boom', isError: true,
      origin: { conversationId: SESSION_ID, position: expect.any(Number) },
    }]);
  });

  it('shows a compaction as a note, not a user turn', async () => {
    tmpFile = writeFixture([
      METADATA,
      { type: 'context.apply_compaction', summary: 'What happened so far', compactedCount: 4, time: BASE_TIME },
      { type: 'turn.prompt', input: [{ type: 'text', text: 'the summary' }], origin: 'compaction_summary', time: BASE_TIME },
    ]);
    const entries = await parseKimiTranscript(SESSION_ID, tmpFile);
    expect(entries.map((entry) => entry.kind === 'system' && entry.subtype)).toEqual(['compaction', 'compaction']);
  });

  it('parses only the tail of a transcript larger than the parse cap, marking the omission', async () => {
    const cap = 2 * 1024;
    setParseWindowBytesForTests(cap);
    try {
      const { lines, lastTurn } = linesPastCap(cap);
      tmpFile = writeFixture(lines);
      const entries = await parseKimiTranscript(SESSION_ID, tmpFile);

      expect(entries.length).toBeLessThan(lines.length);
      expect(entries.some((entry) => entry.kind === 'user' && entry.text.startsWith('turn 0 '))).toBe(false);
      expect(entries.some((entry) => entry.kind === 'user' && entry.text.startsWith(`turn ${lastTurn} `))).toBe(true);
      expect(entries[0]).toMatchObject({ kind: 'system', subtype: 'truncated' });
    } finally {
      setParseWindowBytesForTests();
    }
  });

  it('keeps a turn uuid stable when the transcript grows past the cap and the window slides', async () => {
    const cap = 2 * 1024;
    setParseWindowBytesForTests(cap);
    try {
      const { lines, lastTurn } = linesPastCap(cap);
      tmpFile = writeFixture(lines);
      const before = await parseKimiTranscript(SESSION_ID, tmpFile);

      const appended = [1, 2].map((offset) => prompt(`turn ${lastTurn + offset} ${'q'.repeat(200)}`, BASE_TIME + lastTurn + offset));
      fs.writeFileSync(tmpFile, [...lines, ...appended].map((line) => JSON.stringify(line)).join('\n'));
      const after = await parseKimiTranscript(SESSION_ID, tmpFile);

      const lastBefore = before[before.length - 1];
      const sameTurnAfter = after.find((entry) => entry.kind === 'user' && lastBefore.kind === 'user' && entry.text === lastBefore.text);
      expect(sameTurnAfter?.uuid).toBe(lastBefore.uuid);
    } finally {
      setParseWindowBytesForTests();
    }
  });

  it('namespaces uuids by session so two sessions on one task cannot collide', async () => {
    tmpFile = writeFixture([METADATA, prompt('hello')]);
    const one = await parseKimiTranscript('session-one', tmpFile);
    const two = await parseKimiTranscript('session-two', tmpFile);
    expect(one[0].uuid).toBe('session-one:1');
    expect(two[0].uuid).toBe('session-two:1');
  });

  it('gives the flushed text and the record that flushed it distinct uuids', async () => {
    tmpFile = writeFixture([METADATA, textPart('thinking out loud'), toolCall('tc-9', 'Bash', {})]);
    const entries = await parseKimiTranscript(SESSION_ID, tmpFile);
    expect(entries.map((entry) => entry.uuid)).toEqual([`${SESSION_ID}:1`, `${SESSION_ID}:2`]);
  });

  it('flushes a trailing text run left pending at the end of the file', async () => {
    tmpFile = writeFixture([METADATA, textPart('trailing thought')]);
    const entries = await parseKimiTranscript(SESSION_ID, tmpFile);
    expect(entries).toEqual([{
      kind: 'assistant', uuid: `${SESSION_ID}:1`, ts: BASE_TIME, blocks: [{ type: 'text', text: 'trailing thought' }],
      origin: { conversationId: SESSION_ID, position: expect.any(Number) },
    }]);
  });

  it('stamps a flushed text run with the line its first part starts at', async () => {
    tmpFile = writeFixture([METADATA, textPart('Here are '), textPart('the files.'), toolCall('tc-1', 'Bash', {})]);
    const lineStarts = fs.readFileSync(tmpFile, 'utf8').split('\n').reduce<number[]>(
      (starts, line) => starts.concat(starts[starts.length - 1] + Buffer.byteLength(line, 'utf8') + 1),
      [0],
    );
    const entries = await parseKimiTranscript(SESSION_ID, tmpFile);
    expect(entries.map((entry) => entry.origin?.position)).toEqual([lineStarts[1], lineStarts[3]]);
  });

  it('walks a whole file in windows, minting the uuids the whole parse mints', async () => {
    const lines: object[] = [METADATA];
    for (let turn = 0; turn < 20; turn += 1) lines.push(prompt(`question ${turn} ${'q'.repeat(120)}`, BASE_TIME + turn));
    tmpFile = writeFixture(lines);
    const whole = await parseKimiTranscript(SESSION_ID, tmpFile);

    const walked: TranscriptEntry[] = [];
    let offset = 0;
    for (let guard = 0; guard < 100; guard += 1) {
      const window = await parseKimiTranscriptWindow(SESSION_ID, tmpFile, offset, 700);
      walked.push(...window.entries);
      if (window.nextByteOffset >= window.totalBytes || window.nextByteOffset <= offset) break;
      offset = window.nextByteOffset;
    }
    expect(walked.map((entry) => entry.uuid)).toEqual(whole.map((entry) => entry.uuid));
  });

  it('pages its history in tiles that add up to the whole file, a text run cut only where a seam falls', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kimi-transcript-'));
    tmpFile = path.join(dir, 'wire.jsonl');
    const filePath = tmpFile;
    const records: object[] = [METADATA];
    for (let turn = 0; turn < 12; turn += 1) {
      let step = 0;
      const time = (): number => {
        step += 1;
        return BASE_TIME + turn * 10_000 + step * 250;
      };
      records.push(prompt(`question ${turn} ${'é漢'.repeat(turn % 4)}`, time()));
      records.push({ type: 'token_counting.measured', length: turn, tokens: turn * 100, time: time() });
      // Records vary in length from turn to turn, as real text does. Turns of
      // one length would phase-lock the seams to the same spot in every turn.
      for (const fragment of ['Reading ', `f${turn}.ts `, `to answer ${'carefully '.repeat(turn % 5)}`, `ünïcode ${'漢'.repeat(turn % 3)}.`]) {
        records.push(textPart(fragment, time()));
      }
      records.push(toolCall(`tc-${turn}`, 'Read', { path: `f${turn}.ts` }, time()));
      records.push(toolResult(`tc-${turn}`, `contents ${turn}\n${'x = 1\n'.repeat(turn % 7)}`, turn === 5, time()));
      records.push(textPart('The file holds ', time()));
      // A record that yields no entry, inside a run, which it does not end.
      records.push({ type: 'token_counting.measured', length: turn, tokens: turn * 110, time: time() });
      records.push(textPart(`${turn} lines.`, time()));
      records.push({ type: 'turn.ended', turnId: turn, reason: 'completed', time: time() });
    }
    fs.writeFileSync(filePath, records.map((record) => `${JSON.stringify(record)}\n`).join(''));

    const walk = await walkHistoryPages({
      filePath,
      conversationId: SESSION_ID,
      parseTail: () => parseKimiTranscript(SESSION_ID, filePath),
      readPage: (request) => readKimiTranscriptPage(SESSION_ID, filePath, request),
      tailBytes: 1500,
      pageBytes: 700,
    });
    // Line 1: the metadata line before the first prompt still counts.
    expect(walk.whole[0].uuid).toBe(`${SESSION_ID}:1`);

    for (const pages of [walk.backward, walk.forward]) {
      const paged = pages.flatMap((page) => page.entries).concat(walk.tail);
      const { cut, kept } = expectRunsSplitOnlyAtSeams(paged, walk.whole, seamsOf(pages, walk.tailStart));
      // Both cases happened, so neither half of the comparison is vacuous.
      expect(cut).toBeGreaterThan(0);
      expect(kept).toBeGreaterThan(0);
    }
  });
});
