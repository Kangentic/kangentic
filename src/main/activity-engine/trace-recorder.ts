import * as fs from 'node:fs';
import * as path from 'node:path';
import type { SessionUsage } from '../../shared/types';
import {
  queueAppendWithRotation,
  resetRotationState,
  ROTATED_FILE_SUFFIX,
} from '../diagnostics/async-file-queue';

/**
 * Dev-only passive recording of PTY chunk arrivals and status.json
 * deltas to per-session JSONL files. The "Capture trace" devtool reads
 * these alongside `events.jsonl` to produce a portable replay fixture.
 *
 * Every entry point early-returns when `!__KANGENTIC_DEV__`, so esbuild
 * eliminates the body in production builds and the recorder is
 * unreachable from a shipped binary.
 *
 * Why always-on (in dev) instead of devtool-triggered: a flip-flop
 * report comes in after the fact. Without passive capture, by the time
 * we know we want a trace the data is gone. Recording is lightweight -
 * `pty-chunks.jsonl` stores `{ts, length}` per chunk (no content);
 * `status-deltas.jsonl` stores `{ts, ...usage}` per status update,
 * which fires a few times per minute at most.
 *
 * Output schema:
 *   pty-chunks.jsonl:    {"ts":1730000000000,"length":42}
 *   status-deltas.jsonl: {"ts":1730000000000,"model":"sonnet-4.5","inputTokens":1234,"outputTokens":567}
 *
 * Disk-growth bound: each file rotates once it would exceed
 * `TRACE_FILE_MAX_BYTES`. The previous primary is renamed to
 * `<file>.1`, replacing any prior rotation. Total per-file disk use
 * stays within `2 * TRACE_FILE_MAX_BYTES`. The capture-trace devtool
 * concatenates the rotated copy + the live primary so a captured
 * bundle still represents the full recorded stream.
 */

/**
 * Per-file rotation cap. At ~3 KB/s for dense PTY streaming this
 * keeps the most recent ~55 minutes in the primary, plus a similarly
 * sized rotated copy. Sized to be useful for diagnosing flip-flops
 * (which usually surface within a few minutes) without letting an
 * unattended dev session pile up gigabytes of recorder output.
 */
export const TRACE_FILE_MAX_BYTES = 10 * 1024 * 1024;
const TRACE_FILES = ['pty-chunks.jsonl', 'status-deltas.jsonl'] as const;

const sessionDirs = new Map<string, string>();

/**
 * Append `line` to `<sessionDir>/<fileName>` through the async file queue.
 *
 * The queue buffers the write off the PTY hot path (no synchronous
 * `appendFileSync` on the ~60Hz `onData` path), rotates the file at
 * `TRACE_FILE_MAX_BYTES`, serializes all ops per path, and best-effort
 * swallows its own errors - including the ENOENT shutdown race where
 * `killAllSessions` deletes the session dir while a final chunk is still in
 * flight. So the recorder no longer does sync I/O, byte bookkeeping, or
 * per-session error logging here.
 */
function tryRecord(sessionId: string, fileName: string, line: string): void {
  const sessionDir = sessionDirs.get(sessionId);
  if (!sessionDir) return;
  const filePath = path.join(sessionDir, fileName);
  queueAppendWithRotation(filePath, line, TRACE_FILE_MAX_BYTES);
}

export function setSessionDir(sessionId: string, sessionDir: string): void {
  if (!__KANGENTIC_DEV__) return;
  sessionDirs.set(sessionId, sessionDir);
  // Truncate stale recorder output (primary AND rotated) from a prior
  // run with this sessionId. status-file-reader's attach() already
  // truncates status.json and events.jsonl on the same boundary; mirror
  // that so a resumed session doesn't replay old chunks/deltas mixed
  // in with fresh ones. Best-effort: a missing file is the common case.
  // This runs once at session start, not on the hot path, so sync unlink
  // is fine.
  for (const fileName of TRACE_FILES) {
    const filePath = path.join(sessionDir, fileName);
    for (const variant of [filePath, filePath + ROTATED_FILE_SUFFIX]) {
      try {
        fs.unlinkSync(variant);
      } catch {
        // File may not exist yet (fresh session) - ignore.
      }
    }
    // The on-disk primary is now gone; reset the queue's byte counter so the
    // first fresh append starts from zero, not a stale total from a prior run.
    resetRotationState(filePath);
  }
}

export function clearSessionDir(sessionId: string): void {
  if (!__KANGENTIC_DEV__) return;
  const sessionDir = sessionDirs.get(sessionId);
  sessionDirs.delete(sessionId);
  // Free the queue's per-path byte counters. The trace files themselves
  // persist on disk so a post-exit "Capture trace" still bundles them.
  if (sessionDir) {
    for (const fileName of TRACE_FILES) {
      resetRotationState(path.join(sessionDir, fileName));
    }
  }
}

export function recordPtyChunk(sessionId: string, length: number): void {
  if (!__KANGENTIC_DEV__) return;
  if (!sessionDirs.has(sessionId)) return;
  const line = JSON.stringify({ ts: Date.now(), length }) + '\n';
  tryRecord(sessionId, 'pty-chunks.jsonl', line);
}

export function recordStatusDelta(sessionId: string, usage: SessionUsage): void {
  if (!__KANGENTIC_DEV__) return;
  if (!sessionDirs.has(sessionId)) return;
  const line = JSON.stringify({
    ts: Date.now(),
    model: usage.model.id,
    inputTokens: usage.contextWindow.totalInputTokens,
    outputTokens: usage.contextWindow.totalOutputTokens,
  }) + '\n';
  tryRecord(sessionId, 'status-deltas.jsonl', line);
}
