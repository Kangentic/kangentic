/**
 * Copilot CLI's session event log read as a transcript.
 *
 * `tests/fixtures/copilot-events/copilot-1.0.88-tool-success-events.jsonl` and
 * `copilot-1.0.88-tool-failure-events.jsonl` are sanitized captures of real
 * Copilot CLI 1.0.88 logs. They pin the real shape, including an `apply_patch`
 * request whose `arguments` is a string. `doc-shaped-events.jsonl` is NOT a
 * capture. It is shaped from the Copilot SDK's session event reference
 * (https://github.com/github/copilot-sdk/blob/main/docs/features/streaming-events.md:
 * the `{ id, timestamp, parentId, agentId?, ephemeral?, type, data }` envelope
 * and each event's data fields) and GitHub's config directory reference, which
 * names `session-state/<id>/events.jsonl` the event log. It stays only for
 * `session.compaction_complete` and `session.resume`, which no local log held.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Lets a test make the stream behind `streamJsonlRecords` fail after its first
// chunk, the partial read the usage and tool count readers must not report.
const streamFailure = vi.hoisted(() => ({ armed: false }));
vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
  const createReadStream = ((...args: Parameters<typeof actual.createReadStream>) => {
    const stream = actual.createReadStream(...args);
    if (streamFailure.armed) stream.once('data', () => stream.destroy(new Error('EBUSY: file is held')));
    return stream;
  }) as typeof actual.createReadStream;
  return { ...actual, createReadStream, default: { ...actual, createReadStream } };
});

import {
  copilotTranscriptToolCounts,
  copilotTranscriptUsage,
  parseCopilotTranscript,
  readCopilotTranscriptPage,
} from '../../src/main/agent/adapters/copilot/transcript-parser';
import { setParseWindowBytesForTests } from '../../src/main/agent/shared/transcript-truncation';
import { expectPagesTile } from './helpers/history-page-tiling';

const SESSION_ID = '11111111-2222-4333-8444-555555555555';
const FIXTURE = path.join(__dirname, '..', 'fixtures', 'copilot-events', 'doc-shaped-events.jsonl');
const SUCCESS_LOG = path.join(__dirname, '..', 'fixtures', 'copilot-events', 'copilot-1.0.88-tool-success-events.jsonl');
const FAILURE_LOG = path.join(__dirname, '..', 'fixtures', 'copilot-events', 'copilot-1.0.88-tool-failure-events.jsonl');
const FIRST_CALL_ID = '00000000-0000-4000-8000-000000000010';
const SECOND_CALL_ID = '00000000-0000-4000-8000-000000000018';

let tmpDir: string | null = null;
afterEach(() => {
  if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  tmpDir = null;
});

function writeLog(lines: unknown[]): string {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'copilot-transcript-'));
  const filePath = path.join(tmpDir, 'events.jsonl');
  fs.writeFileSync(filePath, lines.map((line) => JSON.stringify(line)).join('\n') + '\n');
  return filePath;
}

describe('parseCopilotTranscript', () => {
  it('returns [] for a missing file', async () => {
    expect(await parseCopilotTranscript(SESSION_ID, path.join(os.tmpdir(), 'copilot-missing-events.jsonl'))).toEqual([]);
  });

  it('reads the conversation out of the event log and skips the rest', async () => {
    const entries = await parseCopilotTranscript(SESSION_ID, FIXTURE);
    expect(entries.map((entry) => entry.kind)).toEqual([
      'user', 'assistant', 'tool_result', 'tool_result', 'tool_result', 'assistant', 'system', 'system', 'user',
    ]);
    expect(entries[0]).toMatchObject({ kind: 'user', uuid: 'evt-user-1', text: 'List the files and fix the failing test', ts: Date.parse('2026-10-30T10:00:01.000Z') });
    expect(entries[1]).toMatchObject({
      kind: 'assistant',
      uuid: 'evt-assistant-1',
      blocks: [
        { type: 'thinking', text: 'The user wants a listing, then a fix.' },
        { type: 'text', text: "I'll look at the tree first." },
        { type: 'tool_use', id: 'call-1', name: 'view', input: { path: '/mock/repo' } },
        { type: 'tool_use', id: 'call-2', name: 'powershell', input: { command: 'npm test' } },
      ],
    });
  });

  it('pairs a result with its call, and a failed call shows its error', async () => {
    const entries = await parseCopilotTranscript(SESSION_ID, FIXTURE);
    const results = entries.filter((entry) => entry.kind === 'tool_result');
    expect(results[0]).toMatchObject({ toolUseId: 'call-1', content: 'src/\ntests/\npackage.json' });
    expect(results[0]).not.toHaveProperty('isError');
    expect(results[1]).toMatchObject({ toolUseId: 'call-2', content: 'Command failed with exit code 1', isError: true });
  });

  it('shows a compaction summary and the start of a resumed run', async () => {
    const entries = await parseCopilotTranscript(SESSION_ID, FIXTURE);
    const system = entries.filter((entry) => entry.kind === 'system');
    expect(system[0]).toMatchObject({ subtype: 'compaction', text: 'Listed the repo and fixed the failing test.' });
    expect(system[1]).toMatchObject({ subtype: 'session_boundary', uuid: 'evt-resume' });
  });

  it('stamps every entry with the byte its line starts at', async () => {
    const entries = await parseCopilotTranscript(SESSION_ID, FIXTURE);
    const text = fs.readFileSync(FIXTURE, 'utf-8');
    // The start of the line holding the first user message, whatever its key order.
    const lineStart = text.lastIndexOf('\n', text.indexOf('"id":"evt-user-1"')) + 1;
    const firstUserByte = Buffer.byteLength(text.slice(0, lineStart));
    expect(entries[0].origin).toEqual({ conversationId: SESSION_ID, position: firstUserByte });
  });

  it('names a record without an id by its byte', async () => {
    const filePath = writeLog([{ type: 'user.message', data: { content: 'hi' }, timestamp: '2026-10-30T10:00:00.000Z' }]);
    const entries = await parseCopilotTranscript(SESSION_ID, filePath);
    expect(entries).toHaveLength(1);
    expect(entries[0].uuid).toBe(`${SESSION_ID}@0`);
  });

  it('marks a log cut to the read window as truncated', async () => {
    const cap = 2 * 1024;
    setParseWindowBytesForTests(cap);
    try {
      const lines = [];
      for (let turn = 0; turn < 40; turn += 1) {
        lines.push({ type: 'user.message', id: `evt-${turn}`, timestamp: '2026-10-30T10:00:00.000Z', data: { content: `turn ${turn} ${'q'.repeat(150)}` } });
      }
      const entries = await parseCopilotTranscript(SESSION_ID, writeLog(lines));
      expect(entries[0]).toMatchObject({ kind: 'system', subtype: 'truncated' });
      expect(entries[entries.length - 1]).toMatchObject({ kind: 'user', uuid: 'evt-39' });
    } finally {
      setParseWindowBytesForTests();
    }
  });

  it('pages its history in tiles that add up to the whole file', async () => {
    const lines = [];
    for (let turn = 0; turn < 24; turn += 1) {
      const timestamp = new Date(Date.UTC(2026, 9, 1, 9, turn)).toISOString();
      lines.push({ type: 'user.message', id: turn % 3 === 0 ? undefined : `user-${turn}`, timestamp, data: { content: `question ${turn} ${'é漢'.repeat(turn % 5)}` } });
      lines.push({ type: 'assistant.usage', ephemeral: true, id: `usage-${turn}`, timestamp, data: { model: 'gpt-5-mini' } });
      lines.push({ type: 'assistant.message', id: `assistant-${turn}`, timestamp, data: { messageId: `m-${turn}`, content: `answer ${turn}`, toolRequests: [{ toolCallId: `call-${turn}`, name: 'view', arguments: { path: `f${turn}` } }] } });
      lines.push({ type: 'tool.execution_complete', id: `result-${turn}`, timestamp, data: { toolCallId: `call-${turn}`, success: true, result: { content: `contents ${turn}` } } });
    }
    const filePath = writeLog(lines);
    const whole = await expectPagesTile({
      filePath,
      conversationId: SESSION_ID,
      parseTail: () => parseCopilotTranscript(SESSION_ID, filePath),
      readPage: (request) => readCopilotTranscriptPage(SESSION_ID, filePath, request),
      tailBytes: 1500,
      pageBytes: 700,
    });
    expect(whole.some((entry) => entry.uuid === `${SESSION_ID}@0`)).toBe(true);
  });
});

describe('parseCopilotTranscript event edge cases', () => {
  const timestamp = '2026-10-30T10:00:00.000Z';

  it('yields no entry for a compaction that did not succeed', async () => {
    const filePath = writeLog([
      { type: 'session.compaction_complete', id: 'c-1', timestamp, data: { success: false, summaryContent: 'half a summary' } },
    ]);
    expect(await parseCopilotTranscript(SESSION_ID, filePath)).toEqual([]);
  });

  it('turns an assistant message with empty content and only tool requests into tool_use blocks', async () => {
    const filePath = writeLog([
      { type: 'assistant.message', id: 'a-1', timestamp, data: { content: '', toolRequests: [{ toolCallId: 'call-1', name: 'view', arguments: { path: 'a' } }] } },
    ]);
    const entries = await parseCopilotTranscript(SESSION_ID, filePath);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      kind: 'assistant',
      uuid: 'a-1',
      blocks: [{ type: 'tool_use', id: 'call-1', name: 'view', input: { path: 'a' } }],
    });
  });

  it('names a tool request that carries no name "tool"', async () => {
    const filePath = writeLog([
      { type: 'assistant.message', id: 'a-1', timestamp, data: { toolRequests: [{ toolCallId: 'call-1', arguments: {} }] } },
    ]);
    const entries = await parseCopilotTranscript(SESSION_ID, filePath);
    expect(entries[0]).toMatchObject({ blocks: [{ type: 'tool_use', id: 'call-1', name: 'tool' }] });
  });

  it('yields no entry for an assistant message with no content, reasoning or tool requests', async () => {
    const filePath = writeLog([
      { type: 'assistant.message', id: 'a-1', timestamp, data: { content: '' } },
      { type: 'assistant.message', id: 'a-2', timestamp, data: { messageId: 'm-2' } },
    ]);
    expect(await parseCopilotTranscript(SESSION_ID, filePath)).toEqual([]);
  });

  it('falls back to the error text for a successful call with no result', async () => {
    const filePath = writeLog([
      { type: 'tool.execution_complete', id: 'r-1', timestamp, data: { toolCallId: 'call-1', success: true, error: { message: 'warned' } } },
    ]);
    const entries = await parseCopilotTranscript(SESSION_ID, filePath);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ kind: 'tool_result', toolUseId: 'call-1', content: 'warned' });
    expect(entries[0]).not.toHaveProperty('isError');
  });

  it('gives empty content to a successful call with neither result nor error', async () => {
    const filePath = writeLog([
      { type: 'tool.execution_complete', id: 'r-1', timestamp, data: { toolCallId: 'call-1', success: true } },
    ]);
    const entries = await parseCopilotTranscript(SESSION_ID, filePath);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ kind: 'tool_result', toolUseId: 'call-1', content: '' });
  });
});

describe('a tool_result carrying both a result and an error', () => {
  const timestamp = '2026-10-30T10:00:00.000Z';
  const data = { toolCallId: 'call-1', result: { content: 'the result text' }, error: { message: 'the error text' } };

  it('shows the result text of a success', async () => {
    const entries = await parseCopilotTranscript(SESSION_ID, writeLog([
      { type: 'tool.execution_complete', id: 'r-1', timestamp, data: { ...data, success: true } },
    ]));
    expect(entries[0]).toMatchObject({ kind: 'tool_result', content: 'the result text' });
    expect(entries[0]).not.toHaveProperty('isError');
  });

  it('shows the error text of a failure, marked as an error', async () => {
    const entries = await parseCopilotTranscript(SESSION_ID, writeLog([
      { type: 'tool.execution_complete', id: 'r-1', timestamp, data: { ...data, success: false } },
    ]));
    expect(entries[0]).toMatchObject({ kind: 'tool_result', content: 'the error text', isError: true });
  });
});

describe('Copilot 1.0.88 captured logs (sanitized)', () => {
  it('replays a successful tool call: user, assistant with the call, its result, the closing assistant', async () => {
    const entries = await parseCopilotTranscript(SESSION_ID, SUCCESS_LOG);
    expect(entries.map((entry) => entry.kind)).toEqual(['user', 'assistant', 'tool_result', 'assistant']);
    expect(entries[0]).toMatchObject({ kind: 'user', text: 'Sanitized data content.' });
    expect(entries[1]).toMatchObject({
      kind: 'assistant',
      blocks: [
        { type: 'text', text: 'Sanitized data content.' },
        { type: 'tool_use', id: FIRST_CALL_ID, name: 'probe-lookup_code', input: {} },
      ],
    });
    expect(entries[2]).toMatchObject({ kind: 'tool_result', toolUseId: FIRST_CALL_ID, content: 'Sanitized result content.' });
    expect(entries[2]).not.toHaveProperty('isError');
    expect(entries[3]).toMatchObject({ kind: 'assistant', blocks: [{ type: 'text', text: 'Sanitized data content.' }] });
  });

  it('sums the success log\'s shutdown usage and counts its one tool call', async () => {
    expect(await copilotTranscriptUsage(SUCCESS_LOG)).toEqual({ inputTokens: 19872, outputTokens: 27 });
    expect(await copilotTranscriptToolCounts(SUCCESS_LOG)).toEqual({
      toolCallCount: 1,
      toolBreakdown: [{ toolName: 'probe-lookup_code', callCount: 1, totalDurationMs: 0, interruptedCount: 0 }],
    });
  });

  it('replays two failed tool calls, one whose arguments are a string, and a closing thinking block', async () => {
    const entries = await parseCopilotTranscript(SESSION_ID, FAILURE_LOG);
    expect(entries.map((entry) => entry.kind)).toEqual(['user', 'assistant', 'tool_result', 'assistant', 'tool_result', 'assistant']);
    expect(entries[1]).toMatchObject({
      blocks: [
        { type: 'text', text: 'Sanitized data content.' },
        { type: 'tool_use', id: FIRST_CALL_ID, name: 'powershell', input: { command: 'sanitized', description: 'sanitized' } },
      ],
    });
    // The real shape the docs do not show: `arguments` is a string.
    expect(entries[3]).toMatchObject({
      blocks: [
        { type: 'text', text: 'Sanitized data content.' },
        { type: 'tool_use', id: SECOND_CALL_ID, name: 'apply_patch', input: 'sanitized' },
      ],
    });
    expect(entries[2]).toMatchObject({ toolUseId: FIRST_CALL_ID, content: 'Sanitized error message.', isError: true });
    expect(entries[4]).toMatchObject({ toolUseId: SECOND_CALL_ID, content: 'Sanitized error message.', isError: true });
    expect(entries[5]).toMatchObject({
      kind: 'assistant',
      blocks: [
        { type: 'thinking', text: 'sanitized' },
        { type: 'text', text: 'Sanitized data content.' },
      ],
    });
  });

  it('sums the failure log\'s shutdown usage and counts each tool once', async () => {
    expect(await copilotTranscriptUsage(FAILURE_LOG)).toEqual({ inputTokens: 36459, outputTokens: 290 });
    expect(await copilotTranscriptToolCounts(FAILURE_LOG)).toEqual({
      toolCallCount: 2,
      toolBreakdown: [
        { toolName: 'powershell', callCount: 1, totalDurationMs: 0, interruptedCount: 0 },
        { toolName: 'apply_patch', callCount: 1, totalDurationMs: 0, interruptedCount: 0 },
      ],
    });
  });
});

describe('a partial read of the event log', () => {
  const shutdown = { type: 'session.shutdown', data: { modelMetrics: { 'model-a': { usage: { inputTokens: 5, outputTokens: 1 } } } } };
  const toolStart = { type: 'tool.execution_start', data: { toolCallId: 'call-1', toolName: 'view' } };

  it('reports no usage when the stream fails after a shutdown was read', async () => {
    const filePath = writeLog([shutdown]);
    expect(await copilotTranscriptUsage(filePath)).toEqual({ inputTokens: 5, outputTokens: 1 });
    streamFailure.armed = true;
    try {
      expect(await copilotTranscriptUsage(filePath)).toBeNull();
    } finally {
      streamFailure.armed = false;
    }
  });

  it('reports no tool counts when the stream fails after a tool start was read', async () => {
    const filePath = writeLog([toolStart]);
    expect((await copilotTranscriptToolCounts(filePath))?.toolCallCount).toBe(1);
    streamFailure.armed = true;
    try {
      expect(await copilotTranscriptToolCounts(filePath)).toBeNull();
    } finally {
      streamFailure.armed = false;
    }
  });
});

describe('copilotTranscriptToolCounts', () => {
  it('counts distinct calls per tool, a subagent\'s included', async () => {
    expect(await copilotTranscriptToolCounts(FIXTURE)).toEqual({
      toolCallCount: 4,
      toolBreakdown: [
        { toolName: 'view', callCount: 2, totalDurationMs: 0, interruptedCount: 0 },
        { toolName: 'powershell', callCount: 1, totalDurationMs: 0, interruptedCount: 0 },
        { toolName: 'edit', callCount: 1, totalDurationMs: 0, interruptedCount: 0 },
      ],
    });
  });

  it('counts a repeated start once', async () => {
    const start = { type: 'tool.execution_start', timestamp: '2026-10-30T10:00:00.000Z', data: { toolCallId: 'call-1', toolName: 'view' } };
    expect((await copilotTranscriptToolCounts(writeLog([start, start])))?.toolCallCount).toBe(1);
  });

  it('answers null for a log with no calls, or none at all', async () => {
    expect(await copilotTranscriptToolCounts(writeLog([{ type: 'user.message', data: { content: 'hi' } }]))).toBeNull();
    expect(await copilotTranscriptToolCounts(path.join(os.tmpdir(), 'copilot-missing-events.jsonl'))).toBeNull();
  });
});

describe('copilotTranscriptUsage', () => {
  it('answers null for a missing file', async () => {
    expect(await copilotTranscriptUsage(path.join(os.tmpdir(), 'copilot-missing-events.jsonl'))).toBeNull();
  });

  it('sums the last shutdown\'s models', async () => {
    expect(await copilotTranscriptUsage(FIXTURE)).toEqual({ inputTokens: 1600, outputTokens: 80 });
  });

  it('never reads the ephemeral per-call usage, and answers null before a run ends', async () => {
    const filePath = writeLog([
      { type: 'assistant.usage', ephemeral: true, data: { model: 'gpt-5-mini', inputTokens: 10, outputTokens: 2 } },
    ]);
    expect(await copilotTranscriptUsage(filePath)).toBeNull();
  });
});
