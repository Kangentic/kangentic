/**
 * Qwen's lifetime tokens and tool calls, read from its own chat JSONL
 * (`transcript-metrics.ts`). The session row's lifetime totals and the
 * tool-call popover's counts and Tokens column come from these, so a double
 * count or a stray read of another run is a wrong number shown as fact.
 *
 * Record shapes from packages/core/src/services/chatRecordingService.ts,
 * v0.26.6: `assistant` records carry `functionCall` parts and one API
 * response's `usageMetadata`; `tool_result` records carry `functionResponse`
 * parts; `system` ui_telemetry records repeat the counts and are never read.
 */
import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  parseQwenTranscriptToolCounts,
  parseQwenTranscriptToolResultTokens,
  parseQwenTranscriptUsage,
  resetQwenToolCallCursorsForTests,
} from '../../src/main/agent/adapters/qwen-code/transcript-metrics';

const directories: string[] = [];

afterEach(() => {
  resetQwenToolCallCursorsForTests();
  for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

function line(record: Record<string, unknown>): string {
  return `${JSON.stringify(record)}\n`;
}

function sessionFile(text: string): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'qwen-metrics-'));
  directories.push(directory);
  const filePath = path.join(directory, 'session.jsonl');
  fs.writeFileSync(filePath, text);
  return filePath;
}

function assistant(uuid: string, timestamp: string, calls: ReadonlyArray<{ id: string; name: string }>, usageMetadata?: Record<string, number>): string {
  return line({
    type: 'assistant', uuid, timestamp, model: 'qwen3-coder-plus',
    message: { role: 'model', parts: calls.map((call) => ({ functionCall: { id: call.id, name: call.name, args: {} } })) },
    ...(usageMetadata ? { usageMetadata } : {}),
  });
}

function toolResult(uuid: string, timestamp: string, id: string, output: string): string {
  return line({ type: 'tool_result', uuid, timestamp, message: { role: 'user', parts: [{ functionResponse: { id, name: 'tool', response: { output } } }] } });
}

const telemetry = line({ type: 'system', subtype: 'ui_telemetry', systemPayload: { uiEvent: { input_token_count: 999, output_token_count: 999 } } });

describe('parseQwenTranscriptUsage', () => {
  it('sums every API response once: full input (cache included) and output, never the telemetry copies', async () => {
    const filePath = sessionFile(
      assistant('a1', '2026-11-01T10:00:00.000Z', [], { promptTokenCount: 100, cachedContentTokenCount: 40, candidatesTokenCount: 20, totalTokenCount: 120 })
      + telemetry
      + assistant('a2', '2026-11-01T10:01:00.000Z', [], { promptTokenCount: 150, candidatesTokenCount: 30, totalTokenCount: 180 })
      // The same record written twice counts once.
      + assistant('a2', '2026-11-01T10:01:00.000Z', [], { promptTokenCount: 150, candidatesTokenCount: 30, totalTokenCount: 180 }),
    );
    expect(await parseQwenTranscriptUsage(filePath)).toEqual({ inputTokens: 250, outputTokens: 50 });
  });

  it('is null for a missing file or one with no usage', async () => {
    expect(await parseQwenTranscriptUsage(path.join(os.tmpdir(), 'qwen-metrics-missing.jsonl'))).toBeNull();
    expect(await parseQwenTranscriptUsage(sessionFile(telemetry))).toBeNull();
  });
});

describe('parseQwenTranscriptToolCounts and parseQwenTranscriptToolResultTokens', () => {
  it('counts distinct calls by id and sizes each result at four characters a token', async () => {
    const filePath = sessionFile(
      assistant('a1', '2026-11-01T10:00:00.000Z', [{ id: 'c1', name: 'read_file' }, { id: 'c2', name: 'grep_search' }])
      + toolResult('t1', '2026-11-01T10:00:01.000Z', 'c1', 'x'.repeat(40))
      + toolResult('t2', '2026-11-01T10:00:01.000Z', 'c2', 'y'.repeat(7))
      // A re-written record carrying the same call is not a second call.
      + assistant('a1', '2026-11-01T10:00:00.000Z', [{ id: 'c1', name: 'read_file' }]),
    );
    const counts = await parseQwenTranscriptToolCounts(filePath);
    expect(counts?.toolCallCount).toBe(2);
    expect(counts?.toolBreakdown).toEqual(expect.arrayContaining([
      { toolName: 'read_file', callCount: 1, totalDurationMs: 0, interruptedCount: 0, resultTokens: 10 },
      { toolName: 'grep_search', callCount: 1, totalDurationMs: 0, interruptedCount: 0, resultTokens: 2 },
    ]));
    expect(await parseQwenTranscriptToolResultTokens(filePath)).toEqual({ read_file: 10, grep_search: 2 });
  });

  it('reads an older user record carrying the functionResponse too', async () => {
    const filePath = sessionFile(
      assistant('a1', '2026-11-01T10:00:00.000Z', [{ id: 'c1', name: 'read_file' }])
      + line({ type: 'user', uuid: 'r1', message: { role: 'user', parts: [{ functionResponse: { id: 'c1', response: { output: 'abcd' } } }] } }),
    );
    expect(await parseQwenTranscriptToolResultTokens(filePath)).toEqual({ read_file: 1 });
  });

  it('scopes a read to one run by the records\' timestamps', async () => {
    const filePath = sessionFile(
      assistant('a1', '2026-11-01T10:00:00.000Z', [{ id: 'c1', name: 'read_file' }])
      + assistant('a2', '2026-11-01T11:00:00.000Z', [{ id: 'c2', name: 'edit' }])
      + assistant('a3', '2026-11-01T12:00:00.000Z', [{ id: 'c3', name: 'edit' }]),
    );
    const since = Date.parse('2026-11-01T10:30:00.000Z');
    const until = Date.parse('2026-11-01T11:30:00.000Z');
    expect((await parseQwenTranscriptToolCounts(filePath, since, until))?.toolCallCount).toBe(1);
    expect((await parseQwenTranscriptToolCounts(filePath, since))?.toolCallCount).toBe(2);
    expect(await parseQwenTranscriptToolCounts(filePath, Date.parse('2026-11-02T00:00:00.000Z'))).toBeNull();
  });

  it('reads only what was appended on the next call, and starts over when the file is rewritten', async () => {
    const first = assistant('a1', '2026-11-01T10:00:00.000Z', [{ id: 'c1', name: 'read_file' }]);
    const filePath = sessionFile(first);
    expect((await parseQwenTranscriptToolCounts(filePath))?.toolCallCount).toBe(1);

    fs.appendFileSync(filePath, assistant('a2', '2026-11-01T10:01:00.000Z', [{ id: 'c2', name: 'edit' }]));
    expect((await parseQwenTranscriptToolCounts(filePath))?.toolCallCount).toBe(2);

    // Rewritten in place to a different session of the same length or longer.
    fs.writeFileSync(filePath, assistant('b1', '2026-11-01T10:00:00.000Z', [{ id: 'z9', name: 'write_file' }]).padEnd(fs.statSync(filePath).size + 10, ' '));
    const rewritten = await parseQwenTranscriptToolCounts(filePath);
    expect(rewritten?.toolBreakdown.map((stat) => stat.toolName)).toEqual(['write_file']);
  });

  it('is null when the file is missing', async () => {
    const missing = path.join(os.tmpdir(), 'qwen-metrics-missing.jsonl');
    expect(await parseQwenTranscriptToolCounts(missing)).toBeNull();
    expect(await parseQwenTranscriptToolResultTokens(missing)).toBeNull();
  });

  it('counts a call whose record has no timestamp under an open window and leaves it out of a closed one', async () => {
    const filePath = sessionFile(
      line({
        type: 'assistant', uuid: 'a1', model: 'qwen3-coder-plus',
        message: { role: 'model', parts: [{ functionCall: { id: 'c1', name: 'read_file', args: {} } }] },
      }),
    );
    expect((await parseQwenTranscriptToolCounts(filePath))?.toolCallCount).toBe(1);
    expect((await parseQwenTranscriptToolCounts(filePath, Date.parse('2026-11-01T00:00:00.000Z')))?.toolCallCount).toBe(1);
    // A closed window cannot claim a call it cannot place in time.
    expect(await parseQwenTranscriptToolCounts(filePath, null, Date.parse('2026-11-02T00:00:00.000Z'))).toBeNull();
    expect(await parseQwenTranscriptToolCounts(filePath, Date.parse('2026-11-01T00:00:00.000Z'), Date.parse('2026-11-02T00:00:00.000Z'))).toBeNull();
  });
});

describe('the real Qwen session fixtures', () => {
  const fixturesDirectory = path.join(__dirname, '..', 'fixtures');

  it('replays the chat with a tool call: one list_directory call and a 5 token result, no usage recorded', async () => {
    const filePath = path.join(fixturesDirectory, 'qwen-real-session-tools.jsonl');
    // The functionResponse output is "file1.txt\nfile2.txt": 9 + 1 + 9 = 19
    // characters, and ceil(19 / 4) = 5 tokens. The fixture's one functionCall
    // is fc-1 (list_directory), answered by the user record that follows it.
    const counts = await parseQwenTranscriptToolCounts(filePath);
    expect(counts).toEqual({
      toolCallCount: 1,
      toolBreakdown: [{ toolName: 'list_directory', callCount: 1, totalDurationMs: 0, interruptedCount: 0, resultTokens: 5 }],
    });
    expect(await parseQwenTranscriptToolResultTokens(filePath)).toEqual({ list_directory: 5 });
    // No assistant record in this fixture carries usageMetadata, so there is
    // no total to report (null, never a zero shown as fact).
    expect(await parseQwenTranscriptUsage(filePath)).toBeNull();
  });

  it('replays the chat with no tool calls: usage 10 in and 43 out, and no tool counts', async () => {
    const filePath = path.join(fixturesDirectory, 'qwen-real-session.jsonl');
    // One assistant record: promptTokenCount 10, cachedContentTokenCount 0,
    // candidatesTokenCount 43. Input is the full prompt side (10 + 0 cache
    // reads), output is 43. The ui_telemetry record repeats them and is not read.
    expect(await parseQwenTranscriptUsage(filePath)).toEqual({ inputTokens: 10, outputTokens: 43 });
    // No functionCall in the file: no call is in scope, so the count is null
    // and the result sizes are an empty record.
    expect(await parseQwenTranscriptToolCounts(filePath)).toBeNull();
    expect(await parseQwenTranscriptToolResultTokens(filePath)).toEqual({});
  });
});

/**
 * `tests/fixtures/qwen-0.25.2-session/` is written by hand in the exact record
 * structure of a real 0.25.2 session with a subagent: the field set, where
 * `usageMetadata` sits (on the thought record before a tool call, never on
 * the tool-call record), `tool_result` records with `toolCallResult`, and the
 * `ui_telemetry` lines between them. Its content is invented. A sanitized copy
 * of the real capture was not committed, because it would carry a developer's
 * local Qwen data into a public repository.
 */
describe('the 0.25.2-shaped session with a subagent', () => {
  const chatPath = path.join(__dirname, '..', 'fixtures', 'qwen-0.25.2-session', 'chats', '00000000-0000-4000-8000-000000000001.jsonl');

  it('sums the two API responses, cache reads in the input, and never the telemetry lines', async () => {
    // 18000 + 19000 input (15000 of the second cached), 120 + 200 output.
    expect(await parseQwenTranscriptUsage(chatPath)).toEqual({ inputTokens: 37000, outputTokens: 320 });
  });

  it('counts the agent launch and the glob, each sized from its tool_result record', async () => {
    // "The directory holds 3 items: README.md, package.json, src." is 58
    // characters (15 tokens); "Found 3 file(s): README.md package.json src" is 43 (11).
    const counts = await parseQwenTranscriptToolCounts(chatPath);
    expect(counts?.toolCallCount).toBe(2);
    expect(counts?.toolBreakdown).toEqual(expect.arrayContaining([
      { toolName: 'agent', callCount: 1, totalDurationMs: 0, interruptedCount: 0, resultTokens: 15 },
      { toolName: 'glob', callCount: 1, totalDurationMs: 0, interruptedCount: 0, resultTokens: 11 },
    ]));
    // Scoped to the run that started after the subagent returned.
    expect(await parseQwenTranscriptToolResultTokens(chatPath, Date.parse('2026-10-19T05:15:49.000Z'))).toEqual({ glob: 11 });
  });
});
