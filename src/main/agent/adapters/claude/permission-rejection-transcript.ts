import fs from 'node:fs';
import { locateClaudeTranscriptFile } from './transcript-parser';

/**
 * Definitive detection of a manually REJECTED permission prompt from Claude's
 * durable session transcript - a signal no hook can ever deliver.
 *
 * When a user denies a tool-use permission prompt at the TUI (or from a
 * paired phone via `answer-permission-prompt`), Claude Code does NOT
 * re-invoke the model: the turn aborts rather than ending, so `Stop` never
 * fires. `PostToolUse` fires only "after a tool call succeeds" (the denied
 * tool never ran), and `PermissionDenied` exists only for AUTO-MODE denials.
 * A manual deny therefore leaves NO hook event of any kind - the whole
 * reason `permissionPending` sticks forever without this drain (see
 * docs/activity-detection.md, "Permission flag").
 *
 * The rejection IS always appended to Claude's durable session JSONL, as a
 * synthetic `tool_result` user turn:
 *
 *   { "type": "tool_result", "is_error": true, "tool_use_id": "toolu_...",
 *     "content": "The user doesn't want to proceed with this tool use. ..." }
 *
 * Verified against real captured sessions to land AT DENY TIME (not batched
 * into the next user turn, which is 11+ seconds later in the captured
 * case) - the one fact this whole drain rests on.
 */

/**
 * Stable prefix of Claude's rejection message. Both observed content
 * variants (a plain deny, and a deny carrying the user's typed feedback)
 * share it verbatim; only the text after it differs.
 */
const REJECTION_PREFIX = "The user doesn't want to proceed with this tool use";

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

/** True when a `tool_result` block's `content` carries the rejection prefix,
 *  whether the SDK wrote it as a plain string (the observed shape) or as an
 *  array of content blocks. */
function contentStartsWithRejectionPrefix(content: unknown): boolean {
  if (typeof content === 'string') return content.startsWith(REJECTION_PREFIX);
  if (Array.isArray(content)) {
    // Check EVERY text block, not just the first: an SDK that splits the
    // result into a preamble block plus the rejection text would otherwise
    // be judged on the preamble alone and read as "not a rejection".
    for (const block of content) {
      if (isRecord(block) && block.type === 'text' && typeof block.text === 'string'
        && block.text.startsWith(REJECTION_PREFIX)) {
        return true;
      }
    }
  }
  return false;
}

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
 * skipping a mtime/size cache avoids a needless correctness hazard: two
 * back-to-back rewrites of the same size landing within one filesystem's
 * mtime resolution window could otherwise serve a stale tail. This is
 * unlike `background-shell-transcript.ts`'s forward-only byte CURSOR, which
 * exists to keep a much larger, per-cycle-shared consumer cheap and has no
 * such staleness mode (it only ever reads bytes newly appended past its own
 * cursor).
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
 * `AdapterRuntimeStrategy.permissionPrompts.reportRejectedPromptTools`
 * implementation for Claude. Scans the tail of the live session transcript
 * for a REJECTED `tool_result` (is_error + the stable rejection prefix)
 * matching one of the caller's `toolIds`, at or after `sinceMs`. Returns the
 * matched subset. Never throws.
 *
 * A bounded TAIL re-scan (not a forward-only byte cursor like the bg-shell
 * transcript drain in `background-shell-transcript.ts`) is deliberate: that
 * cursor anchors at EOF on its first call for a path, which is safe there
 * because a shell is asked about long before it could terminate. Here the
 * first call happens AFTER the prompt is already open, so an EOF anchor
 * would fall behind a denial landing inside the very first poll interval
 * and miss it forever.
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
}): string[] {
  const { cwd, agentSessionId, toolIds, sinceMs } = options;
  if (toolIds.length === 0) return [];

  const filePath = locateClaudeTranscriptFile(agentSessionId, cwd);
  const lines = readTailLinesSync(filePath);
  if (!lines || lines.length === 0) return [];

  const tracked = new Set(toolIds);
  const rejected = new Set<string>();

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
    if (parseTimestamp(raw.timestamp) < sinceMs) continue;

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
      if (!contentStartsWithRejectionPrefix(block.content)) continue;
      rejected.add(toolUseId);
    }
  }

  return Array.from(rejected);
}
