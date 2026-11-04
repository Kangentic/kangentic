import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseGeminiTranscriptWindow, turnUsageFromTokens } from '../../src/main/agent/adapters/gemini/transcript-parser';
import { GeminiSessionHistoryParser } from '../../src/main/agent/adapters/gemini/session-history-parser';
import type { TranscriptEntry } from '../../src/shared/types';

const createdDirs: string[] = [];

afterEach(() => {
  for (const dir of createdDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function writeLines(lines: string[]): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gemini-records-'));
  createdDirs.push(dir);
  const filePath = path.join(dir, 'session-2026-06-01T00-00-abcd1234.jsonl');
  fs.writeFileSync(filePath, lines.join('\n') + '\n');
  return filePath;
}

const HEADER = JSON.stringify({ sessionId: 'abcd1234-0000', projectHash: 'x', startTime: '2026-06-01T00:00:00.000Z', kind: 'main' });

function resultFor(output: string): unknown[] {
  return [{ functionResponse: { response: { output } } }];
}

function geminiLine(id: string, timestamp: string, toolCalls: unknown[]): string {
  return JSON.stringify({ id, timestamp, type: 'gemini', content: '', model: 'gemini-x', toolCalls });
}

/**
 * Parse the lines after `prefixCount` of them as one window. A mid-file read drops
 * its first (presumed partial) line, so the window starts on the newline that ends
 * the last prefix line: that drops an empty remainder and keeps every later line whole.
 */
async function windowAfter(lines: string[], prefixCount: number): Promise<TranscriptEntry[]> {
  const filePath = writeLines(lines);
  const startByte = Buffer.byteLength(lines.slice(0, prefixCount).join('\n'));
  const result = await parseGeminiTranscriptWindow('abcd1234-0000', filePath, startByte, 1_000_000);
  return result.entries;
}

function toolResults(entries: TranscriptEntry[]): Array<Extract<TranscriptEntry, { kind: 'tool_result' }>> {
  return entries.filter((entry): entry is Extract<TranscriptEntry, { kind: 'tool_result' }> => entry.kind === 'tool_result');
}

describe('Gemini transcript window: $patch records for earlier messages', () => {
  const pendingMessage = geminiLine('g1', '2026-06-01T00:00:01.000Z', [
    { id: 'call-1', name: 'a', args: {}, status: 'executing' },
    { id: 'call-2', name: 'b', args: {}, status: 'executing' },
  ]);

  it('keeps both results when two patches arrive in a window that starts past byte 0', async () => {
    const lines = [
      HEADER,
      pendingMessage,
      JSON.stringify({ $patch: { id: 'g1', toolCalls: [{ id: 'call-1', result: resultFor('one') }] } }),
      JSON.stringify({ $patch: { id: 'g1', toolCalls: [{ id: 'call-2', result: resultFor('two') }] } }),
    ];
    const results = toolResults(await windowAfter(lines, 2));
    expect(results.map((entry) => entry.toolUseId)).toEqual(['call-1', 'call-2']);
    expect(results.map((entry) => entry.content)).toEqual(['one', 'two']);
    expect(results.every((entry) => entry.uuid === 'g1')).toBe(true);
  });

  it('yields results for updates[] entries after the first, and stamps the latest message time', async () => {
    const messageTime = '2026-06-01T05:00:00.000Z';
    const lines = [
      HEADER,
      pendingMessage,
      JSON.stringify({ id: 'u2', timestamp: messageTime, type: 'user', content: [{ text: 'next' }] }),
      JSON.stringify({
        $patch: {
          id: 'unrelated',
          updates: [
            { id: 'g1', toolCalls: [{ id: 'call-1', result: resultFor('first') }] },
            { id: 'g1', toolCalls: [{ id: 'call-2', result: resultFor('second') }] },
          ],
        },
      }),
    ];
    const results = toolResults(await windowAfter(lines, 2));
    expect(results.map((entry) => entry.toolUseId)).toEqual(['call-1', 'call-2']);
    expect(results.map((entry) => entry.content)).toEqual(['first', 'second']);
    expect(results.every((entry) => entry.ts === Date.parse(messageTime))).toBe(true);
  });
});

describe('Gemini transcript: which tool calls count as having a result', () => {
  async function resultsFor(call: Record<string, unknown>): Promise<Array<Extract<TranscriptEntry, { kind: 'tool_result' }>>> {
    const lines = [HEADER, geminiLine('g1', '2026-06-01T00:00:01.000Z', [{ id: 'c', name: 't', args: {}, ...call }])];
    const filePath = writeLines(lines);
    const result = await parseGeminiTranscriptWindow('abcd1234-0000', filePath, 0, 1_000_000);
    return toolResults(result.entries);
  }

  it('counts a call with only resultDisplay', async () => {
    const results = await resultsFor({ resultDisplay: 'shown' });
    expect(results).toHaveLength(1);
    expect(results[0].content).toBe('shown');
  });

  it.each(['success', 'error', 'cancelled'])('counts a %s call with no result', async (status) => {
    const results = await resultsFor({ status });
    expect(results).toHaveLength(1);
    expect(results[0].isError).toBe(status === 'error');
  });

  it('does not count an executing call with nothing else', async () => {
    expect(await resultsFor({ status: 'executing' })).toHaveLength(0);
  });
});

describe('turnUsageFromTokens', () => {
  it('clamps cached to input so fresh input is never negative', () => {
    expect(turnUsageFromTokens({ input: 10, cached: 50, output: 3 })).toEqual({
      inputTokens: 0,
      outputTokens: 3,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 10,
    });
  });

  it('coerces negative, NaN and non-number fields to 0', () => {
    expect(turnUsageFromTokens({ input: -5, cached: Number.NaN, output: '7', thoughts: -1 })).toEqual({
      inputTokens: 0,
      outputTokens: 0,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
    });
  });

  it('adds thoughts to output and subtracts cached from input', () => {
    expect(turnUsageFromTokens({ input: 100, cached: 40, output: 5, thoughts: 7 })).toEqual({
      inputTokens: 60,
      outputTokens: 12,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 40,
    });
  });

  it.each([null, undefined, 'x', 4, [1, 2]])('returns undefined for non-object %j', (value) => {
    expect(turnUsageFromTokens(value)).toBeUndefined();
  });
});

describe('Gemini session history parser: $rewindTo and $patch.orderIds', () => {
  const message = (id: string, model: string, input: number): string => JSON.stringify({
    id, type: 'gemini', model, content: 'x', tokens: { input, output: 1, cached: 0 },
  });

  it('clears every earlier message when $rewindTo names an unknown id', () => {
    const content = [
      HEADER,
      message('m1', 'gemini-old', 111),
      JSON.stringify({ $rewindTo: 'not-a-known-id' }),
    ].join('\n');
    const result = GeminiSessionHistoryParser.parse(content, 'full');
    expect(result.usage).toBeNull();
  });

  it('keeps messages before a known $rewindTo target and drops the rest', () => {
    const content = [
      HEADER,
      message('m1', 'gemini-first', 111),
      message('m2', 'gemini-second', 222),
      JSON.stringify({ $rewindTo: 'm2' }),
    ].join('\n');
    const usage = GeminiSessionHistoryParser.parse(content, 'full').usage;
    expect(usage?.model.id).toBe('gemini-first');
    expect(usage?.contextWindow.totalInputTokens).toBe(111);
  });

  it('makes a message moved to the end by orderIds the latest one', () => {
    const content = [
      HEADER,
      message('m1', 'gemini-moved', 111),
      message('m2', 'gemini-later', 222),
      JSON.stringify({ $patch: { orderIds: ['m1'] } }),
    ].join('\n');
    const usage = GeminiSessionHistoryParser.parse(content, 'full').usage;
    expect(usage?.model.id).toBe('gemini-moved');
    expect(usage?.contextWindow.totalInputTokens).toBe(111);
  });

  it('reports the later message when no orderIds patch reorders anything', () => {
    const content = [
      HEADER,
      message('m1', 'gemini-first', 111),
      message('m2', 'gemini-later', 222),
    ].join('\n');
    expect(GeminiSessionHistoryParser.parse(content, 'full').usage?.model.id).toBe('gemini-later');
  });
});
