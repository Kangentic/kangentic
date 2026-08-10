import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { SubmissionContext, SubmissionVerifier } from '../../../../shared/types';

/**
 * Copilot's `command-injection` verifier. CONFIRM-ONLY.
 *
 * Confirm-only despite being the fastest measured adapter, because the harness
 * matched the probe nonce as a SUBSTRING while this verifier requires the whole
 * entry to trim-equal the submitted text, and no real capture of this file is
 * committed to pin the extractor against. See
 * `CopilotAdapter.canEscalateOnVerificationFailure`.
 *
 * MEASURED, NOT ASSUMED (scripts/measure-injection-flush.mjs, 2026-08-09):
 *   short prompt: 36ms, 37ms   (turn ~3.1s, ~12.3s)
 *   long prompt:  38ms, 37ms   (turn ~32.3s, ~23.3s)
 *   slash:        37ms, 53ms
 * The fastest of any adapter, and dead flat against a turn 850x longer, so the
 * write happens on SUBMIT. Slash commands ARE recorded, unlike Codex and
 * OpenCode, so no `canVerifySlashSubmission` opt-out is needed.
 *
 * The adapter previously declared "no history file". That was wrong: Copilot
 * keeps `~/.copilot/command-history-state.json`. It is not a transcript though,
 * and the differences drive everything below:
 *
 *   - GLOBAL. One file for every session and every project, not per-session.
 *   - NEWEST FIRST. `commandHistory[0]` is the most recent submission
 *     (verified against live probe data, not assumed).
 *   - NO timestamps and NO session id.
 *   - Rewritten in place rather than appended.
 *
 * So this does not use the shared submitted-text scan, which bounds itself with
 * a per-record `sentAt` watermark that does not exist here.
 */

/** Clock-skew tolerance, matching the shared scan. */
const SENT_AT_TOLERANCE_MS = 50;

/**
 * How many leading entries to accept a match from.
 *
 * Strictly `[0]` would be exact, but the file is GLOBAL: a second Kangentic
 * task injecting into its own Copilot session at the same moment writes to the
 * same array and pushes ours down. That is a routine board action, not an edge
 * case, and the failure it would cause is the expensive direction - a false
 * negative exhausts the retries and reports `failed`, which today is a notice
 * and would become a session restart the moment this adapter ever earns
 * escalation.
 *
 * A false POSITIVE, by contrast, only reports `confirmed` without proof and
 * takes no destructive action. Scanning a few leading entries therefore biases
 * the residual error toward the harmless side, and the mtime guard still bounds
 * how stale any of them can be. Keep this window when graduating the adapter:
 * it is what makes the graduation safe.
 */
const RECENT_ENTRY_LIMIT = 5;

/** Copilot's prompt history is global, so `cwd` and session id play no part. */
export function resolveCopilotHistoryPath(): string {
  return path.join(os.homedir(), '.copilot', 'command-history-state.json');
}

/**
 * Return the newest `RECENT_ENTRY_LIMIT` submissions, newest first, or null
 * when the file is missing or unparseable.
 */
export function readRecentCopilotCommands(raw: string): string[] | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // A partial write mid-flush; the caller keeps polling.
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const history = (parsed as { commandHistory?: unknown }).commandHistory;
  if (!Array.isArray(history)) return null;
  return history
    .filter((entry): entry is string => typeof entry === 'string')
    .slice(0, RECENT_ENTRY_LIMIT);
}

export function createCopilotCommandInjectionVerifier(): SubmissionVerifier {
  return async (context: SubmissionContext): Promise<boolean> => {
    if (context.type !== 'command-injection') return false;

    const filePath = resolveCopilotHistoryPath();
    const sentAt = context.sentAt ?? Date.now();

    // Guard 1: with no per-record timestamp, the FILE's mtime is the only
    // evidence that anything was written after we pressed Enter. A missing
    // file reads as "keep polling", never as a verified failure.
    let mtimeMs: number;
    try {
      mtimeMs = (await fs.stat(filePath)).mtimeMs;
    } catch {
      return false;
    }
    if (mtimeMs < sentAt - SENT_AT_TOLERANCE_MS) return false;

    let raw: string;
    try {
      raw = await fs.readFile(filePath, 'utf-8');
    } catch {
      return false;
    }

    const recent = readRecentCopilotCommands(raw);
    if (!recent) return false;

    // Guard 2: exact match, and only among the newest entries. Exactness is the
    // point - `instead can we/pull-request` CONTAINS `/pull-request`, so a
    // substring test would confirm the precise swallowed-Enter bug the verifier
    // exists to catch.
    const expected = context.text.trim();
    if (!expected) return false;
    return recent.some((entry) => entry.trim() === expected);
  };
}
