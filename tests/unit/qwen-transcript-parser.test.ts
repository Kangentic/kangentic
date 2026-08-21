import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseQwenTranscript, locateQwenTranscriptFile } from '../../src/main/agent/adapters/qwen-code/transcript-parser';
import { qwenChatsDir } from '../../src/main/agent/adapters/qwen-code/session-history-parser';
import { setParseWindowBytesForTests } from '../../src/main/agent/shared/transcript-truncation';

describe('parseQwenTranscript', () => {
  let tmpFile: string | null = null;
  afterEach(() => {
    if (tmpFile) {
      try { fs.rmSync(path.dirname(tmpFile), { recursive: true, force: true }); } catch { /* ignore */ }
      tmpFile = null;
    }
  });

  it('returns [] for a missing file', async () => {
    const entries = await parseQwenTranscript(path.join(os.tmpdir(), 'qwen-missing.jsonl'));
    expect(entries).toEqual([]);
  });

  it('parses the pinned fixture: thought + text + functionCall, with a paired functionResponse', async () => {
    const fixturePath = path.join(__dirname, '..', 'fixtures', 'qwen-real-session-tools.jsonl');
    const entries = await parseQwenTranscript(fixturePath);
    expect(entries.map((entry) => entry.kind)).toEqual(['user', 'assistant', 'tool_result']);
    expect(entries[0]).toMatchObject({ kind: 'user', text: 'List the files in this directory.' });
    expect(entries[1]).toMatchObject({
      kind: 'assistant',
      model: 'qwen3-coder-plus',
      blocks: [
        { type: 'thinking', text: 'Let me list the directory.' },
        { type: 'text', text: 'Here are the files.' },
        { type: 'tool_use', id: 'fc-1', name: 'list_directory' },
      ],
    });
    expect(entries[2]).toMatchObject({ kind: 'tool_result', toolUseId: 'fc-1', content: 'file1.txt\nfile2.txt' });
  });

  it('parses only the tail of a transcript larger than the parse cap, marking the omission', async () => {
    // qwen mints uuids window-relative (`qwen-${entryIndex++}`, starting at 0
    // within whatever window was actually read), so `qwen-0` is present
    // regardless of truncation - assert on the per-turn TEXT instead.
    const cap = 2 * 1024;
    setParseWindowBytesForTests(cap);
    try {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qwen-transcript-'));
      tmpFile = path.join(dir, 'session.jsonl');
      const lines: string[] = [];
      let written = 0;
      let lineIndex = 0;
      while (written <= cap * 3) {
        const fixtureLine = JSON.stringify({
          type: 'user',
          message: { role: 'user', parts: [{ text: `turn ${lineIndex} ${'q'.repeat(200)}` }] },
        });
        lines.push(fixtureLine);
        written += Buffer.byteLength(fixtureLine, 'utf-8') + 1;
        lineIndex += 1;
      }
      const lastLineIndex = lineIndex - 1;
      fs.writeFileSync(tmpFile, lines.join('\n'));
      expect(fs.statSync(tmpFile).size).toBeGreaterThan(cap);

      const entries = await parseQwenTranscript(tmpFile);

      expect(entries.length).toBeLessThan(lines.length);
      expect(entries.some((entry) => entry.kind === 'user' && entry.text.startsWith('turn 0 '))).toBe(false);
      expect(entries.some((entry) => entry.kind === 'user' && entry.text.startsWith(`turn ${lastLineIndex} `))).toBe(true);

      expect(entries[0]).toMatchObject({ kind: 'system', subtype: 'truncated' });
    } finally {
      setParseWindowBytesForTests();
    }
  });

  it('skips system ui_telemetry lines', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qwen-transcript-'));
    tmpFile = path.join(dir, 'session.jsonl');
    fs.writeFileSync(tmpFile, [
      JSON.stringify({ type: 'system', subtype: 'ui_telemetry' }),
      JSON.stringify({ type: 'user', message: { role: 'user', parts: [{ text: 'hi' }] } }),
    ].join('\n'));
    const entries = await parseQwenTranscript(tmpFile);
    expect(entries).toEqual([{ kind: 'user', uuid: expect.any(String), ts: expect.any(Number), text: 'hi' }]);
  });
});

describe('locateQwenTranscriptFile', () => {
  it('builds <chatsDir>/<sessionId>.jsonl from the cwd slug', () => {
    const cwd = 'C:/Users/dev/project';
    expect(locateQwenTranscriptFile('abc-123', cwd)).toBe(path.join(qwenChatsDir(cwd), 'abc-123.jsonl'));
  });
});
