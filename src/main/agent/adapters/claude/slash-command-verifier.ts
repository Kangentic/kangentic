import fs from 'node:fs/promises';
import type { CommandVerifier } from '../../../transition-engine/terminal-submit-scheduler';

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

  return async function verify(command: string, sentAt: number): Promise<boolean> {
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

async function scanForMatch(
  jsonlPath: string,
  commandName: string,
  expectedArgs: string,
  sentAt: number,
): Promise<boolean> {
  let content: string;
  try {
    content = await fs.readFile(jsonlPath, 'utf-8');
  } catch {
    return false;
  }
  // Scan from the tail backwards. We expect the matching entry to be near
  // the end of the file (just-written), and we can stop as soon as we cross
  // the sentAt watermark.
  const lines = content.split(/\r?\n/);
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
