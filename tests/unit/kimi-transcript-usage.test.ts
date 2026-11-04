/**
 * Lifetime tokens, tool counts and subagent usage read from Kimi Code's wire
 * files, shaped to `wire-manifest.d.ts` and `loopEventFold.ts` at 2.4.1. A
 * wrong read lands on the task's stats as fact, so a partial read must answer
 * nothing rather than a smaller number.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The real reader, except that a test can make it report the file as not read to
// the end after it delivered every record: the shape of a read that failed
// part way (an EBUSY on Windows), which no file on disk can be made to produce.
const readControl = vi.hoisted(() => ({ reportPartialRead: false }));
vi.mock('../../src/main/agent/shared/history-scan', async () => {
  const actual = await vi.importActual<typeof import('../../src/main/agent/shared/history-scan')>('../../src/main/agent/shared/history-scan');
  return {
    ...actual,
    streamJsonlRecords: async (...args: Parameters<typeof actual.streamJsonlRecords>) => {
      const readWholeFile = await actual.streamJsonlRecords(...args);
      return readControl.reportPartialRead ? false : readWholeFile;
    },
  };
});

import { kimiTranscriptToolCounts, kimiTranscriptUsage } from '../../src/main/agent/adapters/kimi/transcript-usage';
import { parseKimiSubagentUsage, statKimiSubagentTranscripts } from '../../src/main/agent/adapters/kimi/subagent-transcripts';

let directory: string;

const stepEnd = (uuid: string, usage: Record<string, number>, time = 1000) =>
  JSON.stringify({ type: 'context.append_loop_event', agentId: 'main', event: { type: 'step.end', uuid, usage }, time });
const toolCall = (toolCallId: string, name: string, time: number, stepUuid = 'step-1') =>
  JSON.stringify({ type: 'context.append_loop_event', agentId: 'main', event: { type: 'tool.call', stepUuid, toolCallId, name, args: {} }, time });

function write(relativePath: string, lines: string[]): string {
  const filePath = path.join(directory, relativePath);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, lines.join('\n') + '\n');
  return filePath;
}

beforeEach(() => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'kangentic-kimi-usage-'));
});

afterEach(() => {
  readControl.reportPartialRead = false;
  fs.rmSync(directory, { recursive: true, force: true });
});

describe('a read that did not reach the end of the file', () => {
  it('answers nothing for usage and for tool counts, never a smaller total', async () => {
    const filePath = write('wire.jsonl', [stepEnd('s1', { inputOther: 100, output: 10 }), toolCall('a', 'Read', 1000)]);
    await expect(kimiTranscriptUsage(filePath)).resolves.toEqual({ inputTokens: 100, outputTokens: 10 });
    await expect(kimiTranscriptToolCounts(filePath)).resolves.toMatchObject({ toolCallCount: 1 });

    readControl.reportPartialRead = true;
    await expect(kimiTranscriptUsage(filePath)).resolves.toBeNull();
    await expect(kimiTranscriptToolCounts(filePath)).resolves.toBeNull();
  });
});

describe('kimiTranscriptUsage', () => {
  it('sums every step, cache reads and writes in the input', async () => {
    const filePath = write('wire.jsonl', [
      '{"type":"metadata","protocol_version":"1.5","created_at":1}',
      stepEnd('s1', { inputOther: 100, output: 10, inputCacheRead: 50, inputCacheCreation: 5 }),
      stepEnd('s2', { inputOther: 200, output: 20 }),
    ]);
    await expect(kimiTranscriptUsage(filePath)).resolves.toEqual({ inputTokens: 355, outputTokens: 30 });
  });

  it('answers nothing for a file with no steps, or none at all', async () => {
    await expect(kimiTranscriptUsage(write('empty.jsonl', ['{"type":"metadata"}']))).resolves.toBeNull();
    await expect(kimiTranscriptUsage(path.join(directory, 'missing.jsonl'))).resolves.toBeNull();
  });
});

describe('kimiTranscriptToolCounts', () => {
  const lines = [toolCall('a', 'Read', 1000), toolCall('a', 'Read', 1000), toolCall('b', 'Bash', 2000), toolCall('c', 'Bash', 3000)];

  it('counts distinct calls per tool, most used first', async () => {
    const counts = await kimiTranscriptToolCounts(write('wire.jsonl', lines));
    expect(counts?.toolCallCount).toBe(3);
    expect(counts?.toolBreakdown.map((stat) => [stat.toolName, stat.callCount])).toEqual([['Bash', 2], ['Read', 1]]);
  });

  it('scopes to one run\'s window, since every resume appends to one file', async () => {
    const file = write('wire.jsonl', lines.map((line) => line.replace(/"time":(\d+)/, (_all, time) => `"time":${Number(time) * 1e10}`)));
    const counts = await kimiTranscriptToolCounts(file, { sinceMs: 2000e10, untilMs: 3000e10 });
    expect(counts?.toolCallCount).toBe(1);
  });

  it('reads a time written in seconds as ms when it scopes the window', async () => {
    const secondsFile = write('wire.jsonl', [toolCall('a', 'Read', 1_792_000_000), toolCall('b', 'Bash', 1_792_000_500)]);
    // 1_792_000_000 s is 1_792_000_000_000 ms: inside this window, while the
    // later call (500 s on) falls outside it.
    const counts = await kimiTranscriptToolCounts(secondsFile, { sinceMs: 1_792_000_000_000, untilMs: 1_792_000_100_000 });
    expect(counts?.toolBreakdown.map((stat) => stat.toolName)).toEqual(['Read']);
  });

  it('leaves a call with no time out of a closed window only', async () => {
    const line = JSON.stringify({ type: 'context.append_loop_event', event: { type: 'tool.call', toolCallId: 'x', name: 'Read' } });
    const file = write('wire.jsonl', [line]);
    expect((await kimiTranscriptToolCounts(file, { sinceMs: 1 }))?.toolCallCount).toBe(1);
    await expect(kimiTranscriptToolCounts(file, { sinceMs: 1, untilMs: 2 })).resolves.toBeNull();
  });
});

describe('subagent transcripts', () => {
  const sessionDir = () => directory;
  const mainWire = () => path.join(directory, 'agents', 'main', 'wire.jsonl');

  beforeEach(() => {
    write('agents/main/wire.jsonl', [
      JSON.stringify({ type: 'subagent.spawned', subagentId: 'agent-0', subagentName: 'explore', parentToolCallId: 'call-1', runInBackground: false, time: 1 }),
    ]);
  });

  it('reports no signature for a session that never fanned out', () => {
    expect(statKimiSubagentTranscripts(sessionDir())).toBeNull();
  });

  it('signs the subagent files, and not the main one', () => {
    const filePath = write('agents/agent-0/wire.jsonl', [stepEnd('s1', { output: 1 })]);
    const signature = statKimiSubagentTranscripts(sessionDir());
    expect(signature?.fileCount).toBe(1);
    expect(signature?.totalSize).toBe(fs.statSync(filePath).size);
  });

  it('reads a step per ledger row, keyed so a re-walk writes the same rows', async () => {
    write('agents/agent-0/wire.jsonl', [
      JSON.stringify({ type: 'llm.request', model: 'k3', provider: 'p', kind: 'loop', time: 1 }),
      stepEnd('s1', { inputOther: 100, output: 10, inputCacheRead: 30, inputCacheCreation: 5 }, 1_792_000_000_000),
      stepEnd('s2', { inputOther: 0, output: 0 }),
      toolCall('call-2', 'Agent', 2, 's2'),
    ]);
    const parsed = await parseKimiSubagentUsage(sessionDir(), mainWire());
    expect(parsed).toMatchObject({ directoryPresent: true, complete: true });
    expect(parsed.turns).toEqual([{
      turnUuid: 'sub:agent-0:s1',
      subagentId: 'agent-0',
      agentType: 'explore',
      spawnDepth: 1,
      parentToolUseId: 'call-1',
      ts: 1_792_000_000_000,
      model: 'k3',
      usage: { inputTokens: 100, outputTokens: 10, cacheCreationInputTokens: 5, cacheReadInputTokens: 30 },
    }]);
    // The zero-count step made no row, and its spawn link is kept anyway.
    expect(parsed.spawnLinks).toEqual([{ toolUseId: 'call-2', turnUuid: 'sub:agent-0:s2' }]);
  });

  it('is not complete when the main wire that names the spawns is missing', async () => {
    fs.rmSync(mainWire());
    write('agents/agent-0/wire.jsonl', [stepEnd('s1', { output: 4 }, 1_792_000_000_000)]);
    const parsed = await parseKimiSubagentUsage(sessionDir(), mainWire());
    expect(parsed.directoryPresent).toBe(true);
    expect(parsed.complete).toBe(false);
  });

  it('leaves the depth unknown for a subagent a subagent spawned, and the ts unknown for a record with no time', async () => {
    write('agents/main/wire.jsonl', [
      JSON.stringify({ type: 'subagent.spawned', subagentId: 'agent-0', subagentName: 'explore', parentToolCallId: 'call-1', parentAgentId: 'main', time: 1 }),
      JSON.stringify({ type: 'subagent.spawned', subagentId: 'agent-1', subagentName: 'review', parentToolCallId: 'call-2', parentAgentId: 'agent-0', time: 2 }),
    ]);
    write('agents/agent-0/wire.jsonl', [stepEnd('s1', { output: 4 }, 1_792_000_000_000)]);
    const timeless = JSON.stringify({ type: 'context.append_loop_event', event: { type: 'step.end', uuid: 's2', usage: { output: 9 } } });
    write('agents/agent-1/wire.jsonl', [timeless]);
    const parsed = await parseKimiSubagentUsage(sessionDir(), mainWire());
    const byId = new Map(parsed.turns.map((turn) => [turn.subagentId, turn]));
    expect(byId.get('agent-0')?.spawnDepth).toBe(1);
    expect(byId.get('agent-1')).toMatchObject({ spawnDepth: null, ts: null, parentToolUseId: 'call-2' });
  });

  it('records a coverage gap for a session with no subagent files', async () => {
    const parsed = await parseKimiSubagentUsage(sessionDir(), mainWire());
    expect(parsed.directoryPresent).toBe(false);
  });
});
