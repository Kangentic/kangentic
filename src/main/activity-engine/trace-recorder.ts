import * as fs from 'node:fs';
import * as path from 'node:path';
import type { SessionUsage } from '../../shared/types';

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
const ROTATED_SUFFIX = '.1';
const TRACE_FILES = ['pty-chunks.jsonl', 'status-deltas.jsonl'] as const;

const sessionDirs = new Map<string, string>();
const byteCounts = new Map<string, Map<string, number>>();
const errorOnceLogged = new Set<string>();

/**
 * Pure rotation + append helper. Exported for unit tests so the
 * rotation contract can be verified without going through the
 * `__KANGENTIC_DEV__` gate or the per-session bookkeeping.
 *
 * Returns the new byte count for `filePath` after the append (zero
 * plus the appended line's length when rotation fired; otherwise
 * `currentBytes + line.length`).
 *
 * Sync I/O on purpose: rotation must observe the previous append's
 * effect on disk before renaming, otherwise an in-flight async write
 * could land in the rotated `.1` file instead of the fresh primary.
 * Append latency for a ~50-byte line on NTFS is sub-millisecond, so
 * the cost is negligible even at 60Hz from the PTY hot path.
 */
export function appendWithRotationSync(
  filePath: string,
  line: string,
  currentBytes: number,
  maxBytes: number = TRACE_FILE_MAX_BYTES,
): number {
  let bytes = currentBytes;
  if (bytes + line.length > maxBytes) {
    const rotatedPath = filePath + ROTATED_SUFFIX;
    // Drop any prior rotated copy. fs.renameSync on Windows fails when
    // the destination exists, so we unlink first regardless of OS to
    // keep the behavior portable.
    try {
      fs.unlinkSync(rotatedPath);
    } catch {
      // May not exist - ignore.
    }
    try {
      fs.renameSync(filePath, rotatedPath);
    } catch {
      // Primary may not exist on the very first rotation attempt
      // after a session start with an empty cap (uncommon). Either
      // way the next appendFileSync will create a fresh primary.
    }
    bytes = 0;
  }
  fs.appendFileSync(filePath, line);
  return bytes + line.length;
}

function getCounter(sessionId: string, fileName: string): number {
  return byteCounts.get(sessionId)?.get(fileName) ?? 0;
}

function setCounter(sessionId: string, fileName: string, bytes: number): void {
  let counts = byteCounts.get(sessionId);
  if (!counts) {
    counts = new Map();
    byteCounts.set(sessionId, counts);
  }
  counts.set(fileName, bytes);
}

function tryRecord(sessionId: string, fileName: string, line: string): void {
  const sessionDir = sessionDirs.get(sessionId);
  if (!sessionDir) return;
  const filePath = path.join(sessionDir, fileName);
  try {
    const newBytes = appendWithRotationSync(
      filePath,
      line,
      getCounter(sessionId, fileName),
    );
    setCounter(sessionId, fileName, newBytes);
  } catch (error) {
    // ENOENT is the expected shutdown race: killAllSessions deletes the
    // session dir while a final PTY chunk is still in flight. Swallow it
    // silently - it is noise, not a fault. Log other errors once per session.
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return;
    if (!errorOnceLogged.has(sessionId)) {
      errorOnceLogged.add(sessionId);
      const message = error instanceof Error ? error.message : String(error);
      console.warn(
        `[trace-recorder] append failed for session=${sessionId.slice(0, 8)} file=${fileName}: ${message}`,
      );
    }
  }
}

export function setSessionDir(sessionId: string, sessionDir: string): void {
  if (!__KANGENTIC_DEV__) return;
  sessionDirs.set(sessionId, sessionDir);
  byteCounts.delete(sessionId);
  // Truncate stale recorder output (primary AND rotated) from a prior
  // run with this sessionId. status-file-reader's attach() already
  // truncates status.json and events.jsonl on the same boundary; mirror
  // that so a resumed session doesn't replay old chunks/deltas mixed
  // in with fresh ones. Best-effort: a missing file is the common case.
  for (const fileName of TRACE_FILES) {
    for (const variant of [fileName, fileName + ROTATED_SUFFIX]) {
      try {
        fs.unlinkSync(path.join(sessionDir, variant));
      } catch {
        // File may not exist yet (fresh session) - ignore.
      }
    }
  }
}

export function clearSessionDir(sessionId: string): void {
  if (!__KANGENTIC_DEV__) return;
  sessionDirs.delete(sessionId);
  byteCounts.delete(sessionId);
  errorOnceLogged.delete(sessionId);
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
