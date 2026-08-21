import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseGeminiTranscript } from '../../src/main/agent/adapters/gemini/transcript-parser';
import { setParseWindowBytesForTests } from '../../src/main/agent/shared/transcript-truncation';

function writeFixture(lines: string[]): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gemini-transcript-'));
  const file = path.join(dir, 'session.jsonl');
  fs.writeFileSync(file, lines.join('\n'));
  return file;
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
    const entries = await parseGeminiTranscript(path.join(os.tmpdir(), 'gemini-missing.jsonl'));
    expect(entries).toEqual([]);
  });

  it('dedupes a re-emitted message by id, last emission wins', async () => {
    tmpFile = writeFixture([
      JSON.stringify({ sessionId: 's', startTime: 't', kind: 'main' }),
      JSON.stringify({ id: 'g1', type: 'gemini', content: '', model: 'gemini-3-pro', thoughts: [] }),
      JSON.stringify({ id: 'g1', type: 'gemini', content: 'final text', model: 'gemini-3-pro', thoughts: [] }),
    ]);
    const entries = await parseGeminiTranscript(tmpFile);
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
    const entries = await parseGeminiTranscript(tmpFile);
    expect(entries).toEqual([
      { kind: 'user', uuid: 'u1', ts: expect.any(Number), text: 'real prompt' },
    ]);
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

    const entries = await parseGeminiTranscript(tmpFile);
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

      const entries = await parseGeminiTranscript(tmpFile);

      // Whatever else happens, the user is TOLD the transcript was cut rather
      // than being shown a silently empty conversation.
      expect(entries[0]).toMatchObject({ kind: 'system', subtype: 'truncated' });
    } finally {
      setParseWindowBytesForTests();
    }
  });

  it('parses the pinned fixture: thoughts -> thinking, toolCalls -> tool_use + tool_result', async () => {
    const fixturePath = path.join(__dirname, '..', 'fixtures', 'gemini-real-session.jsonl');
    const entries = await parseGeminiTranscript(fixturePath);
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
