import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  parseClaudeTranscript,
  parseClaudeTranscriptWindow,
  resetIncrementalParseStateForTests,
  incrementalStateSizeForTests,
  incrementalStateBytesForTests,
  setIncrementalStateBudgetForTests,
} from '../../src/main/agent/adapters/claude/transcript-parser';
import { setParseWindowBytesForTests } from '../../src/main/agent/shared/transcript-truncation';

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
    // Module-scope cap: restore it or a lowered value leaks into later files.
    setParseWindowBytesForTests();
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

  it('evicts on the BYTE budget while the count cap is still satisfied', async () => {
    // The map was capped by file COUNT only, while each record retains a full
    // untruncated entries array, so retention scaled with transcript SIZE and
    // nothing bounded it. (Measured, so the guard is not oversold: one
    // whole-file parse of the 137.9MB transcript retains 12.7MB of entries, so
    // 32 such slots is ~0.4GB - a real ceiling worth bounding, but the parse
    // PEAK is what actually OOM'd the process. See the parse-cap test below.)
    //
    // The assertion has to be on BYTES. Ten files is far under the count cap of
    // 32, so the pre-fix implementation retains every one of them and passes
    // any count-based assertion while holding the whole working set.
    const seedTenFiles = async (prefix: string): Promise<void> => {
      for (let fileIndex = 0; fileIndex < 10; fileIndex += 1) {
        const distinctPath = path.join(tmpDir, `${prefix}-${fileIndex}.jsonl`);
        fs.writeFileSync(distinctPath, userLine(`u${fileIndex}`, 'p'.repeat(900)));
        await parseClaudeTranscript(distinctPath);
      }
    };

    // CONTROL: with no binding byte budget, the count cap alone retains all ten
    // and roughly 10KB. This is the pre-fix behavior, and it is what makes the
    // assertions below a genuine red-green rather than a tautology.
    setIncrementalStateBudgetForTests(Number.MAX_SAFE_INTEGER);
    await seedTenFiles('control');
    expect(incrementalStateSizeForTests()).toBe(10);
    expect(incrementalStateBytesForTests()).toBeGreaterThan(4 * 1024);

    resetIncrementalParseStateForTests();
    setIncrementalStateBudgetForTests(4 * 1024);
    await seedTenFiles('budget');

    expect(incrementalStateSizeForTests()).toBeLessThan(10);
    expect(incrementalStateBytesForTests()).toBeLessThanOrEqual(4 * 1024);
  });

  it('parses only the tail of a transcript larger than the parse cap, marking the omission', async () => {
    // The peak-allocation bound, and the load-bearing half of this fix. A byte
    // budget cannot provide it: eviction runs only AFTER a parse has
    // allocated. Without a cap here, reading the 137.9MB transcript builds a
    // 275.9MB UTF-16 string every time, and several such reads were routinely
    // in flight at once - which is how the heap reached 3.4GB.
    const cap = 4 * 1024;
    setParseWindowBytesForTests(cap);

    const parts: string[] = [];
    let written = 0;
    let lineIndex = 0;
    while (written <= cap * 3) {
      const line = userLine(`u${lineIndex}`, `turn ${lineIndex} ${'q'.repeat(200)}`);
      parts.push(line);
      written += Buffer.byteLength(line, 'utf-8');
      lineIndex += 1;
    }
    const lastUuid = `u${lineIndex - 1}`;
    fs.writeFileSync(file, parts.join(''));
    expect(fs.statSync(file).size).toBeGreaterThan(cap);

    const entries = await parseClaudeTranscript(file);

    // The oldest turn is gone, the newest is present: this is a TAIL window.
    expect(entries.some((entry) => entry.uuid === 'u0')).toBe(false);
    expect(entries.some((entry) => entry.uuid === lastUuid)).toBe(true);

    // The omission is reported in-band rather than silently dropping turns.
    const marker = entries[0];
    expect(marker).toMatchObject({ kind: 'system', subtype: 'truncated' });
    expect((marker as { text: string }).text).toContain('not shown');

    // Retention is bounded by the window, not by the file size.
    expect(incrementalStateBytesForTests()).toBeLessThanOrEqual(cap);
  });

  it('keeps parsing correctly after an append to an already-truncated transcript', async () => {
    const cap = 4 * 1024;
    setParseWindowBytesForTests(cap);

    const parts: string[] = [];
    let written = 0;
    let lineIndex = 0;
    while (written <= cap * 2) {
      const line = userLine(`u${lineIndex}`, `turn ${lineIndex} ${'q'.repeat(200)}`);
      parts.push(line);
      written += Buffer.byteLength(line, 'utf-8');
      lineIndex += 1;
    }
    fs.writeFileSync(file, parts.join(''));
    await parseClaudeTranscript(file);

    fs.appendFileSync(file, userLine('u-after-truncation', 'appended past the cap'));
    const reparsed = await parseClaudeTranscript(file);

    // An append to an over-cap file still lands, and retention stays bounded.
    expect(reparsed[reparsed.length - 1]).toMatchObject({
      kind: 'user',
      uuid: 'u-after-truncation',
      text: 'appended past the cap',
    });
    expect(incrementalStateBytesForTests()).toBeLessThanOrEqual(cap);
  });

  it('carries exactly one truncation marker across a re-window as the file keeps growing', async () => {
    // A live session past the cap keeps appending, and every cap-worth of
    // growth forces a fresh window (the `canIncrement` gate). Each full parse
    // prepends a marker, so if a re-window ever appended to the previous array
    // instead of rebuilding, markers would stack up at the head of the
    // conversation, one per re-window.
    const cap = 4 * 1024;
    setParseWindowBytesForTests(cap);

    const appendTurns = (startIndex: number, count: number): void => {
      let batch = '';
      for (let offset = 0; offset < count; offset += 1) {
        batch += userLine(`u${startIndex + offset}`, `turn ${'q'.repeat(300)}`);
      }
      fs.appendFileSync(file, batch);
    };

    appendTurns(0, 20);
    await parseClaudeTranscript(file);

    // Push well past the cap several times over, re-parsing after each burst.
    let nextIndex = 20;
    for (let burst = 0; burst < 4; burst += 1) {
      appendTurns(nextIndex, 20);
      nextIndex += 20;
      const entries = await parseClaudeTranscript(file);
      const markers = entries.filter(
        (entry) => entry.kind === 'system' && entry.subtype === 'truncated',
      );
      expect(markers.length).toBeLessThanOrEqual(1);
      // When present it is always at the head, describing the omitted prefix.
      if (markers.length === 1) expect(entries[0]).toBe(markers[0]);
      expect(incrementalStateBytesForTests()).toBeLessThanOrEqual(cap);
    }
  });

  it('parseClaudeTranscriptWindow walks a whole file in windows and retains NO state', async () => {
    // The indexer's path: every turn is seen, but nothing is cached - a sweep
    // over every session must not evict the viewer's hot state (before this
    // existed, a sweep was exactly what packed the state map with the largest
    // files on the machine).
    const lines: string[] = [];
    for (let turn = 0; turn < 40; turn += 1) {
      lines.push(userLine(`u${turn}`, `turn ${turn} ${'x'.repeat(200)}`));
    }
    fs.writeFileSync(file, lines.join(''));
    const totalBytes = fs.statSync(file).size;

    const seen: string[] = [];
    let offset = 0;
    let guard = 0;
    while (offset < totalBytes && guard < 200) {
      guard += 1;
      const window = await parseClaudeTranscriptWindow(file, offset, 1024);
      if (window.nextByteOffset <= offset) break;
      for (const entry of window.entries) seen.push(entry.uuid);
      offset = window.nextByteOffset;
    }

    // Every turn indexed exactly once, no gap and no duplicate.
    expect(seen).toEqual(Array.from({ length: 40 }, (unused, turn) => `u${turn}`));
    expect(incrementalStateSizeForTests()).toBe(0);
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
