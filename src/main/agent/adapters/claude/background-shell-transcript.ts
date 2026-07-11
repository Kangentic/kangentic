import fs from 'node:fs';
import { locateClaudeTranscriptFile } from './transcript-parser';

/**
 * Definitive reclaim for a named background shell whose exit was never
 * hooked. Claude injects a `<task-notification>` user message when a
 * backgrounded shell reaches a terminal state, but delivers it as a
 * `queued_command` ATTACHMENT rather than a real user turn - so it never
 * fires the `UserPromptSubmit` hook (confirmed empirically against a real
 * incident transcript, task #386). The notification IS still appended to
 * Claude's durable session JSONL, so tailing that file for a TRACKED
 * shell's terminal notification is the reliable signal a hook drain can
 * never provide.
 *
 * Matching captured ids against the caller's own tracked `shellIds` is what
 * makes an unrelated notification (a subagent/Task completion, delivered as
 * a genuine `role:user` message and carrying a long-hex agent id) a
 * structural no-match - it is never in the tracked set.
 */

/** Shell/task ids are short word-char/dash slugs; bound the length defensively. */
const NOTIFICATION_ID_PATTERN = /^[\w-]{1,64}$/;

/**
 * Matches a terminal `<task-notification>` block. Capture group 1 is the
 * `<task-id>`, which for a background shell equals the shell id that opened
 * it. Anchored on the wrapper AND a terminal `<status>` so a future
 * non-terminal (progress) notification never matches. `[\s\S]` spans
 * newlines without needing flags; the block appears JSON-escaped (literal
 * `\n`) inside one JSONL line, which `[\s\S]` also spans since the escape
 * sequence is still two raw characters in the line's text form.
 */
const TERMINAL_NOTIFICATION_PATTERN =
  /<task-notification>[\s\S]*?<task-id>([\w-]{1,64})<\/task-id>[\s\S]*?<status>(?:completed|failed|killed|cancelled|aborted)<\/status>/g;

interface TranscriptCursor {
  size: number;
  byteOffset: number;
  carry: Buffer;
}

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

/** Extract every id captured by a terminal `<task-notification>` in the given text. */
function extractTerminatedIds(text: string): string[] {
  const ids: string[] = [];
  for (const match of text.matchAll(TERMINAL_NOTIFICATION_PATTERN)) {
    const id = match[1];
    if (id !== undefined) ids.push(id);
  }
  return ids;
}

/**
 * Read new bytes appended to `filePath` since the last call for this path,
 * returning every terminal-notification id captured across those bytes. On
 * the FIRST call for a path, anchors the cursor at end-of-file and returns
 * []: the caller starts asking about a shell only shortly after it began
 * (`background_shell_start`), long before a terminal notification could
 * exist, so history never needs scanning - only forward growth. A shrink,
 * rotation, or read failure re-anchors at the current EOF rather than
 * risking a stale offset.
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
    touchCursor(filePath, { size: stat.size, byteOffset: stat.size, carry: Buffer.alloc(0) });
    return [];
  }

  if (stat.size < previous.byteOffset) {
    // Shrink/rotation: re-anchor at the new EOF rather than reading with a
    // stale offset.
    touchCursor(filePath, { size: stat.size, byteOffset: stat.size, carry: Buffer.alloc(0) });
    return [];
  }

  if (stat.size === previous.byteOffset) {
    // No growth since last call.
    return [];
  }

  let fileDescriptor: number;
  try {
    fileDescriptor = fs.openSync(filePath, 'r');
  } catch {
    return [];
  }
  try {
    const length = stat.size - previous.byteOffset;
    const buffer = Buffer.alloc(length);
    const bytesRead = fs.readSync(fileDescriptor, buffer, 0, length, previous.byteOffset);
    const appended = bytesRead === length ? buffer : buffer.subarray(0, bytesRead);
    const combined = Buffer.concat([previous.carry, appended]);
    const { completeLinesText, carry } = splitCompleteLines(combined);
    // Advance the cursor by what was ACTUALLY read, not the full expected new
    // size. A short read (bytesRead < length - possible on a network share or
    // an AV/lock-contended Windows file being concurrently appended) must
    // leave the unread tail to be picked up next cycle; advancing to stat.size
    // would skip that gap forever and silently lose a terminal notification
    // landing in it. On a full read this equals stat.size, so the normal path
    // is unchanged.
    touchCursor(filePath, { size: stat.size, byteOffset: previous.byteOffset + bytesRead, carry });
    return completeLinesText.length > 0 ? extractTerminatedIds(completeLinesText) : [];
  } catch {
    return [];
  } finally {
    fs.closeSync(fileDescriptor);
  }
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
}): string[] {
  const { cwd, agentSessionId, shellIds } = options;
  if (shellIds.length === 0) return [];
  if (!NOTIFICATION_ID_PATTERN.test(agentSessionId)) return [];

  const filePath = locateClaudeTranscriptFile(agentSessionId, cwd);
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
