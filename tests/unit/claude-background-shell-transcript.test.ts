/**
 * Unit tests for the Claude background-shell transcript-drain resolver
 * (task #386). Locks the terminal <task-notification> shape captured from a
 * real incident transcript, the first read's bounded lookback (#803: a
 * notification written before the first ask is still found), forward-only
 * tailing after it, id filtering to the caller's
 * tracked shellIds (structural rejection of subagent completions), and
 * cross-read carry handling for a line split across two reads.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  FIRST_READ_LOOKBACK_BYTES,
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

// The shape Claude Code writes when a shell ends mid-turn: a
// `queue-operation` record whose `content` is the notification (captured
// from the #803 incident transcript, paths generalized).
function queuedNotificationLine(shellId: string): string {
  const content =
    `<task-notification>\n<task-id>${shellId}</task-id>\n` +
    '<tool-use-id>toolu_016NXnzWJKBNTkZZjMJd1rsx</tool-use-id>\n' +
    `<output-file>/tmp/claude/-repo/${agentSessionId}/tasks/${shellId}.output</output-file>\n` +
    '<status>completed</status>\n' +
    '<summary>Background command "Run the unit tests" completed (exit code 0)</summary>\n</task-notification>';
  return JSON.stringify({
    type: 'queue-operation',
    operation: 'enqueue',
    timestamp: '2026-11-11T15:19:09.322Z',
    sessionId: agentSessionId,
    content,
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

  it('reports a notification written before the first call (#803: a shell that exited before its id reached Kangentic)', () => {
    // Issue #803: Claude wrote this `queue-operation` line 30 ms BEFORE the
    // named `background_shell_start` carrying its id was logged, so the
    // transcript's first drain call came after it. Anchoring that call at
    // EOF lost the notification for good and held a turn-end move forever.
    fs.writeFileSync(transcriptPath, `${queuedNotificationLine('baciwed3y')}\n`);

    const result = reportTerminatedBackgroundShells({ cwd, agentSessionId, shellIds: ['baciwed3y'] });

    expect(result).toEqual(['baciwed3y']);
  });

  it('bounds the first read: a notification more than the lookback window before EOF is not reported', () => {
    const filler = `${JSON.stringify({ type: 'assistant', text: 'x'.repeat(4096) })}\n`;
    const fillerLines = Math.ceil((FIRST_READ_LOOKBACK_BYTES + 4096) / filler.length);
    fs.writeFileSync(transcriptPath, `${terminationLine('bvqiw3a6s')}\n${filler.repeat(fillerLines)}`);

    expect(reportTerminatedBackgroundShells({ cwd, agentSessionId, shellIds: ['bvqiw3a6s'] })).toEqual([]);

    // The cursor stands at EOF afterwards: a later notification is read once.
    fs.appendFileSync(transcriptPath, `${terminationLine('bvqiw3a6s')}\n`);
    expect(reportTerminatedBackgroundShells({ cwd, agentSessionId, shellIds: ['bvqiw3a6s'] })).toEqual(['bvqiw3a6s']);
  });

  it('drops the partial line the lookback window starts inside, and still reports the lines after it', () => {
    // One line straddles the window's start. Its tail alone holds a whole
    // notification, which must not be read as a line of its own.
    const straddling = JSON.stringify({ type: 'assistant', text: `${'y'.repeat(FIRST_READ_LOOKBACK_BYTES)}${'<task-notification>\n<task-id>bpartial01</task-id>\n<status>completed</status>\n</task-notification>'}` });
    fs.writeFileSync(transcriptPath, `${straddling}\n${terminationLine('bvqiw3a6s')}\n`);

    expect(reportTerminatedBackgroundShells({ cwd, agentSessionId, shellIds: ['bpartial01', 'bvqiw3a6s'] })).toEqual(['bvqiw3a6s']);
  });

  it('keeps skipping a line the whole window sits inside until it ends on a later read, and never reads that line\'s tail as a line', () => {
    fs.writeFileSync(transcriptPath, `{"type":"assistant","text":"${'z'.repeat(FIRST_READ_LOOKBACK_BYTES + 16)}`);
    expect(reportTerminatedBackgroundShells({ cwd, agentSessionId, shellIds: ['bpartial01', 'bvqiw3a6s'] })).toEqual([]);

    // The line ends with notification-shaped text, then a real notification follows.
    fs.appendFileSync(transcriptPath, '<task-notification><task-id>bpartial01</task-id><status>completed</status></task-notification>"}\n');
    fs.appendFileSync(transcriptPath, `${terminationLine('bvqiw3a6s')}\n`);
    expect(reportTerminatedBackgroundShells({ cwd, agentSessionId, shellIds: ['bpartial01', 'bvqiw3a6s'] })).toEqual(['bvqiw3a6s']);
  });

  it('keeps a line that begins exactly on the lookback window start (the byte before the window is a newline)', () => {
    const terminal = terminationLine('bvqiw3a6s');
    const terminalBytes = Buffer.byteLength(terminal) + 1;
    // The trailing filler is sized so the notification line starts at
    // exactly fileSize - FIRST_READ_LOOKBACK_BYTES.
    const trailingBytes = FIRST_READ_LOOKBACK_BYTES - terminalBytes;
    const leadingLine = `${'p'.repeat(99)}\n`;
    const trailingLine = `${'a'.repeat(trailingBytes - 1)}\n`;
    fs.writeFileSync(transcriptPath, `${leadingLine}${terminal}\n${trailingLine}`);
    const fileSize = fs.statSync(transcriptPath).size;
    expect(fileSize - FIRST_READ_LOOKBACK_BYTES).toBe(leadingLine.length);

    expect(reportTerminatedBackgroundShells({ cwd, agentSessionId, shellIds: ['bvqiw3a6s'] })).toEqual(['bvqiw3a6s']);
  });

  it('reads only the newly appended bytes on the next call when the first window sat inside one unterminated line', () => {
    fs.writeFileSync(transcriptPath, `{"type":"assistant","text":"${'z'.repeat(FIRST_READ_LOOKBACK_BYTES + 16)}`);
    const readSyncSpy = vi.spyOn(fs, 'readSync');
    expect(reportTerminatedBackgroundShells({ cwd, agentSessionId, shellIds: ['bpartial01', 'bvqiw3a6s'] })).toEqual([]);
    const callsAfterFirstRead = readSyncSpy.mock.calls.length;
    expect(callsAfterFirstRead).toBeGreaterThan(0);

    const smallChunk = 'q'.repeat(32);
    fs.appendFileSync(transcriptPath, smallChunk);
    expect(reportTerminatedBackgroundShells({ cwd, agentSessionId, shellIds: ['bpartial01', 'bvqiw3a6s'] })).toEqual([]);
    const secondReadCalls = readSyncSpy.mock.calls.slice(callsAfterFirstRead);
    expect(secondReadCalls).toHaveLength(1);
    // readSync(fd, buffer, offset, length, position): the length is the 4th argument.
    expect(secondReadCalls[0]?.[3]).toBe(smallChunk.length);

    // The line ends, then a real notification follows; the line's tail is not read as a line.
    fs.appendFileSync(transcriptPath, '<task-notification><task-id>bpartial01</task-id><status>completed</status></task-notification>"}\n');
    fs.appendFileSync(transcriptPath, `${terminationLine('bvqiw3a6s')}\n`);
    expect(reportTerminatedBackgroundShells({ cwd, agentSessionId, shellIds: ['bpartial01', 'bvqiw3a6s'] })).toEqual(['bvqiw3a6s']);
  });

  it('reports a tracked shell id once its terminal notification is appended after the anchor', () => {
    fs.writeFileSync(transcriptPath, '');
    // An empty file has nothing to look back at: the cursor starts at 0.
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

  // --- Monitor holders and block scoping -------------------------------
  //
  // `Monitor` shares this notification wrapper, this id space, and the same
  // tasks/<id>.output store with background shells, so it drains through the
  // same resolver. It differs in two ways that these tests pin:
  //   1. It emits NON-terminal notifications (one per event) while it waits.
  //      Background shells never did, which is why the original whole-text
  //      regex could get away with spanning line boundaries.
  //   2. Its timeout is terminal but carries NO <status> element.

  /** A Monitor progress delivery: terminal wrapper shape, non-terminal meaning. */
  function monitorEventLine(taskId: string, eventText: string): string {
    const content =
      `<task-notification>\n<task-id>${taskId}</task-id>\n` +
      `<summary>Monitor event: "Wait for the rig to come up"</summary>\n` +
      `<event>${eventText}</event>\n</task-notification>`;
    return JSON.stringify({
      type: 'user',
      message: { role: 'user', content },
      sessionId: agentSessionId,
      uuid: 'c1d2e3f4-5a6b-4c7d-8e9f-0a1b2c3d4e5f',
      timestamp: '2026-07-27T16:39:34.074Z',
    });
  }

  it('does not let a non-terminal block\'s task-id pair with a LATER block\'s status (cross-block bleed)', () => {
    // THE BUG: the resolver scanned the whole tailed text with one lazy
    // regex, so `<task-notification> ... <task-id>A ... <status>` could span
    // the JSONL line boundary and bind A's id to a DIFFERENT block's terminal
    // status. Latent while only background shells wrote here (they emit no
    // non-terminal notification); Monitor emits one per event, making it
    // reachable. Red before the block-scoping fix: returns the live Monitor's
    // id and misses the shell that actually ended.
    fs.writeFileSync(transcriptPath, '');
    reportTerminatedBackgroundShells({ cwd, agentSessionId, shellIds: ['bmon1live', 'bshellaaa'] });

    fs.appendFileSync(
      transcriptPath,
      `${monitorEventLine('bmon1live', '[metro] Waiting on http://localhost:8081')}\n${terminationLine('bshellaaa')}\n`,
    );
    const result = reportTerminatedBackgroundShells({
      cwd,
      agentSessionId,
      shellIds: ['bmon1live', 'bshellaaa'],
    });

    expect(result).toEqual(['bshellaaa']);
  });

  it('never drains on a non-terminal Monitor event delivery alone', () => {
    fs.writeFileSync(transcriptPath, '');
    reportTerminatedBackgroundShells({ cwd, agentSessionId, shellIds: ['bmon1live'] });

    fs.appendFileSync(transcriptPath, `${monitorEventLine('bmon1live', '[metro] Android Bundled 10123ms')}\n`);
    const result = reportTerminatedBackgroundShells({ cwd, agentSessionId, shellIds: ['bmon1live'] });

    expect(result).toEqual([]);
  });

  it('drains a Monitor that timed out, whose terminal block carries no <status> at all', () => {
    // Monitor's timeout notification reuses the progress shape - <task-id> +
    // <summary> + <event> - and its ONLY terminal marker is the bracketed
    // phrase inside <event>. The event text below is captured verbatim from a
    // real transcript, em-dash included: it is recorded data, not authored
    // punctuation, and it proves the resolver's prefix match survives the real
    // suffix rather than only a trimmed stand-in.
    fs.writeFileSync(transcriptPath, '');
    reportTerminatedBackgroundShells({ cwd, agentSessionId, shellIds: ['bunv416j8'] });

    fs.appendFileSync(
      transcriptPath,
      `${monitorEventLine('bunv416j8', '[Monitor timed out — re-arm if needed.]')}\n`,
    );
    const result = reportTerminatedBackgroundShells({ cwd, agentSessionId, shellIds: ['bunv416j8'] });

    expect(result).toEqual(['bunv416j8']);
  });

  it('drains a Monitor that expired, in the wording Claude Code 2.1.316 writes', () => {
    // Verbatim from a 2.1.316 transcript, the only wording any retained
    // transcript holds. The old marker alone matched none of them, so every
    // expired Monitor held its task working for good: 25 of one task's 30
    // holders at its first step check.
    fs.writeFileSync(transcriptPath, '');
    reportTerminatedBackgroundShells({ cwd, agentSessionId, shellIds: ['b3mntbkwh'] });

    fs.appendFileSync(
      transcriptPath,
      `${monitorEventLine('b3mntbkwh', '[Monitor expired after 15m with 19 events delivered. Re-arm it if you still need the watch.]')}\n`,
    );
    const result = reportTerminatedBackgroundShells({ cwd, agentSessionId, shellIds: ['b3mntbkwh'] });

    expect(result).toEqual(['b3mntbkwh']);
  });

  it('never drains a live Monitor whose summary only quotes "[Monitor expired"', () => {
    fs.writeFileSync(transcriptPath, '');
    reportTerminatedBackgroundShells({ cwd, agentSessionId, shellIds: ['bmon1live'] });

    const content =
      `<task-notification>\n<task-id>bmon1live</task-id>\n` +
      `<summary>Log line quoted from the rig: "[Monitor expired after 3m]"</summary>\n` +
      `<event>[rig] still booting</event>\n</task-notification>`;
    const line = JSON.stringify({
      type: 'user',
      message: { role: 'user', content },
      sessionId: agentSessionId,
      uuid: 'a7b8c9d0-e1f2-4a3b-8c4d-5e6f7a8b9c0d',
      timestamp: '2026-11-02T08:21:40.000Z',
    });
    fs.appendFileSync(transcriptPath, `${line}\n`);
    const result = reportTerminatedBackgroundShells({ cwd, agentSessionId, shellIds: ['bmon1live'] });

    expect(result).toEqual([]);
  });

  it('treats status "stopped" as terminal', () => {
    // Emitted when a Monitor or shell is stopped from the UI. It was absent
    // from the terminal-status set, so those holders were never drained here.
    fs.writeFileSync(transcriptPath, '');
    reportTerminatedBackgroundShells({ cwd, agentSessionId, shellIds: ['bvqiw3a6s'] });

    fs.appendFileSync(transcriptPath, `${terminationLine('bvqiw3a6s', 'stopped')}\n`);
    const result = reportTerminatedBackgroundShells({ cwd, agentSessionId, shellIds: ['bvqiw3a6s'] });

    expect(result).toEqual(['bvqiw3a6s']);
  });

  // This diff rewrote the terminal-status check from a regex alternation
  // (?:completed|failed|killed|cancelled|aborted) into the TERMINAL_STATUSES
  // Set, adding 'stopped'. Only 'completed' (via terminationLine's default)
  // and 'stopped' (immediately above) are asserted elsewhere in this file - a
  // dropped or misspelled Set entry for any of these four would silently
  // leave that whole status class undrained (the same false-idle-forever
  // failure class this file exists to guard), with nothing here to catch it.
  it.each(['failed', 'killed', 'cancelled', 'aborted'])('treats status "%s" as terminal', (status) => {
    fs.writeFileSync(transcriptPath, '');
    reportTerminatedBackgroundShells({ cwd, agentSessionId, shellIds: ['bvqiw3a6s'] });

    fs.appendFileSync(transcriptPath, `${terminationLine('bvqiw3a6s', status)}\n`);
    const result = reportTerminatedBackgroundShells({ cwd, agentSessionId, shellIds: ['bvqiw3a6s'] });

    expect(result).toEqual(['bvqiw3a6s']);
  });

  it('still refuses a non-terminal status, so a progress notification cannot drain a live holder', () => {
    fs.writeFileSync(transcriptPath, '');
    reportTerminatedBackgroundShells({ cwd, agentSessionId, shellIds: ['bvqiw3a6s'] });

    fs.appendFileSync(transcriptPath, `${terminationLine('bvqiw3a6s', 'running')}\n`);
    const result = reportTerminatedBackgroundShells({ cwd, agentSessionId, shellIds: ['bvqiw3a6s'] });

    expect(result).toEqual([]);
  });

  it('drains EVERY tracked id named by one orphan-scan block, ignoring its internal marker id', () => {
    // A new session emits a single block listing every holder the previous
    // session left without a completion record, plus an `__orphan_summary__`
    // scan marker. Only the first id was ever captured; the rest stayed
    // pinned. The marker is filtered structurally - it is not in the tracked
    // set - so returning all ids is safe.
    const content =
      `<task-notification>\n<task-id>b76wnhzwj</task-id>\n<task-id>bunv416j8</task-id>\n` +
      `<task-id>__orphan_summary__</task-id>\n<status>stopped</status>\n` +
      `<summary>2 background shell command task(s) from the previous session have no completion record.</summary>\n` +
      `</task-notification>`;
    const line = JSON.stringify({
      type: 'user',
      message: { role: 'user', content },
      sessionId: agentSessionId,
      uuid: 'd4e5f6a7-8b9c-4d0e-1f2a-3b4c5d6e7f80',
      timestamp: '2026-07-27T18:02:53.607Z',
    });

    fs.writeFileSync(transcriptPath, '');
    reportTerminatedBackgroundShells({ cwd, agentSessionId, shellIds: ['b76wnhzwj', 'bunv416j8'] });

    fs.appendFileSync(transcriptPath, `${line}\n`);
    const result = reportTerminatedBackgroundShells({
      cwd,
      agentSessionId,
      shellIds: ['b76wnhzwj', 'bunv416j8'],
    });

    expect(result.sort()).toEqual(['b76wnhzwj', 'bunv416j8']);
  });

  it('bounds a block at the next opening tag when a wrapper is left unclosed', () => {
    // Captured transcripts do contain back-to-back wrappers where the first is
    // not closed. A plain lazy open-to-close match merges the two into one
    // block, which would let the live Monitor's id inherit the shell's status.
    fs.writeFileSync(transcriptPath, '');
    reportTerminatedBackgroundShells({ cwd, agentSessionId, shellIds: ['bmon1live', 'bshellaaa'] });

    const unclosedThenTerminal =
      `<task-notification>\n<task-id>bmon1live</task-id>\n<event>[rig] still booting</event>\n` +
      `<task-notification>\n<task-id>bshellaaa</task-id>\n<status>completed</status>\n</task-notification>`;
    const line = JSON.stringify({
      type: 'user',
      message: { role: 'user', content: unclosedThenTerminal },
      sessionId: agentSessionId,
      uuid: 'e5f6a7b8-9c0d-4e1f-2a3b-4c5d6e7f8091',
      timestamp: '2026-07-27T16:40:03.404Z',
    });

    fs.appendFileSync(transcriptPath, `${line}\n`);
    const result = reportTerminatedBackgroundShells({
      cwd,
      agentSessionId,
      shellIds: ['bmon1live', 'bshellaaa'],
    });

    expect(result).toEqual(['bshellaaa']);
  });

  it('requires the "[Monitor timed out" phrase to sit inside an <event> element - a live Monitor whose block merely quotes the phrase elsewhere is never drained', () => {
    // The marker's whole purpose (comment on MONITOR_TIMEOUT_MARKER) is to
    // stop a monitored log line that happens to quote the phrase from
    // draining a LIVE holder. Here the phrase sits inside <summary>, quoting
    // something the rig itself printed, while the block's own <event> carries
    // unrelated live progress text - and there is no terminal <status>
    // anywhere. Red if the <event> requirement is dropped from
    // MONITOR_TIMEOUT_MARKER: the bare-phrase regex would match the
    // <summary> text and drain a Monitor that is still running.
    fs.writeFileSync(transcriptPath, '');
    reportTerminatedBackgroundShells({ cwd, agentSessionId, shellIds: ['bmon1live'] });

    const content =
      `<task-notification>\n<task-id>bmon1live</task-id>\n` +
      `<summary>Log line quoted verbatim from the rig: "[Monitor timed out at 09:14 UTC]"</summary>\n` +
      `<event>[rig] still booting, waiting for health check</event>\n</task-notification>`;
    const line = JSON.stringify({
      type: 'user',
      message: { role: 'user', content },
      sessionId: agentSessionId,
      uuid: 'f1a2b3c4-d5e6-4f70-8192-a3b4c5d6e7f8',
      timestamp: '2026-07-27T16:41:12.000Z',
    });

    fs.appendFileSync(transcriptPath, `${line}\n`);
    const result = reportTerminatedBackgroundShells({ cwd, agentSessionId, shellIds: ['bmon1live'] });

    expect(result).toEqual([]);
  });
});
