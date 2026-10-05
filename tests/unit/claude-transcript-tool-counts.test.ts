/**
 * Tests for `parseClaudeTranscriptToolCounts` - the transcript-derived
 * tool-call-count fallback that backfills the live `UsageAccumulator` count
 * for sessions whose ToolStart/ToolEnd hook events never reached it (e.g. a
 * suspended/parked session that reports 0 despite real cost/tokens).
 *
 * Cross-checked against a pinned transcript fixture
 * (tests/fixtures/transcripts/claude-tool-use-sample.jsonl) so the dedup-by-
 * tool_use.id math is locked.
 */

import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import fsPromises from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import {
  parseClaudeTranscriptToolCounts,
  parseClaudeTranscriptToolResultTokens,
  claudeProjectSlug,
  resetToolCallCursorsForTests,
} from '../../src/main/agent/adapters/claude/transcript-parser';
import { ClaudeAdapter } from '../../src/main/agent/adapters/claude/claude-adapter';

const FIXTURE_PATH = path.join(__dirname, '..', 'fixtures', 'transcripts', 'claude-tool-use-sample.jsonl');
const USAGE_FIXTURE_PATH = path.join(__dirname, '..', 'fixtures', 'transcripts', 'claude-usage-sample.jsonl');

describe('parseClaudeTranscriptToolCounts', () => {
  it('counts distinct tool_use ids, deduping a re-emitted message and counting parallel calls separately', async () => {
    const counts = await parseClaudeTranscriptToolCounts(FIXTURE_PATH);
    expect(counts).not.toBeNull();
    // The fixture has:
    //   tu_bash (Bash): single tool_use -> counted once
    //   tu_grep (Grep): same message re-emitted across TWO lines, same id -> counted once
    //   tu_read (Read) + tu_write (Write): parallel tool_use blocks in one message -> both counted
    //   tu_mcp (mcp__github__create_issue) + tu_todo (TodoWrite): ordinary tool_use blocks -> both counted
    //   a user line, a compact_boundary system line, a malformed line, a text-only assistant line -> all skipped
    expect(counts!.toolCallCount).toBe(6);

    const byName = new Map(counts!.toolBreakdown.map((stat) => [stat.toolName, stat]));
    expect(byName.get('Bash')?.callCount).toBe(1);
    expect(byName.get('Grep')?.callCount).toBe(1);
    expect(byName.get('Read')?.callCount).toBe(1);
    expect(byName.get('Write')?.callCount).toBe(1);
    expect(byName.get('mcp__github__create_issue')?.callCount).toBe(1);
    expect(byName.get('TodoWrite')?.callCount).toBe(1);

    for (const stat of counts!.toolBreakdown) {
      expect(stat.totalDurationMs).toBe(0);
      expect(stat.interruptedCount).toBe(0);
      expect(stat.costUsd).toBeUndefined();
      expect(stat.inputTokens).toBeUndefined();
      expect(stat.outputTokens).toBeUndefined();
    }
  });

  it('cross-checks against the token-usage fixture (one tool_use, Read)', async () => {
    const counts = await parseClaudeTranscriptToolCounts(USAGE_FIXTURE_PATH);
    expect(counts).not.toBeNull();
    expect(counts!.toolCallCount).toBe(1);
    expect(counts!.toolBreakdown).toEqual([
      { toolName: 'Read', callCount: 1, totalDurationMs: 0, interruptedCount: 0 },
    ]);
  });

  it('returns null for a missing transcript file (caller keeps the live count)', async () => {
    const missing = path.join(os.tmpdir(), 'kangentic-no-such-transcript-tool-counts-12345.jsonl');
    expect(await parseClaudeTranscriptToolCounts(missing)).toBeNull();
  });

  it('returns null for a transcript with assistant text but no tool_use blocks', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kangentic-transcript-tool-counts-'));
    const filePath = path.join(dir, 'no-tools.jsonl');
    try {
      fs.writeFileSync(
        filePath,
        '{"type":"user","message":{"content":"hi"}}\n' +
          '{"type":"assistant","message":{"id":"msg_1","content":[{"type":"text","text":"hello"}]}}\n',
      );
      expect(await parseClaudeTranscriptToolCounts(filePath)).toBeNull();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('falls back to "tool" as the breakdown key when a tool_use block has no name', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kangentic-transcript-tool-counts-'));
    const filePath = path.join(dir, 'missing-name.jsonl');
    try {
      fs.writeFileSync(
        filePath,
        '{"type":"assistant","message":{"id":"msg_1","content":[{"type":"tool_use","id":"tu_1"}]}}\n' +
          '{"type":"assistant","message":{"id":"msg_2","content":[{"type":"tool_use","id":"tu_2","name":""}]}}\n',
      );
      const counts = await parseClaudeTranscriptToolCounts(filePath);
      expect(counts).not.toBeNull();
      // Both a missing `name` field and an empty-string `name` fall back to
      // the same "tool" bucket, and each has a distinct tool_use.id, so both
      // are counted (not deduped against each other).
      expect(counts!.toolCallCount).toBe(2);
      expect(counts!.toolBreakdown).toEqual([
        { toolName: 'tool', callCount: 2, totalDurationMs: 0, interruptedCount: 0 },
      ]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('skips an assistant message whose content is not an array (a single tool_use-shaped object, not block-array-wrapped)', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kangentic-transcript-tool-counts-'));
    const filePath = path.join(dir, 'non-array-content.jsonl');
    try {
      // A well-formed transcript always wraps content in an array, even for
      // a single block. This simulates a malformed/legacy line where content
      // is a bare object shaped like a tool_use block - it must be skipped
      // entirely, not unwrapped and counted.
      fs.writeFileSync(
        filePath,
        '{"type":"assistant","message":{"id":"msg_1","content":{"type":"tool_use","id":"tu_bare","name":"Bash"}}}\n',
      );
      expect(await parseClaudeTranscriptToolCounts(filePath)).toBeNull();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Result tokens and the resumable cursor.
// ---------------------------------------------------------------------------

function assistantToolUse(id: string, name: string, extra = ''): string {
  return `{"type":"assistant"${extra},"message":{"id":"msg_${id}","content":[{"type":"tool_use","id":"${id}","name":"${name}","input":{}}]}}\n`;
}

function userToolResult(id: string, content: unknown, extra = ''): string {
  return `{"type":"user"${extra},"message":{"content":[{"type":"tool_result","tool_use_id":"${id}","content":${JSON.stringify(content)}}]}}\n`;
}

/** A base64 PNG whose header says `width` x `height`, padded with `paddingBytes` of filler. */
function pngBase64(width: number, height: number, paddingBytes = 0): string {
  const header = Buffer.alloc(24);
  header.writeUInt32BE(0x89504e47, 0);
  header.writeUInt32BE(0x0d0a1a0a, 4);
  header.writeUInt32BE(13, 8);
  header.write('IHDR', 12, 'ascii');
  header.writeUInt32BE(width, 16);
  header.writeUInt32BE(height, 20);
  return Buffer.concat([header, Buffer.alloc(paddingBytes, 7)]).toString('base64');
}

/**
 * Spy on every positioned `FileHandle.read`, which is how the parser reads a
 * transcript. `mock.calls[n][3]` is the byte position of read n. The spy goes
 * on the shared prototype, found through a throwaway handle, because each
 * `fs.open` returns a new handle object.
 */
async function spyOnHandleReads(filePath: string) {
  const probe = await fsPromises.open(filePath, 'r');
  const handlePrototype = Object.getPrototypeOf(probe) as FileHandle;
  await probe.close();
  return vi.spyOn(handlePrototype, 'read');
}

function readPositions(readSpy: Awaited<ReturnType<typeof spyOnHandleReads>>): number[] {
  return readSpy.mock.calls.map((callArguments) => (callArguments as unknown[])[3] as number);
}

type PositionedRead = (
  buffer: Buffer,
  offset: number,
  length: number,
  position: number,
) => Promise<{ bytesRead: number; buffer: Buffer }>;

/**
 * The real `FileHandle.read`, for a fake that fails one read and passes every
 * other through. Call it BEFORE `spyOnHandleReads`: afterwards the prototype
 * holds the spy, and calling that from inside its own fake recurses.
 */
async function captureOriginalHandleRead(filePath: string): Promise<PositionedRead> {
  const probe = await fsPromises.open(filePath, 'r');
  const original = (Object.getPrototypeOf(probe) as FileHandle).read;
  await probe.close();
  return original as unknown as PositionedRead;
}

/**
 * Make ONE positioned read fail, the first whose position `matches`: `'short'`
 * returns a byte fewer than the real read got (a file truncated mid-read),
 * `'reject'` rejects without reading (an I/O error). Every other read, before
 * and after, goes through to the real file.
 */
function injectReadFault(
  readSpy: Awaited<ReturnType<typeof spyOnHandleReads>>,
  originalRead: PositionedRead,
  fault: 'short' | 'reject',
  matches: (position: number) => boolean,
): void {
  let injected = false;
  readSpy.mockImplementation((async function (this: FileHandle, buffer: Buffer, offset: number, length: number, position: number) {
    const shouldFail = !injected && matches(position);
    if (shouldFail) injected = true;
    if (shouldFail && fault === 'reject') throw new Error('EIO: simulated read failure');
    const result = await originalRead.call(this, buffer, offset, length, position);
    return shouldFail ? { ...result, bytesRead: result.bytesRead - 1 } : result;
  }) as unknown as FileHandle['read']);
}

describe('parseClaudeTranscriptToolCounts - result tokens and resume', () => {
  let dir: string;

  beforeEach(() => {
    resetToolCallCursorsForTests();
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kangentic-transcript-result-tokens-'));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('sizes each tool_result by id and sums it per tool', async () => {
    const filePath = path.join(dir, 'results.jsonl');
    fs.writeFileSync(
      filePath,
      assistantToolUse('r1', 'Read') + userToolResult('r1', 'x'.repeat(400)) +
        assistantToolUse('r2', 'Read') + userToolResult('r2', [{ type: 'text', text: 'y'.repeat(80) }]) +
        assistantToolUse('b1', 'Bash'),
    );
    const counts = await parseClaudeTranscriptToolCounts(filePath);
    const byName = new Map(counts!.toolBreakdown.map((stat) => [stat.toolName, stat]));
    // chars/4: 400 -> 100, 80 -> 20.
    expect(byName.get('Read')).toMatchObject({ callCount: 2, resultTokens: 120 });
    // Bash has no result yet, so it carries no estimate rather than a 0.
    expect(byName.get('Bash')?.resultTokens).toBeUndefined();
  });

  it('prices an image from its header dimensions, never by base64 length', async () => {
    const filePath = path.join(dir, 'image.jsonl');
    // 1000 x 600 -> 36 x 22 patches of 28px = 792 tokens. 300 KB of payload
    // would read as ~100k tokens through the character estimate.
    const image = { type: 'image', source: { type: 'base64', media_type: 'image/png', data: pngBase64(1000, 600, 300_000) } };
    fs.writeFileSync(filePath, assistantToolUse('s1', 'Screenshot') + userToolResult('s1', [image]));
    const counts = await parseClaudeTranscriptToolCounts(filePath);
    expect(counts!.toolBreakdown[0].resultTokens).toBe(792);
  });

  it('adds no result tokens for sidechain lines', async () => {
    const filePath = path.join(dir, 'sidechain.jsonl');
    fs.writeFileSync(
      filePath,
      assistantToolUse('side', 'Read', ',"isSidechain":true') +
        userToolResult('side', 'z'.repeat(400), ',"isSidechain":true'),
    );
    const counts = await parseClaudeTranscriptToolCounts(filePath);
    expect(counts!.toolBreakdown[0]).toMatchObject({ toolName: 'Read', callCount: 1 });
    expect(counts!.toolBreakdown[0].resultTokens).toBeUndefined();
  });

  it('resumes after an append, including a line that was half-written at the first read', async () => {
    const filePath = path.join(dir, 'append.jsonl');
    const resultLine = userToolResult('r1', 'x'.repeat(400));
    const splitAt = Math.floor(resultLine.length / 2);
    fs.writeFileSync(filePath, assistantToolUse('r1', 'Read') + resultLine.slice(0, splitAt));
    const first = await parseClaudeTranscriptToolCounts(filePath);
    expect(first!.toolBreakdown[0]).toMatchObject({ callCount: 1 });
    expect(first!.toolBreakdown[0].resultTokens).toBeUndefined();

    fs.appendFileSync(filePath, resultLine.slice(splitAt) + assistantToolUse('r2', 'Read') + userToolResult('r2', 'y'.repeat(40)));
    const second = await parseClaudeTranscriptToolCounts(filePath);
    expect(second!.toolCallCount).toBe(2);
    expect(second!.toolBreakdown[0]).toMatchObject({ toolName: 'Read', callCount: 2, resultTokens: 110 });
  });

  it('starts over when the file shrinks (a rewrite, not an append)', async () => {
    const filePath = path.join(dir, 'rewrite.jsonl');
    fs.writeFileSync(filePath, assistantToolUse('a', 'Bash') + assistantToolUse('b', 'Bash') + assistantToolUse('c', 'Bash'));
    expect((await parseClaudeTranscriptToolCounts(filePath))!.toolCallCount).toBe(3);
    fs.writeFileSync(filePath, assistantToolUse('d', 'Read'));
    const counts = await parseClaudeTranscriptToolCounts(filePath);
    expect(counts!.toolCallCount).toBe(1);
    expect(counts!.toolBreakdown.map((stat) => stat.toolName)).toEqual(['Read']);
  });

  it('scopes counts and result tokens to one run of a transcript that holds two', async () => {
    // Claude appends every --resume to the same file; a session covers one run.
    const filePath = path.join(dir, 'two-runs.jsonl');
    const firstRun = ',"timestamp":"2026-10-04T22:52:20.000Z"';
    const secondRun = ',"timestamp":"2026-10-04T22:57:40.000Z"';
    fs.writeFileSync(
      filePath,
      assistantToolUse('r1', 'Read', firstRun) + userToolResult('r1', 'x'.repeat(4000), firstRun) +
        assistantToolUse('b1', 'Bash', firstRun) + userToolResult('b1', 'y'.repeat(400), firstRun) +
        assistantToolUse('r2', 'Read', secondRun) + userToolResult('r2', 'z'.repeat(800), secondRun),
    );
    const secondRunStart = Date.parse('2026-10-04T22:56:53.959Z');

    const scoped = await parseClaudeTranscriptToolCounts(filePath, secondRunStart);
    expect(scoped!.toolCallCount).toBe(1);
    expect(scoped!.toolBreakdown).toEqual([
      { toolName: 'Read', callCount: 1, totalDurationMs: 0, interruptedCount: 0, resultTokens: 200 },
    ]);
    expect(await parseClaudeTranscriptToolResultTokens(filePath, secondRunStart)).toEqual({ Read: 200 });

    // Unscoped, the whole file counts.
    const whole = await parseClaudeTranscriptToolCounts(filePath);
    expect(whole!.toolCallCount).toBe(3);
    expect(await parseClaudeTranscriptToolResultTokens(filePath)).toEqual({ Read: 1200, Bash: 100 });

    // A run with no calls yet has nothing to report.
    expect(await parseClaudeTranscriptToolCounts(filePath, Date.parse('2026-10-05T00:00:00.000Z'))).toBeNull();
    expect(await parseClaudeTranscriptToolResultTokens(filePath, Date.parse('2026-10-05T00:00:00.000Z'))).toEqual({});
  });

  it('returns null result tokens for a missing transcript', async () => {
    expect(await parseClaudeTranscriptToolResultTokens(path.join(dir, 'missing.jsonl'), null)).toBeNull();
  });

  it('overlapping calls on one path agree and do not double count', async () => {
    const filePath = path.join(dir, 'overlap.jsonl');
    fs.writeFileSync(filePath, assistantToolUse('r1', 'Read') + userToolResult('r1', 'x'.repeat(400)));
    const [first, second] = await Promise.all([
      parseClaudeTranscriptToolCounts(filePath),
      parseClaudeTranscriptToolCounts(filePath),
    ]);
    expect(first!.toolBreakdown[0]).toMatchObject({ callCount: 1, resultTokens: 100 });
    expect(second!.toolBreakdown[0]).toMatchObject({ callCount: 1, resultTokens: 100 });
  });

  it('starts over when the mtime goes backwards, even though the file did not shrink', async () => {
    const filePath = path.join(dir, 'older-mtime.jsonl');
    const firstContent = assistantToolUse('a', 'Bash') + assistantToolUse('b', 'Bash') + assistantToolUse('c', 'Bash');
    // Same byte length on purpose: only the mtime tells this apart from an unchanged file.
    const secondContent = assistantToolUse('d', 'Read') + assistantToolUse('e', 'Read') + assistantToolUse('f', 'Read');
    expect(Buffer.byteLength(secondContent)).toBeGreaterThanOrEqual(Buffer.byteLength(firstContent));

    fs.writeFileSync(filePath, firstContent);
    const newer = new Date('2026-10-04T12:00:00.000Z');
    fs.utimesSync(filePath, newer, newer);
    const first = await parseClaudeTranscriptToolCounts(filePath);
    expect(first!.toolBreakdown.map((stat) => stat.toolName)).toEqual(['Bash']);

    fs.writeFileSync(filePath, secondContent);
    const older = new Date(newer.getTime() - 60_000);
    fs.utimesSync(filePath, older, older);
    const second = await parseClaudeTranscriptToolCounts(filePath);

    // A full re-read of the new content only: not the stale Bash rows, not old plus new.
    expect(second!.toolCallCount).toBe(3);
    expect(second!.toolBreakdown).toEqual([
      { toolName: 'Read', callCount: 3, totalDurationMs: 0, interruptedCount: 0 },
    ]);
  });

  it('returns null once the file is deleted, and counts a recreated file from scratch', async () => {
    const filePath = path.join(dir, 'deleted.jsonl');
    fs.writeFileSync(filePath, assistantToolUse('a', 'Bash') + assistantToolUse('b', 'Bash'));
    expect((await parseClaudeTranscriptToolCounts(filePath))!.toolCallCount).toBe(2);

    fs.rmSync(filePath, { force: true });
    expect(await parseClaudeTranscriptToolCounts(filePath)).toBeNull();
    expect(await parseClaudeTranscriptToolResultTokens(filePath)).toBeNull();

    // Larger than the old file, so a leftover cursor could not be told apart by size.
    fs.writeFileSync(
      filePath,
      assistantToolUse('c', 'Read') + assistantToolUse('d', 'Read') + assistantToolUse('e', 'Read') + assistantToolUse('f', 'Grep'),
    );
    const recreated = await parseClaudeTranscriptToolCounts(filePath);
    expect(recreated!.toolCallCount).toBe(4);
    expect(recreated!.toolBreakdown.map((stat) => [stat.toolName, stat.callCount])).toEqual([['Read', 3], ['Grep', 1]]);
  });

  it('consumes a complete final line that has no trailing newline, and does not count it again after an append', async () => {
    const filePath = path.join(dir, 'no-trailing-newline.jsonl');
    // No tool_use id on the last line: an id would let the dedupe hide a re-read.
    const unterminatedLine = '{"type":"assistant","message":{"id":"msg_tail","content":[{"type":"tool_use","name":"Grep","input":{}}]}}';
    fs.writeFileSync(filePath, assistantToolUse('a', 'Read') + unterminatedLine);

    const first = await parseClaudeTranscriptToolCounts(filePath);
    expect(first!.toolCallCount).toBe(2);

    fs.appendFileSync(filePath, '\n' + assistantToolUse('b', 'Bash'));
    const second = await parseClaudeTranscriptToolCounts(filePath);
    expect(second!.toolCallCount).toBe(3);
    expect(second!.toolBreakdown.map((stat) => [stat.toolName, stat.callCount])).toEqual([['Read', 1], ['Grep', 1], ['Bash', 1]]);
  });

  it('counts a tool_use line with no timestamp under any sinceMs', async () => {
    const filePath = path.join(dir, 'no-timestamp.jsonl');
    fs.writeFileSync(
      filePath,
      assistantToolUse('untimed', 'Read') +
        assistantToolUse('timed', 'Bash', ',"timestamp":"2026-10-04T22:52:20.000Z"'),
    );
    const farFuture = Date.parse('2099-01-01T00:00:00.000Z');

    const scoped = await parseClaudeTranscriptToolCounts(filePath, farFuture);
    expect(scoped!.toolBreakdown.map((stat) => [stat.toolName, stat.callCount])).toEqual([['Read', 1]]);
    // The timed call is still excluded by a later start.
    expect(scoped!.toolCallCount).toBe(1);
  });

  it('leaves a call with no timestamp out of a closed window, which cannot place it', async () => {
    const filePath = path.join(dir, 'no-timestamp-closed.jsonl');
    fs.writeFileSync(
      filePath,
      assistantToolUse('untimed', 'Read') +
        assistantToolUse('timed', 'Bash', ',"timestamp":"2026-10-04T22:52:20.000Z"'),
    );
    const windowStart = Date.parse('2026-10-04T22:50:00.000Z');
    const windowEnd = Date.parse('2026-10-04T22:55:00.000Z');

    const closed = await parseClaudeTranscriptToolCounts(filePath, windowStart, windowEnd);
    expect(closed!.toolBreakdown.map((stat) => [stat.toolName, stat.callCount])).toEqual([['Bash', 1]]);
  });

  it('excludes a call at exactly untilMs, which belongs to the next run', async () => {
    const filePath = path.join(dir, 'boundary.jsonl');
    const boundary = '2026-10-04T22:56:53.959Z';
    fs.writeFileSync(
      filePath,
      assistantToolUse('before', 'Read', ',"timestamp":"2026-10-04T22:56:53.958Z"') +
        assistantToolUse('at', 'Bash', `,"timestamp":"${boundary}"`),
    );

    const earlierRun = await parseClaudeTranscriptToolCounts(filePath, null, Date.parse(boundary));
    const laterRun = await parseClaudeTranscriptToolCounts(filePath, Date.parse(boundary));
    expect(earlierRun!.toolBreakdown.map((stat) => stat.toolName)).toEqual(['Read']);
    expect(laterRun!.toolBreakdown.map((stat) => stat.toolName)).toEqual(['Bash']);
  });

  it('treats a NaN sinceMs as no scope, so the whole file counts', async () => {
    const filePath = path.join(dir, 'nan-since.jsonl');
    const earlier = ',"timestamp":"2026-10-04T22:52:20.000Z"';
    const later = ',"timestamp":"2026-10-04T22:57:40.000Z"';
    fs.writeFileSync(
      filePath,
      assistantToolUse('r1', 'Read', earlier) + userToolResult('r1', 'x'.repeat(400), earlier) +
        assistantToolUse('b1', 'Bash', later) + userToolResult('b1', 'y'.repeat(80), later),
    );

    const counts = await parseClaudeTranscriptToolCounts(filePath, Number.NaN);
    expect(counts!.toolCallCount).toBe(2);
    expect(await parseClaudeTranscriptToolResultTokens(filePath, Number.NaN)).toEqual({ Read: 100, Bash: 20 });
  });

  it('treats a NaN untilMs as no upper bound, not as a window that closes before every call', async () => {
    const filePath = path.join(dir, 'nan-until.jsonl');
    const earlier = ',"timestamp":"2026-10-04T22:52:20.000Z"';
    const later = ',"timestamp":"2026-10-04T22:57:40.000Z"';
    fs.writeFileSync(
      filePath,
      assistantToolUse('r1', 'Read', earlier) + userToolResult('r1', 'x'.repeat(400), earlier) +
        assistantToolUse('b1', 'Bash', later) + userToolResult('b1', 'y'.repeat(80), later),
    );

    const counts = await parseClaudeTranscriptToolCounts(filePath, null, Number.NaN);
    expect(counts!.toolCallCount).toBe(2);
    expect(await parseClaudeTranscriptToolResultTokens(filePath, null, Number.NaN)).toEqual({ Read: 100, Bash: 20 });
  });

  it('counts a call and its result when the result line spans the 4 MB read-chunk boundary', async () => {
    // Test-local mirror of the parser's private chunk size. The straddle is
    // asserted below, so a change to the real constant shows up as a stale mirror.
    const chunkBytes = 4 * 1024 * 1024;
    const fillerPrefix = '{"type":"summary","summary":"';
    const fillerSuffix = '"}\n';
    const fillerLine = (totalBytes: number): string =>
      fillerPrefix + 'f'.repeat(totalBytes - Buffer.byteLength(fillerPrefix + fillerSuffix)) + fillerSuffix;

    const openingLine = assistantToolUse('big1', 'Read');
    const resultLine = userToolResult('big1', 'y'.repeat(4000));
    // Start the result line so the chunk boundary falls in its middle.
    const resultStart = chunkBytes - Math.floor(Buffer.byteLength(resultLine) / 2);
    const pieces: string[] = [openingLine];
    let written = Buffer.byteLength(openingLine);
    while (resultStart - written > 128 * 1024) {
      pieces.push(fillerLine(64 * 1024));
      written += 64 * 1024;
    }
    pieces.push(fillerLine(resultStart - written));
    written = resultStart;
    pieces.push(resultLine);
    const resultEnd = written + Buffer.byteLength(resultLine);
    pieces.push(assistantToolUse('big2', 'Bash') + userToolResult('big2', 'z'.repeat(400)));

    expect(resultStart).toBeLessThan(chunkBytes);
    expect(resultEnd).toBeGreaterThan(chunkBytes);

    const filePath = path.join(dir, 'chunk-boundary.jsonl');
    fs.writeFileSync(filePath, pieces.join(''));

    const counts = await parseClaudeTranscriptToolCounts(filePath);
    expect(counts!.toolCallCount).toBe(2);
    // chars/4: 4000 -> 1000, 400 -> 100.
    expect(counts!.toolBreakdown).toEqual([
      { toolName: 'Read', callCount: 1, totalDurationMs: 0, interruptedCount: 0, resultTokens: 1000 },
      { toolName: 'Bash', callCount: 1, totalDurationMs: 0, interruptedCount: 0, resultTokens: 100 },
    ]);
  });

  // The two cases below put a line across MORE than one chunk boundary, which
  // the case above (one boundary) cannot: the middle chunk holds no newline at
  // all, so the parser has to carry several pieces of one line and join them
  // once, at the newline.
  const CHUNK_BYTES = 4 * 1024 * 1024;
  // About 9.4 MB of ASCII, a multiple of 4 so chars/4 is exact.
  const MULTI_CHUNK_RESULT_CHARS = 2 * CHUNK_BYTES + 1024 * 1024;

  it('counts a call and its result when the result line spans three read chunks, with the line after it intact', async () => {
    const openingLine = assistantToolUse('big1', 'Read');
    const resultLine = userToolResult('big1', 'y'.repeat(MULTI_CHUNK_RESULT_CHARS));
    const resultStart = Buffer.byteLength(openingLine);
    const resultEnd = resultStart + Buffer.byteLength(resultLine);
    // Two chunk boundaries fall strictly inside the line, so a whole chunk of it holds no newline.
    expect(resultStart).toBeLessThan(CHUNK_BYTES);
    expect(resultEnd).toBeGreaterThan(2 * CHUNK_BYTES);

    const filePath = path.join(dir, 'three-chunk-line.jsonl');
    fs.writeFileSync(
      filePath,
      openingLine + resultLine + assistantToolUse('big2', 'Bash') + userToolResult('big2', 'z'.repeat(400)),
    );

    const counts = await parseClaudeTranscriptToolCounts(filePath);
    expect(counts!.toolCallCount).toBe(2);
    expect(counts!.toolBreakdown).toEqual([
      { toolName: 'Read', callCount: 1, totalDurationMs: 0, interruptedCount: 0, resultTokens: MULTI_CHUNK_RESULT_CHARS / 4 },
      { toolName: 'Bash', callCount: 1, totalDurationMs: 0, interruptedCount: 0, resultTokens: 100 },
    ]);
  }, 20_000);

  it('does not consume a multi-chunk line that is still being written, and counts its result once the line is finished', async () => {
    const openingLine = assistantToolUse('big1', 'Read');
    const resultLine = userToolResult('big1', 'y'.repeat(MULTI_CHUNK_RESULT_CHARS));
    // Cut inside the third chunk, so the unterminated part already spans two full chunks.
    const cutAt = 2 * CHUNK_BYTES + 512;
    const filePath = path.join(dir, 'three-chunk-line-in-progress.jsonl');
    fs.writeFileSync(filePath, openingLine + resultLine.slice(0, cutAt));

    const first = await parseClaudeTranscriptToolCounts(filePath);
    expect(first!.toolCallCount).toBe(1);
    expect(first!.toolBreakdown[0].resultTokens).toBeUndefined();

    fs.appendFileSync(filePath, resultLine.slice(cutAt) + assistantToolUse('big2', 'Bash'));
    const second = await parseClaudeTranscriptToolCounts(filePath);
    expect(second!.toolCallCount).toBe(2);
    expect(second!.toolBreakdown).toEqual([
      { toolName: 'Read', callCount: 1, totalDurationMs: 0, interruptedCount: 0, resultTokens: MULTI_CHUNK_RESULT_CHARS / 4 },
      { toolName: 'Bash', callCount: 1, totalDurationMs: 0, interruptedCount: 0 },
    ]);
  }, 20_000);

  it.each([
    ['the same length', 3],
    ['longer', 4],
  ])('starts over when the file is rewritten in place to %s with a later mtime, which size, mtime and inode alone read as unchanged or appended', async (_label, rewrittenCallCount) => {
    const filePath = path.join(dir, 'rewritten-in-place.jsonl');
    // Every line is the same length ('Bash' and 'Read', one-character ids), so
    // three Read lines are exactly as long as three Bash lines.
    const originalContent = ['a', 'b', 'c'].map((id) => assistantToolUse(id, 'Bash')).join('');
    const rewrittenContent = ['d', 'e', 'f', 'g'].slice(0, rewrittenCallCount).map((id) => assistantToolUse(id, 'Read')).join('');
    const originalTime = new Date('2026-10-04T12:00:00.000Z');
    fs.writeFileSync(filePath, originalContent);
    fs.utimesSync(filePath, originalTime, originalTime);
    const statBefore = fs.statSync(filePath);
    const first = await parseClaudeTranscriptToolCounts(filePath);
    expect(first!.toolBreakdown.map((stat) => [stat.toolName, stat.callCount])).toEqual([['Bash', 3]]);

    // 'r+' writes through the same inode on every OS; a rewrite through a new
    // file would be caught by the inode check and prove nothing here.
    const descriptor = fs.openSync(filePath, 'r+');
    try {
      fs.writeSync(descriptor, rewrittenContent, 0);
    } finally {
      fs.closeSync(descriptor);
    }
    const laterTime = new Date(originalTime.getTime() + 60_000);
    fs.utimesSync(filePath, laterTime, laterTime);

    // The three checks the cursor made before the tail comparison all pass.
    const statAfter = fs.statSync(filePath);
    expect(statAfter.ino).toBe(statBefore.ino);
    expect(statAfter.size).toBeGreaterThanOrEqual(statBefore.size);
    expect(statAfter.mtimeMs).toBeGreaterThan(statBefore.mtimeMs);
    // The only difference is in the bytes just before the old end.
    const tailLength = 64;
    const oldEnd = statBefore.size;
    expect(
      Buffer.from(rewrittenContent).subarray(oldEnd - tailLength, oldEnd)
        .equals(Buffer.from(originalContent).subarray(oldEnd - tailLength, oldEnd)),
    ).toBe(false);

    const second = await parseClaudeTranscriptToolCounts(filePath);
    // The new content only: none of the stale Bash rows.
    expect(second!.toolCallCount).toBe(rewrittenCallCount);
    expect(second!.toolBreakdown).toEqual([
      { toolName: 'Read', callCount: rewrittenCallCount, totalDurationMs: 0, interruptedCount: 0 },
    ]);
  });

  it('resumes an append from the old end instead of re-reading the file, and counts exactly the appended calls', async () => {
    const filePath = path.join(dir, 'append-resume.jsonl');
    const initialCallCount = 20;
    const initialContent = Array.from({ length: initialCallCount }, (_, index) => assistantToolUse(`t${index}`, 'Read')).join('');
    fs.writeFileSync(filePath, initialContent);
    const firstEnd = fs.statSync(filePath).size;
    const readSpy = await spyOnHandleReads(filePath);

    const first = await parseClaudeTranscriptToolCounts(filePath);
    expect(first!.toolCallCount).toBe(initialCallCount);
    // The first read starts at byte 0.
    expect(Math.min(...readPositions(readSpy))).toBe(0);

    readSpy.mockClear();
    fs.appendFileSync(filePath, assistantToolUse('a1', 'Bash') + assistantToolUse('a2', 'Bash'));
    const second = await parseClaudeTranscriptToolCounts(filePath);
    expect(second!.toolCallCount).toBe(initialCallCount + 2);
    expect(second!.toolBreakdown.map((stat) => [stat.toolName, stat.callCount])).toEqual([['Read', initialCallCount], ['Bash', 2]]);
    // The tail check reads a few bytes back from the old end; a full re-read would start at 0.
    const secondReadPositions = readPositions(readSpy);
    expect(secondReadPositions.length).toBeGreaterThan(0);
    expect(Math.min(...secondReadPositions)).toBeGreaterThanOrEqual(firstEnd - 256);

    // And again: the tail was captured again after the first append.
    const secondEnd = fs.statSync(filePath).size;
    readSpy.mockClear();
    fs.appendFileSync(filePath, assistantToolUse('a3', 'Bash'));
    const third = await parseClaudeTranscriptToolCounts(filePath);
    expect(third!.toolCallCount).toBe(initialCallCount + 3);
    expect(Math.min(...readPositions(readSpy))).toBeGreaterThanOrEqual(secondEnd - 256);
  });

  it('answers a repeat call on an unchanged file without opening it', async () => {
    const filePath = path.join(dir, 'unchanged.jsonl');
    fs.writeFileSync(filePath, assistantToolUse('a', 'Read') + userToolResult('a', 'x'.repeat(400)));
    const openSpy = vi.spyOn(fsPromises, 'open');

    const first = await parseClaudeTranscriptToolCounts(filePath);
    expect(openSpy).toHaveBeenCalledTimes(1);

    const second = await parseClaudeTranscriptToolCounts(filePath);
    const tokens = await parseClaudeTranscriptToolResultTokens(filePath);

    expect(openSpy).toHaveBeenCalledTimes(1);
    expect(second).toEqual(first);
    expect(tokens).toEqual({ Read: 100 });
  });

  // A count that comes back low is written to the session row as the run's
  // total, so a read that fails partway must yield null and a dropped cursor,
  // never a count from a half-read file or a cursor that resumes from it.
  describe('a read that fails partway', () => {
    const initialCallCount = 5;
    const initialContent = (): string =>
      Array.from({ length: initialCallCount }, (_, index) => assistantToolUse(`t${index}`, 'Read')).join('');
    const appendedContent = (): string => assistantToolUse('a1', 'Bash') + assistantToolUse('a2', 'Bash');

    it('returns null on a short read, then recounts the whole file from byte 0 with nothing counted twice', async () => {
      const filePath = path.join(dir, 'short-read.jsonl');
      fs.writeFileSync(filePath, initialContent());
      const warm = await parseClaudeTranscriptToolCounts(filePath);
      expect(warm!.toolCallCount).toBe(initialCallCount);
      const warmEnd = fs.statSync(filePath).size;

      fs.appendFileSync(filePath, appendedContent());
      const originalRead = await captureOriginalHandleRead(filePath);
      const faultedSpy = await spyOnHandleReads(filePath);
      // Fault the read of the appended bytes, which starts at the old end. The
      // read before it is the tail check, and a short tail check only resets
      // the cursor; it does not fail the call.
      injectReadFault(faultedSpy, originalRead, 'short', (position) => position === warmEnd);

      // Null, not a count of the five calls the cursor already held.
      expect(await parseClaudeTranscriptToolCounts(filePath)).toBeNull();
      // The fault landed on the read it was aimed at, so this cannot pass vacuously.
      expect(readPositions(faultedSpy)).toContain(warmEnd);
      faultedSpy.mockRestore();

      const recoverySpy = await spyOnHandleReads(filePath);
      const recovered = await parseClaudeTranscriptToolCounts(filePath);
      expect(recovered!.toolCallCount).toBe(initialCallCount + 2);
      expect(recovered!.toolBreakdown.map((stat) => [stat.toolName, stat.callCount])).toEqual([['Read', initialCallCount], ['Bash', 2]]);
      // The failed call dropped the cursor, so the recount starts at 0 and does
      // not resume from an offset the failed read left behind.
      expect(Math.min(...readPositions(recoverySpy))).toBe(0);
    });

    it('lets the call chained behind a failed one return the correct count', async () => {
      const filePath = path.join(dir, 'failure-isolation.jsonl');
      fs.writeFileSync(filePath, initialContent() + userToolResult('t0', 'x'.repeat(400)));
      expect((await parseClaudeTranscriptToolCounts(filePath))!.toolCallCount).toBe(initialCallCount);

      fs.appendFileSync(filePath, appendedContent());
      const originalRead = await captureOriginalHandleRead(filePath);
      const readSpy = await spyOnHandleReads(filePath);
      // The first read of the first call rejects. Nothing after it does.
      injectReadFault(readSpy, originalRead, 'reject', () => true);

      // Both start in the same tick, so the second chains onto the first.
      const [failed, chained] = await Promise.allSettled([
        parseClaudeTranscriptToolCounts(filePath),
        parseClaudeTranscriptToolCounts(filePath),
      ]);

      // A read error is an answer of null, never a rejection that reaches the caller.
      expect(failed).toEqual({ status: 'fulfilled', value: null });
      expect(chained.status).toBe('fulfilled');
      const counts = (chained as PromiseFulfilledResult<Awaited<ReturnType<typeof parseClaudeTranscriptToolCounts>>>).value;
      expect(counts!.toolCallCount).toBe(initialCallCount + 2);
      expect(counts!.toolBreakdown).toEqual([
        { toolName: 'Read', callCount: initialCallCount, totalDurationMs: 0, interruptedCount: 0, resultTokens: 100 },
        { toolName: 'Bash', callCount: 2, totalDurationMs: 0, interruptedCount: 0 },
      ]);
      // The first read is the failed call's tail check. Everything after it is
      // the chained call, which found no cursor and so read the file from the start.
      expect(Math.min(...readPositions(readSpy).slice(1))).toBe(0);
    });
  });

  describe('the retained-cursor limit', () => {
    // Mirrors the parser's private TOOL_CALL_CURSOR_LIMIT. The two cases below
    // fail on either side of it, so a stale mirror shows up as a red test.
    const CURSOR_LIMIT = 16;

    function writeTranscripts(count: number): string[] {
      return Array.from({ length: count }, (_, index) => {
        const filePath = path.join(dir, `retained-${index}.jsonl`);
        fs.writeFileSync(filePath, assistantToolUse(`f${index}`, 'Read'));
        return filePath;
      });
    }

    it('keeps the cursors of the 16 most recent paths, so re-parsing every one of them reads nothing', async () => {
      const filePaths = writeTranscripts(CURSOR_LIMIT);
      for (const filePath of filePaths) {
        expect((await parseClaudeTranscriptToolCounts(filePath))!.toolCallCount).toBe(1);
      }

      const readSpy = await spyOnHandleReads(filePaths[0]);
      const openSpy = vi.spyOn(fsPromises, 'open');
      readSpy.mockClear();
      openSpy.mockClear();
      for (const filePath of filePaths) {
        expect((await parseClaudeTranscriptToolCounts(filePath))!.toolCallCount).toBe(1);
      }

      // Positions, not the spy itself, so a failure prints a short list rather than every buffer read.
      expect(readPositions(readSpy)).toEqual([]);
      expect(openSpy).not.toHaveBeenCalled();
    });

    it('evicts the oldest path past the limit and re-reads it from byte 0, while the newest stays resumable', async () => {
      const filePaths = writeTranscripts(CURSOR_LIMIT + 1);
      for (const filePath of filePaths) {
        expect((await parseClaudeTranscriptToolCounts(filePath))!.toolCallCount).toBe(1);
      }
      const newestPath = filePaths[CURSOR_LIMIT];

      const readSpy = await spyOnHandleReads(filePaths[0]);
      readSpy.mockClear();

      // The newest path first: re-parsing the oldest below would evict another
      // path, and this keeps that out of the picture.
      expect((await parseClaudeTranscriptToolCounts(newestPath))!.toolCallCount).toBe(1);
      expect(readPositions(readSpy)).toEqual([]);

      // The first path lost its cursor to the 17th, so it is read in full, and
      // counted once.
      const oldest = await parseClaudeTranscriptToolCounts(filePaths[0]);
      expect(oldest!.toolCallCount).toBe(1);
      expect(oldest!.toolBreakdown).toEqual([{ toolName: 'Read', callCount: 1, totalDurationMs: 0, interruptedCount: 0 }]);
      const oldestReadPositions = readPositions(readSpy);
      expect(oldestReadPositions.length).toBeGreaterThan(0);
      expect(Math.min(...oldestReadPositions)).toBe(0);
    });
  });
});

// ---------------------------------------------------------------------------
// A sanitized capture of a real Claude session. The cases above build their JSONL
// from templates, so none of them shows that the field names and literals the
// parser reads (`assistant`/`user` types, `tool_use`, `tool_result`, `tool_use_id`,
// `timestamp`) match what Claude writes. Expectations come from the capture itself.
// ---------------------------------------------------------------------------

describe('parseClaudeTranscriptToolCounts - real captured session', () => {
  const REAL_SESSION_FIXTURE = path.join(__dirname, '..', 'fixtures', 'claude-real-session.jsonl');

  interface CapturedFacts {
    /** Distinct `tool_use` ids in assistant lines, with the tool each names. */
    toolNameByUseId: Map<string, string>;
    /** `tool_use_id` of every `tool_result` block in user lines. */
    resultUseIds: string[];
    /** Earliest and latest assistant `tool_use` line timestamps, in ms. */
    firstToolUseMs: number;
    lastToolUseMs: number;
  }

  function readCapturedFacts(): CapturedFacts {
    const toolNameByUseId = new Map<string, string>();
    const resultUseIds: string[] = [];
    let firstToolUseMs = Number.POSITIVE_INFINITY;
    let lastToolUseMs = Number.NEGATIVE_INFINITY;
    for (const line of fs.readFileSync(REAL_SESSION_FIXTURE, 'utf-8').split('\n')) {
      if (line.length === 0) continue;
      const record = JSON.parse(line) as { type?: string; timestamp?: string; message?: { content?: unknown } };
      const rawContent = record.message?.content;
      const content = Array.isArray(rawContent) ? (rawContent as Array<Record<string, unknown>>) : [];
      for (const block of content) {
        if (record.type === 'assistant' && block.type === 'tool_use' && typeof block.id === 'string' && typeof block.name === 'string') {
          toolNameByUseId.set(block.id, block.name);
          if (typeof record.timestamp === 'string') {
            firstToolUseMs = Math.min(firstToolUseMs, Date.parse(record.timestamp));
            lastToolUseMs = Math.max(lastToolUseMs, Date.parse(record.timestamp));
          }
        }
        if (record.type === 'user' && block.type === 'tool_result' && typeof block.tool_use_id === 'string') {
          resultUseIds.push(block.tool_use_id);
        }
      }
    }
    return { toolNameByUseId, resultUseIds, firstToolUseMs, lastToolUseMs };
  }

  beforeEach(() => {
    resetToolCallCursorsForTests();
  });

  it('counts the capture distinct tool_use ids and gives the tool whose result is in it a positive estimate', async () => {
    const facts = readCapturedFacts();
    expect(facts.toolNameByUseId.size).toBeGreaterThan(0);
    expect(facts.resultUseIds.length).toBeGreaterThan(0);
    const resultToolName = facts.toolNameByUseId.get(facts.resultUseIds[0]);
    expect(resultToolName).toBeDefined();

    const resultTokens = await parseClaudeTranscriptToolResultTokens(REAL_SESSION_FIXTURE);
    expect(resultTokens).not.toBeNull();
    expect(resultTokens![resultToolName!]).toBeGreaterThan(0);

    const counts = await parseClaudeTranscriptToolCounts(REAL_SESSION_FIXTURE);
    expect(counts).not.toBeNull();
    expect(counts!.toolCallCount).toBe(facts.toolNameByUseId.size);
    const resultRow = counts!.toolBreakdown.find((stat) => stat.toolName === resultToolName);
    const expectedCallsForTool = Array.from(facts.toolNameByUseId.values()).filter((name) => name === resultToolName).length;
    expect(resultRow!.callCount).toBe(expectedCallsForTool);
    expect(resultRow!.resultTokens).toBe(resultTokens![resultToolName!]);
  });

  it('scopes by the timestamps the capture carries: every call counts from the first, none after the last', async () => {
    const facts = readCapturedFacts();
    expect(Number.isFinite(facts.firstToolUseMs)).toBe(true);

    const fromFirst = await parseClaudeTranscriptToolCounts(REAL_SESSION_FIXTURE, facts.firstToolUseMs);
    expect(fromFirst!.toolCallCount).toBe(facts.toolNameByUseId.size);
    expect(await parseClaudeTranscriptToolCounts(REAL_SESSION_FIXTURE, facts.lastToolUseMs + 1)).toBeNull();
  });

  it('places a result estimate in the closed window that holds its call, by the call\'s timestamp and not the result line\'s', async () => {
    // One call in this capture, so a window either holds it or does not.
    const facts = readCapturedFacts();
    expect(facts.toolNameByUseId.size).toBe(1);
    const callMs = facts.firstToolUseMs;
    const open = await parseClaudeTranscriptToolResultTokens(REAL_SESSION_FIXTURE);
    const [toolName] = Object.keys(open!);
    expect(open![toolName]).toBeGreaterThan(0);

    // The window ends 1 ms past the call, long before the result line the
    // capture wrote a second later. The estimate follows the call.
    const holdingCall = await parseClaudeTranscriptToolResultTokens(REAL_SESSION_FIXTURE, callMs, callMs + 1);
    expect(holdingCall).toEqual(open);
    expect((await parseClaudeTranscriptToolCounts(REAL_SESSION_FIXTURE, callMs, callMs + 1))!.toolCallCount).toBe(1);

    // Ending exactly at the call, the window belongs to the run before it.
    expect(await parseClaudeTranscriptToolResultTokens(REAL_SESSION_FIXTURE, null, callMs)).toEqual({});
    expect(await parseClaudeTranscriptToolCounts(REAL_SESSION_FIXTURE, null, callMs)).toBeNull();
    // Starting after it, the window belongs to the run after.
    expect(await parseClaudeTranscriptToolResultTokens(REAL_SESSION_FIXTURE, callMs + 1, callMs + 60_000)).toEqual({});
    expect(await parseClaudeTranscriptToolCounts(REAL_SESSION_FIXTURE, callMs + 1, callMs + 60_000)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// The two halves of one pinned transcript. The closed-window cases above build
// their lines from templates, so they cannot show that a window cut at a
// timestamp a fixture carries hands every call to exactly one run. The calls and
// their timestamps are read from the fixture's own lines here, not from the
// parser. The fixture is the pinned tool-use sample: the real session capture
// holds a single call, which no window can split, and the sample has no
// tool_result lines, so the result estimates are covered on the capture above.
// ---------------------------------------------------------------------------

describe('parseClaudeTranscriptToolCounts - a pinned transcript cut into two closed windows', () => {
  interface FixtureCall {
    toolName: string;
    timestampMs: number;
  }

  /** Each distinct `tool_use` id once, at the timestamp of the first line that carries it. */
  function readFixtureCalls(): FixtureCall[] {
    const callByUseId = new Map<string, FixtureCall>();
    for (const line of fs.readFileSync(FIXTURE_PATH, 'utf-8').split('\n')) {
      let record: { type?: string; timestamp?: string; message?: { content?: unknown } };
      try {
        record = JSON.parse(line) as typeof record;
      } catch {
        // The fixture carries a deliberately malformed line, and the file ends in a newline.
        continue;
      }
      const rawContent = record.message?.content;
      const content = Array.isArray(rawContent) ? (rawContent as Array<Record<string, unknown>>) : [];
      for (const block of content) {
        if (record.type !== 'assistant' || block.type !== 'tool_use') continue;
        if (typeof block.id !== 'string' || typeof block.name !== 'string' || typeof record.timestamp !== 'string') continue;
        if (!callByUseId.has(block.id)) callByUseId.set(block.id, { toolName: block.name, timestampMs: Date.parse(record.timestamp) });
      }
    }
    return Array.from(callByUseId.values()).sort((first, second) => first.timestampMs - second.timestampMs);
  }

  function callCountByTool(calls: FixtureCall[]): Record<string, number> {
    const countByTool: Record<string, number> = {};
    for (const call of calls) countByTool[call.toolName] = (countByTool[call.toolName] ?? 0) + 1;
    return countByTool;
  }

  beforeEach(() => {
    resetToolCallCursorsForTests();
  });

  it('hands every call to exactly one half, and a call at the cut to the later one', async () => {
    const calls = readFixtureCalls();
    expect(calls).toHaveLength(6);
    // The cut falls exactly on a call's own timestamp: the Read and Write that
    // share it start the later run, and the Bash and Grep before it end the earlier.
    const cutMs = calls[Math.floor(calls.length / 2)].timestampMs;
    const earlierCalls = calls.filter((call) => call.timestampMs < cutMs);
    const laterCalls = calls.filter((call) => call.timestampMs >= cutMs);
    expect(earlierCalls).toHaveLength(2);
    expect(laterCalls).toHaveLength(4);

    const whole = await parseClaudeTranscriptToolCounts(FIXTURE_PATH);
    const earlier = await parseClaudeTranscriptToolCounts(FIXTURE_PATH, calls[0].timestampMs, cutMs);
    const later = await parseClaudeTranscriptToolCounts(FIXTURE_PATH, cutMs, calls[calls.length - 1].timestampMs + 1);

    expect(earlier!.toolCallCount).toBe(earlierCalls.length);
    expect(later!.toolCallCount).toBe(laterCalls.length);
    expect(earlier!.toolCallCount + later!.toolCallCount).toBe(whole!.toolCallCount);

    const countsOf = (counts: NonNullable<typeof whole>): Record<string, number> => Object.fromEntries(
      counts.toolBreakdown.map((stat) => [stat.toolName, stat.callCount]),
    );
    expect(countsOf(earlier!)).toEqual(callCountByTool(earlierCalls));
    expect(countsOf(later!)).toEqual(callCountByTool(laterCalls));
    // Summed by tool, the halves the parser returned are the whole it returned.
    const summedHalves: Record<string, number> = {};
    for (const half of [earlier!, later!]) {
      for (const stat of half.toolBreakdown) summedHalves[stat.toolName] = (summedHalves[stat.toolName] ?? 0) + stat.callCount;
    }
    expect(summedHalves).toEqual(countsOf(whole!));
  });
});

// ---------------------------------------------------------------------------
// A real Claude tool result carrying an image: a screenshot tool's result, as
// Claude wrote it, paired with the assistant line that made the call. Every key
// is the real one; values are placeholders or filler, and the image keeps only
// its first 33 bytes (the PNG signature and the IHDR chunk), so it has the real
// dimensions and no pixels. It pins the shape the image path reads
// (`tool_result.content[].type === 'image'`, `source.media_type`,
// `source.data`), which the synthetic image cases above build by hand.
// ---------------------------------------------------------------------------

describe('parseClaudeTranscriptToolResultTokens - real captured image result', () => {
  const IMAGE_FIXTURE = path.join(__dirname, '..', 'fixtures', 'claude-image-tool-result.jsonl');

  beforeEach(() => {
    resetToolCallCursorsForTests();
  });

  it('counts the screenshot by its PNG dimensions, not by the length of its base64', async () => {
    const [assistantLine, userLine] = fs.readFileSync(IMAGE_FIXTURE, 'utf-8').trim().split('\n').map((line) => JSON.parse(line) as {
      message: { content: Array<Record<string, unknown>> };
    });
    const toolUse = assistantLine.message.content[0] as { type: string; id: string; name: string };
    const toolResult = userLine.message.content[0] as { type: string; tool_use_id: string; content: Array<Record<string, unknown>> };
    expect(toolUse.type).toBe('tool_use');
    expect(toolResult.type).toBe('tool_result');
    expect(toolResult.tool_use_id).toBe(toolUse.id);

    const image = toolResult.content.find((block) => block.type === 'image') as { source: { media_type: string; data: string } };
    const text = toolResult.content.find((block) => block.type === 'text') as { text: string };
    expect(image.source.media_type).toBe('image/png');

    // Read the dimensions straight from the IHDR chunk, independent of the parser.
    const header = Buffer.from(image.source.data, 'base64');
    const width = header.readUInt32BE(16);
    const height = header.readUInt32BE(20);
    // Anthropic's high-resolution tier: scale the long edge to at most 2576px,
    // then one token per 28x28 patch, capped at 4784.
    const scale = Math.min(1, 2576 / Math.max(width, height));
    const imageTokens = Math.min(4784, Math.ceil(Math.round(width * scale) / 28) * Math.ceil(Math.round(height * scale) / 28));
    // Below the cap, so this is the dimension path and not the unreadable-header fallback.
    expect(imageTokens).toBeLessThan(4784);
    const textTokens = Math.ceil(text.text.length / 4);

    const resultTokens = await parseClaudeTranscriptToolResultTokens(IMAGE_FIXTURE);

    expect(resultTokens).toEqual({ [toolUse.name]: imageTokens + textTokens });
    // The base64 here is 44 characters; a character count would give about 11.
    expect(resultTokens![toolUse.name]).toBeGreaterThan(image.source.data.length);
  });
});

// ---------------------------------------------------------------------------
// ClaudeAdapter.transcriptToolCounts - three input-path branches, mirroring
// ClaudeAdapter.transcriptUsage's branch coverage.
//
// (a) explicit transcriptPath provided -> reads that file directly
// (b) no transcriptPath but agentSessionId + cwd provided -> derives the
//     canonical ~/.claude/projects/<slug>/<id>.jsonl path via
//     locateClaudeTranscriptFile and reads it
// (c) neither transcriptPath nor agentSessionId+cwd -> returns null
//     without touching the filesystem
// ---------------------------------------------------------------------------

describe('ClaudeAdapter.transcriptToolCounts', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('(branch a) reads and parses tool counts from an explicit transcriptPath', async () => {
    const adapter = new ClaudeAdapter();
    const counts = await adapter.transcriptToolCounts({ transcriptPath: FIXTURE_PATH });

    expect(counts).not.toBeNull();
    expect(counts!.toolCallCount).toBe(6);
  });

  it('(branch b) derives the path from agentSessionId + cwd and reads it when the file exists', async () => {
    const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'kangentic-claude-adapter-tool-counts-'));
    vi.spyOn(os, 'homedir').mockReturnValue(tempHome);

    try {
      const agentSessionId = 'branch-b-session';
      const cwd = '/mock/project';
      const slug = claudeProjectSlug(cwd);
      const transcriptDir = path.join(tempHome, '.claude', 'projects', slug);
      const transcriptFile = path.join(transcriptDir, `${agentSessionId}.jsonl`);
      fs.mkdirSync(transcriptDir, { recursive: true });
      fs.copyFileSync(FIXTURE_PATH, transcriptFile);

      const adapter = new ClaudeAdapter();
      const counts = await adapter.transcriptToolCounts({ agentSessionId, cwd });

      expect(counts).not.toBeNull();
      expect(counts!.toolCallCount).toBe(6);
    } finally {
      fs.rmSync(tempHome, { recursive: true, force: true });
    }
  });

  it('(branch c) returns null when neither transcriptPath nor agentSessionId+cwd is provided', async () => {
    const adapter = new ClaudeAdapter();

    expect(await adapter.transcriptToolCounts({})).toBeNull();
    expect(await adapter.transcriptToolCounts({ agentSessionId: 'some-id', cwd: null })).toBeNull();
    expect(await adapter.transcriptToolCounts({ agentSessionId: null, cwd: '/some/path' })).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// ClaudeAdapter run-scoped reads. The session-metrics tests prove `sinceMs`
// reaches a stubbed adapter and the parser cases above prove the parser honours
// it; these prove the real adapter hands it on. Without that, a resumed
// session's popover and run-end backfill read the whole conversation again.
// ---------------------------------------------------------------------------

describe('ClaudeAdapter run-scoped transcript reads', () => {
  let dir: string;
  let transcriptPath: string;
  const secondRunStart = Date.parse('2026-10-04T22:56:53.959Z');

  beforeEach(() => {
    resetToolCallCursorsForTests();
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kangentic-adapter-run-scope-'));
    transcriptPath = path.join(dir, 'two-runs.jsonl');
    // Claude appends every --resume to one file: a Read in the first run, a
    // Bash in the second.
    const firstRun = ',"timestamp":"2026-10-04T22:52:20.000Z"';
    const secondRun = ',"timestamp":"2026-10-04T22:57:40.000Z"';
    fs.writeFileSync(
      transcriptPath,
      assistantToolUse('r1', 'Read', firstRun) + userToolResult('r1', 'x'.repeat(4000), firstRun) +
        assistantToolUse('b1', 'Bash', secondRun) + userToolResult('b1', 'y'.repeat(800), secondRun),
    );
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('transcriptToolCounts counts only the calls at or after sinceMs', async () => {
    const adapter = new ClaudeAdapter();

    const scoped = await adapter.transcriptToolCounts({ transcriptPath, sinceMs: secondRunStart });
    expect(scoped!.toolCallCount).toBe(1);
    expect(scoped!.toolBreakdown).toEqual([
      { toolName: 'Bash', callCount: 1, totalDurationMs: 0, interruptedCount: 0, resultTokens: 200 },
    ]);

    // No sinceMs (or null) keeps the whole conversation.
    expect((await adapter.transcriptToolCounts({ transcriptPath }))!.toolCallCount).toBe(2);
    expect((await adapter.transcriptToolCounts({ transcriptPath, sinceMs: null }))!.toolCallCount).toBe(2);
  });

  it('transcriptToolResultTokens returns the per-tool estimates of the run that starts at sinceMs', async () => {
    const adapter = new ClaudeAdapter();

    expect(await adapter.transcriptToolResultTokens({ transcriptPath, sinceMs: secondRunStart })).toEqual({ Bash: 200 });
    expect(await adapter.transcriptToolResultTokens({ transcriptPath })).toEqual({ Read: 1000, Bash: 200 });
    expect(await adapter.transcriptToolResultTokens({ transcriptPath, sinceMs: null })).toEqual({ Read: 1000, Bash: 200 });
  });

  it('a closed window holds only the earlier run, read after the later run began', async () => {
    // An earlier run that ended at app quit, read once its successor is
    // running: the window ends at the successor's start.
    const adapter = new ClaudeAdapter();
    const firstRunStart = Date.parse('2026-10-04T22:50:00.000Z');

    expect(await adapter.transcriptToolResultTokens({ transcriptPath, sinceMs: firstRunStart, untilMs: secondRunStart }))
      .toEqual({ Read: 1000 });
    const counts = await adapter.transcriptToolCounts({ transcriptPath, sinceMs: firstRunStart, untilMs: secondRunStart });
    expect(counts!.toolBreakdown.map((stat) => stat.toolName)).toEqual(['Read']);
  });

  it('transcriptToolResultTokens returns null when no transcript can be located or read', async () => {
    const adapter = new ClaudeAdapter();

    expect(await adapter.transcriptToolResultTokens({})).toBeNull();
    expect(await adapter.transcriptToolResultTokens({ agentSessionId: 'some-id', cwd: null })).toBeNull();
    expect(await adapter.transcriptToolResultTokens({ transcriptPath: path.join(dir, 'missing.jsonl') })).toBeNull();
  });
});
