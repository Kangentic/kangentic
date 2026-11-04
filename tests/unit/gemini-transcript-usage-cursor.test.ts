/**
 * Coverage holes in Gemini's chat-file reader (transcript-usage.ts): patched
 * and re-emitted tool results, cursor invalidation beyond a shrink, a legacy
 * `.json` session read again, id-less and `$set`-seeded messages, a call that
 * takes its message's time, and a replay of a real (sanitized) chat file.
 *
 * What a user loses without these: a parked Gemini session double counts its
 * tokens after the CLI rewrites the file, or its tool-call popover shows the
 * wrong Tokens column.
 */
import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  geminiTranscriptToolCounts,
  geminiTranscriptToolResultTokens,
  geminiTranscriptUsage,
  resetGeminiUsageCursorsForTests,
} from '../../src/main/agent/adapters/gemini/transcript-usage';

const temporaryDirectories: string[] = [];

function makeDirectory(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'gemini-usage-cursor-'));
  temporaryDirectories.push(directory);
  return directory;
}

function serialize(lines: unknown[]): string {
  return lines.map((line) => `${JSON.stringify(line)}\n`).join('');
}

function writeChat(lines: unknown[]): string {
  const file = path.join(makeDirectory(), 'session-2026-10-01T09-00-7d21b8e4.jsonl');
  fs.writeFileSync(file, serialize(lines));
  return file;
}

beforeEach(() => resetGeminiUsageCursorsForTests());
afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

const at = (minute: number): string => new Date(Date.UTC(2026, 9, 1, 9, minute)).toISOString();
const atMs = (minute: number): number => Date.UTC(2026, 9, 1, 9, minute);
const header = { sessionId: '7d21b8e4-5a63-4f0c-b19d-3e8a2c6f4b70', projectHash: '4c1e9a07', startTime: at(0), lastUpdated: at(0), kind: 'main' };
const output = (text: string): unknown => [{ functionResponse: { id: 'x', name: 'tool', response: { output: text } } }];
const tokens = (input: number, outputCount: number): unknown => ({ input, output: outputCount, cached: 0, total: input + outputCount });

describe('tool results arriving after the call', () => {
  it('applies a result carried in $patch.updates[] to the existing call', async () => {
    const file = writeChat([
      header,
      { id: 'g1', timestamp: at(1), type: 'gemini', content: '', toolCalls: [{ id: 'c1', name: 'read_file', args: {}, status: 'executing', timestamp: at(1) }] },
      // The outer patch holds no toolCalls itself, so only the updates[] entry carries the result.
      { $patch: { id: 'g1', updates: [{ id: 'g1', toolCalls: [{ id: 'c1', result: output('abcdefgh') }] }] } },
    ]);
    await expect(geminiTranscriptToolResultTokens(file)).resolves.toEqual({ read_file: 2 });
  });

  it('takes a result from a re-emitted message and still counts the call once', async () => {
    const file = writeChat([
      header,
      { id: 'g1', timestamp: at(1), type: 'gemini', content: '', toolCalls: [{ id: 'c1', name: 'shell', args: {}, status: 'executing', timestamp: at(1) }] },
      { id: 'g1', timestamp: at(1), type: 'gemini', content: 'done', toolCalls: [{ id: 'c1', name: 'shell', args: {}, status: 'success', timestamp: at(1), result: output('x'.repeat(20)) }] },
    ]);
    await expect(geminiTranscriptToolCounts(file)).resolves.toEqual({
      toolCallCount: 1,
      toolBreakdown: [{ toolName: 'shell', callCount: 1, totalDurationMs: 0, interruptedCount: 0, resultTokens: 5 }],
    });
  });
});

describe('cursor invalidation', () => {
  const firstLine = { id: 'g1', timestamp: at(1), type: 'gemini', content: 'A', tokens: tokens(100, 10) };
  const secondLine = { id: 'g2', timestamp: at(2), type: 'gemini', content: 'B', tokens: tokens(200, 20) };

  function setModifiedTime(file: string, secondsFromNow: number): void {
    const time = new Date(Date.now() + secondsFromNow * 1000);
    fs.utimesSync(file, time, time);
  }

  it('starts over when the file is rewritten in place to the same size with different bytes', async () => {
    const file = writeChat([header, firstLine, secondLine]);
    setModifiedTime(file, -20);
    await expect(geminiTranscriptUsage(file)).resolves.toEqual({ inputTokens: 300, outputTokens: 30 });
    // Same length: "input":200 becomes "input":900 in the final line, inside the last 64 bytes.
    const rewritten = serialize([header, firstLine, { ...secondLine, tokens: tokens(900, 20) }]);
    expect(rewritten.length).toBe(serialize([header, firstLine, secondLine]).length);
    fs.writeFileSync(file, rewritten);
    // A later mtime keeps the mtime guard quiet, so only the tail comparison can notice.
    setModifiedTime(file, -10);
    await expect(geminiTranscriptUsage(file)).resolves.toEqual({ inputTokens: 1000, outputTokens: 30 });
  });

  it('starts over when the file is rewritten in place to a longer size', async () => {
    const file = writeChat([header, firstLine, secondLine]);
    setModifiedTime(file, -20);
    await expect(geminiTranscriptUsage(file)).resolves.toEqual({ inputTokens: 300, outputTokens: 30 });
    const thirdLine = { id: 'g3', timestamp: at(3), type: 'gemini', content: 'C', tokens: tokens(5, 1) };
    fs.writeFileSync(file, serialize([header, firstLine, { ...secondLine, tokens: tokens(900, 20) }, thirdLine]));
    setModifiedTime(file, -10);
    // Old plus new would be 300 + 900 + 5; a fresh read gives 100 + 900 + 5.
    await expect(geminiTranscriptUsage(file)).resolves.toEqual({ inputTokens: 1005, outputTokens: 31 });
  });

  it('answers an unchanged file the same twice and adds only an appended line afterwards', async () => {
    const file = writeChat([header, firstLine]);
    await expect(geminiTranscriptUsage(file)).resolves.toEqual({ inputTokens: 100, outputTokens: 10 });
    await expect(geminiTranscriptUsage(file)).resolves.toEqual({ inputTokens: 100, outputTokens: 10 });
    fs.appendFileSync(file, serialize([secondLine]));
    await expect(geminiTranscriptUsage(file)).resolves.toEqual({ inputTokens: 300, outputTokens: 30 });
  });
});

describe('a legacy .json session read again', () => {
  it('counts only the rewritten document, not the first read plus the second', async () => {
    const file = path.join(makeDirectory(), 'session-legacy.json');
    // Id-less messages cannot overwrite each other, so a kept cursor would double count the first one.
    const first = { id: undefined, type: 'gemini', content: 'A', tokens: tokens(100, 10) };
    const second = { id: undefined, type: 'gemini', content: 'B', tokens: tokens(200, 20) };
    fs.writeFileSync(file, JSON.stringify({ ...header, messages: [first] }, null, 2));
    await expect(geminiTranscriptUsage(file)).resolves.toEqual({ inputTokens: 100, outputTokens: 10 });
    fs.writeFileSync(file, JSON.stringify({ ...header, messages: [first, second] }, null, 2));
    await expect(geminiTranscriptUsage(file)).resolves.toEqual({ inputTokens: 300, outputTokens: 30 });
  });
});

describe('messages without an id and $set seeds', () => {
  it('sums id-less gemini messages and counts messages seeded by a $set line', async () => {
    const file = writeChat([
      header,
      { timestamp: at(1), type: 'gemini', content: 'A', tokens: tokens(100, 10) },
      { timestamp: at(2), type: 'gemini', content: 'B', tokens: tokens(50, 5) },
      { $set: { messages: [{ id: 's1', timestamp: at(3), type: 'gemini', content: 'C', tokens: tokens(1000, 100) }] } },
    ]);
    await expect(geminiTranscriptUsage(file)).resolves.toEqual({ inputTokens: 1150, outputTokens: 115 });
  });
});

describe('a tool call with no timestamp of its own', () => {
  function chatWithTimelessCall(): string {
    return writeChat([
      header,
      { id: 'g1', timestamp: at(5), type: 'gemini', content: '', toolCalls: [{ id: 'c1', name: 'list_dir', args: {}, status: 'success' }] },
    ]);
  }

  it('is counted by a closed window around its message time', async () => {
    const file = chatWithTimelessCall();
    const counts = await geminiTranscriptToolCounts(file, atMs(5), atMs(6));
    expect(counts?.toolCallCount).toBe(1);
    expect(counts?.toolBreakdown[0].toolName).toBe('list_dir');
  });

  it('is left out of closed windows that exclude its message time', async () => {
    const file = chatWithTimelessCall();
    await expect(geminiTranscriptToolCounts(file, atMs(6), atMs(7))).resolves.toBeNull();
    // until is exclusive
    await expect(geminiTranscriptToolCounts(file, atMs(1), atMs(5))).resolves.toBeNull();
  });
});

describe('replay of a real Gemini chat file', () => {
  function copyRealSession(): string {
    const file = path.join(makeDirectory(), 'session-real.jsonl');
    fs.copyFileSync(path.join(__dirname, '..', 'fixtures', 'gemini-real-session.jsonl'), file);
    return file;
  }

  it('takes the last tokens of the message it emitted twice', async () => {
    await expect(geminiTranscriptUsage(copyRealSession())).resolves.toEqual({ inputTokens: 1240, outputTokens: 80 });
  });

  it('counts the one list_dir call with the estimated tokens of its functionResponse output', async () => {
    // "file1.txt\nfile2.txt" is 19 characters: ceil(19 / 4) = 5 tokens.
    await expect(geminiTranscriptToolCounts(copyRealSession())).resolves.toEqual({
      toolCallCount: 1,
      toolBreakdown: [{ toolName: 'list_dir', callCount: 1, totalDurationMs: 0, interruptedCount: 0, resultTokens: 5 }],
    });
  });
});
