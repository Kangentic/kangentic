import fs from 'node:fs';
import type { SubmissionVerifier } from '../../../../shared/types';
import {
  createSubmittedTextSubmissionVerifier,
  type UserTurnRecord,
} from '../../shared/submitted-text-verifier';
import {
  codexSessionsDirForToday,
  codexSessionsDirForYesterday,
  findMatchingFile,
} from './session-history-parser';

/**
 * Codex's `command-injection` verifier.
 *
 * MEASURED, NOT ASSUMED (scripts/measure-injection-flush.mjs, 2026-08-08):
 *   short prompt: 64ms, 108ms      (turn ~1.2-1.3s)
 *   long prompt:  62ms, 61ms       (turn ~4.4-4.6s)
 * Append latency is flat against a turn that runs 70x longer, which is the
 * discriminator: Codex writes the user turn on SUBMIT, not on turn-end. Worst
 * observed 108ms, comfortably inside the ~400ms verify window.
 *
 * The read-only pre-screen agreed before any quota was spent: across 114
 * rollout files on a real machine, five ended in a TORN JSON line and one ended
 * mid-turn on `exec_command_end`. A truncated final line is only possible if
 * the process died mid-append, which rules out a turn-end buffer flush.
 */

/**
 * Resolved rollout paths, keyed by agent session id.
 *
 * PERSISTENT ON PURPOSE, and deliberately not the one-shot pattern Gemini's
 * `discoveredSessionPaths` uses (it deletes on read). The verifier is rebuilt
 * once per poll at 25ms, so a cache that self-destructs on first read would
 * force a fresh `readdirSync` of the whole day's sessions directory ~40 times a
 * second in the MAIN process.
 *
 * Entries are revalidated with `existsSync` before use, so a stale path cannot
 * outlive its file.
 */
const resolvedRolloutPaths = new Map<string, string>();

/** Reset between tests so one test's memoised path cannot answer another's. */
export function clearCodexRolloutPathCache(): void {
  resolvedRolloutPaths.clear();
}

/**
 * Synchronously resolve the rollout file for a session id.
 *
 * MUST stay synchronous and cheap. `CodexSessionHistoryParser.locate` cannot be
 * reused here: it polls 10 x 500ms, which is longer than the entire verify
 * window it would be called inside, and it re-scans on every attempt with no
 * cache at all.
 *
 * Codex writes `rollout-<ISO-timestamp>-<sessionUUID>.jsonl` under a UTC-dated
 * directory. The timestamp prefix is unknown, so the first resolution scans;
 * afterwards the memo answers. The yesterday fallback covers a session that
 * spans a UTC date rollover.
 */
export function resolveCodexRolloutPath(agentSessionId: string): string | null {
  const memoised = resolvedRolloutPaths.get(agentSessionId);
  if (memoised && fs.existsSync(memoised)) return memoised;
  // Evict by KEY (the session id), not by the path value - deleting the path
  // would never match a key and would silently leave the stale entry behind.
  if (memoised) resolvedRolloutPaths.delete(agentSessionId);

  const escapedId = agentSessionId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(`^rollout-.*-${escapedId}\\.jsonl$`);

  for (const directory of [codexSessionsDirForToday(), codexSessionsDirForYesterday()]) {
    const found = findMatchingFile(directory, pattern);
    if (found) {
      resolvedRolloutPaths.set(agentSessionId, found);
      return found;
    }
  }
  return null;
}

/**
 * Extract a user turn from one rollout JSONL line.
 *
 * The shape was read off a live capture rather than assumed:
 *   {"timestamp":"2026-08-08T16:35:31.811Z","type":"response_item",
 *    "payload":{"type":"message","role":"user",
 *               "content":[{"type":"input_text","text":"..."}]}}
 *
 * Codex 0.118+ also emits an `event_msg` / `user_message` record for the same
 * turn. Both are accepted: whichever the running version writes, the exact-match
 * scan gives the same answer.
 *
 * Synthetic priming turns (`<environment_context>`, `<user_instructions>`) carry
 * `role: 'user'` too. They are skipped for the same reason
 * `codex/transcript-parser.ts` skips them - they are not something the user
 * submitted. Exact matching would reject them anyway; skipping is just cheaper
 * and states the intent.
 */
export function extractCodexUserTurn(line: string): UserTurnRecord | null {
  const trimmed = line.trim();
  if (!trimmed || !trimmed.startsWith('{')) return null;

  const entry: unknown = JSON.parse(trimmed);
  if (!entry || typeof entry !== 'object') return null;

  const record = entry as {
    timestamp?: unknown;
    type?: unknown;
    payload?: {
      type?: unknown;
      role?: unknown;
      message?: unknown;
      content?: unknown;
    };
  };

  const payload = record.payload;
  if (!payload || typeof payload !== 'object') return null;

  let text: string | null = null;

  if (record.type === 'response_item' && payload.type === 'message' && payload.role === 'user') {
    if (Array.isArray(payload.content)) {
      const parts: string[] = [];
      for (const block of payload.content) {
        if (block && typeof block === 'object') {
          const candidate = (block as { text?: unknown }).text;
          if (typeof candidate === 'string') parts.push(candidate);
        }
      }
      text = parts.join('');
    } else if (typeof payload.content === 'string') {
      text = payload.content;
    }
  } else if (record.type === 'event_msg' && payload.type === 'user_message') {
    if (typeof payload.message === 'string') text = payload.message;
  }

  if (text === null) return null;
  if (text.startsWith('<environment_context>') || text.startsWith('<user_instructions>')) {
    return null;
  }

  const timestampMs = typeof record.timestamp === 'string'
    ? Date.parse(record.timestamp)
    : NaN;

  return {
    timestampMs: Number.isNaN(timestampMs) ? null : timestampMs,
    text,
  };
}

/**
 * Build the verifier, or `null` when this adapter cannot verify the command.
 *
 * SLASH COMMANDS ARE DELIBERATELY NOT VERIFIED. The same measurement run showed
 * an unregistered `/...` never reaches the rollout file at all: Codex handles
 * slash input in the TUI. Returning `false` for one would exhaust the retries,
 * report `failed`, and escalate to a session RESTART that destroys live work -
 * on an agent that may well have accepted the command. Declining to verify
 * leaves the outcome `unconfirmed`, which is the honest answer and is
 * non-destructive by design.
 */
export function createCodexCommandInjectionVerifier(): SubmissionVerifier {
  return createSubmittedTextSubmissionVerifier({
    resolvePath: (agentSessionId) => resolveCodexRolloutPath(agentSessionId),
    extractUserTurn: extractCodexUserTurn,
  });
}
