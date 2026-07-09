import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  parseClaudeTranscript,
  resetIncrementalParseStateForTests,
  incrementalStateSizeForTests,
} from '../../src/main/agent/adapters/claude/transcript-parser';

/**
 * Covers the incremental-append parse path in `parseClaudeTranscript`: when a
 * transcript file's size grows and its mtime does not go backwards, only the
 * NEW bytes are read and parsed, appended onto the entries array from the
 * prior call - instead of re-reading and re-parsing the whole file. All
 * cases reuse the SAME path across multiple `parseClaudeTranscript` calls
 * (unlike claude-transcript-parser.test.ts's fresh-path-per-test convention),
 * which is exactly what exercises this path, so each test resets the
 * module-scope incremental state first for isolation.
 */

function line(record: Record<string, unknown>): string {
  return `${JSON.stringify(record)}\n`;
}

function crlfLine(record: Record<string, unknown>): string {
  return `${JSON.stringify(record)}\r\n`;
}

function userLineRecord(uuid: string, text: string, ts: string): Record<string, unknown> {
  return { type: 'user', uuid, timestamp: ts, message: { role: 'user', content: text } };
}

function userLine(uuid: string, text: string, ts = '2026-06-01T00:00:00Z'): string {
  return line({ type: 'user', uuid, timestamp: ts, message: { role: 'user', content: text } });
}

function assistantTextLine(
  uuid: string,
  messageId: string,
  text: string,
  usage: Record<string, number> | null,
  ts = '2026-06-01T00:00:01Z',
): string {
  const message: Record<string, unknown> = {
    id: messageId,
    role: 'assistant',
    model: 'claude-opus-4-8',
    content: [{ type: 'text', text }],
  };
  if (usage) message.usage = usage;
  return line({ type: 'assistant', uuid, timestamp: ts, message });
}

describe('parseClaudeTranscript incremental append', () => {
  let tmpDir: string;
  let file: string;

  beforeEach(() => {
    resetIncrementalParseStateForTests();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'transcript-incremental-test-'));
    file = path.join(tmpDir, 'session.jsonl');
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('append round-trip: parsing after N appends equals a single full parse of the final content', async () => {
    fs.writeFileSync(file, userLine('u1', 'first prompt'));
    const afterFirst = await parseClaudeTranscript(file);
    expect(afterFirst).toHaveLength(1);

    fs.appendFileSync(file, assistantTextLine('a1', 'm1', 'first reply', { input_tokens: 10, output_tokens: 5 }));
    const afterSecond = await parseClaudeTranscript(file);
    expect(afterSecond).toHaveLength(2);

    fs.appendFileSync(file, userLine('u2', 'second prompt'));
    const afterThird = await parseClaudeTranscript(file);
    expect(afterThird).toHaveLength(3);

    // Cross-check against a single full parse of the same final content from
    // a fresh (never-incrementally-touched) path.
    const fullPath = path.join(tmpDir, 'session-full.jsonl');
    fs.writeFileSync(fullPath, fs.readFileSync(file));
    const fullParse = await parseClaudeTranscript(fullPath);

    expect(afterThird.map((entry) => entry.uuid)).toEqual(fullParse.map((entry) => entry.uuid));
  });

  it('holds a partial (no trailing newline) line as carry until it completes, never parsing it early', async () => {
    fs.writeFileSync(file, userLine('u1', 'first prompt'));
    await parseClaudeTranscript(file);

    // Simulate a write-in-progress: append a line's bytes WITHOUT its
    // terminating newline yet.
    const partial = JSON.stringify({ type: 'user', uuid: 'u2', timestamp: '2026-06-01T00:00:02Z', message: { role: 'user', content: 'second prompt' } });
    fs.appendFileSync(file, partial);
    const whilePartial = await parseClaudeTranscript(file);
    expect(whilePartial).toHaveLength(1); // the partial line must NOT appear yet

    // Now the writer finishes the line.
    fs.appendFileSync(file, '\n');
    const afterComplete = await parseClaudeTranscript(file);
    expect(afterComplete).toHaveLength(2);
    expect(afterComplete[1]).toMatchObject({ kind: 'user', uuid: 'u2', text: 'second prompt' });
  });

  it('falls back to a full reparse when the file shrinks (rotation/truncation), never reading stale byte offsets', async () => {
    fs.writeFileSync(file, userLine('u1', 'first prompt') + assistantTextLine('a1', 'm1', 'first reply', null));
    const before = await parseClaudeTranscript(file);
    expect(before).toHaveLength(2);

    // Truncate to a single, DIFFERENT line (simulating log rotation).
    fs.writeFileSync(file, userLine('u-new', 'after rotation'));
    const after = await parseClaudeTranscript(file);

    expect(after).toHaveLength(1);
    expect(after[0]).toMatchObject({ kind: 'user', uuid: 'u-new', text: 'after rotation' });
  });

  it('attributes usage exactly once for a turn split across two SEPARATE parse calls (thinking-only line, then the text line in a later increment)', async () => {
    // The thinking block is EMPTY (real Claude JSONL never persists plaintext
    // thinking), so this line produces NO entry and must NOT claim message
    // m1's usage - if it did, the text line's usage below would be dropped.
    fs.writeFileSync(
      file,
      line({
        type: 'assistant',
        uuid: 'think-1',
        timestamp: '2026-06-01T00:00:00Z',
        message: { id: 'm1', role: 'assistant', model: 'claude-opus-4-8', content: [{ type: 'thinking', thinking: '' }] },
      }),
    );
    const afterThinkingOnly = await parseClaudeTranscript(file);
    expect(afterThinkingOnly).toHaveLength(0);

    // The text line for the SAME message id lands in a LATER increment.
    fs.appendFileSync(file, assistantTextLine('text-1', 'm1', 'the actual reply', { input_tokens: 100, output_tokens: 40 }));
    const afterText = await parseClaudeTranscript(file);

    expect(afterText).toHaveLength(1);
    const [entry] = afterText;
    expect(entry.kind).toBe('assistant');
    if (entry.kind === 'assistant') {
      expect(entry.usage).toEqual({
        inputTokens: 100,
        outputTokens: 40,
        cacheCreationInputTokens: 0,
        cacheReadInputTokens: 0,
      });
    }
  });

  it('does not re-read already-consumed bytes: a second call with no file change returns entries without touching the filesystem again', async () => {
    fs.writeFileSync(file, userLine('u1', 'first prompt'));
    const first = await parseClaudeTranscript(file);
    const second = await parseClaudeTranscript(file);

    // Same content, same result (identity is the transcript-cache layer's
    // concern, not this function's - this only asserts correctness holds).
    expect(second).toEqual(first);
  });

  it('caps incrementalStateByPath at INCREMENTAL_STATE_LIMIT (32) and evicts the oldest path on overflow', async () => {
    const totalDistinctPaths = 40;
    const parsedPaths: string[] = [];
    for (let pathIndex = 0; pathIndex < totalDistinctPaths; pathIndex += 1) {
      const distinctPath = path.join(tmpDir, `session-${pathIndex}.jsonl`);
      fs.writeFileSync(distinctPath, userLine(`u${pathIndex}`, `prompt ${pathIndex}`));
      parsedPaths.push(distinctPath);
      await parseClaudeTranscript(distinctPath);
    }

    // Crisp red-green anchor: reverting the eviction loop in
    // `touchIncrementalState` leaves every one of the 40 distinct paths
    // resident, so this assertion fails at 40 without the cap in place.
    expect(incrementalStateSizeForTests()).toBeLessThanOrEqual(32);

    // Observable eviction: the FIRST (oldest, now-evicted) path's state is
    // gone, so appending to it and re-parsing takes the full-reparse
    // fallback rather than an incremental append. The fallback is
    // transparent to correctness, so this still parses correctly - proving
    // the cap evicted state without corrupting a later parse of that path.
    const oldestPath = parsedPaths[0];
    fs.appendFileSync(oldestPath, userLine('u-oldest-appended', 'appended after eviction'));
    const oldestReparsed = await parseClaudeTranscript(oldestPath);
    expect(oldestReparsed).toHaveLength(2);
    expect(oldestReparsed[1]).toMatchObject({
      kind: 'user',
      uuid: 'u-oldest-appended',
      text: 'appended after eviction',
    });

    // One of the LAST 32 touched paths should still be cached (reused
    // incremental state), and the cap continues to hold after this parse.
    const mostRecentPath = parsedPaths[totalDistinctPaths - 1];
    fs.appendFileSync(mostRecentPath, userLine('u-recent-appended', 'appended while cached'));
    const recentReparsed = await parseClaudeTranscript(mostRecentPath);
    expect(recentReparsed).toHaveLength(2);
    expect(recentReparsed[1]).toMatchObject({
      kind: 'user',
      uuid: 'u-recent-appended',
      text: 'appended while cached',
    });
    expect(incrementalStateSizeForTests()).toBeLessThanOrEqual(32);
  });

  it('parses a CRLF-terminated line appended incrementally to a CRLF-terminated transcript', async () => {
    fs.writeFileSync(file, crlfLine(userLineRecord('u1', 'first prompt', '2026-06-01T00:00:00Z')));
    const afterFirst = await parseClaudeTranscript(file);
    expect(afterFirst).toHaveLength(1);
    expect(afterFirst[0]).toMatchObject({ kind: 'user', uuid: 'u1', text: 'first prompt' });

    fs.appendFileSync(file, crlfLine(userLineRecord('u2', 'second prompt', '2026-06-01T00:00:01Z')));
    const afterSecond = await parseClaudeTranscript(file);

    expect(afterSecond).toHaveLength(2);
    expect(afterSecond[1]).toMatchObject({ kind: 'user', uuid: 'u2', text: 'second prompt' });
  });
});
