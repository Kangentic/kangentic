import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * Buffered async append helper for diagnostic writers.
 *
 * Replaces per-call `fs.appendFileSync` + `fs.mkdirSync` (both synchronous,
 * blocking the main event loop) with a per-path FIFO queue flushed via
 * `fs.promises.appendFile`. Multiple entries enqueued before a flush
 * starts get coalesced into one disk write.
 *
 * Cost on Windows: a single `appendFileSync` to `<projectRoot>/.kangentic/logs/`
 * runs 5-50 ms (cold + AV scan). At ~50 calls/s in steady state (every IPC
 * call + every renderer console.* + every main warn) that produces 250-2500 ms
 * of blocked main loop per second, manifesting as terminal-typing stutter and
 * the 5-second-perceived freeze. This helper moves the work off the critical
 * path: the producer call returns synchronously after queueing; disk IO
 * happens on the next `setImmediate` tick.
 *
 * Order is preserved per file: only one flush task runs per filePath at a
 * time. Entries enqueued during a flush are drained by the same task before
 * it resolves. Errors from the underlying FS calls are swallowed so a
 * best-effort diagnostic feature can never crash the agent.
 *
 * Optional size-bounded rotation: a writer that calls
 * `queueAppendWithRotation` gets the same async, non-blocking enqueue plus a
 * per-file size cap. Because rotation runs inside the same serialized
 * per-path flush task, the rename observes every prior append's effect on
 * disk (no in-flight write can land in the rotated `.1` copy), which is why
 * the rotating writer no longer needs synchronous I/O.
 */

/** Suffix for the rotated-out copy of a size-capped file (`<file>.1`). */
export const ROTATED_FILE_SUFFIX = '.1';

const queues = new Map<string, string[]>();
const pendingFlush = new Map<string, Promise<void>>();
const dirReady = new Set<string>();
// Rotation bookkeeping, populated only for paths written via
// `queueAppendWithRotation`. `rotationMaxBytes` holds the per-file cap;
// `rotationBytes` tracks the live primary's byte count so the flush task can
// decide when to rotate without a `statSync`.
const rotationMaxBytes = new Map<string, number>();
const rotationBytes = new Map<string, number>();

/**
 * Append `line` (caller is responsible for the trailing newline) to
 * `filePath`. Non-blocking: returns immediately. The actual disk write
 * happens on the next `setImmediate` turn.
 */
export function queueAppend(filePath: string, line: string): void {
  let queue = queues.get(filePath);
  if (!queue) {
    queue = [];
    queues.set(filePath, queue);
  }
  queue.push(line);
  if (pendingFlush.has(filePath)) return;
  const flushPromise = (async () => {
    await new Promise<void>((resolve) => setImmediate(resolve));
    try {
      await flush(filePath);
    } finally {
      pendingFlush.delete(filePath);
    }
  })();
  pendingFlush.set(filePath, flushPromise);
}

/**
 * Like `queueAppend`, but caps `filePath` at `maxBytes`: when the next batch
 * would push the primary over the cap, the primary is rotated to `<file>.1`
 * (replacing any prior rotated copy) before the append, bounding total disk
 * use at `2 * maxBytes`. Non-blocking, same as `queueAppend`.
 *
 * `maxBytes` is measured in JS string length (UTF-16 code units), not UTF-8
 * bytes on disk; the two are equal for ASCII trace output and the counter
 * slightly undercounts disk use for multi-byte content. The cap is enforced
 * per flush batch, so a single flush whose coalesced lines exceed `maxBytes`
 * writes one oversized primary before rotating on the next flush (unreachable
 * at the 10MB trace cap, where a batch would need ~100k lines in one tick).
 */
export function queueAppendWithRotation(
  filePath: string,
  line: string,
  maxBytes: number,
): void {
  rotationMaxBytes.set(filePath, maxBytes);
  queueAppend(filePath, line);
}

/**
 * Reset the in-memory primary byte count for a rotating path. Call this after
 * externally truncating or deleting the file (e.g. a session re-attach that
 * unlinks stale output) so the next append starts counting from zero rather
 * than a stale total that would trigger a spurious early rotation.
 */
export function resetRotationState(filePath: string): void {
  rotationBytes.delete(filePath);
}

async function maybeRotate(filePath: string, addedBytes: number): Promise<void> {
  const maxBytes = rotationMaxBytes.get(filePath);
  if (maxBytes === undefined) return;
  const current = rotationBytes.get(filePath) ?? 0;
  if (current + addedBytes <= maxBytes) return;
  // Drop any prior rotated copy, then move the primary to `<file>.1`.
  // unlink-first so a locked rotated copy fails only the unlink, not the
  // rename: on Windows an open handle on the destination blocks the replace
  // even though `fs.rename` (MoveFileEx) can otherwise overwrite. Both ops are
  // best-effort: a missing primary on the very first rotation is expected and
  // the append recreates it.
  const rotatedPath = filePath + ROTATED_FILE_SUFFIX;
  try {
    await fs.promises.unlink(rotatedPath);
  } catch {
    // May not exist - ignore.
  }
  let renamed = false;
  try {
    await fs.promises.rename(filePath, rotatedPath);
    renamed = true;
  } catch {
    // Primary may not exist yet - ignore.
  }
  // Only zero the counter when the primary was actually rotated out. If the
  // rename failed (e.g. a Windows reader holds the `.1` copy open), the primary
  // is still the live file, so keep its running total: the next append
  // re-attempts rotation instead of letting the primary grow past the cap on a
  // counter falsely reset to zero.
  if (renamed) rotationBytes.set(filePath, 0);
}

async function flush(filePath: string): Promise<void> {
  while (true) {
    const queue = queues.get(filePath);
    if (!queue || queue.length === 0) return;
    const batch = queue.splice(0, queue.length).join('');
    try {
      const directory = path.dirname(filePath);
      if (!dirReady.has(directory)) {
        await fs.promises.mkdir(directory, { recursive: true });
        dirReady.add(directory);
      }
      await maybeRotate(filePath, batch.length);
      await fs.promises.appendFile(filePath, batch, 'utf-8');
      if (rotationMaxBytes.has(filePath)) {
        rotationBytes.set(filePath, (rotationBytes.get(filePath) ?? 0) + batch.length);
      }
    } catch {
      // Best-effort: drop this batch. Disk full / permissions / locked
      // file are non-fatal for diagnostic writers. Continue draining the
      // queue in case a subsequent batch targets a different code path.
    }
  }
}

/**
 * Test helper: await all pending flushes. Diagnostic writers fire on
 * setImmediate, so tests that read from the log file synchronously
 * after triggering a write must call this first.
 */
export async function flushAllForTest(): Promise<void> {
  while (pendingFlush.size > 0) {
    const inFlight = Array.from(pendingFlush.values());
    await Promise.allSettled(inFlight);
  }
}

/** Test helper: clear all in-memory state. Tests should call this in beforeEach. */
export function resetForTest(): void {
  queues.clear();
  pendingFlush.clear();
  dirReady.clear();
  rotationMaxBytes.clear();
  rotationBytes.clear();
}
