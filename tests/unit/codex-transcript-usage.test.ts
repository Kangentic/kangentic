/**
 * The per-task stats Codex's rollout feeds (transcript-usage.ts): lifetime
 * tokens, tool-call counts named as Codex's hooks name them, and result-size
 * estimates read from appended bytes only.
 *
 * Fixture lines are shaped like codex-cli 0.163.0's rollout
 * (codex-rs/history/src/rollout_payload.rs, codex-rs/protocol/src/models.rs at
 * rust-v0.163.0), sanitized: zeroed ids, no real paths.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { JSONL_READ_CHUNK_BYTES } from '../../src/main/agent/shared/jsonl-complete-lines';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  codexHookToolName,
  codexTranscriptToolCounts,
  codexTranscriptToolResultTokens,
  codexTranscriptUsage,
  resetCodexResultCursorsForTests,
} from '../../src/main/agent/adapters/codex/transcript-usage';

const SESSION = '00000000-0000-4000-8000-000000000001';
const OTHER_THREAD = '00000000-0000-4000-8000-000000000002';

const sessionMeta = (): string => JSON.stringify({ timestamp: '2026-10-20T10:00:00.000Z', type: 'session_meta', payload: { id: SESSION, cwd: 'C:\\Users\\dev\\repo', cli_version: '0.163.0' } });

function usageRecord(threadId: string, responseId: string, input: number, output: number): string {
  const usage = { input_tokens: input, cached_input_tokens: 0, cache_write_input_tokens: 0, output_tokens: output, reasoning_output_tokens: 0, total_tokens: input + output };
  return JSON.stringify({
    timestamp: '2026-10-20T10:01:00.000Z',
    type: 'token_usage_record',
    payload: { thread_id: threadId, session_id: SESSION, turn_id: 'turn-1', response_id: responseId, usage, turn_token_usage: usage, thread_token_usage: usage },
  });
}

function tokenCount(input: number, output: number): string {
  const total = { input_tokens: input, cached_input_tokens: 0, output_tokens: output, reasoning_output_tokens: 0, total_tokens: input + output };
  return JSON.stringify({ timestamp: '2026-10-20T10:01:00.000Z', type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: total, last_token_usage: total, model_context_window: 258400 }, rate_limits: null } });
}

function functionCall(callId: string, name: string, at: string | null, namespace?: string): string {
  return JSON.stringify({
    ...(at ? { timestamp: at } : {}),
    type: 'response_item',
    payload: { type: 'function_call', name, ...(namespace ? { namespace } : {}), arguments: '{"cmd":"ls"}', call_id: callId },
  });
}

function customCall(callId: string, name: string, at: string): string {
  return JSON.stringify({ timestamp: at, type: 'response_item', payload: { type: 'custom_tool_call', status: 'completed', call_id: callId, name, input: '*** Begin Patch\n*** End Patch\n' } });
}

function output(callId: string, text: string, at: string, type = 'function_call_output'): string {
  return JSON.stringify({ timestamp: at, type: 'response_item', payload: { type, call_id: callId, output: text } });
}

let directory: string;

function writeRollout(lines: string[]): string {
  const filePath = path.join(directory, `rollout-2026-10-20T10-00-00-${SESSION}.jsonl`);
  fs.writeFileSync(filePath, `${lines.join('\n')}\n`);
  return filePath;
}

beforeEach(() => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-transcript-usage-'));
  resetCodexResultCursorsForTests();
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(directory, { recursive: true, force: true });
});

describe('codexTranscriptUsage', () => {
  it('sums each response once, for the rollout own thread only', async () => {
    const filePath = writeRollout([
      sessionMeta(),
      usageRecord(SESSION, 'resp-1', 1_000, 10),
      usageRecord(SESSION, 'resp-1', 1_000, 10),
      usageRecord(SESSION, 'resp-2', 2_000, 20),
      usageRecord(OTHER_THREAD, 'resp-3', 50_000, 500),
      // A later token_count never replaces the per-response sum.
      tokenCount(9, 9),
    ]);
    await expect(codexTranscriptUsage(filePath)).resolves.toEqual({ inputTokens: 3_000, outputTokens: 30 });
  });

  it('takes the last running total from a rollout written before 0.163', async () => {
    const filePath = writeRollout([sessionMeta(), tokenCount(1_000, 10), tokenCount(2_500, 40)]);
    await expect(codexTranscriptUsage(filePath)).resolves.toEqual({ inputTokens: 2_500, outputTokens: 40 });
  });

  it('is null for a rollout with no usage, and for a missing file', async () => {
    await expect(codexTranscriptUsage(writeRollout([sessionMeta()]))).resolves.toBeNull();
    await expect(codexTranscriptUsage(path.join(directory, 'missing.jsonl'))).resolves.toBeNull();
  });

  it('counts a record that names no thread as the rollout own', async () => {
    const withoutThread = JSON.parse(usageRecord(SESSION, 'resp-1', 700, 7)) as { payload: Record<string, unknown> };
    delete withoutThread.payload.thread_id;
    const filePath = writeRollout([
      sessionMeta(),
      JSON.stringify(withoutThread),
      usageRecord(OTHER_THREAD, 'resp-2', 50_000, 500),
    ]);
    await expect(codexTranscriptUsage(filePath)).resolves.toEqual({ inputTokens: 700, outputTokens: 7 });
  });

  it('counts a record that comes before any session_meta line', async () => {
    const filePath = writeRollout([
      // The rollout's own thread is not known yet, so this one cannot be told apart and counts.
      usageRecord(OTHER_THREAD, 'resp-1', 300, 3),
      sessionMeta(),
      usageRecord(SESSION, 'resp-2', 400, 4),
      usageRecord(OTHER_THREAD, 'resp-3', 50_000, 500),
    ]);
    await expect(codexTranscriptUsage(filePath)).resolves.toEqual({ inputTokens: 700, outputTokens: 7 });
  });

  it('reads the pre-0.163 token_count capture: the last info.total_token_usage', async () => {
    const fixturePath = path.join(__dirname, '..', 'fixtures', 'codex-rollout-event-msg.jsonl');
    await expect(codexTranscriptUsage(fixturePath)).resolves.toEqual({ inputTokens: 21_122, outputTokens: 334 });
  });
});

describe('a rollout in the 0.163.0 record shape', () => {
  // Keys from local 0.163.0 rollouts, every value invented, so this is not a
  // capture of a real turn. See the note in docs/integrations/agents/codex-cli.md.
  const shapeRollout = path.join(__dirname, '..', 'fixtures', 'codex-0.163.0-rollout-shape.jsonl');

  it('sums the two responses of the rollout own thread, past the nested thread record', async () => {
    await expect(codexTranscriptUsage(shapeRollout)).resolves.toEqual({ inputTokens: 2_500, outputTokens: 100 });
  });

  it('counts the apply_patch and the exec_command, each under its hook name', async () => {
    await expect(codexTranscriptToolCounts(shapeRollout)).resolves.toEqual({
      toolCallCount: 2,
      toolBreakdown: [
        { toolName: 'apply_patch', callCount: 1, totalDurationMs: 0, interruptedCount: 0 },
        { toolName: 'Bash', callCount: 1, totalDurationMs: 0, interruptedCount: 0 },
      ],
    });
  });

  it('estimates both outputs under those same names', async () => {
    // 54 characters for the patch result, 38 for the command's.
    await expect(codexTranscriptToolResultTokens(shapeRollout)).resolves.toEqual({ apply_patch: 14, Bash: 10 });
  });
});

describe('real captured rollouts', () => {
  const realRollout = path.join(__dirname, '..', 'fixtures', 'codex-real-rollout.jsonl');
  const backgroundRollout = path.join(__dirname, '..', 'fixtures', 'codex-rollout-background-session.jsonl');

  it('counts the one call of the plain capture under the name the rollout records', async () => {
    await expect(codexTranscriptToolCounts(realRollout)).resolves.toEqual({
      toolCallCount: 1,
      toolBreakdown: [{ toolName: 'shell', callCount: 1, totalDurationMs: 0, interruptedCount: 0 }],
    });
    // "file1.txt\nfile2.txt" is 19 characters.
    await expect(codexTranscriptToolResultTokens(realRollout)).resolves.toEqual({ shell: 5 });
  });

  it('names exec_command as Bash and leaves the write_stdin poll out of the counts and the result tokens', async () => {
    await expect(codexTranscriptToolCounts(backgroundRollout)).resolves.toEqual({
      toolCallCount: 3,
      toolBreakdown: [{ toolName: 'Bash', callCount: 3, totalDurationMs: 0, interruptedCount: 0 }],
    });
    // Outputs of 143, 105 and 143 characters: 36 + 27 + 36. The poll's own 113-character output is not counted.
    await expect(codexTranscriptToolResultTokens(backgroundRollout)).resolves.toEqual({ Bash: 99 });
  });
});

describe('codexHookToolName', () => {
  it('names a call the way Codex 0.163.0 hooks report it', () => {
    expect(codexHookToolName('exec_command', null)).toBe('Bash');
    expect(codexHookToolName('local_shell', null)).toBe('Bash');
    expect(codexHookToolName('apply_patch', null)).toBe('apply_patch');
    expect(codexHookToolName('spawn_agent', 'multi_agent_v1')).toBe('spawn_agent');
    expect(codexHookToolName('kangentic_list_tasks', 'mcp__kangentic__')).toBe('mcp__kangentic__kangentic_list_tasks');
    expect(codexHookToolName('_create', 'mcp__memory')).toBe('mcp__memory__create');
    expect(codexHookToolName('view_image', null)).toBe('view_image');
  });
});

describe('codexTranscriptToolCounts', () => {
  const lines = (): string[] => [
    sessionMeta(),
    functionCall('call-1', 'exec_command', '2026-10-20T10:00:10.000Z'),
    output('call-1', 'ok', '2026-10-20T10:00:11.000Z'),
    // The same call written twice counts once.
    functionCall('call-1', 'exec_command', '2026-10-20T10:00:10.000Z'),
    customCall('call-2', 'apply_patch', '2026-10-20T10:00:20.000Z'),
    functionCall('call-3', 'write_stdin', '2026-10-20T10:00:30.000Z'),
    functionCall('call-4', 'kangentic_list_tasks', '2026-10-20T11:00:00.000Z', 'mcp__kangentic__'),
    JSON.stringify({ timestamp: '2026-10-20T11:00:10.000Z', type: 'response_item', payload: { type: 'local_shell_call', call_id: 'call-5', status: 'completed', action: { type: 'exec', command: ['ls'] } } }),
    functionCall('call-6', 'exec_command', null),
  ];

  it('counts distinct calls by hook name, leaving out the write_stdin polls no hook reports', async () => {
    const counts = await codexTranscriptToolCounts(writeRollout(lines()));
    expect(counts).toEqual({
      toolCallCount: 5,
      toolBreakdown: [
        { toolName: 'Bash', callCount: 3, totalDurationMs: 0, interruptedCount: 0 },
        { toolName: 'apply_patch', callCount: 1, totalDurationMs: 0, interruptedCount: 0 },
        { toolName: 'mcp__kangentic__kangentic_list_tasks', callCount: 1, totalDurationMs: 0, interruptedCount: 0 },
      ],
    });
  });

  it('counts only one run of a resumed rollout, and leaves a call with no time out of a closed window', async () => {
    const filePath = writeRollout(lines());
    const firstRun = await codexTranscriptToolCounts(filePath, Date.parse('2026-10-20T10:00:00.000Z'), Date.parse('2026-10-20T10:30:00.000Z'));
    expect(firstRun?.toolCallCount).toBe(2);
    const laterRun = await codexTranscriptToolCounts(filePath, Date.parse('2026-10-20T10:30:00.000Z'));
    // The two calls after 10:30, plus the call with no time in an open window.
    expect(laterRun?.toolCallCount).toBe(3);
  });

  it('includes a call made exactly at sinceMs and leaves out one made exactly at untilMs', async () => {
    const filePath = writeRollout([
      sessionMeta(),
      functionCall('call-1', 'exec_command', '2026-10-20T10:00:10.000Z'),
      customCall('call-2', 'apply_patch', '2026-10-20T10:00:20.000Z'),
    ]);
    const counts = await codexTranscriptToolCounts(filePath, Date.parse('2026-10-20T10:00:10.000Z'), Date.parse('2026-10-20T10:00:20.000Z'));
    expect(counts).toEqual({
      toolCallCount: 1,
      toolBreakdown: [{ toolName: 'Bash', callCount: 1, totalDurationMs: 0, interruptedCount: 0 }],
    });
  });

  it('is null for a rollout with no tool call', async () => {
    await expect(codexTranscriptToolCounts(writeRollout([sessionMeta()]))).resolves.toBeNull();
  });
});

describe('codexTranscriptToolResultTokens', () => {
  it('estimates each output at chars/4 under its call hook name, within the window', async () => {
    const filePath = writeRollout([
      sessionMeta(),
      functionCall('call-1', 'exec_command', '2026-10-20T10:00:10.000Z'),
      output('call-1', 'x'.repeat(40), '2026-10-20T10:00:11.000Z'),
      customCall('call-2', 'apply_patch', '2026-10-20T10:00:20.000Z'),
      output('call-2', 'y'.repeat(9), '2026-10-20T10:00:21.000Z', 'custom_tool_call_output'),
      functionCall('call-3', 'exec_command', '2026-10-20T11:00:10.000Z'),
      JSON.stringify({ timestamp: '2026-10-20T11:00:11.000Z', type: 'response_item', payload: { type: 'function_call_output', call_id: 'call-3', output: [{ type: 'input_text', text: 'z'.repeat(8) }, { type: 'input_image', image_url: 'data:image/png;base64,AAAA' }] } }),
    ]);
    await expect(codexTranscriptToolResultTokens(filePath)).resolves.toEqual({ Bash: 12, apply_patch: 3 });
    await expect(codexTranscriptToolResultTokens(filePath, null, Date.parse('2026-10-20T10:30:00.000Z'))).resolves.toEqual({ Bash: 10, apply_patch: 3 });
  });

  it('reads only what was appended since the last call, and starts over when the file was rewritten', async () => {
    const filePath = writeRollout([sessionMeta(), functionCall('call-1', 'exec_command', '2026-10-20T10:00:10.000Z')]);
    await expect(codexTranscriptToolResultTokens(filePath)).resolves.toEqual({});
    // The output lands on a later read, matched to the call an earlier read saw.
    fs.appendFileSync(filePath, `${output('call-1', 'a'.repeat(20), '2026-10-20T10:00:11.000Z')}\n`);
    await expect(codexTranscriptToolResultTokens(filePath)).resolves.toEqual({ Bash: 5 });
    // A line still being written is not read until it ends.
    fs.appendFileSync(filePath, `${functionCall('call-2', 'exec_command', '2026-10-20T10:00:12.000Z')}\n${output('call-2', 'b'.repeat(4), '2026-10-20T10:00:13.000Z').slice(0, 20)}`);
    await expect(codexTranscriptToolResultTokens(filePath)).resolves.toEqual({ Bash: 5 });
    // A smaller file is a rewrite: nothing from the old cursor is kept.
    writeRollout([sessionMeta(), customCall('call-9', 'apply_patch', '2026-10-20T10:00:00.000Z'), output('call-9', 'c'.repeat(4), '2026-10-20T10:00:01.000Z', 'custom_tool_call_output')]);
    await expect(codexTranscriptToolResultTokens(filePath)).resolves.toEqual({ apply_patch: 1 });
  });

  it('is null for a missing file', async () => {
    await expect(codexTranscriptToolResultTokens(path.join(directory, 'missing.jsonl'))).resolves.toBeNull();
  });

  it('includes an output written exactly at sinceMs and leaves out one written exactly at untilMs', async () => {
    const filePath = writeRollout([
      sessionMeta(),
      functionCall('call-1', 'exec_command', '2026-10-20T10:00:09.000Z'),
      output('call-1', 'x'.repeat(40), '2026-10-20T10:00:10.000Z'),
      customCall('call-2', 'apply_patch', '2026-10-20T10:00:19.000Z'),
      output('call-2', 'y'.repeat(40), '2026-10-20T10:00:20.000Z', 'custom_tool_call_output'),
    ]);
    const sinceMs = Date.parse('2026-10-20T10:00:10.000Z');
    const untilMs = Date.parse('2026-10-20T10:00:20.000Z');
    await expect(codexTranscriptToolResultTokens(filePath, sinceMs, untilMs)).resolves.toEqual({ Bash: 10 });
  });

  it('keeps a tool named like an inherited key as its own number, not a string built from Object.prototype', async () => {
    const filePath = writeRollout([
      sessionMeta(),
      functionCall('call-1', 'constructor', '2026-10-20T10:00:10.000Z'),
      output('call-1', 'x'.repeat(20), '2026-10-20T10:00:11.000Z'),
      functionCall('call-2', '__proto__', '2026-10-20T10:00:12.000Z'),
      output('call-2', 'y'.repeat(8), '2026-10-20T10:00:13.000Z'),
    ]);
    const tokens = await codexTranscriptToolResultTokens(filePath);
    expect(tokens).not.toBeNull();
    expect(Object.hasOwn(tokens!, 'constructor')).toBe(true);
    expect(tokens!.constructor).toBe(5);
    expect(Object.hasOwn(tokens!, '__proto__')).toBe(true);
    expect(Object.getPrototypeOf(tokens)).toBe(Object.prototype);
    expect(Object.entries(tokens!)).toEqual([['constructor', 5], ['__proto__', 2]]);
  });

  /**
   * The next `fs.promises.open` answers a real handle, with `adjust` applied to it,
   * so a read error is made at a chosen point instead of by racing the file system.
   */
  function openNextWith(adjust: (handle: fs.promises.FileHandle) => void): void {
    const realOpen = fs.promises.open.bind(fs.promises);
    vi.spyOn(fs.promises, 'open').mockImplementationOnce(async (...openArguments: Parameters<typeof fs.promises.open>) => {
      const handle = await realOpen(...openArguments);
      adjust(handle);
      return handle;
    });
  }

  it('resolves null when a read fails mid-way, and the next call reads the file whole instead of from the half-applied cursor', async () => {
    const filePath = writeRollout([
      sessionMeta(),
      functionCall('call-1', 'exec_command', '2026-10-20T10:00:10.000Z'),
      output('call-1', 'x'.repeat(40), '2026-10-20T10:00:11.000Z'),
    ]);
    await expect(codexTranscriptToolResultTokens(filePath)).resolves.toEqual({ Bash: 10 });
    // More than one read chunk is appended, so the first chunk's lines are applied before the second read fails.
    const filler = JSON.stringify({ timestamp: '2026-10-20T10:00:14.000Z', type: 'event_msg', payload: { type: 'agent_message', message: 'p'.repeat(1000) } });
    const fillerLines = Array.from({ length: Math.ceil((JSONL_READ_CHUNK_BYTES * 1.5) / (filler.length + 1)) }, () => filler);
    fs.appendFileSync(filePath, `${[
      functionCall('call-2', 'exec_command', '2026-10-20T10:00:12.000Z'),
      output('call-2', 'y'.repeat(8), '2026-10-20T10:00:13.000Z'),
      ...fillerLines,
    ].join('\n')}\n`);
    openNextWith((handle) => {
      const realRead = handle.read.bind(handle) as (...readArguments: unknown[]) => Promise<unknown>;
      let readCount = 0;
      vi.spyOn(handle, 'read').mockImplementation((async (...readArguments: unknown[]) => {
        readCount += 1;
        // The file looks cut short from the second chunk on.
        return readCount >= 2 ? { bytesRead: 0, buffer: readArguments[0] } : realRead(...readArguments);
      }) as unknown as typeof handle.read);
    });
    await expect(codexTranscriptToolResultTokens(filePath)).resolves.toBeNull();
    // A kept cursor would push call-2's output a second time (14).
    await expect(codexTranscriptToolResultTokens(filePath)).resolves.toEqual({ Bash: 12 });
  });

  it('does not let a read that failed fail the read queued behind it on the same path', async () => {
    const filePath = writeRollout([
      sessionMeta(),
      functionCall('call-1', 'exec_command', '2026-10-20T10:00:10.000Z'),
      output('call-1', 'x'.repeat(40), '2026-10-20T10:00:11.000Z'),
    ]);
    // Closing the handle fails after the cursor advanced, which rejects the step itself.
    openNextWith((handle) => {
      const realClose = handle.close.bind(handle);
      vi.spyOn(handle, 'close').mockImplementation(async () => {
        await realClose();
        throw new Error('close failed');
      });
    });
    const failed = codexTranscriptToolResultTokens(filePath);
    const queued = codexTranscriptToolResultTokens(filePath);
    await expect(failed).rejects.toThrow('close failed');
    await expect(queued).resolves.toEqual({ Bash: 10 });
  });

  it('counts an output once when two reads of one rollout overlap, and the next read sees what was appended', async () => {
    const filePath = writeRollout([
      sessionMeta(),
      functionCall('call-1', 'exec_command', '2026-10-20T10:00:10.000Z'),
      output('call-1', 'x'.repeat(40), '2026-10-20T10:00:11.000Z'),
    ]);
    const [first, second] = await Promise.all([
      codexTranscriptToolResultTokens(filePath, 0, null),
      codexTranscriptToolResultTokens(filePath, 0, null),
    ]);
    expect(first).toEqual({ Bash: 10 });
    expect(second).toEqual({ Bash: 10 });
    fs.appendFileSync(filePath, `${functionCall('call-2', 'exec_command', '2026-10-20T10:00:12.000Z')}\n${output('call-2', 'y'.repeat(8), '2026-10-20T10:00:13.000Z')}\n`);
    await expect(codexTranscriptToolResultTokens(filePath, 0, null)).resolves.toEqual({ Bash: 12 });
  });

  it('counts an appended output once when two reads overlap on a cursor an earlier read left', async () => {
    // Two overlapping reads that each start fresh build separate cursors; the double
    // count needs one shared cursor, which an earlier read leaves behind.
    const filePath = writeRollout([sessionMeta()]);
    await expect(codexTranscriptToolResultTokens(filePath, 0, null)).resolves.toEqual({});
    fs.appendFileSync(filePath, `${functionCall('call-1', 'exec_command', '2026-10-20T10:00:10.000Z')}\n${output('call-1', 'x'.repeat(40), '2026-10-20T10:00:11.000Z')}\n`);
    const [first, second] = await Promise.all([
      codexTranscriptToolResultTokens(filePath, 0, null),
      codexTranscriptToolResultTokens(filePath, 0, null),
    ]);
    expect(first).toEqual({ Bash: 10 });
    expect(second).toEqual({ Bash: 10 });
    fs.appendFileSync(filePath, `${functionCall('call-2', 'exec_command', '2026-10-20T10:00:12.000Z')}\n${output('call-2', 'y'.repeat(8), '2026-10-20T10:00:13.000Z')}\n`);
    await expect(codexTranscriptToolResultTokens(filePath, 0, null)).resolves.toEqual({ Bash: 12 });
  });

  it('keeps cursors for the 16 newest rollouts: the first of 17 is read again from the start', async () => {
    const rolloutAt = (index: number): string => path.join(directory, `rollout-${index}.jsonl`);
    const callAndOutput = (outputLength: number): string[] => [
      functionCall('call-1', 'exec_command', '2026-10-20T10:00:10.000Z'),
      output('call-1', 'x'.repeat(outputLength), '2026-10-20T10:00:11.000Z'),
    ];
    fs.writeFileSync(rolloutAt(0), `${callAndOutput(40).join('\n')}\n`);
    await expect(codexTranscriptToolResultTokens(rolloutAt(0))).resolves.toEqual({ Bash: 10 });
    for (let index = 1; index <= 16; index += 1) {
      fs.writeFileSync(rolloutAt(index), `${callAndOutput(4).join('\n')}\n`);
      await codexTranscriptToolResultTokens(rolloutAt(index));
    }
    // Rewritten in place, larger than before. A kept cursor would carry on from its old offset
    // and keep the old 10; an evicted one reads the new file whole.
    fs.writeFileSync(rolloutAt(0), `${callAndOutput(80).join('\n')}\n`);
    await expect(codexTranscriptToolResultTokens(rolloutAt(0))).resolves.toEqual({ Bash: 20 });
  });
});
