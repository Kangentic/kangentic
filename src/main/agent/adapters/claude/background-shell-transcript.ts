import fs from 'node:fs';
import { peekClaudeTranscriptFile } from './transcript-locator';
import type { StoredCliTarget } from '../../../../shared/types';
import { placeFromStored } from '../../shared/cli-target';

/**
 * Definitive reclaim for a named background holder whose exit was never
 * hooked. Claude injects a `<task-notification>` user message when a
 * backgrounded shell - or a `Monitor` task, which shares the same id space,
 * the same `tasks/<id>.output` store, and the same notification wrapper -
 * reaches a terminal state.
 *
 * When the CLI is MID-TURN it delivers that notification as a
 * `queued_command` ATTACHMENT rather than a real user turn, so it fires no
 * `UserPromptSubmit` hook (confirmed empirically against a real incident
 * transcript, task #386). Mid-turn is exactly when a drain matters, so a hook
 * drain is unreliable by construction. (It does arrive as a genuine
 * `promptSource: "system"` user turn when the CLI is idle at delivery time -
 * that is the case a hook would have caught, and the one that never needed
 * catching.) The notification IS always appended to Claude's durable session
 * JSONL, so tailing that file for a TRACKED holder's terminal notification is
 * the reliable signal a hook drain can never provide.
 *
 * Matching captured ids against the caller's own tracked `shellIds` is what
 * makes an unrelated notification (a subagent/Task completion, delivered as
 * a genuine `role:user` message and carrying a long-hex agent id) a
 * structural no-match - it is never in the tracked set.
 */

/** Shell/task ids are short word-char/dash slugs; bound the length defensively. */
const NOTIFICATION_ID_PATTERN = /^[\w-]{1,64}$/;

/**
 * Splits the tailed text into individual `<task-notification>` blocks, so each
 * one is judged terminal-or-not in ISOLATION. Capture group 1 is a block's
 * inner text.
 *
 * A block ends at the EARLIER of its own closing tag or the next opening tag.
 * Both halves of that are load-bearing:
 *
 *   - Scanning the whole tailed text at once (what this replaced) let a
 *     NON-terminal block's `<task-id>` pair with a LATER block's `<status>`
 *     across the JSONL line boundary and drain the wrong tracked shell. That
 *     was latent only while non-terminal notifications did not exist; Monitor
 *     emits one per event, so it is now reachable.
 *   - A plain lazy open-to-close match would merge two neighbouring blocks
 *     whenever a wrapper is duplicated or left unclosed, which real captured
 *     transcripts do contain.
 *
 * `[\s\S]` spans newlines without needing flags; the block appears
 * JSON-escaped (literal `\n`) inside one JSONL line, which `[\s\S]` also spans
 * since the escape sequence is still two raw characters in the line's text
 * form.
 */
const NOTIFICATION_BLOCK_PATTERN =
  /<task-notification>([\s\S]*?)(?=<\/task-notification>|<task-notification>|$)/g;

/**
 * Every `<task-id>` inside one block. A notification may name SEVERAL: the
 * orphan-scan block a new session emits for shells the previous one left
 * behind lists each id plus an `__orphan_summary__:*` marker. Returning all of
 * them is safe because `reportTerminatedBackgroundShells` filters to the
 * caller's tracked set, which the marker can never be in.
 */
const TASK_ID_PATTERN = /<task-id>([\w-]{1,64})<\/task-id>/g;

/** Any `<status>` element inside one block. */
const STATUS_PATTERN = /<status>([\w-]{1,32})<\/status>/g;

/**
 * Terminal `<status>` values: the task is over and its holder may be drained.
 * `running` is deliberately absent - it is a progress status, not a terminal
 * one. `stopped` covers a Monitor or shell stopped from the UI and the
 * orphan-scan notification described above; it was missing here, so those
 * blocks were silently ignored.
 */
const TERMINAL_STATUSES: ReadonlySet<string> = new Set([
  'completed',
  'failed',
  'killed',
  'cancelled',
  'aborted',
  'stopped',
]);

/**
 * A Monitor that reaches its `timeoutMs` is terminal but carries NO `<status>`
 * element at all - this prefix inside `<event>` is its only marker. Monitor's
 * non-terminal event deliveries use the identical wrapper with an arbitrary
 * `<event>` payload, so this is the sole thing separating them; requiring the
 * `<event>` tag keeps a monitored log line that happens to quote the phrase
 * from draining a live holder.
 *
 * Two wordings. Claude Code 2.1.316 writes `[Monitor expired after 15m with 19
 * events delivered. Re-arm it if you still need the watch.]`, and that is the
 * only one any retained transcript holds: one overnight run had 24 of them and
 * no other, and the old marker alone left 25 of one task's 30 holders open for
 * good. `[Monitor timed out` is kept for the CLIs that wrote it. A third
 * rewording is bounded anyway by the Monitor's own `timeoutMs`
 * (`SessionTelemetry`'s holder expiry), so this match is the fast path, not the
 * only one.
 *
 * Matching the PREFIX rather than the whole sentence is deliberate: the timed
 * out marker continues with a U+2014, which `tests/unit/writing-style-characters.test.ts`
 * forbids anywhere in `src/`.
 */
const MONITOR_TIMEOUT_MARKER = /<event>\s*\[Monitor (?:timed out|expired)/;

interface TranscriptCursor {
  size: number;
  byteOffset: number;
  carry: Buffer;
  /**
   * The cursor stands inside a line the first read began in the middle of,
   * so the next read discards bytes through the first newline rather than
   * reading that line's tail as a line of its own.
   */
  insidePartialLine: boolean;
}

const EMPTY_BUFFER = Buffer.alloc(0);

/** LRU cap mirroring transcript-parser.ts's incremental-state cache. */
const CURSOR_LIMIT = 32;
const cursorByPath = new Map<string, TranscriptCursor>();

function touchCursor(filePath: string, cursor: TranscriptCursor): void {
  cursorByPath.delete(filePath);
  cursorByPath.set(filePath, cursor);
  if (cursorByPath.size > CURSOR_LIMIT) {
    const oldestKey = cursorByPath.keys().next().value;
    if (oldestKey !== undefined) cursorByPath.delete(oldestKey);
  }
}

/** Split on the last newline; return the leading complete-lines text and the trailing partial-line carry. */
function splitCompleteLines(buffer: Buffer): { completeLinesText: string; carry: Buffer } {
  const lastNewline = buffer.lastIndexOf(0x0a);
  if (lastNewline === -1) return { completeLinesText: '', carry: buffer };
  return {
    completeLinesText: buffer.subarray(0, lastNewline + 1).toString('utf-8'),
    carry: buffer.subarray(lastNewline + 1),
  };
}

/** Whether one notification block reports a terminal state. */
function isTerminalBlock(block: string): boolean {
  for (const match of block.matchAll(STATUS_PATTERN)) {
    const status = match[1];
    if (status !== undefined && TERMINAL_STATUSES.has(status)) return true;
  }
  return MONITOR_TIMEOUT_MARKER.test(block);
}

/** Extract every id named by a TERMINAL `<task-notification>` in the given text. */
function extractTerminatedIds(text: string): string[] {
  const ids: string[] = [];
  for (const blockMatch of text.matchAll(NOTIFICATION_BLOCK_PATTERN)) {
    const block = blockMatch[1];
    if (block === undefined || !isTerminalBlock(block)) continue;
    for (const idMatch of block.matchAll(TASK_ID_PATTERN)) {
      const id = idMatch[1];
      if (id !== undefined) ids.push(id);
    }
  }
  return ids;
}

/**
 * How far back from end-of-file the FIRST read of a transcript looks. The
 * watcher asks about a shell within a poll cycle or two (about 2 s) of
 * learning its id. A shell that exits at once can have its terminal
 * notification written before Kangentic learns the id at all. In #803 the
 * notification landed 30 ms before the named `background_shell_start`, and an
 * EOF anchor at the first ask lost it for good. 1 MiB covers several large
 * tool results in that gap and keeps the one-time read bounded.
 */
export const FIRST_READ_LOOKBACK_BYTES = 1024 * 1024;

/**
 * Read `filePath` from `offset` to `size`, prepend `carry`, and return every
 * terminal-notification id in the complete lines, storing the cursor at what
 * was read. With `insidePartialLine` the read began inside a line, so the
 * bytes through the first newline are discarded. A read that finds no
 * newline there stores the cursor still inside that line, and the next read
 * keeps discarding.
 */
function readTerminatedIdsFrom(
  filePath: string,
  size: number,
  offset: number,
  carry: Buffer,
  insidePartialLine: boolean,
): string[] {
  let fileDescriptor: number;
  try {
    fileDescriptor = fs.openSync(filePath, 'r');
  } catch {
    return [];
  }
  try {
    const length = size - offset;
    const buffer = Buffer.allocUnsafe(length);
    const bytesRead = fs.readSync(fileDescriptor, buffer, 0, length, offset);
    let appended: Buffer = bytesRead === length ? buffer : buffer.subarray(0, bytesRead);
    if (insidePartialLine) {
      const firstNewline = appended.indexOf(0x0a);
      if (firstNewline === -1) {
        // Still inside that line. Move past what was read so a long line is
        // not read again on every poll.
        touchCursor(filePath, { size, byteOffset: offset + bytesRead, carry: EMPTY_BUFFER, insidePartialLine: true });
        return [];
      }
      appended = appended.subarray(firstNewline + 1);
    }
    const combined = carry.length === 0 ? appended : Buffer.concat([carry, appended]);
    const split = splitCompleteLines(combined);
    // Advance the cursor by what was ACTUALLY read, not the full expected new
    // size. A short read (bytesRead < length - possible on a network share or
    // an AV/lock-contended Windows file being concurrently appended) must
    // leave the unread tail to be picked up next cycle; advancing to `size`
    // would skip that gap forever and silently lose a terminal notification
    // landing in it. On a full read this equals `size`, so the normal path
    // is unchanged.
    // The carry is copied: a subarray, even an empty one, keeps the whole
    // read buffer alive, which on a first read is up to 1 MiB per cursor.
    const storedCarry = split.carry.length === 0 ? EMPTY_BUFFER : Buffer.from(split.carry);
    touchCursor(filePath, { size, byteOffset: offset + bytesRead, carry: storedCarry, insidePartialLine: false });
    return split.completeLinesText.length > 0 ? extractTerminatedIds(split.completeLinesText) : [];
  } catch {
    return [];
  } finally {
    fs.closeSync(fileDescriptor);
  }
}

/**
 * Read new bytes appended to `filePath` since the last call for this path,
 * returning every terminal-notification id captured across those bytes. The
 * FIRST call for a path reads back up to `FIRST_READ_LOOKBACK_BYTES` from
 * end-of-file, since a shell that exits at once can be reported before the
 * caller first asks (#803). Reading history is safe because the caller
 * filters to its own tracked ids, each minted for one launch: a terminal
 * notification naming one means that shell ended. A shrink or rotation
 * re-anchors at the current EOF rather than risking a stale offset, since
 * the bytes before it are a rewrite, not new.
 */
function tailTerminalNotificationIds(filePath: string): string[] {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(filePath);
  } catch {
    cursorByPath.delete(filePath);
    return [];
  }

  const previous = cursorByPath.get(filePath);
  if (!previous) {
    const windowStart = stat.size - FIRST_READ_LOOKBACK_BYTES;
    if (windowStart <= 0) return readTerminatedIdsFrom(filePath, stat.size, 0, EMPTY_BUFFER, false);
    // Begin one byte before the window, inside the line that precedes it.
    // When that byte is the newline ending a line, discarding through the
    // first newline keeps the window's first line whole.
    return readTerminatedIdsFrom(filePath, stat.size, windowStart - 1, EMPTY_BUFFER, true);
  }

  if (stat.size < previous.byteOffset) {
    // Shrink/rotation: re-anchor at the new EOF rather than reading with a
    // stale offset.
    touchCursor(filePath, { size: stat.size, byteOffset: stat.size, carry: EMPTY_BUFFER, insidePartialLine: false });
    return [];
  }

  if (stat.size === previous.byteOffset) {
    // No growth since last call.
    return [];
  }

  return readTerminatedIdsFrom(filePath, stat.size, previous.byteOffset, previous.carry, previous.insidePartialLine);
}

/**
 * `AdapterRuntimeStrategy.backgroundShells.reportTerminatedShells`
 * implementation for Claude. Tails the live session transcript for terminal
 * `<task-notification>` ids, filters them to the caller's tracked
 * `shellIds`, and returns the matches. Never throws.
 */
export function reportTerminatedBackgroundShells(options: {
  cwd: string;
  agentSessionId: string;
  shellIds: string[];
  cliTarget?: StoredCliTarget | null;
  transcriptPath?: string | null;
}): string[] {
  const { cwd, agentSessionId, shellIds } = options;
  if (shellIds.length === 0) return [];
  if (!NOTIFICATION_ID_PATTERN.test(agentSessionId)) return [];

  // Wherever Claude wrote it (a resumed conversation stays in the folder it
  // started in); synchronous, so the locator's peek, which never scans.
  const filePath = peekClaudeTranscriptFile({
    agentSessionId,
    cwd,
    place: placeFromStored(options.cliTarget),
    reportedPath: options.transcriptPath,
  });
  const terminatedIds = tailTerminalNotificationIds(filePath);
  if (terminatedIds.length === 0) return [];

  const tracked = new Set(shellIds);
  const matched = new Set<string>();
  for (const id of terminatedIds) {
    if (tracked.has(id)) matched.add(id);
  }
  return Array.from(matched);
}

/** Test-only: clear the module-scope transcript-cursor cache between test cases. */
export function resetBackgroundShellTranscriptCursorsForTests(): void {
  cursorByPath.clear();
}
