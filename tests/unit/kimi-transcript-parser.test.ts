import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseKimiTranscript } from '../../src/main/agent/adapters/kimi/transcript-parser';
import { setParseWindowBytesForTests } from '../../src/main/agent/shared/transcript-truncation';

// NOTE: the assistant-text (ContentPart) handling is schema-derived from the
// upstream wire spec - no real Kimi sessions were available locally. The
// fixture mirrors the verified envelope shape; tool calls/results and prompts
// are pinned to the on-disk shapes from the mock CLI.

const SESSION_ID = '4f1c0b2a-8d3e-4a91-9c77-2b5e6f0a1d34';

function writeFixture(lines: object[]): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kimi-transcript-'));
  const file = path.join(dir, 'wire.jsonl');
  fs.writeFileSync(file, lines.map((line) => JSON.stringify(line)).join('\n'));
  return file;
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

  it('accumulates ContentPart fragments and pairs ToolCall/ToolResult by id', async () => {
    const fixturePath = path.join(__dirname, '..', 'fixtures', 'kimi-wire-session.jsonl');
    const entries = await parseKimiTranscript(SESSION_ID, fixturePath);
    expect(entries.map((entry) => entry.kind)).toEqual(['user', 'assistant', 'assistant', 'tool_result']);
    expect(entries[0]).toMatchObject({ kind: 'user', text: 'List the files in this directory.' });
    // ContentPart fragments "Here are " + "the files." flushed at the ToolCall.
    expect(entries[1]).toMatchObject({ kind: 'assistant', blocks: [{ type: 'text', text: 'Here are the files.' }] });
    expect(entries[2]).toMatchObject({ kind: 'assistant', blocks: [{ type: 'tool_use', id: 'tc-1', name: 'Shell', input: { command: 'ls' } }] });
    expect(entries[3]).toMatchObject({ kind: 'tool_result', toolUseId: 'tc-1', content: 'file1.txt\nfile2.txt\n', isError: false });

    // The exact strings are the contract (persisted citation anchors), and
    // they show the two rules that make them unique: every uuid is the
    // PHYSICAL line (line 0 is the metadata envelope, so the first turn is 1),
    // and the flushed assistant text is attributed to the line its FIRST
    // ContentPart arrived on (2), not to the ToolCall line that flushed it (4).
    expect(entries.map((entry) => entry.uuid)).toEqual([
      `${SESSION_ID}:1`,
      `${SESSION_ID}:2`,
      `${SESSION_ID}:4`,
      `${SESSION_ID}:5`,
    ]);
  });

  it('parses only the tail of a transcript larger than the parse cap, marking the omission', async () => {
    const cap = 2 * 1024;
    setParseWindowBytesForTests(cap);
    try {
      const lines: object[] = [{ type: 'metadata', protocol_version: '1.9' }];
      let written = Buffer.byteLength(JSON.stringify(lines[0]), 'utf-8') + 1;
      let lineIndex = 0;
      while (written <= cap * 3) {
        const fixtureLine = {
          timestamp: 1780430656.8 + lineIndex,
          message: { type: 'TurnBegin', payload: { user_input: `turn ${lineIndex} ${'q'.repeat(200)}` } },
        };
        lines.push(fixtureLine);
        written += Buffer.byteLength(JSON.stringify(fixtureLine), 'utf-8') + 1;
        lineIndex += 1;
      }
      const lastLineIndex = lineIndex - 1;
      tmpFile = writeFixture(lines);
      expect(fs.statSync(tmpFile).size).toBeGreaterThan(cap);

      const entries = await parseKimiTranscript(SESSION_ID, tmpFile);

      expect(entries.length).toBeLessThan(lines.length);
      expect(entries.some((entry) => entry.kind === 'user' && entry.text.startsWith('turn 0 '))).toBe(false);
      expect(entries.some((entry) => entry.kind === 'user' && entry.text.startsWith(`turn ${lastLineIndex} `))).toBe(true);

      expect(entries[0]).toMatchObject({ kind: 'system', subtype: 'truncated' });
    } finally {
      setParseWindowBytesForTests();
    }
  });

  it('keeps a turn uuid stable when the transcript grows past the cap and the window slides', async () => {
    // Guards the same regression as the Codex parser: a window-relative
    // counter reassigned a different uuid to the same logical turn on every
    // re-parse, silently breaking the persisted citation anchors.
    const cap = 2 * 1024;
    setParseWindowBytesForTests(cap);
    try {
      const lines: object[] = [{ type: 'metadata', protocol_version: '1.9' }];
      let written = Buffer.byteLength(JSON.stringify(lines[0]), 'utf-8') + 1;
      let lineIndex = 0;
      while (written <= cap * 3) {
        const fixtureLine = {
          timestamp: 1780430656.8 + lineIndex,
          message: { type: 'TurnBegin', payload: { user_input: `turn ${lineIndex} ${'q'.repeat(200)}` } },
        };
        lines.push(fixtureLine);
        written += Buffer.byteLength(JSON.stringify(fixtureLine), 'utf-8') + 1;
        lineIndex += 1;
      }
      tmpFile = writeFixture(lines);
      const before = await parseKimiTranscript(SESSION_ID, tmpFile);

      // Append just enough to slide the window without clearing it entirely.
      const appended = [0, 1].map((offset) => ({
        timestamp: 1780430656.8 + lineIndex + offset,
        message: { type: 'TurnBegin', payload: { user_input: `turn ${lineIndex + offset} ${'q'.repeat(200)}` } },
      }));
      fs.writeFileSync(tmpFile, [...lines, ...appended].map((line) => JSON.stringify(line)).join('\n'));
      const after = await parseKimiTranscript(SESSION_ID, tmpFile);

      const oldestBefore = before.find((entry) => entry.kind === 'user');
      expect(after.some((entry) => entry.uuid === oldestBefore!.uuid)).toBe(false);

      const lastBefore = before[before.length - 1];
      const sameTurnAfter = after.find(
        (entry) => entry.kind === 'user' && lastBefore.kind === 'user' && entry.text === lastBefore.text,
      );
      expect(sameTurnAfter).toBeDefined();
      expect(sameTurnAfter!.uuid).toBe(lastBefore.uuid);
    } finally {
      setParseWindowBytesForTests();
    }
  });

  it('namespaces uuids by session so two sessions on one task cannot collide', async () => {
    tmpFile = writeFixture([
      { type: 'metadata', protocol_version: '1.9' },
      { timestamp: 1780430656.8, message: { type: 'TurnBegin', payload: { user_input: 'hello' } } },
    ]);
    const one = await parseKimiTranscript('session-one', tmpFile);
    const two = await parseKimiTranscript('session-two', tmpFile);

    expect(one[0].uuid).toBe('session-one:1');
    expect(two[0].uuid).toBe('session-two:1');
  });

  it('gives the flushed assistant text and the record that flushed it distinct uuids', async () => {
    // One line can trigger a flush AND emit its own entry. They must not
    // collide: the stitch dedups by uuid and would drop the second.
    tmpFile = writeFixture([
      { type: 'metadata', protocol_version: '1.9' },
      { timestamp: 1780430656.9, message: { type: 'ContentPart', payload: { text: 'thinking out loud' } } },
      { timestamp: 1780430656.97, message: { type: 'ToolCall', payload: { type: 'function', id: 'tc-9', function: { name: 'Shell', arguments: '{}' } } } },
    ]);
    const entries = await parseKimiTranscript(SESSION_ID, tmpFile);
    expect(entries.map((entry) => entry.uuid)).toEqual([`${SESSION_ID}:1`, `${SESSION_ID}:2`]);
    expect(new Set(entries.map((entry) => entry.uuid)).size).toBe(entries.length);
  });

  it('flushes a trailing assistant fragment left pending at end of transcript', async () => {
    // Every other flush in this file is triggered by a boundary record
    // (ToolCall/TurnEnd/TurnBegin) mid-loop. A transcript that ends mid-stream
    // with no closing boundary relies on the unconditional `flushAssistantText()`
    // call AFTER the loop - deleting that line would silently drop this entry
    // rather than throw, since nothing else calls flush for it.
    tmpFile = writeFixture([
      { type: 'metadata', protocol_version: '1.9' },
      { timestamp: 1780430656.9, message: { type: 'ContentPart', payload: { text: 'trailing thought' } } },
    ]);
    const entries = await parseKimiTranscript(SESSION_ID, tmpFile);
    expect(entries).toEqual([
      { kind: 'assistant', uuid: `${SESSION_ID}:1`, ts: expect.any(Number), blocks: [{ type: 'text', text: 'trailing thought' }] },
    ]);
  });

  it('flags an error tool result via return_value.is_error', async () => {
    tmpFile = writeFixture([
      { type: 'metadata', protocol_version: '1.9' },
      { timestamp: 1780430657.02, message: { type: 'ToolResult', payload: { tool_call_id: 'tc-2', return_value: { is_error: true, message: 'boom' } } } },
    ]);
    const entries = await parseKimiTranscript(SESSION_ID, tmpFile);
    expect(entries).toEqual([
      { kind: 'tool_result', uuid: expect.any(String), ts: expect.any(Number), toolUseId: 'tc-2', content: 'boom', isError: true },
    ]);
  });

  it('extracts user text from a ContentPart-array user_input', async () => {
    tmpFile = writeFixture([
      { type: 'metadata', protocol_version: '1.9' },
      { timestamp: 1780430656.8, message: { type: 'TurnBegin', payload: { user_input: [{ type: 'text', text: 'hello' }, { type: 'image' }] } } },
    ]);
    const entries = await parseKimiTranscript(SESSION_ID, tmpFile);
    expect(entries).toEqual([
      { kind: 'user', uuid: expect.any(String), ts: expect.any(Number), text: 'hello' },
    ]);
  });
});
