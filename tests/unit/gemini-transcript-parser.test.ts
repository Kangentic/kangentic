import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseGeminiTranscript, readGeminiTranscriptPage } from '../../src/main/agent/adapters/gemini/transcript-parser';
import { setParseWindowBytesForTests } from '../../src/main/agent/shared/transcript-truncation';
import type { TranscriptEntry } from '../../src/shared/types';
import { expectPagesTile } from './helpers/history-page-tiling';

const SESSION_ID = '7d21b8e4-5a63-4f0c-b19d-3e8a2c6f4b70';

/** Write `lines` as a JSONL file with a trailing newline, as Gemini does. */
function writeSessionFile(lines: string[]): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gemini-transcript-'));
  const file = path.join(dir, 'session.jsonl');
  fs.writeFileSync(file, `${lines.join('\n')}\n`);
  return file;
}

/** The byte each of `lines` starts at once written by `writeSessionFile`. */
function lineStartBytes(lines: string[]): number[] {
  const starts: number[] = [];
  let byte = 0;
  for (const line of lines) {
    starts.push(byte);
    byte += Buffer.byteLength(line, 'utf8') + 1;
  }
  return starts;
}

/** Whether a line is a standalone message, the kind of line that yields an entry. */
function isMessageLine(line: string): boolean {
  const record: unknown = JSON.parse(line);
  return typeof record === 'object' && record !== null && 'type' in record
    && (record.type === 'user' || record.type === 'gemini');
}

/**
 * A tail size near `target` whose window opens exactly on a line `opensTail`
 * accepts. A tail read from byte `start - 1` drops through that newline and
 * opens on the line at `start`, and the shared tiling check needs the tail's
 * first line to yield its first entry.
 */
function tailBytesOpeningOn(lines: string[], opensTail: (line: string) => boolean, target: number): number {
  const starts = lineStartBytes(lines);
  const size = starts[starts.length - 1] + Buffer.byteLength(lines[lines.length - 1], 'utf8') + 1;
  const index = lines.findIndex((line, lineIndex) => lineIndex > 0 && size - starts[lineIndex] <= target && opensTail(line));
  if (index === -1) throw new Error('no line opens a tail that small');
  return size - starts[index] + 1;
}

/** Keep, per uuid, the copy from the later position, as the viewer's merge
 *  does with entries read on both sides of a seam. */
function keepLaterCopies(entries: TranscriptEntry[]): TranscriptEntry[] {
  const latest = new Map<string, number>();
  for (const entry of entries) {
    latest.set(entry.uuid, Math.max(latest.get(entry.uuid) ?? -1, entry.origin?.position ?? -1));
  }
  return entries.filter((entry) => (entry.origin?.position ?? -1) === latest.get(entry.uuid));
}

function writeFixture(lines: string[]): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gemini-transcript-'));
  const file = path.join(dir, 'session.jsonl');
  fs.writeFileSync(file, lines.join('\n'));
  return file;
}

/** Enough id-less standalone `user` message lines to overflow `cap` several
 *  times over, each one identifiable by the index embedded in its text.
 *  `startIndex` lets a caller append a second, distinct batch to simulate
 *  the file growing. */
function buildOverCapIdLessLines(cap: number, startIndex = 0): { lines: string[]; lastLineIndex: number } {
  const lines: string[] = [];
  let written = 0;
  let lineIndex = startIndex;
  while (written <= cap * 3) {
    const fixtureLine = JSON.stringify({ type: 'user', content: [{ text: `turn ${lineIndex} ${'q'.repeat(200)}` }] });
    lines.push(fixtureLine);
    written += Buffer.byteLength(fixtureLine, 'utf-8') + 1;
    lineIndex += 1;
  }
  return { lines, lastLineIndex: lineIndex - 1 };
}

describe('parseGeminiTranscript', () => {
  let tmpFile: string | null = null;
  afterEach(() => {
    if (tmpFile) {
      try { fs.rmSync(path.dirname(tmpFile), { recursive: true, force: true }); } catch { /* ignore */ }
      tmpFile = null;
    }
  });

  it('returns [] for a missing file', async () => {
    const entries = await parseGeminiTranscript(SESSION_ID, path.join(os.tmpdir(), 'gemini-missing.jsonl'));
    expect(entries).toEqual([]);
  });

  it('gives id-less messages distinct session-scoped uuids rather than a shared empty one', async () => {
    // The map key used to fall back to `gemini-${size}` while the emitted uuid
    // fell back to `''`, so id-less messages were keyed apart but then all
    // shared one uuid - and the task stitch dedups by uuid, keeping the first.
    tmpFile = writeFixture([
      JSON.stringify({ type: 'user', content: [{ text: 'first' }] }),
      JSON.stringify({ type: 'user', content: [{ text: 'second' }] }),
    ]);
    const entries = await parseGeminiTranscript(SESSION_ID, tmpFile);

    expect(entries).toHaveLength(2);
    expect(entries.map((entry) => entry.uuid)).toEqual([`${SESSION_ID}:0`, `${SESSION_ID}:1`]);
  });

  it('treats an explicit empty-string id the same as a missing one', async () => {
    // The map KEY is the uuid, so this is the sharpest case: an unguarded `''`
    // id would make both messages collide on the SAME map key and the second
    // would silently overwrite the first (last-wins), not just share a uuid -
    // one message would vanish from the parse entirely, before the task stitch
    // ever runs.
    tmpFile = writeFixture([
      JSON.stringify({ type: 'user', id: '', content: [{ text: 'first' }] }),
      JSON.stringify({ type: 'user', id: '', content: [{ text: 'second' }] }),
    ]);
    const entries = await parseGeminiTranscript(SESSION_ID, tmpFile);

    expect(entries).toHaveLength(2);
    expect(entries.map((entry) => entry.uuid)).toEqual([`${SESSION_ID}:0`, `${SESSION_ID}:1`]);
  });

  it('distinguishes id-less messages seeded from the same $set line', async () => {
    // One `$set` line seeds several messages, so the line alone is not unique.
    // A second line is needed for this to stay JSONL - a lone `{...}` with no
    // newline is the LEGACY single-object form and takes a different branch.
    tmpFile = writeFixture([
      JSON.stringify({ $set: { messages: [
        { type: 'user', content: [{ text: 'first' }] },
        { type: 'user', content: [{ text: 'second' }] },
      ] } }),
      JSON.stringify({ type: 'user', id: 'm-3', content: [{ text: 'third' }] }),
    ]);
    const entries = await parseGeminiTranscript(SESSION_ID, tmpFile);

    expect(entries).toHaveLength(3);
    expect(entries.map((entry) => entry.uuid)).toEqual([
      `${SESSION_ID}:0.0`,
      `${SESSION_ID}:0.1`,
      'm-3',
    ]);
  });

  it('dedupes a re-emitted message by id, last emission wins', async () => {
    tmpFile = writeFixture([
      JSON.stringify({ sessionId: 's', startTime: 't', kind: 'main' }),
      JSON.stringify({ id: 'g1', type: 'gemini', content: '', model: 'gemini-3-pro', thoughts: [] }),
      JSON.stringify({ id: 'g1', type: 'gemini', content: 'final text', model: 'gemini-3-pro', thoughts: [] }),
    ]);
    const entries = await parseGeminiTranscript(SESSION_ID, tmpFile);
    // Exactly one assistant entry, carrying the LAST emission's content.
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ kind: 'assistant', blocks: [{ type: 'text', text: 'final text' }] });
  });

  it('skips the injected session_context opening turn', async () => {
    tmpFile = writeFixture([
      JSON.stringify({ sessionId: 's', startTime: 't' }),
      JSON.stringify({ $set: { messages: [{ id: 'seed', type: 'user', content: [{ text: '<session_context>\nintro\n</session_context>' }] }] } }),
      JSON.stringify({ id: 'u1', type: 'user', content: [{ text: 'real prompt' }] }),
    ]);
    const entries = await parseGeminiTranscript(SESSION_ID, tmpFile);
    expect(entries).toEqual([
      {
        kind: 'user', uuid: 'u1', ts: expect.any(Number), text: 'real prompt',
        origin: { conversationId: SESSION_ID, position: expect.any(Number) },
      },
    ]);
  });

  it('gives an id-less message in the legacy single-document form a session-scoped uuid', async () => {
    // The legacy branch calls `addMessage(message, 0, index)`, so an id-less
    // message there should fall back to `${agentSessionId}:0.<index>` - but
    // the only test that reaches this branch (below) gives every message an
    // `id`, so the literal `0` line-index argument is never asserted.
    tmpFile = writeFixture([
      JSON.stringify({
        messages: [
          { id: 'u1', type: 'user', content: [{ text: 'first' }] },
          { type: 'gemini', content: 'unlabeled reply', model: 'gemini-3-pro', thoughts: [] },
        ],
      }),
    ]);

    const entries = await parseGeminiTranscript(SESSION_ID, tmpFile);
    expect(entries).toHaveLength(2);
    expect(entries[0]).toMatchObject({ kind: 'user', uuid: 'u1', text: 'first' });
    expect(entries[1]).toMatchObject({
      kind: 'assistant',
      uuid: `${SESSION_ID}:0.1`,
      blocks: [{ type: 'text', text: 'unlabeled reply' }],
    });
  });

  it('parses the legacy single-JSON-document form (one line, no newlines)', async () => {
    // The legacy branch is gated on the whole file containing ZERO newlines
    // (transcript-parser.ts's `!trimmed.includes('\n')`), so it is reachable
    // only when the entire session is one physical line. Nothing else in this
    // suite exercises it: every other fixture is multi-line JSONL and takes the
    // line loop instead. Any reader that hands the parser text line by line, or
    // that reads only a trailing window of a file, stops satisfying that gate
    // and silently drops the whole conversation to zero entries.
    tmpFile = writeFixture([
      JSON.stringify({
        messages: [
          { id: 'u1', type: 'user', content: [{ text: 'legacy prompt' }] },
          { id: 'g1', type: 'gemini', content: 'legacy reply', model: 'gemini-3-pro', thoughts: [] },
        ],
      }),
    ]);

    const entries = await parseGeminiTranscript(SESSION_ID, tmpFile);
    expect(entries).toHaveLength(2);
    expect(entries[0]).toMatchObject({ kind: 'user', uuid: 'u1', text: 'legacy prompt' });
    expect(entries[1]).toMatchObject({
      kind: 'assistant',
      uuid: 'g1',
      model: 'gemini-3-pro',
      blocks: [{ type: 'text', text: 'legacy reply' }],
    });
    // One line holds nothing to page. Its entries carry no origin, and the
    // page read declines the form.
    expect(entries.every((entry) => entry.origin === undefined)).toBe(true);
    await expect(readGeminiTranscriptPage(SESSION_ID, tmpFile, { direction: 'around', position: 0, maxBytes: 1024 }))
      .resolves.toEqual({ status: 'unavailable', reason: 'unsupported_agent' });
  });

  it('does not mis-parse a legacy single-document session that exceeded the parse cap', async () => {
    // The legacy branch is detected by the file containing no newlines. A TAIL
    // WINDOW of an oversized legacy document also contains no newline, but it
    // is a fragment whose opening brace was cut off - so without an explicit
    // "did we read the whole file" guard it would take the legacy branch,
    // fail to parse, and return zero entries with no explanation at all.
    setParseWindowBytesForTests(512);
    try {
      const messages = Array.from({ length: 40 }, (unused, index) => ({
        id: `u${index}`,
        type: 'user',
        content: [{ text: `legacy prompt ${index} ${'y'.repeat(40)}` }],
      }));
      tmpFile = writeFixture([JSON.stringify({ messages })]);
      expect(fs.statSync(tmpFile).size).toBeGreaterThan(512);

      const entries = await parseGeminiTranscript(SESSION_ID, tmpFile);

      // Whatever else happens, the user is TOLD the transcript was cut rather
      // than being shown a silently empty conversation.
      expect(entries[0]).toMatchObject({ kind: 'system', subtype: 'truncated' });
      // It offers no earlier history to page either. The document is one
      // line, and the page read declines it.
      expect(entries[0]).not.toHaveProperty('earlierHistory');
      await expect(readGeminiTranscriptPage(SESSION_ID, tmpFile, { direction: 'around', position: 0, maxBytes: 512 }))
        .resolves.toEqual({ status: 'unavailable', reason: 'unsupported_agent' });
    } finally {
      setParseWindowBytesForTests();
    }
  });

  it('keeps a fallback uuid stable when id-less messages grow past the cap and the window slides', async () => {
    // `countOmittedLines: true` is functionally dead unless a test combines
    // BOTH an id-less message (the only path that reads `lineIndexBase`) and
    // a transcript that outgrows the parse cap. The only other over-cap test
    // in this suite goes through the LEGACY single-document branch, a
    // different code path entirely - deleting `countOmittedLines: true` here
    // makes zero tests in this file fail.
    const cap = 2 * 1024;
    setParseWindowBytesForTests(cap);
    try {
      const { lines } = buildOverCapIdLessLines(cap);
      tmpFile = writeFixture(lines);
      const before = await parseGeminiTranscript(SESSION_ID, tmpFile);

      // Append only a couple of turns, so the window slides far enough to
      // drop the oldest but still overlaps the previous one.
      const appended = [0, 1].map((offset) => JSON.stringify({
        type: 'user',
        content: [{ text: `turn ${lines.length + offset} ${'q'.repeat(200)}` }],
      }));
      fs.writeFileSync(tmpFile, [...lines, ...appended].join('\n'));
      const after = await parseGeminiTranscript(SESSION_ID, tmpFile);

      // The window slid: the oldest turn of the first parse is gone from the
      // second, which is what makes this a real test of the sliding case.
      const firstTurn = before.find((entry) => entry.kind === 'user');
      const lastTurnBefore = before[before.length - 1];
      expect(after.some((entry) => entry.uuid === firstTurn!.uuid)).toBe(false);

      // ...but a turn present in BOTH windows keeps the SAME uuid.
      const sameTurnAfter = after.find(
        (entry) => entry.kind === 'user' && lastTurnBefore.kind === 'user' && entry.text === lastTurnBefore.text,
      );
      expect(sameTurnAfter).toBeDefined();
      expect(sameTurnAfter!.uuid).toBe(lastTurnBefore.uuid);
    } finally {
      setParseWindowBytesForTests();
    }
  });

  it('parses the pinned fixture: thoughts -> thinking, toolCalls -> tool_use + tool_result', async () => {
    const fixturePath = path.join(__dirname, '..', 'fixtures', 'gemini-real-session.jsonl');
    const entries = await parseGeminiTranscript(SESSION_ID, fixturePath);
    expect(entries.map((entry) => entry.kind)).toEqual(['user', 'assistant', 'tool_result']);
    expect(entries[0]).toMatchObject({ kind: 'user', text: 'List the files in this directory.' });
    expect(entries[1]).toMatchObject({
      kind: 'assistant',
      model: 'gemini-3-pro-preview',
      blocks: [
        { type: 'thinking', text: 'Planning the listing: I will enumerate the workspace files.' },
        { type: 'text', text: 'Here are the files.' },
        { type: 'tool_use', id: 'call_g1', name: 'list_dir' },
      ],
    });
    expect(entries[2]).toMatchObject({ kind: 'tool_result', toolUseId: 'call_g1', content: 'file1.txt\nfile2.txt' });
    // A real current-generation file is not mistaken for the legacy document.
    const page = await readGeminiTranscriptPage(SESSION_ID, fixturePath, { direction: 'around', position: 0, maxBytes: 64 * 1024 });
    expect(page.status).toBe('ok');
  });

  it('pages its history in tiles that add up to the whole file, line-numbered uuids included', async () => {
    // No message is re-emitted here. A re-emission couples two lines, and
    // whether a seam falls between them depends on the page sizes. The test
    // below pins that case with the seam placed on purpose.
    const at = (minute: number): string => new Date(Date.UTC(2026, 9, 1, 9, minute)).toISOString();
    const lines = [
      JSON.stringify({ sessionId: SESSION_ID, projectHash: '4c1e9a07', startTime: at(0), lastUpdated: at(0), kind: 'main' }),
      // The seeding `$set` holds the CLI's injected context turn (no entry) and
      // an id-less opening prompt, named by its line and its index within it.
      JSON.stringify({ $set: { messages: [
        { id: 'seed', type: 'user', timestamp: at(0), content: [{ text: '<session_context>\nworkspace: /mock/petclinic\n</session_context>' }] },
        { type: 'user', timestamp: at(0), content: [{ text: 'Find where owners are searched by last name.' }] },
      ] } }),
    ];
    for (let turn = 1; turn <= 12; turn += 1) {
      const timestamp = at(turn);
      // Every third prompt has no id of its own, so it is named by its line.
      const id = turn % 3 === 0 ? {} : { id: `user-${turn}` };
      lines.push(JSON.stringify({ ...id, timestamp, type: 'user', content: [{ text: `question ${turn} ${'é漢'.repeat(turn % 4)}` }] }));
      lines.push(JSON.stringify({
        id: `gemini-${turn}`, timestamp, type: 'gemini', model: 'gemini-3-pro-preview', content: `answer ${turn}`,
        thoughts: [{ subject: 'Planning', description: `read owner file ${turn}`, timestamp }],
        toolCalls: [{
          id: `call-${turn}`, name: 'read_file', args: { path: `src/owner-${turn}.ts` }, status: 'success',
          result: [{ functionResponse: { id: `call-${turn}`, name: 'read_file', response: { output: `contents ${turn}` } } }],
        }],
      }));
      // A patch that only moves `lastUpdated` yields no entry.
      lines.push(JSON.stringify({ $set: { lastUpdated: timestamp } }));
    }
    // A line longer than a page is skipped unparsed, so every line must fit one.
    for (const line of lines) expect(Buffer.byteLength(line, 'utf8')).toBeLessThan(700);
    tmpFile = writeSessionFile(lines);
    const filePath = tmpFile;

    const whole = await expectPagesTile({
      filePath,
      conversationId: SESSION_ID,
      parseTail: () => parseGeminiTranscript(SESSION_ID, filePath),
      readPage: (request) => readGeminiTranscriptPage(SESSION_ID, filePath, request),
      tailBytes: tailBytesOpeningOn(lines, isMessageLine, 1500),
      pageBytes: 700,
    });
    // Turn 3's prompt sits on line 8, well before the tail.
    expect(whole.some((entry) => entry.uuid === `${SESSION_ID}:8`)).toBe(true);
    expect(whole.some((entry) => entry.uuid === `${SESSION_ID}:1.1`)).toBe(true);
  });

  it('pages a re-emitted message on each side of a seam, and the merge keeps the copy the whole file keeps', async () => {
    const timestamp = '2026-10-01T09:00:00.000Z';
    const thoughts = [{ subject: 'Planning', description: 'list the workspace' }];
    const lines = [
      JSON.stringify({ sessionId: SESSION_ID, projectHash: '4c1e9a07', startTime: timestamp, lastUpdated: timestamp, kind: 'main' }),
      JSON.stringify({ id: 'u1', timestamp, type: 'user', content: [{ text: 'List the files.' }] }),
      // A streaming reply is written first without its tool call...
      JSON.stringify({ id: 'g1', timestamp, type: 'gemini', model: 'gemini-3-pro-preview', content: '', thoughts }),
      JSON.stringify({ $set: { lastUpdated: timestamp } }),
      // ...then again with it, under the same id.
      JSON.stringify({
        id: 'g1', timestamp, type: 'gemini', model: 'gemini-3-pro-preview', content: 'Here are the files.', thoughts,
        toolCalls: [{
          id: 'call-1', name: 'list_directory', args: { path: '.' }, status: 'success',
          result: [{ functionResponse: { id: 'call-1', name: 'list_directory', response: { output: 'pom.xml\nsrc' } } }],
        }],
      }),
      JSON.stringify({ id: 'u2', timestamp, type: 'user', content: [{ text: 'Open pom.xml.' }] }),
    ];
    tmpFile = writeSessionFile(lines);
    const filePath = tmpFile;
    const starts = lineStartBytes(lines);
    const whole = await parseGeminiTranscript(SESSION_ID, filePath);

    // Open the tail exactly on the second emission, so the seam separates the copies.
    setParseWindowBytesForTests(fs.statSync(filePath).size - starts[4] + 1);
    let tail: TranscriptEntry[];
    try {
      tail = await parseGeminiTranscript(SESSION_ID, filePath);
    } finally {
      setParseWindowBytesForTests();
    }
    const notice = tail[0];
    if (notice.kind !== 'system' || !notice.earlierHistory) throw new Error('expected a pageable notice');
    expect(notice.earlierHistory.position).toBe(starts[4]);
    const result = await readGeminiTranscriptPage(SESSION_ID, filePath, {
      direction: 'before', cursor: notice.earlierHistory.cursor, maxBytes: 64 * 1024,
    });
    if (result.status !== 'ok') throw new Error(`expected a page, got ${JSON.stringify(result)}`);
    expect(result.page.reachedStart).toBe(true);

    // Each side dedupes within itself, so each holds its own copy of g1 at its own line.
    const tailEntries = tail.slice(1);
    expect(result.page.entries.filter((entry) => entry.uuid === 'g1').map((entry) => entry.origin?.position)).toEqual([starts[2]]);
    expect(tailEntries.filter((entry) => entry.uuid === 'g1').map((entry) => entry.origin?.position)).toEqual([starts[4], starts[4]]);
    // The whole file keeps the later emission at its own line, which is the
    // copy the viewer keeps when the same uuid arrives from two positions.
    expect(keepLaterCopies([...result.page.entries, ...tailEntries])).toEqual(whole);
  });
});
