import fs from 'node:fs';
import path from 'node:path';
import { locateClaudeSubagentDir } from './subagent-usage-parser';
import { peekClaudeTranscriptFile } from './transcript-locator';
import type { StoredCliTarget } from '../../../../shared/types';
import { placeFromStored } from '../../shared/cli-target';

/**
 * Definitive detection of a permission prompt that ended without running its
 * tool, from Claude's durable session transcript - a signal no hook can ever
 * deliver.
 *
 * When a user denies a prompt at the TUI (or from a paired phone via
 * `answer-permission-prompt`), Claude Code does NOT re-invoke the model: the
 * turn aborts rather than ending, so `Stop` never fires. A prompt that times
 * out on Claude's built-in safety check goes the other way: the model gets the
 * denial and carries on, under later tool ids the engine reads as siblings.
 * Either way `PostToolUse` fires only "after a tool call succeeds" (the denied
 * tool never ran), and `PermissionDenied` exists only for AUTO-MODE denials. A
 * denial therefore leaves NO hook event of any kind - the whole reason
 * `permissionPending` sticks without this drain (see
 * docs/architecture/activity/predicate.md, "Permission flag").
 *
 * The denial IS always appended to Claude's durable session JSONL, as a
 * synthetic `tool_result` user turn for the awaited call:
 *
 *   { "type": "tool_result", "is_error": true, "tool_use_id": "toolu_...",
 *     "content": "..." }
 *
 * The content is deliberately not read. Claude has more than one denial wording,
 * and matching one left a safety-check denial reading as "needs you" for 7m42s
 * with nothing waiting. An error result for the awaited id proves the prompt is
 * over, whatever it says. Verified against real captured sessions to land AT
 * DENY TIME (not batched into the next user turn, which is 11+ seconds later in
 * the captured case) - the one fact this whole drain rests on.
 */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Parses a transcript line's `timestamp` field, or 0 (never fresh enough
 *  to pass a real `sinceMs` filter) when it is missing or unparseable. */
function parseTimestamp(value: unknown): number {
  if (typeof value !== 'string') return 0;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

/**
 * How old an error result must be before it counts. An approved call keeps its
 * prompt open until its own end, and when it fails, the result reaches the
 * transcript just before `PostToolUseFailure` is read. Taken for a denial there,
 * the card would drop to idle and the hook's `tool_end` would count twice. Longer
 * than one poll, so the hook wins whenever the tool really ran, and a denial
 * clears a poll later.
 */
const HOOK_SETTLE_MS = 2_500;

/**
 * Bytes read from the end of the transcript. A denial's `tool_result` line
 * is short; 256 KB comfortably covers many turns of scrollback so several
 * outstanding prompts across one session are never pushed out of the
 * window.
 */
const TAIL_BYTES = 256 * 1024;

/**
 * Read the last `TAIL_BYTES` of `filePath` and return its lines, or `null`
 * when the file cannot be read. Synchronous, to match every other
 * `AdapterRuntimeStrategy` transcript-reporting callback: this is called
 * from a plain function, never awaited.
 *
 * Deliberately UNCACHED. This is polled once per ~2s per session that is
 * actually awaiting a permission decision - typically zero or one at a
 * time - so a bounded 256 KB read is negligible against that cadence, and
 * each subagent still writing while the prompt is open adds one more. A cap
 * on those reads could leave out the file that holds the denial. Skipping a
 * mtime/size cache avoids a needless correctness hazard: two
 * back-to-back rewrites of the same size landing within one filesystem's
 * mtime resolution window could otherwise serve a stale tail. This is
 * unlike `background-shell-transcript.ts`'s byte CURSOR, which exists to keep
 * a much larger, per-cycle-shared consumer cheap and has no such staleness
 * mode (after one bounded look-back on its first read, it only reads bytes
 * newly appended past its own cursor).
 */
function readTailLinesSync(filePath: string): string[] | null {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(filePath);
  } catch {
    return null;
  }

  let content: string;
  try {
    if (stat.size <= TAIL_BYTES) {
      content = fs.readFileSync(filePath, 'utf-8');
    } else {
      const fileDescriptor = fs.openSync(filePath, 'r');
      try {
        const buffer = Buffer.alloc(TAIL_BYTES);
        const bytesRead = fs.readSync(fileDescriptor, buffer, 0, TAIL_BYTES, stat.size - TAIL_BYTES);
        const raw = buffer.subarray(0, bytesRead).toString('utf-8');
        // The window starts mid-line (and possibly mid-multi-byte-char).
        // Drop everything before the first newline: a truncated leading
        // entry could not have parsed anyway.
        const firstNewline = raw.indexOf('\n');
        content = firstNewline === -1 ? '' : raw.slice(firstNewline + 1);
      } finally {
        fs.closeSync(fileDescriptor);
      }
    }
  } catch {
    return null;
  }

  return content.split(/\r?\n/);
}

/**
 * The session's subagent transcripts written to since `sinceMs`. A prompt a
 * subagent raised ends in that subagent's own file, which the main transcript
 * does not mention. A file nothing wrote to since the prompt opened cannot hold
 * its answer, so a review with dozens of subagents reads only the live ones.
 */
function subagentTranscriptsWrittenSince(directory: string, sinceMs: number): string[] {
  let names: string[];
  try {
    names = fs.readdirSync(directory);
  } catch {
    return [];
  }
  const transcripts: string[] = [];
  for (const name of names) {
    if (!name.endsWith('.jsonl')) continue;
    const transcript = path.join(directory, name);
    try {
      if (fs.statSync(transcript).mtimeMs >= sinceMs) transcripts.push(transcript);
    } catch {
      // Gone between the listing and the stat: it holds no answer now.
    }
  }
  return transcripts;
}

/**
 * `AdapterRuntimeStrategy.permissionPrompts.reportRejectedPromptTools`
 * implementation for Claude. Scans the tail of the live session transcript and
 * of the subagent transcripts written to since `sinceMs`, for an error
 * `tool_result` matching one of the caller's `toolIds`, at or after `sinceMs`.
 * Returns the matched subset. Never throws.
 *
 * A bounded TAIL re-scan, not a byte cursor like the bg-shell transcript
 * drain's in `background-shell-transcript.ts`, is deliberate. The first call
 * happens AFTER the prompt is already open, so a cursor anchored at EOF would
 * fall behind a denial landing inside the very first poll interval and miss
 * it forever. The bg-shell cursor anchored that way until #803 showed the
 * same loss for a shell that exited before its first ask. It now reads back
 * a bounded window on its first call.
 *
 * Re-scanning is made safe by `sinceMs`. The `toolId` match alone is not
 * enough. A `--resume` keeps appending to the same transcript file, so a
 * much older rejection line for a reused `tool_use_id` (unlikely, but not
 * something to bet correctness on) would otherwise still sit in the tail.
 * Filtering to lines whose own `timestamp` is at or after the prompt's park time
 * (`SessionEngineState.needsUserSince`) closes that.
 */
export function reportRejectedPromptTools(options: {
  cwd: string;
  agentSessionId: string;
  toolIds: string[];
  sinceMs: number;
  cliTarget?: StoredCliTarget | null;
  transcriptPath?: string | null;
}): string[] {
  const { cwd, agentSessionId, toolIds, sinceMs } = options;
  if (toolIds.length === 0) return [];

  // Wherever Claude wrote it (a resumed conversation stays in the folder it
  // started in); synchronous, so the locator's peek, which never scans.
  const place = placeFromStored(options.cliTarget);
  const filePath = peekClaudeTranscriptFile({ agentSessionId, cwd, place, reportedPath: options.transcriptPath });
  const subagentDirectory = locateClaudeSubagentDir(agentSessionId, cwd, place, options.transcriptPath);
  const lines = [filePath, ...subagentTranscriptsWrittenSince(subagentDirectory, sinceMs)]
    .flatMap((transcript) => readTailLinesSync(transcript) ?? []);
  if (lines.length === 0) return [];

  const tracked = new Set(toolIds);
  const rejected = new Set<string>();
  const settledBy = Date.now() - HOOK_SETTLE_MS;

  for (const line of lines) {
    if (line.length === 0) continue;
    // Cheap pre-filter before paying for JSON.parse: skip any line that
    // doesn't even mention one of the tracked ids.
    let mentionsTracked = false;
    for (const toolId of tracked) {
      if (line.includes(toolId)) {
        mentionsTracked = true;
        break;
      }
    }
    if (!mentionsTracked) continue;

    let raw: unknown;
    try {
      raw = JSON.parse(line);
    } catch {
      continue;
    }
    if (!isRecord(raw)) continue;
    if (raw.type !== 'user') continue;
    const stampedAt = parseTimestamp(raw.timestamp);
    if (stampedAt < sinceMs || stampedAt > settledBy) continue;

    const message = raw.message;
    if (!isRecord(message)) continue;
    const messageContent = message.content;
    if (!Array.isArray(messageContent)) continue;

    for (const block of messageContent) {
      if (!isRecord(block)) continue;
      if (block.type !== 'tool_result') continue;
      const toolUseId = block.tool_use_id;
      if (typeof toolUseId !== 'string' || !tracked.has(toolUseId)) continue;
      if (block.is_error !== true) continue;
      rejected.add(toolUseId);
    }
  }

  return Array.from(rejected);
}
