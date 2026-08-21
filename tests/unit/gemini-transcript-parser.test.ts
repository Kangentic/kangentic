import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseGeminiTranscript } from '../../src/main/agent/adapters/gemini/transcript-parser';
import { setParseWindowBytesForTests } from '../../src/main/agent/shared/transcript-truncation';

const SESSION_ID = '7d21b8e4-5a63-4f0c-b19d-3e8a2c6f4b70';

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
      { kind: 'user', uuid: 'u1', ts: expect.any(Number), text: 'real prompt' },
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
  });
});
