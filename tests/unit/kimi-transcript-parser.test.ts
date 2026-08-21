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
    const entries = await parseKimiTranscript(path.join(os.tmpdir(), 'kimi-missing.jsonl'));
    expect(entries).toEqual([]);
  });

  it('accumulates ContentPart fragments and pairs ToolCall/ToolResult by id', async () => {
    const fixturePath = path.join(__dirname, '..', 'fixtures', 'kimi-wire-session.jsonl');
    const entries = await parseKimiTranscript(fixturePath);
    expect(entries.map((entry) => entry.kind)).toEqual(['user', 'assistant', 'assistant', 'tool_result']);
    expect(entries[0]).toMatchObject({ kind: 'user', text: 'List the files in this directory.' });
    // ContentPart fragments "Here are " + "the files." flushed at the ToolCall.
    expect(entries[1]).toMatchObject({ kind: 'assistant', blocks: [{ type: 'text', text: 'Here are the files.' }] });
    expect(entries[2]).toMatchObject({ kind: 'assistant', blocks: [{ type: 'tool_use', id: 'tc-1', name: 'Shell', input: { command: 'ls' } }] });
    expect(entries[3]).toMatchObject({ kind: 'tool_result', toolUseId: 'tc-1', content: 'file1.txt\nfile2.txt\n', isError: false });
  });

  it('parses only the tail of a transcript larger than the parse cap, marking the omission', async () => {
    // kimi mints uuids window-relative (`kimi-${entryIndex++}`, starting at 0
    // within whatever window was actually read), so `kimi-0` is present
    // regardless of truncation - assert on the per-turn TEXT instead.
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

      const entries = await parseKimiTranscript(tmpFile);

      expect(entries.length).toBeLessThan(lines.length);
      expect(entries.some((entry) => entry.kind === 'user' && entry.text.startsWith('turn 0 '))).toBe(false);
      expect(entries.some((entry) => entry.kind === 'user' && entry.text.startsWith(`turn ${lastLineIndex} `))).toBe(true);

      expect(entries[0]).toMatchObject({ kind: 'system', subtype: 'truncated' });
    } finally {
      setParseWindowBytesForTests();
    }
  });

  it('flags an error tool result via return_value.is_error', async () => {
    tmpFile = writeFixture([
      { type: 'metadata', protocol_version: '1.9' },
      { timestamp: 1780430657.02, message: { type: 'ToolResult', payload: { tool_call_id: 'tc-2', return_value: { is_error: true, message: 'boom' } } } },
    ]);
    const entries = await parseKimiTranscript(tmpFile);
    expect(entries).toEqual([
      { kind: 'tool_result', uuid: expect.any(String), ts: expect.any(Number), toolUseId: 'tc-2', content: 'boom', isError: true },
    ]);
  });

  it('extracts user text from a ContentPart-array user_input', async () => {
    tmpFile = writeFixture([
      { type: 'metadata', protocol_version: '1.9' },
      { timestamp: 1780430656.8, message: { type: 'TurnBegin', payload: { user_input: [{ type: 'text', text: 'hello' }, { type: 'image' }] } } },
    ]);
    const entries = await parseKimiTranscript(tmpFile);
    expect(entries).toEqual([
      { kind: 'user', uuid: expect.any(String), ts: expect.any(Number), text: 'hello' },
    ]);
  });
});
