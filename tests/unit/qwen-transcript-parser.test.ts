import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  parseQwenTranscript,
  parseQwenTranscriptWindow,
  locateQwenTranscriptFile,
  qwenTurnUsage,
  readQwenTranscriptPage,
} from '../../src/main/agent/adapters/qwen-code/transcript-parser';
import { qwenChatsDir } from '../../src/main/agent/adapters/qwen-code/session-history-parser';
import { setParseWindowBytesForTests } from '../../src/main/agent/shared/transcript-truncation';
import { expectPagesTile } from './helpers/history-page-tiling';

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

  it('does not show a tool_result record\'s plain text output as something the user typed', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'qwen-tool-result-text-'));
    tmpFile = path.join(directory, `${SESSION_ID}.jsonl`);
    fs.writeFileSync(tmpFile, JSON.stringify({
      type: 'tool_result',
      uuid: 'tr-1',
      timestamp: '2026-11-01T10:00:00.000Z',
      message: { role: 'user', parts: [{ text: 'output' }] },
    }) + '\n');

    const entries = await parseQwenTranscript(SESSION_ID, tmpFile);
    expect(entries.filter((entry) => entry.kind === 'user')).toEqual([]);
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

  it('treats an explicit empty-string uuid the same as a missing one', async () => {
    // `raw.uuid` present but `''` is a distinct on-disk shape from the field
    // being absent, and the guard is
    // `typeof raw.uuid === 'string' && raw.uuid.length > 0` - dropping the
    // length check would let `''` through as a "real" uuid, recreating the
    // shared-uuid collision the fallback exists to fix.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qwen-transcript-'));
    tmpFile = path.join(dir, 'session.jsonl');
    const lines = [
      JSON.stringify({ type: 'user', uuid: '', message: { role: 'user', parts: [{ text: 'first' }] } }),
      JSON.stringify({ type: 'user', uuid: '', message: { role: 'user', parts: [{ text: 'second' }] } }),
    ];
    fs.writeFileSync(tmpFile, lines.join('\n'));
    const entries = await parseQwenTranscript(SESSION_ID, tmpFile);

    expect(entries).toHaveLength(2);
    expect(entries.map((entry) => entry.uuid)).toEqual([`${SESSION_ID}:0`, `${SESSION_ID}:1`]);
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
    expect(entries).toEqual([{
      kind: 'user', uuid: expect.any(String), ts: expect.any(Number), text: 'hi',
      origin: { conversationId: SESSION_ID, position: expect.any(Number) },
    }]);
  });

  it('pages its history in tiles that add up to the whole file, line-numbered uuids included', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qwen-transcript-'));
    tmpFile = path.join(dir, `${SESSION_ID}.jsonl`);
    const filePath = tmpFile;
    let text = '';
    for (let turn = 0; turn < 24; turn += 1) {
      const timestamp = new Date(Date.UTC(2026, 9, 1, 9, turn)).toISOString();
      // Every third record has no uuid of its own, so it is named by its line.
      const uuid = turn % 3 === 0 ? {} : { uuid: `user-${turn}` };
      text += `${JSON.stringify({ type: 'user', timestamp, ...uuid, message: { role: 'user', parts: [{ text: `question ${turn} ${'é漢'.repeat(turn % 5)}` }] } })}\n`;
      text += `${JSON.stringify({ type: 'system', subtype: 'ui_telemetry', timestamp })}\n`;
      text += `${JSON.stringify({
        type: 'assistant', timestamp, uuid: `assistant-${turn}`, model: 'qwen3-coder',
        message: { role: 'model', parts: [{ text: `answer ${turn}` }, { functionCall: { id: `call-${turn}`, name: 'read_file', args: { path: `f${turn}` } } }] },
      })}\n`;
      text += `${JSON.stringify({ type: 'user', timestamp, uuid: `result-${turn}`, message: { role: 'user', parts: [{ functionResponse: { id: `call-${turn}`, response: { output: `contents ${turn}` } } }] } })}\n`;
    }
    fs.writeFileSync(filePath, text);
    const whole = await expectPagesTile({
      filePath,
      conversationId: SESSION_ID,
      parseTail: () => parseQwenTranscript(SESSION_ID, filePath),
      readPage: (request) => readQwenTranscriptPage(SESSION_ID, filePath, request),
      tailBytes: 1500,
      pageBytes: 700,
    });
    expect(whole.some((entry) => entry.uuid === `${SESSION_ID}:0`)).toBe(true);
  });
});

/**
 * Record shapes from packages/core/src/services/chatRecordingService.ts at
 * v0.26.6: a tool result is its own `tool_result` record, and each assistant
 * record carries one API response's `usageMetadata`.
 */
describe('Qwen v0.26 records', () => {
  let directory: string | null = null;
  afterEach(() => {
    if (directory) fs.rmSync(directory, { recursive: true, force: true });
    directory = null;
  });

  function writeSession(records: ReadonlyArray<Record<string, unknown>>): string {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'qwen-transcript-'));
    const filePath = path.join(directory, `${SESSION_ID}.jsonl`);
    fs.writeFileSync(filePath, records.map((record) => JSON.stringify(record)).join('\n') + '\n');
    return filePath;
  }

  it('reads a tool_result record as the tool result, never as user text', async () => {
    const filePath = writeSession([
      { type: 'user', uuid: 'u1', timestamp: '2026-11-01T10:00:00.000Z', message: { role: 'user', parts: [{ text: 'Read the config' }] } },
      { type: 'assistant', uuid: 'a1', timestamp: '2026-11-01T10:00:01.000Z', model: 'qwen3-coder-plus', message: { role: 'model', parts: [{ functionCall: { id: 'call-1', name: 'read_file', args: { file_path: 'config.ts' } } }] } },
      { type: 'tool_result', uuid: 't1', timestamp: '2026-11-01T10:00:02.000Z', message: { role: 'user', parts: [{ functionResponse: { id: 'call-1', name: 'read_file', response: { output: 'export default {}' } } }] }, toolCallResult: { callId: 'call-1' } },
    ]);
    const entries = await parseQwenTranscript(SESSION_ID, filePath);
    expect(entries.map((entry) => entry.kind)).toEqual(['user', 'assistant', 'tool_result']);
    expect(entries[2]).toMatchObject({ kind: 'tool_result', uuid: 't1', toolUseId: 'call-1', content: 'export default {}' });
  });

  it('puts each assistant record\'s tokens on its entry: fresh input, cache reads, output', async () => {
    const entries = await parseQwenTranscript(SESSION_ID, path.join(__dirname, '..', 'fixtures', 'qwen-real-session.jsonl'));
    const assistant = entries.find((entry) => entry.kind === 'assistant');
    // The 0.15.3 record: promptTokenCount 10, candidatesTokenCount 43, totalTokenCount 53.
    expect(assistant?.kind === 'assistant' && assistant.usage).toEqual({
      inputTokens: 10, outputTokens: 43, cacheCreationInputTokens: 0, cacheReadInputTokens: 0,
    });
  });

  it.each([
    // Gemini reports reasoning apart: output is candidates plus thoughts.
    ['thoughts apart (Gemini)', { promptTokenCount: 100, cachedContentTokenCount: 40, candidatesTokenCount: 20, thoughtsTokenCount: 30, totalTokenCount: 150 }, 60, 50, 40],
    // An OpenAI-compatible provider counts reasoning inside candidates: never twice.
    ['thoughts inside (OpenAI-compatible)', { promptTokenCount: 100, candidatesTokenCount: 50, thoughtsTokenCount: 30, totalTokenCount: 150 }, 100, 50, 0],
    ['no total to decide by', { promptTokenCount: 100, candidatesTokenCount: 50, thoughtsTokenCount: 30 }, 100, 50, 0],
  ] as const)('counts output once with %s', (_label, usageMetadata, inputTokens, outputTokens, cacheReadInputTokens) => {
    expect(qwenTurnUsage(usageMetadata)).toEqual({ inputTokens, outputTokens, cacheCreationInputTokens: 0, cacheReadInputTokens });
  });

  it('has no usage for a record without counts', () => {
    expect(qwenTurnUsage(undefined)).toBeUndefined();
    expect(qwenTurnUsage({ promptTokenCount: 0, candidatesTokenCount: 0 })).toBeUndefined();
  });

  it('mints the same uuids window by window as a whole-file parse, a record with no uuid included', async () => {
    const records: Record<string, unknown>[] = [];
    for (let turn = 0; turn < 30; turn += 1) {
      const timestamp = new Date(Date.UTC(2026, 10, 1, 9, turn)).toISOString();
      records.push({ type: 'user', timestamp, ...(turn % 7 === 0 ? {} : { uuid: `user-${turn}` }), message: { role: 'user', parts: [{ text: `question ${turn} ${'x'.repeat(80)}` }] } });
      records.push({ type: 'assistant', timestamp, uuid: `assistant-${turn}`, model: 'qwen3-coder-plus', usageMetadata: { promptTokenCount: 10 + turn, candidatesTokenCount: 5, totalTokenCount: 15 + turn }, message: { role: 'model', parts: [{ text: `answer ${turn}` }] } });
    }
    const filePath = writeSession(records);
    const whole = await parseQwenTranscript(SESSION_ID, filePath);

    const windowed: string[] = [];
    let startByte = 0;
    for (let guard = 0; guard < 1000; guard += 1) {
      const window = await parseQwenTranscriptWindow(SESSION_ID, filePath, startByte, 600);
      windowed.push(...window.entries.map((entry) => entry.uuid));
      if (window.nextByteOffset <= startByte || window.nextByteOffset >= window.totalBytes) break;
      startByte = window.nextByteOffset;
    }
    expect(windowed).toEqual(whole.map((entry) => entry.uuid));
    expect(windowed).toContain(`${SESSION_ID}:28`);
  });

  it('counts the lines before a window for a record with no top-level uuid, even when a tool arg holds a nested uuid key', async () => {
    const firstLine = JSON.stringify({ uuid: 'first-record', type: 'user', message: { role: 'user', parts: [{ text: 'hi' }] } });
    // No top-level uuid; "uuid" appears only inside the functionCall args.
    const secondLine = JSON.stringify({
      type: 'assistant', model: 'qwen3-coder-plus',
      message: { role: 'model', parts: [{ functionCall: { id: 'call-1', name: 'read_file', args: { uuid: 'nested-value' } } }] },
    });
    const filePath = writeSession([]);
    fs.writeFileSync(filePath, `${firstLine}\n${secondLine}\n`);
    // A mid-file window drops through its first newline, so starting on the
    // first line's own newline begins the window exactly at the second line.
    const startByte = Buffer.byteLength(firstLine, 'utf-8');

    const whole = await parseQwenTranscript(SESSION_ID, filePath);
    const wholeAssistant = whole.find((entry) => entry.kind === 'assistant');
    // Absolute physical line 1 (0-based): the record after the first line.
    expect(wholeAssistant?.uuid).toBe(`${SESSION_ID}:1`);

    const window = await parseQwenTranscriptWindow(SESSION_ID, filePath, startByte, 1024 * 1024);
    expect(window.entries.map((entry) => entry.kind)).toEqual(['assistant']);
    expect(window.entries[0].uuid).toBe(`${SESSION_ID}:1`);
  });

  it('replays the real tool-call fixture from byte 0 into the same entries as a whole-file parse', async () => {
    const fixturePath = path.join(__dirname, '..', 'fixtures', 'qwen-real-session-tools.jsonl');
    const whole = await parseQwenTranscript(SESSION_ID, fixturePath);
    const window = await parseQwenTranscriptWindow(SESSION_ID, fixturePath, 0, 1024 * 1024);
    const shape = (entries: typeof whole) => entries.map((entry) => ({
      uuid: entry.uuid,
      kind: entry.kind,
      blockKinds: entry.kind === 'assistant' ? entry.blocks.map((block) => block.type) : [],
    }));
    expect(shape(window.entries)).toEqual(shape(whole));
    expect(shape(window.entries)[1].blockKinds).toEqual(['thinking', 'text', 'tool_use']);
  });
});

describe('locateQwenTranscriptFile', () => {
  it('builds <chatsDir>/<sessionId>.jsonl from the cwd slug', () => {
    const cwd = 'C:/Users/dev/project';
    expect(locateQwenTranscriptFile('abc-123', cwd)).toBe(path.join(qwenChatsDir(cwd), 'abc-123.jsonl'));
  });
});
