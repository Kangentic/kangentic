import fs from 'node:fs';
import type { SubmissionVerifier } from '../../../../shared/types';
import {
  createSubmittedTextSubmissionVerifier,
  type UserTurnRecord,
} from '../../shared/submitted-text-verifier';
import { findSessionWireFile } from './session-history-parser';
import { kimiSessionsRoot } from './work-dir-hash';

/**
 * Kimi's `command-injection` verifier. CONFIRM-ONLY.
 *
 * The record SHAPE below is read off real `wire.jsonl` captures (the pinned
 * fixtures under `tests/fixtures/kimi/`, and live files on disk), so parsing is
 * not guesswork. What is NOT known is Kimi's flush LATENCY: the measurement
 * harness could never reach a usable TUI on the development machine, so
 * `scripts/measure-injection-flush.mjs` has no number for it.
 *
 * That is exactly why `KimiAdapter.canEscalateOnVerificationFailure()` returns
 * false. This verifier confirms deliveries and drives retry-on-Enter - both
 * pure upside - but never authorizes the session restart that escalation
 * performs, because a false negative here would be a guess and that restart
 * destroys live work.
 *
 * Graduating it takes both halves of the recipe in `docs/command-injection.md`:
 * the harness against an authenticated Kimi session for the timing, AND the
 * in-app mock run proving THIS resolver finds THAT record. Do not drop the
 * override merely because these tests pass; they cover the shape, which was
 * never the risky part.
 */

const resolvedWirePaths = new Map<string, string>();

/** Reset between tests so one test's memoised path cannot answer another's. */
export function clearKimiWirePathCache(): void {
  resolvedWirePaths.clear();
}

/**
 * Synchronously resolve `wire.jsonl` for a session.
 *
 * `KimiSessionHistoryParser.locate` cannot be reused: it polls 10 x 500ms,
 * which is longer than the entire verify window it would run inside. This
 * reuses the same `findSessionWireFile` scan and memoises the hit, because the
 * work-dir hash is upstream-internal and cannot be derived reliably enough to
 * skip the scan.
 */
export function resolveKimiWirePath(agentSessionId: string): string | null {
  const memoised = resolvedWirePaths.get(agentSessionId);
  if (memoised && fs.existsSync(memoised)) return memoised;
  if (memoised) resolvedWirePaths.delete(agentSessionId);

  const found = findSessionWireFile(kimiSessionsRoot(), agentSessionId);
  if (found) resolvedWirePaths.set(agentSessionId, found);
  return found;
}

/**
 * Extract a user turn from one `wire.jsonl` line.
 *
 * Shape from a real capture:
 *   {"timestamp":1777232808.515,
 *    "message":{"type":"TurnBegin","payload":{"user_input":"..."}}}
 *
 * Two things bite here:
 *   - `timestamp` is unix SECONDS as a float, not milliseconds. Passing it
 *     through unscaled would put every record ~56 years before `sentAt`, so the
 *     watermark would reject all of them and the verifier would never confirm.
 *   - `user_input` is either a string or an array of content parts.
 *
 * `SteerInput` is accepted alongside `TurnBegin`: it is how input sent while a
 * turn is already running is recorded, which is precisely the `immediate`
 * auto_command delivery mode.
 */
export function extractKimiUserTurn(line: string): UserTurnRecord | null {
  const trimmed = line.trim();
  if (!trimmed || !trimmed.startsWith('{')) return null;

  const entry: unknown = JSON.parse(trimmed);
  if (!entry || typeof entry !== 'object') return null;

  const record = entry as {
    timestamp?: unknown;
    message?: { type?: unknown; payload?: { user_input?: unknown } };
  };

  const message = record.message;
  if (!message || typeof message !== 'object') return null;
  if (message.type !== 'TurnBegin' && message.type !== 'SteerInput') return null;

  const userInput = message.payload?.user_input;
  let text: string | null = null;
  if (typeof userInput === 'string') {
    text = userInput;
  } else if (Array.isArray(userInput)) {
    const parts: string[] = [];
    for (const part of userInput) {
      if (typeof part === 'string') {
        parts.push(part);
      } else if (part && typeof part === 'object') {
        const candidate = (part as { text?: unknown }).text;
        if (typeof candidate === 'string') parts.push(candidate);
      }
    }
    text = parts.join('');
  }
  if (text === null) return null;

  // Seconds -> milliseconds.
  const timestampMs = typeof record.timestamp === 'number'
    ? Math.round(record.timestamp * 1000)
    : NaN;

  return {
    timestampMs: Number.isNaN(timestampMs) ? null : timestampMs,
    text,
  };
}

export function createKimiCommandInjectionVerifier(): SubmissionVerifier {
  return createSubmittedTextSubmissionVerifier({
    resolvePath: (agentSessionId) => resolveKimiWirePath(agentSessionId),
    extractUserTurn: extractKimiUserTurn,
  });
}
