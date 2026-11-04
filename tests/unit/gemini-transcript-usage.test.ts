/**
 * Lifetime tokens, tool counts and result-token estimates read from Gemini
 * CLI's chat file. Fixtures follow the record types of v0.66.0
 * (chatRecordingTypes.ts): `tokens` on each `gemini` message, `toolCalls[]`
 * with their own `timestamp`, a message appended again under its id, results
 * patched in by `$patch`, and `/rewind`'s `$rewindTo`.
 *
 * What a user loses without these: a parked Gemini session's tool count reads
 * 0, its lifetime tokens fall back to the last turn's snapshot, and the
 * tool-call popover has no Tokens column.
 */
import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  estimateResultTokens,
  geminiTranscriptToolCounts,
  geminiTranscriptToolResultTokens,
  geminiTranscriptUsage,
  resetGeminiUsageCursorsForTests,
} from '../../src/main/agent/adapters/gemini/transcript-usage';
import { GeminiAdapter } from '../../src/main/agent/adapters/gemini';

const temporaryDirectories: string[] = [];

function writeChat(lines: unknown[]): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'gemini-usage-'));
  temporaryDirectories.push(directory);
  const file = path.join(directory, 'session-2026-10-01T09-00-7d21b8e4.jsonl');
  fs.writeFileSync(file, lines.map((line) => `${JSON.stringify(line)}\n`).join(''));
  return file;
}

beforeEach(() => resetGeminiUsageCursorsForTests());
afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

const at = (minute: number): string => new Date(Date.UTC(2026, 9, 1, 9, minute)).toISOString();
const header = { sessionId: '7d21b8e4-5a63-4f0c-b19d-3e8a2c6f4b70', projectHash: '4c1e9a07', startTime: at(0), lastUpdated: at(0), kind: 'main' };
const output = (text: string): unknown => [{ functionResponse: { id: 'x', name: 'tool', response: { output: text } } }];

describe('geminiTranscriptUsage', () => {
  it('sums each message id once, its last tokens winning, thoughts counted as output', async () => {
    const file = writeChat([
      header,
      { id: 'u1', timestamp: at(1), type: 'user', content: [{ text: 'Hi' }] },
      // Streamed first with partial tokens, then appended again in full.
      { id: 'g1', timestamp: at(1), type: 'gemini', content: '', tokens: { input: 900, output: 5, cached: 0, total: 905 } },
      { id: 'g1', timestamp: at(1), type: 'gemini', content: 'Hello', tokens: { input: 1000, output: 50, cached: 400, thoughts: 25, total: 1075 } },
      { id: 'g2', timestamp: at(2), type: 'gemini', content: 'More', tokens: { input: 1100, output: 20, cached: 0, total: 1120 } },
    ]);
    // Input is the full input side (promptTokenCount already holds the cached part).
    await expect(geminiTranscriptUsage(file)).resolves.toEqual({ inputTokens: 2100, outputTokens: 95 });
  });

  it('keeps a rewound turn, which was still billed', async () => {
    const file = writeChat([
      header,
      { id: 'g1', timestamp: at(1), type: 'gemini', content: 'A', tokens: { input: 100, output: 10, cached: 0, total: 110 } },
      { $rewindTo: 'g1' },
      { id: 'g2', timestamp: at(2), type: 'gemini', content: 'B', tokens: { input: 100, output: 10, cached: 0, total: 110 } },
    ]);
    await expect(geminiTranscriptUsage(file)).resolves.toEqual({ inputTokens: 200, outputTokens: 20 });
  });

  it('reads a legacy single-document session', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'gemini-usage-'));
    temporaryDirectories.push(directory);
    const file = path.join(directory, 'session-legacy.json');
    fs.writeFileSync(file, JSON.stringify({
      ...header,
      messages: [{ id: 'g1', type: 'gemini', content: 'A', tokens: { input: 300, output: 30, cached: 0, total: 330 } }],
    }, null, 2));
    await expect(geminiTranscriptUsage(file)).resolves.toEqual({ inputTokens: 300, outputTokens: 30 });
  });

  it('is null for a missing file or one with no token record', async () => {
    await expect(geminiTranscriptUsage(path.join(os.tmpdir(), 'gemini-usage-missing.jsonl'))).resolves.toBeNull();
    const file = writeChat([header, { id: 'u1', timestamp: at(1), type: 'user', content: [{ text: 'Hi' }] }]);
    await expect(geminiTranscriptUsage(file)).resolves.toBeNull();
  });

  it('reads what was appended after a previous read', async () => {
    const file = writeChat([header, { id: 'g1', timestamp: at(1), type: 'gemini', content: 'A', tokens: { input: 100, output: 10, cached: 0, total: 110 } }]);
    await expect(geminiTranscriptUsage(file)).resolves.toEqual({ inputTokens: 100, outputTokens: 10 });
    fs.appendFileSync(file, `${JSON.stringify({ id: 'g2', timestamp: at(2), type: 'gemini', content: 'B', tokens: { input: 200, output: 20, cached: 0, total: 220 } })}\n`);
    await expect(geminiTranscriptUsage(file)).resolves.toEqual({ inputTokens: 300, outputTokens: 30 });
  });

  it('leaves a line still being written for the next read', async () => {
    const file = writeChat([header, { id: 'g1', timestamp: at(1), type: 'gemini', content: 'A', tokens: { input: 100, output: 10, cached: 0, total: 110 } }]);
    const nextLine = JSON.stringify({ id: 'g2', timestamp: at(2), type: 'gemini', content: 'B', tokens: { input: 200, output: 20, cached: 0, total: 220 } });
    fs.appendFileSync(file, nextLine.slice(0, 30));
    await expect(geminiTranscriptUsage(file)).resolves.toEqual({ inputTokens: 100, outputTokens: 10 });
    fs.appendFileSync(file, `${nextLine.slice(30)}\n`);
    await expect(geminiTranscriptUsage(file)).resolves.toEqual({ inputTokens: 300, outputTokens: 30 });
  });

  it('starts over when the file was rewritten shorter', async () => {
    const file = writeChat([
      header,
      { id: 'g1', timestamp: at(1), type: 'gemini', content: 'A', tokens: { input: 100, output: 10, cached: 0, total: 110 } },
      { id: 'g2', timestamp: at(2), type: 'gemini', content: 'B', tokens: { input: 200, output: 20, cached: 0, total: 220 } },
    ]);
    await expect(geminiTranscriptUsage(file)).resolves.toEqual({ inputTokens: 300, outputTokens: 30 });
    fs.writeFileSync(file, `${JSON.stringify(header)}\n${JSON.stringify({ id: 'g9', type: 'gemini', content: 'C', tokens: { input: 7, output: 1, cached: 0, total: 8 } })}\n`);
    await expect(geminiTranscriptUsage(file)).resolves.toEqual({ inputTokens: 7, outputTokens: 1 });
  });
});

describe('geminiTranscriptToolCounts and geminiTranscriptToolResultTokens', () => {
  /** Two runs of one conversation in one file, as a `--resume` appends: minutes 1-2, then 10-11. */
  function twoRuns(): string {
    return writeChat([
      header,
      // Run one: a reply recorded with its call pending, appended again with
      // a second call, then the first call's result patched in.
      { id: 'g1', timestamp: at(1), type: 'gemini', content: '', toolCalls: [
        { id: 'call-1', name: 'read_file', args: { file_path: 'a.ts' }, status: 'executing', timestamp: at(1) },
      ] },
      { id: 'g1', timestamp: at(1), type: 'gemini', content: '', toolCalls: [
        { id: 'call-1', name: 'read_file', args: { file_path: 'a.ts' }, status: 'executing', timestamp: at(1) },
        { id: 'call-2', name: 'run_shell_command', args: { command: 'ls' }, status: 'success', timestamp: at(2), result: output('x'.repeat(40)) },
      ] },
      { $patch: { id: 'g1', toolCalls: [{ id: 'call-1', result: output('y'.repeat(400)) }] } },
      // Run two.
      { id: 'g2', timestamp: at(10), type: 'gemini', content: '', toolCalls: [
        { id: 'call-3', name: 'read_file', args: { file_path: 'b.ts' }, status: 'success', timestamp: at(10), result: output('z'.repeat(80)) },
      ] },
      { $patch: { updates: [{ id: 'g2', toolCalls: [{ id: 'call-4', result: output('ignored: no such call') }] }] } },
    ]);
  }
  const runTwoStart = Date.parse(at(10));

  it('counts each call id once across re-emissions, by tool', async () => {
    const counts = await geminiTranscriptToolCounts(twoRuns());
    expect(counts?.toolCallCount).toBe(3);
    expect(counts?.toolBreakdown).toEqual(expect.arrayContaining([
      expect.objectContaining({ toolName: 'read_file', callCount: 2, resultTokens: 120 }),
      expect.objectContaining({ toolName: 'run_shell_command', callCount: 1, resultTokens: 10 }),
    ]));
  });

  it('scopes counts and result tokens to one run\'s window', async () => {
    const file = twoRuns();
    const earlier = await geminiTranscriptToolCounts(file, null, runTwoStart);
    expect(earlier?.toolCallCount).toBe(2);
    const later = await geminiTranscriptToolCounts(file, runTwoStart, null);
    expect(later?.toolBreakdown).toEqual([expect.objectContaining({ toolName: 'read_file', callCount: 1, resultTokens: 20 })]);
    await expect(geminiTranscriptToolResultTokens(file, null, runTwoStart)).resolves.toEqual({ read_file: 100, run_shell_command: 10 });
  });

  it('a call with no time counts in an open window and not in a closed one', async () => {
    const file = writeChat([header, { type: 'gemini', content: '', toolCalls: [{ id: 'call-1', name: 'glob', args: {}, status: 'success' }] }]);
    await expect(geminiTranscriptToolCounts(file)).resolves.toMatchObject({ toolCallCount: 1 });
    await expect(geminiTranscriptToolCounts(file, 0, Date.parse(at(30)))).resolves.toBeNull();
  });

  it('leaves a tool with no result yet out of the result tokens', async () => {
    const file = writeChat([header, { id: 'g1', timestamp: at(1), type: 'gemini', content: '', toolCalls: [
      { id: 'call-1', name: 'read_file', args: {}, status: 'executing', timestamp: at(1) },
    ] }]);
    await expect(geminiTranscriptToolResultTokens(file)).resolves.toEqual({});
  });

  it('result tokens are null only for a file it cannot read', async () => {
    await expect(geminiTranscriptToolResultTokens(path.join(os.tmpdir(), 'gemini-usage-missing.jsonl'))).resolves.toBeNull();
  });
});

describe('estimateResultTokens', () => {
  it('reads a function response\'s output text at about four characters a token', () => {
    expect(estimateResultTokens(output('a'.repeat(41)))).toBe(11);
  });

  it('counts a response with no output text as its JSON', () => {
    const response = { files: ['a', 'b'] };
    expect(estimateResultTokens([{ functionResponse: { response } }])).toBe(Math.ceil(JSON.stringify(response).length / 4));
  });

  it('is undefined while the result is still pending', () => {
    expect(estimateResultTokens(undefined)).toBeUndefined();
    expect(estimateResultTokens(null)).toBeUndefined();
  });
});

describe('GeminiAdapter transcript reads', () => {
  it('finds the chat file from the session id and cwd when no path is given', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'gemini-usage-home-'));
    temporaryDirectories.push(home);
    const previousHome = process.env.GEMINI_CLI_HOME;
    process.env.GEMINI_CLI_HOME = home;
    try {
      const cwd = path.join(home, 'work', 'petclinic');
      const chats = path.join(home, '.gemini', 'tmp', 'petclinic', 'chats');
      fs.mkdirSync(chats, { recursive: true });
      fs.writeFileSync(path.join(chats, 'session-2026-10-01T09-00-7d21b8e4.jsonl'),
        `${JSON.stringify(header)}\n${JSON.stringify({ id: 'g1', type: 'gemini', content: 'A', tokens: { input: 10, output: 2, cached: 0, total: 12 } })}\n`);
      const usage = await new GeminiAdapter().transcriptUsage({ agentSessionId: header.sessionId, cwd });
      expect(usage).toEqual({ inputTokens: 10, outputTokens: 2 });
    } finally {
      if (previousHome === undefined) delete process.env.GEMINI_CLI_HOME;
      else process.env.GEMINI_CLI_HOME = previousHome;
    }
  });

  it('answers null with neither a path nor an id and cwd', async () => {
    await expect(new GeminiAdapter().transcriptUsage({})).resolves.toBeNull();
  });
});
