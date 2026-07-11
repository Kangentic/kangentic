/**
 * Unit tests for the Claude background-shell transcript-drain resolver
 * (task #386). Locks the terminal <task-notification> shape captured from a
 * real incident transcript, the early-EOF-anchor cursor (never scans
 * transcript history), forward-only tailing, id filtering to the caller's
 * tracked shellIds (structural rejection of subagent completions), and
 * cross-read carry handling for a line split across two reads.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  reportTerminatedBackgroundShells,
  resetBackgroundShellTranscriptCursorsForTests,
} from '../../src/main/agent/adapters/claude/background-shell-transcript';
import { claudeProjectSlug } from '../../src/main/agent/adapters/claude/transcript-parser';

const cwd = 'C:\\Users\\dev\\repo';
const agentSessionId = '790dfef5-8325-48fd-bd0f-bd6789a48871';

// A real-shape captured line: Claude's <task-notification> user message,
// built with REAL newlines so JSON.stringify escapes them exactly as the
// real captured transcript does (literal backslash-n inside one JSONL
// record, never a raw 0x0A byte). The task-id equals the shell id for a
// background shell (verified against the real incident transcript - the
// id-namespace-mismatch theory in the original bug report was wrong).
function terminationLine(shellOrTaskId: string, status = 'completed'): string {
  const content =
    `<task-notification>\n<task-id>${shellOrTaskId}</task-id>\n` +
    `<command>npx vitest run tests/unit/hmr-resync.test.ts</command>\n` +
    `<status>${status}</status>\n</task-notification>`;
  return JSON.stringify({
    type: 'user',
    message: { role: 'user', content },
    sessionId: agentSessionId,
    uuid: '11e75685-8e19-4522-9a07-af0ebe89727e',
    timestamp: '2026-07-10T20:12:32.046Z',
  });
}

describe('reportTerminatedBackgroundShells', () => {
  let tempHome: string;
  let transcriptPath: string;

  beforeEach(() => {
    resetBackgroundShellTranscriptCursorsForTests();
    tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'kangentic-bgshell-transcript-'));
    vi.spyOn(os, 'homedir').mockReturnValue(tempHome);
    const dir = path.join(tempHome, '.claude', 'projects', claudeProjectSlug(cwd));
    fs.mkdirSync(dir, { recursive: true });
    transcriptPath = path.join(dir, `${agentSessionId}.jsonl`);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(tempHome, { recursive: true, force: true });
    resetBackgroundShellTranscriptCursorsForTests();
  });

  it('returns [] and anchors at EOF on the first call, even if a terminal notification already exists', () => {
    // The watcher only starts asking about a shell shortly after it began -
    // long before a terminal notification could exist - so the first call
    // for a transcript path must never scan history. A notification present
    // BEFORE the shell was ever tracked is exactly the case this guards:
    // it must NOT be reported.
    fs.writeFileSync(transcriptPath, `${terminationLine('bvqiw3a6s')}\n`);

    const result = reportTerminatedBackgroundShells({ cwd, agentSessionId, shellIds: ['bvqiw3a6s'] });

    expect(result).toEqual([]);
  });

  it('reports a tracked shell id once its terminal notification is appended after the anchor', () => {
    fs.writeFileSync(transcriptPath, '');
    // Anchor at EOF (empty file).
    expect(reportTerminatedBackgroundShells({ cwd, agentSessionId, shellIds: ['bvqiw3a6s'] })).toEqual([]);

    fs.appendFileSync(transcriptPath, `${terminationLine('bvqiw3a6s')}\n`);
    const result = reportTerminatedBackgroundShells({ cwd, agentSessionId, shellIds: ['bvqiw3a6s'] });

    expect(result).toEqual(['bvqiw3a6s']);
  });

  it('ignores a notification whose id is not in the caller-supplied shellIds (structural rejection of subagent completions)', () => {
    fs.writeFileSync(transcriptPath, '');
    reportTerminatedBackgroundShells({ cwd, agentSessionId, shellIds: ['bvqiw3a6s'] });

    // A subagent/Task completion delivers a genuine role:user notification
    // carrying a long-hex agent id - never a tracked shell id.
    fs.appendFileSync(transcriptPath, `${terminationLine('aa01903e41d755d26')}\n`);
    const result = reportTerminatedBackgroundShells({ cwd, agentSessionId, shellIds: ['bvqiw3a6s'] });

    expect(result).toEqual([]);
  });

  it('reports only the matching subset when several ids are tracked and only some terminated', () => {
    fs.writeFileSync(transcriptPath, '');
    reportTerminatedBackgroundShells({ cwd, agentSessionId, shellIds: ['bap8rr008', 'bvqiw3a6s'] });

    fs.appendFileSync(transcriptPath, `${terminationLine('bvqiw3a6s')}\n`);
    const result = reportTerminatedBackgroundShells({ cwd, agentSessionId, shellIds: ['bap8rr008', 'bvqiw3a6s'] });

    expect(result).toEqual(['bvqiw3a6s']);
  });

  it('does not re-report an id already consumed by a previous call (forward-only cursor)', () => {
    fs.writeFileSync(transcriptPath, '');
    reportTerminatedBackgroundShells({ cwd, agentSessionId, shellIds: ['bvqiw3a6s'] });
    fs.appendFileSync(transcriptPath, `${terminationLine('bvqiw3a6s')}\n`);
    expect(reportTerminatedBackgroundShells({ cwd, agentSessionId, shellIds: ['bvqiw3a6s'] })).toEqual(['bvqiw3a6s']);

    // No new bytes appended - the cursor has already consumed this line.
    const result = reportTerminatedBackgroundShells({ cwd, agentSessionId, shellIds: ['bvqiw3a6s'] });
    expect(result).toEqual([]);
  });

  it('matches a terminal notification even when its line is split across two reads (carry)', () => {
    fs.writeFileSync(transcriptPath, '');
    reportTerminatedBackgroundShells({ cwd, agentSessionId, shellIds: ['bvqiw3a6s'] });

    const line = terminationLine('bvqiw3a6s');
    const splitAt = Math.floor(line.length / 2);
    // First half, no trailing newline yet - not a complete line.
    fs.appendFileSync(transcriptPath, line.slice(0, splitAt));
    expect(reportTerminatedBackgroundShells({ cwd, agentSessionId, shellIds: ['bvqiw3a6s'] })).toEqual([]);

    // Second half completes the line.
    fs.appendFileSync(transcriptPath, `${line.slice(splitAt)}\n`);
    const result = reportTerminatedBackgroundShells({ cwd, agentSessionId, shellIds: ['bvqiw3a6s'] });
    expect(result).toEqual(['bvqiw3a6s']);
  });

  it('returns [] when the transcript file does not exist', () => {
    const result = reportTerminatedBackgroundShells({ cwd, agentSessionId, shellIds: ['bvqiw3a6s'] });
    expect(result).toEqual([]);
  });

  it('returns [] for a non-terminal status (does not match the terminal-status anchor)', () => {
    fs.writeFileSync(transcriptPath, '');
    reportTerminatedBackgroundShells({ cwd, agentSessionId, shellIds: ['bvqiw3a6s'] });

    fs.appendFileSync(transcriptPath, `${terminationLine('bvqiw3a6s', 'running')}\n`);
    const result = reportTerminatedBackgroundShells({ cwd, agentSessionId, shellIds: ['bvqiw3a6s'] });

    expect(result).toEqual([]);
  });

  it('returns [] when shellIds is empty (no candidates to ask about)', () => {
    fs.writeFileSync(transcriptPath, `${terminationLine('bvqiw3a6s')}\n`);
    const result = reportTerminatedBackgroundShells({ cwd, agentSessionId, shellIds: [] });
    expect(result).toEqual([]);
  });

  it('returns [] for a non-id-shaped agentSessionId, even when a matching terminal notification exists at the same resolved path (guards a path-traversal-shaped id)', () => {
    fs.writeFileSync(transcriptPath, '');
    // Anchor the cursor at EOF for the REAL transcript path via a legitimate call.
    expect(reportTerminatedBackgroundShells({ cwd, agentSessionId, shellIds: ['bvqiw3a6s'] })).toEqual([]);
    fs.appendFileSync(transcriptPath, `${terminationLine('bvqiw3a6s')}\n`);

    // A path-traversal-shaped id that `path.join` normalizes to the exact
    // same resolved file as `agentSessionId` - proving the guard, not merely
    // file-not-found, is what keeps this rejected. Without the guard this
    // call would tail the already-anchored cursor for that identical path and
    // report the id just appended above.
    const traversalId = `x/../${agentSessionId}`;
    expect(
      reportTerminatedBackgroundShells({ cwd, agentSessionId: traversalId, shellIds: ['bvqiw3a6s'] }),
    ).toEqual([]);

    // Other non-id shapes: empty, and over the 64-char length bound.
    for (const malformedId of ['', 'x'.repeat(100)]) {
      expect(
        reportTerminatedBackgroundShells({ cwd, agentSessionId: malformedId, shellIds: ['bvqiw3a6s'] }),
      ).toEqual([]);
    }
  });

  it('re-anchors at the new EOF when the transcript shrinks below the last consumed offset (rotation/rewrite), never reading with a stale offset', () => {
    fs.writeFileSync(transcriptPath, '');
    expect(
      reportTerminatedBackgroundShells({ cwd, agentSessionId, shellIds: ['bvqiw3a6s', 'bap8rr008'] }),
    ).toEqual([]);

    // Consume two full notifications so the cursor's byteOffset sits well
    // past the size of a single fresh line appended after a shrink.
    fs.appendFileSync(transcriptPath, `${terminationLine('bvqiw3a6s')}\n${terminationLine('bap8rr008')}\n`);
    const consumedResult = reportTerminatedBackgroundShells({
      cwd,
      agentSessionId,
      shellIds: ['bvqiw3a6s', 'bap8rr008'],
    });
    expect(new Set(consumedResult)).toEqual(new Set(['bvqiw3a6s', 'bap8rr008']));

    const sizeBeforeShrink = fs.statSync(transcriptPath).size;

    // Shrink/rotation: the transcript is rewritten smaller than the
    // previously-consumed offset, and a fresh terminal notification lands in
    // the same rewrite. The stale offset must not be trusted to read this -
    // re-anchor at the new EOF instead, so this call returns [] even though a
    // terminal notification is physically present in the file.
    const freshShellId = 'bvqiw3a7s';
    fs.writeFileSync(transcriptPath, `${terminationLine(freshShellId)}\n`);
    expect(fs.statSync(transcriptPath).size).toBeLessThan(sizeBeforeShrink);
    const resultOnShrinkCycle = reportTerminatedBackgroundShells({ cwd, agentSessionId, shellIds: [freshShellId] });
    expect(resultOnShrinkCycle).toEqual([]);

    // A notification appended AFTER the re-anchor is picked up normally,
    // proving the cursor really re-anchored at the new EOF rather than
    // staying stuck at the stale (too-large) offset.
    fs.appendFileSync(transcriptPath, `${terminationLine(freshShellId)}\n`);
    const resultAfterReanchor = reportTerminatedBackgroundShells({ cwd, agentSessionId, shellIds: [freshShellId] });
    expect(resultAfterReanchor).toEqual([freshShellId]);
  });

  it('reports every tracked terminal notification captured in a single read (matchAll, not just the first match)', () => {
    fs.writeFileSync(transcriptPath, '');
    reportTerminatedBackgroundShells({ cwd, agentSessionId, shellIds: ['bvqiw3a6s', 'bap8rr008'] });

    fs.appendFileSync(transcriptPath, `${terminationLine('bvqiw3a6s')}\n${terminationLine('bap8rr008')}\n`);
    const result = reportTerminatedBackgroundShells({
      cwd,
      agentSessionId,
      shellIds: ['bvqiw3a6s', 'bap8rr008'],
    });

    expect(new Set(result)).toEqual(new Set(['bvqiw3a6s', 'bap8rr008']));
    expect(result).toHaveLength(2);
  });

  it('advances the cursor by only the bytes actually read on a short read, so an unread tail is picked up next cycle instead of being permanently skipped', () => {
    fs.writeFileSync(transcriptPath, '');
    expect(reportTerminatedBackgroundShells({ cwd, agentSessionId, shellIds: ['bvqiw3a6s'] })).toEqual([]);

    fs.appendFileSync(transcriptPath, `${terminationLine('bvqiw3a6s')}\n`);

    // Force a torn read: report one fewer byte than was actually placed into
    // the buffer, cutting off the line's only newline. Simulates a network
    // share, AV scan, or lock-contended Windows file being read while a
    // concurrent append is in flight.
    const originalReadSync = fs.readSync.bind(fs);
    const readSyncSpy = vi
      .spyOn(fs, 'readSync')
      .mockImplementationOnce(
        (
          fileDescriptor: number,
          buffer: NodeJS.ArrayBufferView,
          offset: number,
          length: number,
          position: number | null,
        ) => {
          const actualBytesRead = originalReadSync(fileDescriptor, buffer, offset, length, position);
          return Math.max(0, actualBytesRead - 1);
        },
      );

    const resultOnTornRead = reportTerminatedBackgroundShells({ cwd, agentSessionId, shellIds: ['bvqiw3a6s'] });
    expect(resultOnTornRead).toEqual([]);
    readSyncSpy.mockRestore();

    // Next cycle: no new bytes were appended, but the previously short-read
    // tail (the final byte, a lone `\n`) is still unread. If the cursor had
    // instead advanced all the way to stat.size on the torn read, this call
    // would see stat.size === byteOffset ("no growth") and never read that
    // tail - the notification would be permanently lost.
    const resultAfterRecovery = reportTerminatedBackgroundShells({ cwd, agentSessionId, shellIds: ['bvqiw3a6s'] });
    expect(resultAfterRecovery).toEqual(['bvqiw3a6s']);
  });

  it('extracts the shell id from the real captured notification shape (tool-use-id, output-file, and summary tags interleaved between task-id and status)', () => {
    // Real Claude-captured shape (sanitized to a generic dev home): the
    // <task-id> is followed by <tool-use-id>, <output-file>, and only THEN
    // <status> and <summary> - proving the [\s\S]*? span between id and
    // status is robust to real interleaved tags, not just the minimal
    // <task-id>/<command>/<status> shape used elsewhere in this file.
    const realShapeContent =
      `<task-notification>\n<task-id>bvqiw3a6s</task-id>\n` +
      `<tool-use-id>toolu_01JQeHaUT5NcJFwFrenQaGLf</tool-use-id>\n` +
      `<output-file>C:\\Users\\dev\\AppData\\Local\\Temp\\claude\\proj-hash\\session\\tasks\\bvqiw3a6s.output</output-file>\n` +
      `<status>completed</status>\n<summary>Background command "npx vitest run" completed (exit code 0)</summary>\n` +
      `</task-notification>`;
    const line = JSON.stringify({
      type: 'user',
      message: { role: 'user', content: realShapeContent },
      sessionId: agentSessionId,
      uuid: 'a2c9c7e0-1c3f-4c39-9f6b-2a2f4e9b6d7a',
      timestamp: '2026-07-10T20:12:32.046Z',
    });

    fs.writeFileSync(transcriptPath, '');
    reportTerminatedBackgroundShells({ cwd, agentSessionId, shellIds: ['bvqiw3a6s'] });

    fs.appendFileSync(transcriptPath, `${line}\n`);
    const result = reportTerminatedBackgroundShells({ cwd, agentSessionId, shellIds: ['bvqiw3a6s'] });

    expect(result).toEqual(['bvqiw3a6s']);
  });
});
