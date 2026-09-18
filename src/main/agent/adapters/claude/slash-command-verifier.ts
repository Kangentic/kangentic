import path from 'node:path';
import type { CommandVerifier, InjectionVerifyMode } from '../../../transition-engine/terminal-submit-scheduler';
import { readTranscriptTailLines } from '../../shared/transcript-tail-cache';

/**
 * Re-exported so existing callers and tests keep importing the reset helper
 * from here. The cache itself is shared across every adapter's verifier and
 * lives in `shared/transcript-tail-cache.ts`; it MUST stay a single
 * module-global instance, so never construct a second one.
 */
export { clearTranscriptTailCache } from '../../shared/transcript-tail-cache';

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
    // sentAt is the timestamp of the FIRST Enter pressed for this command.
    // `submitKeystrokes` keeps it fixed across its retry-Enters: a later
    // attempt confirming an earlier attempt's submission is the right answer,
    // and advancing the watermark per retry made every later attempt blind to
    // the first one's entry once a newer sibling (an attachment, a pr-link)
    // sat between it and the tail. Bounding the scan to entries at-or-after
    // `sentAt - tolerance` is what keeps an earlier column's invocation from
    // confirming this one.
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

// The bounded tail read and its LRU content-identity cache moved to
// `src/main/agent/shared/transcript-tail-cache.ts` so every adapter's verifier
// shares ONE cache instance. Claude-specific record parsing stays below.

/**
 * 50ms tolerance on the watermark: the system clock may differ by a hair from
 * the `Date.now()` the Enter was stamped with. Anything substantially older
 * than the first Enter is an earlier column's or an earlier session's entry.
 */
const WATERMARK_TOLERANCE_MS = 50;

/** Decides whether one parsed tail entry is the submission being verified. */
type EntryMatcher = (entry: Record<string, unknown>) => boolean;

/**
 * Walk the transcript tail backwards, newest entry first, and stop at the
 * first entry older than the watermark. Both modes share this walk so the
 * watermark rule and the miss diagnostic cannot drift between them; only the
 * per-entry matcher differs.
 *
 * Every `false` return is described to the log through `logScanMiss` (rate
 * limited). The two incidents that motivated the diagnostic were
 * indistinguishable from the "unconfirmed after 5 attempts" line alone: one
 * was a transcript that had not flushed yet, the other a scan that stopped on
 * a newer sibling before reaching the entry. The `newest` and `stop` fields
 * tell those apart at a glance.
 */
async function scanTail(
  jsonlPath: string,
  command: string,
  sentAt: number,
  matches: EntryMatcher,
): Promise<boolean> {
  const watermark = sentAt - WATERMARK_TOLERANCE_MS;
  const lines = await readTranscriptTailLines(jsonlPath);
  if (lines === null) {
    logScanMiss(jsonlPath, command, watermark, { stop: 'unreadable', newestTs: null, scanned: 0 });
    return false;
  }
  let newestTs: number | null = null;
  let scanned = 0;
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
    scanned++;

    const ts = parseTimestamp(entry.timestamp);
    // The first timestamped entry met from the tail is the newest one on disk.
    if (ts !== null && newestTs === null) newestTs = ts;
    if (ts !== null && ts < watermark) {
      logScanMiss(jsonlPath, command, watermark, {
        stop: 'watermark',
        stopEntry: describeEntry(entry),
        stopEntryTs: ts,
        newestTs,
        scanned,
      });
      return false;
    }

    if (matches(entry)) return true;
  }
  logScanMiss(jsonlPath, command, watermark, { stop: 'exhausted', newestTs, scanned });
  return false;
}

/**
 * `command-match`: a discrete `<command-name>` / `<command-args>` invocation
 * with exactly these args. Combined args (e.g. "claude-opus-4-7\n/effort
 * xhigh") fail this check by design - that is the failure mode we want to
 * detect and retry. A queued submission is deliberately NOT accepted here:
 * this mode exists for the adapter's own settings writes, and "the CLI took
 * the text" says nothing about whether it parsed as the discrete invocation
 * the args must prove.
 */
async function scanForMatch(
  jsonlPath: string,
  commandName: string,
  expectedArgs: string,
  sentAt: number,
): Promise<boolean> {
  const command = expectedArgs ? `${commandName} ${expectedArgs}` : commandName;
  return scanTail(jsonlPath, command, sentAt, (entry) => {
    const commandTagContent = extractCommandTagContent(entry);
    if (!commandTagContent) return false;
    return commandTagContent.name === commandName && commandTagContent.args === expectedArgs;
  });
}

/**
 * Confirm that EXACTLY `command` was submitted at or after `sentAt`.
 *
 * Exactness is the entire point. The reported bug submits
 * `instead can we/pull-request` as one message, and that string CONTAINS
 * `/pull-request` - a substring test would confirm the precise failure this
 * verifier exists to catch as a successful delivery.
 *
 * Three shapes count as the same submission:
 *   1. the raw user text equals the command (plain prose, or a `/foo` Claude
 *      did not recognize and therefore left as literal text);
 *   2. the entry was rewritten into `<command-name>` / `<command-args>` tags
 *      because Claude DID recognize it, in which case `/name args`
 *      reconstructs what the user typed;
 *   3. a `queue-operation` `enqueue` whose `content` equals the command. Text
 *      submitted while a turn is running is QUEUED by the CLI: the enqueue
 *      entry is written at once, and the user turn only when the queue drains
 *      at the end of the running turn, which can be minutes later. From the
 *      enqueue on the CLI owns the text (it dequeues it as the next turn or
 *      absorbs it mid-turn), so keystroke delivery is complete and every
 *      further Enter is a no-op. Without this shape a mid-turn injection could
 *      never confirm inside the retry budget, and the escalation restart then
 *      ran the command a second time (#682). A queued message the user pulls
 *      back with Up arrow inside the burst would read as delivered; that is
 *      their own action within a two-second window and is not modelled.
 */
async function scanForSubmittedText(
  jsonlPath: string,
  command: string,
  sentAt: number,
): Promise<boolean> {
  const expected = command.trim();
  return scanTail(jsonlPath, command, sentAt, (entry) => {
    const queued = extractQueuedText(entry);
    if (queued !== null) return queued.trim() === expected;

    const tagged = extractCommandTagContent(entry);
    if (tagged) {
      const reconstructed = tagged.args ? `${tagged.name} ${tagged.args}` : tagged.name;
      // A recognized command whose tags do not reconstruct to what we sent is
      // a DIFFERENT submission (the combined-args concatenation case). Keep
      // scanning rather than accepting it.
      return reconstructed.trim() === expected;
    }

    const userText = extractUserText(entry);
    return userText !== null && userText.trim() === expected;
  });
}

/**
 * Text the CLI accepted into its message queue, or null for any other entry.
 * Only `enqueue` carries delivery meaning; `dequeue` and `remove` describe
 * what happened to a message already accepted.
 */
function extractQueuedText(entry: Record<string, unknown>): string | null {
  if (entry.type !== 'queue-operation') return null;
  if (entry.operation !== 'enqueue') return null;
  return typeof entry.content === 'string' ? entry.content : null;
}

/** Why one scan returned false. */
interface ScanMiss {
  stop: 'watermark' | 'exhausted' | 'unreadable';
  /** The entry the watermark check stopped on (`stop === 'watermark'`). */
  stopEntry?: string;
  stopEntryTs?: number;
  /** Newest top-level timestamp on disk, whatever that entry was. */
  newestTs: number | null;
  /** Entries parsed before the walk ended. */
  scanned: number;
}

/**
 * At most one miss line per `(transcript, command)` per interval. The poll
 * cadence is 25ms, so an unthrottled line per miss would be 40 lines a second
 * per in-flight command; a burst that confirms on its first poll logs nothing.
 *
 * Two tiers. The burst itself (about four seconds of polling) gets the tight
 * interval, which is where the diagnostic earns its keep: the first few lines
 * say whether the transcript had flushed yet and what the walk stopped on.
 * Past `MISS_LOG_TIGHT_LINES` lines for one key the command has left the
 * burst and is being re-checked by the escalation gate, a slow poll that can
 * run for two minutes on an unreadable transcript; a line every 500ms there
 * is 240 copies of the same fact, so the interval widens.
 */
const MISS_LOG_INTERVAL_MS = 500;
const MISS_LOG_SLOW_INTERVAL_MS = 5_000;
const MISS_LOG_TIGHT_LINES = 10;
const MISS_LOG_KEY_TTL_MS = 60_000;
const missLogState = new Map<string, { loggedAt: number; lines: number }>();

function logScanMiss(jsonlPath: string, command: string, watermark: number, miss: ScanMiss): void {
  const key = `${jsonlPath}\n${command}`;
  const now = Date.now();
  const previous = missLogState.get(key);
  const interval = previous && previous.lines >= MISS_LOG_TIGHT_LINES ? MISS_LOG_SLOW_INTERVAL_MS : MISS_LOG_INTERVAL_MS;
  if (previous !== undefined && now - previous.loggedAt < interval) return;
  missLogState.set(key, { loggedAt: now, lines: (previous?.lines ?? 0) + 1 });
  for (const [staleKey, state] of missLogState) {
    if (now - state.loggedAt > MISS_LOG_KEY_TTL_MS) missLogState.delete(staleKey);
  }
  const stop = miss.stop === 'watermark'
    ? `watermark (${miss.stopEntry ?? '?'} @ ${formatIso(miss.stopEntryTs)})`
    : miss.stop;
  console.log(
    `[slash-verifier] "${command}" not yet in ${path.basename(jsonlPath)}: stop=${stop}, `
      + `watermark=${formatIso(watermark)}, newest=${formatIso(miss.newestTs)}, scanned=${miss.scanned}`,
  );
}

/** `type/subtype` (or `type/operation` for queue entries) for the miss line. */
function describeEntry(entry: Record<string, unknown>): string {
  const type = typeof entry.type === 'string' ? entry.type : '?';
  const qualifier = typeof entry.subtype === 'string'
    ? entry.subtype
    : typeof entry.operation === 'string' ? entry.operation : null;
  return qualifier ? `${type}/${qualifier}` : type;
}

function formatIso(epochMs: number | null | undefined): string {
  if (epochMs === null || epochMs === undefined || !Number.isFinite(epochMs)) return 'none';
  return new Date(epochMs).toISOString();
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
