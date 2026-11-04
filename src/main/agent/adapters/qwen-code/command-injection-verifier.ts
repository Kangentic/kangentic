import path from 'node:path';
import type { SubmissionVerifier } from '../../../../shared/types';
import {
  createSubmittedTextSubmissionVerifier,
  type UserTurnRecord,
} from '../../shared/submitted-text-verifier';
import { qwenChatsDir } from './session-history-parser';
import type { CliPlace } from '../../shared/cli-target';

/**
 * Qwen's `command-injection` verifier. CONFIRM-ONLY.
 *
 * Confirm-only despite a clean measurement, because the path below is built
 * from a CAPTURED session id and this resolver has never run against a live
 * Qwen session inside the app. See
 * `QwenAdapter.canEscalateOnVerificationFailure`.
 *
 * MEASURED, NOT ASSUMED (scripts/measure-injection-flush.mjs, 2026-08-08),
 * scoped to `chats/<sessionId>.jsonl` - the file this verifier actually reads:
 *   short prompt: 443ms, 519ms   (turn ~3.0s)
 *   long prompt:  696ms          (turn ~13.5s)
 * Flat against a turn 4.5x longer, so the write happens on submit.
 *
 * MEASURE THE FILE THE VERIFIER READS. An unscoped first run reported 124-201ms
 * because the probe text lands in `~/.qwen/tmp/<hash>/logs.json` (a prompt log)
 * long before the chats JSONL. Crediting the verifier with that number would
 * have understated its real latency by ~3.5x. The numbers above are from a
 * scan restricted to the chats file.
 *
 * Qwen is slower than Codex and lands ABOVE the 400ms single-attempt window, so
 * confirmation typically arrives on the second Enter attempt rather than the
 * first. That is well within the ~4s budget (5 attempts plus the grace) and is why the retry
 * loop exists; it is recorded here so a future tightening of
 * `VERIFY_WINDOW_MS` is understood to put Qwen at risk first.
 */

/** How long a resolved chats path is reused: longer than one command's ~4s of polls. */
const RESOLVED_PATH_TTL_MS = 5_000;
/** Resolved paths kept at once; one per session verifying a command. */
const RESOLVED_PATH_LIMIT = 32;
const resolvedPathByKey = new Map<string, { filePath: string; resolvedAtMs: number }>();

/**
 * Resolve the chats JSONL for a session.
 *
 * Qwen names the file exactly `<sessionId>.jsonl` because the adapter passes
 * `--session-id <uuid>`, so unlike Codex there is no directory scan. The
 * directory is `qwenRuntimeDir`, which reads up to two settings files, and
 * the verifier calls this on every 25ms poll, so a resolved path is reused
 * for `RESOLVED_PATH_TTL_MS`. Qwen fixes its runtime directory when it starts,
 * so a running session's path does not change under the memo. Existence is
 * deliberately NOT checked here: the shared tail reader returns null for a
 * missing file, which the caller treats as "keep polling".
 */
export function resolveQwenSessionPath(agentSessionId: string, cwd: string, place: CliPlace | null = null): string {
  const key = `${place?.distro ?? ''}\0${cwd}\0${agentSessionId}`;
  const nowMs = Date.now();
  const cached = resolvedPathByKey.get(key);
  if (cached && nowMs - cached.resolvedAtMs < RESOLVED_PATH_TTL_MS) return cached.filePath;
  const filePath = path.join(qwenChatsDir(cwd, place), `${agentSessionId}.jsonl`);
  resolvedPathByKey.delete(key);
  resolvedPathByKey.set(key, { filePath, resolvedAtMs: nowMs });
  // Insertion order is age order: drop the oldest past the limit.
  while (resolvedPathByKey.size > RESOLVED_PATH_LIMIT) {
    const oldestKey = resolvedPathByKey.keys().next().value;
    if (oldestKey === undefined) break;
    resolvedPathByKey.delete(oldestKey);
  }
  return filePath;
}

/**
 * Extract a user turn from one Qwen chats JSONL line.
 *
 * Shape read off a live capture:
 *   {"uuid":"...","sessionId":"...","timestamp":"2026-08-08T17:00:29.230Z",
 *    "type":"user","provenance":"real_user","cwd":"...","version":"0.21.7",
 *    "message":{"role":"user","parts":[{"text":"..."}]}}
 *
 * `provenance` separates genuine input from replayed or synthetic turns, so
 * anything that is present and not `real_user` is skipped. Older Qwen builds
 * omit the field entirely; those records are still accepted, since the exact
 * text match is what actually decides the answer.
 */
export function extractQwenUserTurn(line: string): UserTurnRecord | null {
  const trimmed = line.trim();
  if (!trimmed || !trimmed.startsWith('{')) return null;

  const entry: unknown = JSON.parse(trimmed);
  if (!entry || typeof entry !== 'object') return null;

  const record = entry as {
    type?: unknown;
    timestamp?: unknown;
    provenance?: unknown;
    message?: { role?: unknown; parts?: unknown };
  };

  if (record.type !== 'user') return null;
  if (record.provenance !== undefined && record.provenance !== 'real_user') return null;

  const message = record.message;
  if (!message || typeof message !== 'object' || message.role !== 'user') return null;

  let text: string | null = null;
  if (Array.isArray(message.parts)) {
    const parts: string[] = [];
    for (const part of message.parts) {
      if (part && typeof part === 'object') {
        const candidate = (part as { text?: unknown }).text;
        if (typeof candidate === 'string') parts.push(candidate);
      }
    }
    text = parts.join('');
  }
  if (text === null) return null;

  const timestampMs = typeof record.timestamp === 'string'
    ? Date.parse(record.timestamp)
    : NaN;

  return {
    timestampMs: Number.isNaN(timestampMs) ? null : timestampMs,
    text,
  };
}

export function createQwenCommandInjectionVerifier(): SubmissionVerifier {
  return createSubmittedTextSubmissionVerifier({
    resolvePath: (agentSessionId, cwd, place) => resolveQwenSessionPath(agentSessionId, cwd, place),
    extractUserTurn: extractQwenUserTurn,
  });
}
