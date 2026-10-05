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
import {
  parseClaudeTranscriptToolCounts,
  parseClaudeTranscriptToolResultTokens,
  claudeProjectSlug,
  resetToolCountsCursorsForTests,
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

describe('parseClaudeTranscriptToolCounts - result tokens and resume', () => {
  let dir: string;

  beforeEach(() => {
    resetToolCountsCursorsForTests();
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kangentic-transcript-result-tokens-'));
  });

  afterEach(() => {
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
    resetToolCountsCursorsForTests();
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
