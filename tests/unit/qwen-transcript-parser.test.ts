import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseQwenTranscript, locateQwenTranscriptFile } from '../../src/main/agent/adapters/qwen-code/transcript-parser';
import { qwenChatsDir } from '../../src/main/agent/adapters/qwen-code/session-history-parser';
import { setParseWindowBytesForTests } from '../../src/main/agent/shared/transcript-truncation';

const SESSION_ID = '1ac39801-6b52-4a0e-9d18-7c3f2ea4b510';

describe('parseQwenTranscript', () => {
  let tmpFile: string | null = null;
  afterEach(() => {
    if (tmpFile) {
      try { fs.rmSync(path.dirname(tmpFile), { recursive: true, force: true }); } catch { /* ignore */ }
      tmpFile = null;
    }
  });

  it('returns [] for a missing file', async () => {
    const entries = await parseQwenTranscript(SESSION_ID, path.join(os.tmpdir(), 'qwen-missing.jsonl'));
    expect(entries).toEqual([]);
  });

  it('parses the pinned fixture: thought + text + functionCall, with a paired functionResponse', async () => {
    const fixturePath = path.join(__dirname, '..', 'fixtures', 'qwen-real-session-tools.jsonl');
    const entries = await parseQwenTranscript(SESSION_ID, fixturePath);
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
    // This fixture is synthetic and carries no per-record `uuid`, so it
    // exercises the session-scoped physical-line fallback. Line 1 is the
    // skipped `ui_telemetry` system record, so the assistant is line 2.
    expect(entries.map((entry) => entry.uuid)).toEqual([
      `${SESSION_ID}:0`,
      `${SESSION_ID}:2`,
      `${SESSION_ID}:3`,
    ]);
  });

  it('prefers the record own uuid when the on-disk format carries one', async () => {
    // Real Qwen sessions write `uuid` / `parentUuid` / `sessionId` per record.
    // An intrinsic id needs no positional anchor at all, so this path never
    // pays the omitted-line scan.
    const fixturePath = path.join(__dirname, '..', 'fixtures', 'qwen-real-session.jsonl');
    const entries = await parseQwenTranscript(SESSION_ID, fixturePath);
    expect(entries.length).toBeGreaterThan(0);
    expect(entries[0].uuid).toBe('ff2655c3-c716-4f70-b580-fc81d895aa6d');
    for (const entry of entries) {
      expect(entry.uuid).not.toContain(`${SESSION_ID}:`);
    }
  });

  it('namespaces the fallback uuid by session so two sessions cannot collide', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qwen-transcript-'));
    tmpFile = path.join(dir, 'session.jsonl');
    fs.writeFileSync(tmpFile, JSON.stringify({ type: 'user', message: { role: 'user', parts: [{ text: 'hi' }] } }));
    const one = await parseQwenTranscript('session-one', tmpFile);
    const two = await parseQwenTranscript('session-two', tmpFile);
    expect(one[0].uuid).toBe('session-one:0');
    expect(two[0].uuid).toBe('session-two:0');
  });

  it('parses only the tail of a transcript larger than the parse cap, marking the omission', async () => {
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

      const entries = await parseQwenTranscript(SESSION_ID, tmpFile);

      expect(entries.length).toBeLessThan(lines.length);
      expect(entries.some((entry) => entry.kind === 'user' && entry.text.startsWith('turn 0 '))).toBe(false);
      expect(entries.some((entry) => entry.kind === 'user' && entry.text.startsWith(`turn ${lastLineIndex} `))).toBe(true);

      expect(entries[0]).toMatchObject({ kind: 'system', subtype: 'truncated' });
    } finally {
      setParseWindowBytesForTests();
    }
  });

  it('keeps a turn uuid stable when the transcript grows past the cap and the window slides', async () => {
    // The fallback path is the one that could drift, so it is the one pinned:
    // these records carry no `uuid`, so the uuid is the absolute physical line.
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
      fs.writeFileSync(tmpFile, lines.join('\n'));
      const before = await parseQwenTranscript(SESSION_ID, tmpFile);

      const appended = [0, 1].map((offset) => JSON.stringify({
        type: 'user',
        message: { role: 'user', parts: [{ text: `turn ${lineIndex + offset} ${'q'.repeat(200)}` }] },
      }));
      fs.writeFileSync(tmpFile, [...lines, ...appended].join('\n'));
      const after = await parseQwenTranscript(SESSION_ID, tmpFile);

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

  it('skips system ui_telemetry lines', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qwen-transcript-'));
    tmpFile = path.join(dir, 'session.jsonl');
    fs.writeFileSync(tmpFile, [
      JSON.stringify({ type: 'system', subtype: 'ui_telemetry' }),
      JSON.stringify({ type: 'user', message: { role: 'user', parts: [{ text: 'hi' }] } }),
    ].join('\n'));
    const entries = await parseQwenTranscript(SESSION_ID, tmpFile);
    expect(entries).toEqual([{ kind: 'user', uuid: expect.any(String), ts: expect.any(Number), text: 'hi' }]);
  });
});

describe('locateQwenTranscriptFile', () => {
  it('builds <chatsDir>/<sessionId>.jsonl from the cwd slug', () => {
    const cwd = 'C:/Users/dev/project';
    expect(locateQwenTranscriptFile('abc-123', cwd)).toBe(path.join(qwenChatsDir(cwd), 'abc-123.jsonl'));
  });
});
