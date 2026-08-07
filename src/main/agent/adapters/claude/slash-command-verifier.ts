import fs from 'node:fs/promises';
import type { CommandVerifier, InjectionVerifyMode } from '../../../transition-engine/terminal-submit-scheduler';

/**
 * Builds a verifier that polls Claude's session JSONL for confirmation that
 * a slash command (e.g. `/model X`, `/effort Y`) was actually processed by
 * the TUI - not just written to the PTY.
 *
 * Why this exists: when commands are chained (e.g. `/model` followed by
 * `/effort`), occasionally the Enter for the first command fails to submit
 * (autocomplete still showing, model picker overlay open, render frame
 * skipped, etc.). The next command's text then concatenates into the same
 * prompt buffer, and Claude records a single combined entry like
 * `<command-args>claude-opus-4-7\n/effort xhigh</command-args>` - a "model
 * not found" failure that silently leaves the column's intended settings
 * unapplied. Time-based settles cannot detect this because the writes did
 * succeed; only the input semantics broke.
 *
 * The JSONL is the only authoritative signal for "Claude saw the command
 * and processed it as the discrete invocation we intended."
 *
 * Match strategy: each successful slash invocation writes a `local_command`
 * system entry whose `<command-name>` matches the slash and whose
 * `<command-args>` matches exactly what we sent (single line, no embedded
 * `/`-prefix from the next command). We require both; a combined-args entry
 * is treated as a non-match so the burst can retry-Enter and recover.
 */
/**
 * Alias of `InjectionVerifyMode`, deliberately not a copy of its members. The
 * mode this verifier receives IS the injection layer's mode, so redeclaring
 * the union would create two identical types that assign freely and drift
 * silently. `none` is unverifiable by definition.
 */
export type SlashVerifyMode = InjectionVerifyMode;

export interface SlashVerifierOptions {
  /**
   * If set, the verifier polls internally for up to `timeoutMs` before
   * returning false (legacy single-call semantics). When unset (default),
   * the verifier performs a single immediate scan and returns - the caller
   * (TerminalSubmit.pollWithRetries) drives the polling cadence.
   */
  timeoutMs?: number;
  /** Polling interval used only when timeoutMs is set. Default 25ms. */
  pollIntervalMs?: number;
}

/**
 * Build a verifier bound to one session's JSONL transcript.
 * Returns null if the path is empty so callers can fall back to time-based
 * settle without branching at every call site.
 */
export function createSlashCommandVerifier(
  jsonlPath: string | null,
  options: SlashVerifierOptions = {},
): CommandVerifier | null {
  if (!jsonlPath) return null;
  const internalTimeout = options.timeoutMs;
  const pollIntervalMs = options.pollIntervalMs ?? 25;

  return async function verify(
    command: string,
    sentAt: number,
    mode: SlashVerifyMode = 'command-match',
  ): Promise<boolean> {
    // Never report an unverifiable command as confirmed.
    if (mode === 'none') return false;
    if (mode === 'submitted') {
      // A user-supplied auto_command. We cannot require it to parse as a
      // registered slash command: it may be plain prose, or a `/foo` this
      // project does not define, and Claude only treats a LEADING slash as a
      // command anyway. The question that IS answerable, and the one that
      // matters, is whether exactly this text became a user turn.
      return scanForSubmittedText(jsonlPath, command, sentAt);
    }
    const parsed = parseSlashCommand(command);
    if (!parsed) return true; // Non-slash text: no JSONL signal expected.
    // sentAt is the timestamp of the Enter the caller is asking us to confirm
    // (passed through from `pollWithRetries`, advanced on each retry-Enter).
    // Bounding the JSONL scan to entries at-or-after `sentAt - tolerance`
    // prevents stale entries from earlier retries / earlier columns from being
    // treated as confirmation for the current command.
    if (internalTimeout === undefined) {
      // Single-scan mode: caller controls the polling cadence. Returning
      // immediately keeps verification latency tied to file-flush latency
      // (typically < 50ms after the Enter lands) instead of fixed sleeps.
      return scanForMatch(jsonlPath, parsed.name, parsed.args, sentAt);
    }
    const deadline = Date.now() + internalTimeout;
    while (Date.now() < deadline) {
      if (await scanForMatch(jsonlPath, parsed.name, parsed.args, sentAt)) {
        return true;
      }
      await wait(pollIntervalMs);
    }
    return false;
  };
}

/** "/model claude-opus-4-7" -> { name: "/model", args: "claude-opus-4-7" } */
function parseSlashCommand(command: string): { name: string; args: string } | null {
  if (!command.startsWith('/')) return null;
  const trimmed = command.trim();
  const spaceIndex = trimmed.indexOf(' ');
  if (spaceIndex === -1) return { name: trimmed, args: '' };
  return {
    name: trimmed.slice(0, spaceIndex),
    args: trimmed.slice(spaceIndex + 1).trim(),
  };
}

/**
 * Bytes read from the end of the transcript.
 *
 * The scan walks backwards and stops at the `sentAt` watermark, so it only ever
 * needs entries written in the last few hundred milliseconds. Reading the whole
 * file to look at its tail is what made verification expensive: a long session's
 * JSONL is multiple megabytes, and `pollForConfirmation` asks every 25ms.
 */
const TAIL_BYTES = 256 * 1024;

/**
 * Parsed tail, keyed by path and invalidated by (size, mtime).
 *
 * Verification polls at 25ms for up to ~2s per command, but the agent writes to
 * the transcript far less often than that, so the overwhelming majority of
 * polls would re-read and re-split bytes that have not changed. A `stat` costs
 * microseconds against a read plus a `split()` over tens of thousands of lines.
 *
 * Cached by CONTENT IDENTITY rather than by query result, which keeps it safe
 * for any (command, sentAt) pair: identical bytes always parse to identical
 * lines, so a later poll for a different command reuses the array without
 * inheriting an answer.
 *
 * This matters most in bursts. Injection concurrency is per task, so dragging
 * several tasks into a column at once starts several poll loops, each of which
 * was independently re-reading a multi-megabyte file 40 times a second in the
 * MAIN process, where the cost lands on IPC and therefore on the UI.
 *
 * MODULE-GLOBAL ON PURPOSE. It cannot be scoped to the verifier closure:
 * `ClaudeAdapter.getSubmissionVerifier` calls `createSlashCommandVerifier`
 * once per POLL (the transcript path is derived from a session id that is
 * re-resolved each time, to survive a mid-burst `/clear` fork), so a
 * closure-local cache would be rebuilt 40 times a second and never hit.
 *
 * EVICTION IS LRU, NOT CLEAR-ALL, and that distinction is the whole point in
 * the case this exists for. A clear-all on overflow degenerates precisely
 * under burst: with more concurrent transcripts than slots, each insert wipes
 * every other burst's entry, they all miss on their next poll, re-read, and
 * evict each other again - turning the cache into pure overhead at exactly
 * the concurrency where it is needed. Least-recently-used eviction keeps every
 * actively-polling burst resident and ages out only finished ones.
 */
const TAIL_CACHE_LIMIT = 32;
const tailCache = new Map<string, { size: number; mtimeMs: number; lines: string[] }>();

/**
 * Mark `jsonlPath` most-recently-used and drop the oldest entries past the cap.
 * A Map iterates in insertion order, so delete-then-set moves an entry to the
 * end and `keys().next()` yields the least recently used.
 *
 * The cap is sized against CONCURRENT TRANSCRIPTS, not tasks: the `/clear`-fork
 * fallback in `buildCommandInjectionVerifier` scans two paths per poll (the
 * re-resolved id, then the one captured at plan-build time), so a forked
 * session occupies two slots. 32 leaves room for well past any realistic
 * simultaneous drag. Entries self-invalidate on `(size, mtime)`, so the only
 * cost of a larger bound is retained bytes: at most `TAIL_BYTES` per entry, and
 * far less for the short transcripts a fresh session has.
 */
function touchCacheEntry(jsonlPath: string, entry: { size: number; mtimeMs: number; lines: string[] }): void {
  tailCache.delete(jsonlPath);
  tailCache.set(jsonlPath, entry);
  while (tailCache.size > TAIL_CACHE_LIMIT) {
    const leastRecent = tailCache.keys().next();
    if (leastRecent.done) break;
    tailCache.delete(leastRecent.value);
  }
}

/** Reset between tests so one test's cached tail cannot answer another's poll. */
export function clearTranscriptTailCache(): void {
  tailCache.clear();
}

async function readTranscriptTailLines(jsonlPath: string): Promise<string[] | null> {
  let stats: Awaited<ReturnType<typeof fs.stat>>;
  try {
    stats = await fs.stat(jsonlPath);
  } catch {
    return null;
  }

  const cached = tailCache.get(jsonlPath);
  if (cached && cached.size === stats.size && cached.mtimeMs === stats.mtimeMs) {
    // A hit is a use: re-stamp it so a burst that keeps polling never ages out
    // behind bursts that merely started later.
    touchCacheEntry(jsonlPath, cached);
    return cached.lines;
  }

  let content: string;
  try {
    if (stats.size <= TAIL_BYTES) {
      content = await fs.readFile(jsonlPath, 'utf-8');
    } else {
      const handle = await fs.open(jsonlPath, 'r');
      try {
        const buffer = Buffer.alloc(TAIL_BYTES);
        const { bytesRead } = await handle.read(buffer, 0, TAIL_BYTES, stats.size - TAIL_BYTES);
        // The window starts mid-line, and possibly mid-UTF-8-sequence. Dropping
        // everything before the first newline discards both, and costs nothing:
        // a truncated leading entry could not have parsed anyway.
        const raw = buffer.subarray(0, bytesRead).toString('utf-8');
        const firstNewline = raw.indexOf('\n');
        content = firstNewline === -1 ? '' : raw.slice(firstNewline + 1);
      } finally {
        await handle.close();
      }
    }
  } catch {
    return null;
  }

  const lines = content.split(/\r?\n/);
  touchCacheEntry(jsonlPath, { size: stats.size, mtimeMs: stats.mtimeMs, lines });
  return lines;
}

async function scanForMatch(
  jsonlPath: string,
  commandName: string,
  expectedArgs: string,
  sentAt: number,
): Promise<boolean> {
  // Scan from the tail backwards. We expect the matching entry to be near
  // the end of the file (just-written), and we can stop as soon as we cross
  // the sentAt watermark.
  const lines = await readTranscriptTailLines(jsonlPath);
  if (lines === null) return false;
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (!line) continue;
    let entry: unknown;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (!isRecord(entry)) continue;

    const ts = parseTimestamp(entry.timestamp);
    if (ts !== null && ts < sentAt - 50) {
      // 50ms tolerance: the system clock may differ by a hair from
      // performance.now-derived sentAt. Anything substantially older
      // than our send means we've scanned past our window - stop.
      return false;
    }

    const commandTagContent = extractCommandTagContent(entry);
    if (!commandTagContent) continue;

    // Require BOTH the command name and an exact-match args body. Combined
    // args (e.g. "claude-opus-4-7\n/effort xhigh") fail this check by
    // design - that is the failure mode we want to detect and retry.
    if (commandTagContent.name !== commandName) continue;
    if (commandTagContent.args !== expectedArgs) continue;
    return true;
  }
  return false;
}

/**
 * Confirm that EXACTLY `command` became a user turn at or after `sentAt`.
 *
 * Exactness is the entire point. The reported bug submits
 * `instead can we/pull-request` as one message, and that string CONTAINS
 * `/pull-request` - a substring test would confirm the precise failure this
 * verifier exists to catch as a successful delivery.
 *
 * Two shapes count as the same submission:
 *   1. the raw user text equals the command (plain prose, or a `/foo` Claude
 *      did not recognize and therefore left as literal text);
 *   2. the entry was rewritten into `<command-name>` / `<command-args>` tags
 *      because Claude DID recognize it, in which case `/name args`
 *      reconstructs what the user typed.
 */
async function scanForSubmittedText(
  jsonlPath: string,
  command: string,
  sentAt: number,
): Promise<boolean> {
  const lines = await readTranscriptTailLines(jsonlPath);
  if (lines === null) return false;
  const expected = command.trim();
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (!line) continue;
    let entry: unknown;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (!isRecord(entry)) continue;

    const ts = parseTimestamp(entry.timestamp);
    if (ts !== null && ts < sentAt - 50) return false;

    const tagged = extractCommandTagContent(entry);
    if (tagged) {
      const reconstructed = tagged.args ? `${tagged.name} ${tagged.args}` : tagged.name;
      if (reconstructed.trim() === expected) return true;
      // A recognized command whose tags do not reconstruct to what we sent is
      // a DIFFERENT submission (the combined-args concatenation case). Keep
      // scanning rather than accepting it.
      continue;
    }

    const userText = extractUserText(entry);
    if (userText !== null && userText.trim() === expected) return true;
  }
  return false;
}

/**
 * Raw text of a user-turn entry. `message.content` is a string for simple
 * turns and an array of content blocks for richer ones; only the latter shape
 * appears once attachments or tool results are involved, and the current
 * command-tag extractor handles only the string form.
 */
function extractUserText(entry: Record<string, unknown>): string | null {
  if (entry.type !== 'user') return null;
  const message = entry.message;
  if (!isRecord(message)) return null;
  const content = message.content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return null;
  const parts: string[] = [];
  for (const block of content) {
    if (!isRecord(block)) continue;
    if (block.type !== 'text') continue;
    if (typeof block.text === 'string') parts.push(block.text);
  }
  return parts.length > 0 ? parts.join('') : null;
}

/**
 * Extract `<command-name>` and `<command-args>` from a JSONL entry, regardless
 * of whether it is a `system/local_command` entry (top-level `content` string)
 * or a `user` entry (`message.content` string). Returns null if the entry has
 * no recognizable command tags.
 */
function extractCommandTagContent(entry: Record<string, unknown>): { name: string; args: string } | null {
  const candidates: string[] = [];
  if (typeof entry.content === 'string') candidates.push(entry.content);
  const message = entry.message;
  if (isRecord(message) && typeof message.content === 'string') candidates.push(message.content);
  for (const text of candidates) {
    const nameMatch = /<command-name>([^<]*)<\/command-name>/.exec(text);
    const argsMatch = /<command-args>([\s\S]*?)<\/command-args>/.exec(text);
    if (nameMatch) {
      return {
        name: nameMatch[1].trim(),
        args: argsMatch ? argsMatch[1].trim() : '',
      };
    }
  }
  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseTimestamp(value: unknown): number | null {
  if (typeof value !== 'string') return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
