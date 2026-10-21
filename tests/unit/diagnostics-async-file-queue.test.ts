/**
 * Unit tests for `src/main/diagnostics/async-file-queue.ts`.
 *
 * The queue is a singleton (module-scoped Map/Set state) wrapping
 * `fs.promises.appendFile` and `fs.promises.mkdir`. Tests verify:
 *   - FIFO ordering per-path (entries flush in enqueue order)
 *   - Coalescing (multiple queueAppend calls in one tick batch into one write)
 *   - dirReady caching (mkdir only called once per directory)
 *   - Error swallowing (a failed appendFile does not poison the queue)
 *   - resetForTest clears in-memory state
 *   - Per-path isolation (writes to two paths flush independently)
 *   - Exit drain (drainQueuedAppendsSync writes queued and in-flight batches
 *     synchronously, and the flush skips a batch the drain claimed)
 *
 * Tests use `resetForTest()` in beforeEach instead of `vi.resetModules()`
 * because the queue's resetForTest is purpose-built for this and avoids
 * module-cache shenanigans. Spies on `fs.promises.{appendFile,mkdir}` are
 * declared after resetForTest so they observe the real flush calls.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  queueAppend,
  queueAppendWithRotation,
  resetRotationState,
  drainQueuedAppendsSync,
  flushAllForTest,
  resetForTest,
} from '../../src/main/diagnostics/async-file-queue';

let tempDirectory: string;

beforeEach(() => {
  tempDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'async-file-queue-test-'));
  resetForTest();
});

afterEach(() => {
  vi.restoreAllMocks();
  resetForTest();
  try {
    fs.rmSync(tempDirectory, { recursive: true, force: true });
  } catch {
    // best-effort
  }
});

function readFileLines(filePath: string): string[] {
  if (!fs.existsSync(filePath)) return [];
  return fs
    .readFileSync(filePath, 'utf-8')
    .split('\n')
    .filter((line) => line.length > 0);
}

describe('async-file-queue: queueAppend', () => {
  it('writes a single line to disk after flush', async () => {
    const filePath = path.join(tempDirectory, 'single.log');
    queueAppend(filePath, 'hello\n');
    await flushAllForTest();
    expect(readFileLines(filePath)).toEqual(['hello']);
  });

  it('preserves FIFO order for two queueAppend calls to the same path', async () => {
    const filePath = path.join(tempDirectory, 'fifo.log');
    queueAppend(filePath, 'first\n');
    queueAppend(filePath, 'second\n');
    await flushAllForTest();
    expect(readFileLines(filePath)).toEqual(['first', 'second']);
  });

  it('preserves FIFO order across many entries', async () => {
    const filePath = path.join(tempDirectory, 'many.log');
    for (let index = 0; index < 10; index++) {
      queueAppend(filePath, `line-${index}\n`);
    }
    await flushAllForTest();
    const expected = Array.from({ length: 10 }, (_, index) => `line-${index}`);
    expect(readFileLines(filePath)).toEqual(expected);
  });

  it('coalesces multiple synchronous queueAppend calls into one appendFile call', async () => {
    // Pre-create the directory so mkdir doesn't fire and our spy on
    // appendFile counts only the actual write calls.
    fs.mkdirSync(tempDirectory, { recursive: true });
    const filePath = path.join(tempDirectory, 'coalesce.log');
    const appendSpy = vi.spyOn(fs.promises, 'appendFile');

    for (let index = 0; index < 5; index++) {
      queueAppend(filePath, `line-${index}\n`);
    }
    await flushAllForTest();

    // All 5 entries should be batched into a single appendFile call.
    expect(appendSpy).toHaveBeenCalledTimes(1);
    expect(readFileLines(filePath)).toEqual([
      'line-0', 'line-1', 'line-2', 'line-3', 'line-4',
    ]);
  });

  it('mkdir is called only once for the same directory across multiple flushes', async () => {
    const fileA = path.join(tempDirectory, 'a.log');
    const fileB = path.join(tempDirectory, 'b.log');
    const mkdirSpy = vi.spyOn(fs.promises, 'mkdir');

    queueAppend(fileA, 'a\n');
    await flushAllForTest();
    queueAppend(fileB, 'b\n');
    await flushAllForTest();

    // Both files share the same directory; the second flush hits the cache.
    expect(mkdirSpy).toHaveBeenCalledTimes(1);
    expect(readFileLines(fileA)).toEqual(['a']);
    expect(readFileLines(fileB)).toEqual(['b']);
  });

  it('mkdir is called once per distinct directory', async () => {
    const subDirA = path.join(tempDirectory, 'sub-a');
    const subDirB = path.join(tempDirectory, 'sub-b');
    const fileA = path.join(subDirA, 'a.log');
    const fileB = path.join(subDirB, 'b.log');
    const mkdirSpy = vi.spyOn(fs.promises, 'mkdir');

    queueAppend(fileA, 'a\n');
    queueAppend(fileB, 'b\n');
    await flushAllForTest();

    // Two different directories => two mkdir calls.
    expect(mkdirSpy).toHaveBeenCalledTimes(2);
  });

  it('isolates flush tasks per path: two paths flush independently', async () => {
    const fileA = path.join(tempDirectory, 'iso-a.log');
    const fileB = path.join(tempDirectory, 'iso-b.log');

    queueAppend(fileA, 'a-line\n');
    queueAppend(fileB, 'b-line\n');
    await flushAllForTest();

    expect(readFileLines(fileA)).toEqual(['a-line']);
    expect(readFileLines(fileB)).toEqual(['b-line']);
  });

  it('a single failed appendFile does not poison subsequent writes to the same path', async () => {
    fs.mkdirSync(tempDirectory, { recursive: true });
    const filePath = path.join(tempDirectory, 'recover.log');
    const appendSpy = vi.spyOn(fs.promises, 'appendFile')
      .mockRejectedValueOnce(new Error('EACCES'));

    queueAppend(filePath, 'first\n');
    await flushAllForTest();

    // The first write was dropped due to mock failure. Now the spy reverts
    // to real behavior for the next call.
    appendSpy.mockRestore();

    queueAppend(filePath, 'second\n');
    await flushAllForTest();

    expect(readFileLines(filePath)).toEqual(['second']);
  });

  it('a failed mkdir does not crash the queue (best-effort)', async () => {
    const blockingFile = path.join(tempDirectory, 'blocker');
    fs.writeFileSync(blockingFile, 'data');
    // path.dirname will be `<blocker>` which is a regular file, so mkdir fails.
    const filePath = path.join(blockingFile, 'inner', 'log.log');

    expect(() => queueAppend(filePath, 'never-written\n')).not.toThrow();
    await flushAllForTest();

    expect(fs.existsSync(filePath)).toBe(false);
  });
});

describe('async-file-queue: flushAllForTest', () => {
  it('returns immediately when the queue is empty', async () => {
    await expect(flushAllForTest()).resolves.toBeUndefined();
  });

  it('drains entries enqueued during a flush in the same flush cycle', async () => {
    const filePath = path.join(tempDirectory, 'drain.log');

    // Initial enqueue.
    queueAppend(filePath, 'a\n');
    queueAppend(filePath, 'b\n');

    // flushAllForTest awaits the in-flight flush; entries already enqueued
    // before setImmediate fires are drained by the same flush task's
    // while-loop. The single flush task handles both.
    await flushAllForTest();

    expect(readFileLines(filePath)).toEqual(['a', 'b']);
  });
});

describe('async-file-queue: queueAppendWithRotation', () => {
  // Rotation tracks the primary's byte count across appends, so the running
  // total only advances once a flush has actually written each batch. These
  // tests flush between appends to accumulate the count the way the PTY hot
  // path does (one batch per setImmediate window). This is the rotation
  // contract that used to live in the trace-recorder's sync helper.
  function readRaw(filePath: string): string {
    return fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf-8') : '';
  }

  it('appends without rotating when under cap', async () => {
    const filePath = path.join(tempDirectory, 'rot.jsonl');
    queueAppendWithRotation(filePath, 'line1\n', 1024);
    await flushAllForTest();
    expect(readRaw(filePath)).toBe('line1\n');
    expect(fs.existsSync(filePath + '.1')).toBe(false);
  });

  it('continues appending to the primary across writes under cap', async () => {
    const filePath = path.join(tempDirectory, 'rot.jsonl');
    queueAppendWithRotation(filePath, 'line1\n', 1024);
    await flushAllForTest();
    queueAppendWithRotation(filePath, 'line2\n', 1024);
    await flushAllForTest();
    queueAppendWithRotation(filePath, 'line3\n', 1024);
    await flushAllForTest();
    expect(readRaw(filePath)).toBe('line1\nline2\nline3\n');
    expect(fs.existsSync(filePath + '.1')).toBe(false);
  });

  it('rotates the primary to .1 once the running total would exceed cap', async () => {
    const filePath = path.join(tempDirectory, 'rot.jsonl');
    const cap = 16;
    queueAppendWithRotation(filePath, 'older-content\n', cap); // 14 bytes
    await flushAllForTest();
    // 14 + 8 = 22 > 16 -> rotate before appending.
    queueAppendWithRotation(filePath, 'fresh-1\n', cap);
    await flushAllForTest();
    expect(readRaw(filePath)).toBe('fresh-1\n');
    expect(readRaw(filePath + '.1')).toBe('older-content\n');
  });

  it('overwrites the rotated file on subsequent rotations', async () => {
    const filePath = path.join(tempDirectory, 'rot.jsonl');
    // A stale rotated copy from a prior cycle must be dropped, not kept.
    fs.writeFileSync(filePath + '.1', 'stale');
    queueAppendWithRotation(filePath, 'first', 5);
    await flushAllForTest(); // 0 + 5 = 5, not > 5 -> primary = 'first'
    queueAppendWithRotation(filePath, 'second', 5);
    await flushAllForTest(); // 5 + 6 = 11 > 5 -> rotate
    expect(readRaw(filePath)).toBe('second');
    expect(readRaw(filePath + '.1')).toBe('first');
  });

  it('keeps total disk usage bounded at 2x cap across many writes', async () => {
    const filePath = path.join(tempDirectory, 'rot.jsonl');
    const cap = 256;
    const line = 'x'.repeat(50) + '\n';
    for (let writeIndex = 0; writeIndex < 100; writeIndex += 1) {
      queueAppendWithRotation(filePath, line, cap);
      await flushAllForTest();
    }
    const primarySize = fs.statSync(filePath).size;
    const rotatedSize = fs.existsSync(filePath + '.1')
      ? fs.statSync(filePath + '.1').size
      : 0;
    expect(primarySize).toBeLessThanOrEqual(cap);
    expect(rotatedSize).toBeLessThanOrEqual(cap);
    expect(primarySize + rotatedSize).toBeLessThanOrEqual(2 * cap);
    // Sanity: we wrote 5100 bytes total; the bound enforces <= 512.
    expect(primarySize + rotatedSize).toBeLessThan(5100);
  });

  it('does not rotate when the batch lands exactly at cap', async () => {
    const filePath = path.join(tempDirectory, 'rot.jsonl');
    queueAppendWithRotation(filePath, 'aaaaa', 10);
    await flushAllForTest(); // 5 bytes
    queueAppendWithRotation(filePath, 'bbbbb', 10);
    await flushAllForTest(); // 5 + 5 = 10, not > 10 -> no rotate
    expect(readRaw(filePath)).toBe('aaaaabbbbb');
    expect(fs.existsSync(filePath + '.1')).toBe(false);
  });

  it('creates a fresh primary when rotating from a missing file', async () => {
    const filePath = path.join(tempDirectory, 'rot.jsonl');
    // No primary exists. 0 + 20 = 20 > 10 -> rotate (rename of the missing
    // primary fails silently), then append creates a fresh primary.
    queueAppendWithRotation(filePath, 'a'.repeat(20), 10);
    await flushAllForTest();
    expect(readRaw(filePath)).toBe('a'.repeat(20));
    expect(fs.existsSync(filePath + '.1')).toBe(false);
  });

  it('resetRotationState makes the next append start counting from zero', async () => {
    const filePath = path.join(tempDirectory, 'rot.jsonl');
    const cap = 16;
    queueAppendWithRotation(filePath, 'older-content\n', cap); // 14 bytes tracked
    await flushAllForTest();
    // Caller truncated the file out-of-band and reset the counter: the next
    // append must not rotate on the stale 14-byte total.
    fs.rmSync(filePath, { force: true });
    resetRotationState(filePath);
    queueAppendWithRotation(filePath, 'fresh\n', cap); // 0 + 6 = 6, not > 16
    await flushAllForTest();
    expect(readRaw(filePath)).toBe('fresh\n');
    expect(fs.existsSync(filePath + '.1')).toBe(false);
  });

  it('seeds the rotation counter from the on-disk size so a restart cannot grow an over-cap primary', async () => {
    const filePath = path.join(tempDirectory, 'rot.jsonl');
    const cap = 16;
    // A primary left on disk by a prior process, already over the cap. The
    // in-memory counter is empty this "process"; without seeding it would start
    // at 0 and let the primary keep growing far past the cap before rotating.
    fs.writeFileSync(filePath, 'x'.repeat(20) + '\n'); // 21 bytes > 16
    // First rotating append: seeding the counter from the 21-byte on-disk size
    // forces a rotation right away (21 + 6 > 16).
    queueAppendWithRotation(filePath, 'fresh\n', cap);
    await flushAllForTest();
    expect(readRaw(filePath)).toBe('fresh\n');
    expect(readRaw(filePath + '.1')).toBe('x'.repeat(20) + '\n');
  });
});

/**
 * The exit drain. The signal handlers call it right before process.exit, so
 * every assertion here reads the file with no await in between. A line that
 * needs a loop turn to land is a line the real exit loses.
 */
describe('async-file-queue: drainQueuedAppendsSync', () => {
  function readRaw(filePath: string): string {
    return fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf-8') : '';
  }

  /** One turn of the check phase, after the flush's own setImmediate. */
  function nextImmediate(): Promise<void> {
    return new Promise<void>((resolve) => setImmediate(resolve));
  }

  it('writes queued lines synchronously and in order', async () => {
    const filePath = path.join(tempDirectory, 'drain.log');
    queueAppend(filePath, 'first\n');
    queueAppend(filePath, 'second\n');
    queueAppend(filePath, 'third\n');

    drainQueuedAppendsSync();

    expect(readFileLines(filePath)).toEqual(['first', 'second', 'third']);
    // The flush scheduled by those appends then finds nothing left to write.
    await flushAllForTest();
    expect(readFileLines(filePath)).toEqual(['first', 'second', 'third']);
  });

  it('creates a missing directory', () => {
    const filePath = path.join(tempDirectory, 'nested', 'deeper', 'drain.log');
    queueAppend(filePath, 'line\n');

    drainQueuedAppendsSync();

    expect(readFileLines(filePath)).toEqual(['line']);
  });

  it('keeps each file in its own order', () => {
    const fileA = path.join(tempDirectory, 'a.log');
    const fileB = path.join(tempDirectory, 'b.log');
    queueAppend(fileA, 'a-1\n');
    queueAppend(fileB, 'b-1\n');
    queueAppend(fileA, 'a-2\n');
    queueAppend(fileB, 'b-2\n');

    drainQueuedAppendsSync();

    expect(readFileLines(fileA)).toEqual(['a-1', 'a-2']);
    expect(readFileLines(fileB)).toEqual(['b-1', 'b-2']);
  });

  it('writes nothing when nothing is queued, including after a completed flush', async () => {
    drainQueuedAppendsSync();
    expect(fs.readdirSync(tempDirectory)).toEqual([]);

    const filePath = path.join(tempDirectory, 'flushed.log');
    queueAppend(filePath, 'already-written\n');
    await flushAllForTest();

    drainQueuedAppendsSync();

    expect(readFileLines(filePath)).toEqual(['already-written']);
  });

  it('does not throw when a write fails, and still writes the other files', () => {
    const blockingFile = path.join(tempDirectory, 'blocker');
    fs.writeFileSync(blockingFile, 'data');
    // path.dirname is a regular file, so the mkdir fails.
    const blockedPath = path.join(blockingFile, 'inner', 'log.log');
    const healthyPath = path.join(tempDirectory, 'healthy.log');
    queueAppend(blockedPath, 'never-written\n');
    queueAppend(healthyPath, 'written\n');

    expect(() => drainQueuedAppendsSync()).not.toThrow();

    expect(fs.existsSync(blockedPath)).toBe(false);
    expect(readFileLines(healthyPath)).toEqual(['written']);
  });

  it('writes a batch a flush already took off the queue ahead of later lines, and the flush does not write it again', async () => {
    const filePath = path.join(tempDirectory, 'in-flight', 'drain.log');
    // Park the flush in its first await (the per-directory mkdir), after it
    // spliced 'first' off the queue and before it could append it.
    let releaseMkdir: () => void = () => undefined;
    const mkdirGate = new Promise<void>((resolve) => { releaseMkdir = resolve; });
    const mkdirSpy = vi.spyOn(fs.promises, 'mkdir').mockImplementationOnce(async () => {
      await mkdirGate;
      return undefined;
    });
    const appendSpy = vi.spyOn(fs.promises, 'appendFile');

    queueAppend(filePath, 'first\n');
    await nextImmediate();
    expect(mkdirSpy, 'the flush must be parked with its batch taken').toHaveBeenCalledTimes(1);
    queueAppend(filePath, 'second\n');

    drainQueuedAppendsSync();

    expect(readFileLines(filePath)).toEqual(['first', 'second']);

    releaseMkdir();
    await flushAllForTest();

    expect(appendSpy, 'the flush must skip a batch the drain already wrote').not.toHaveBeenCalled();
    expect(readFileLines(filePath)).toEqual(['first', 'second']);
  });

  it('writes a batch whose append is already in flight ahead of later lines', async () => {
    const filePath = path.join(tempDirectory, 'dispatched.log');
    // An append that has reached the thread pool cannot be recalled, so the
    // drain writes the batch itself rather than risk it landing after the
    // later lines. This stand-in append never writes, so the file shows the
    // drain's copy alone.
    let releaseAppend: () => void = () => undefined;
    const appendGate = new Promise<void>((resolve) => { releaseAppend = resolve; });
    const appendSpy = vi.spyOn(fs.promises, 'appendFile').mockImplementationOnce(async () => {
      await appendGate;
    });

    queueAppend(filePath, 'first\n');
    await vi.waitFor(() => expect(appendSpy).toHaveBeenCalledTimes(1));
    queueAppend(filePath, 'second\n');

    drainQueuedAppendsSync();

    expect(readFileLines(filePath)).toEqual(['first', 'second']);

    releaseAppend();
    await flushAllForTest();
    expect(readFileLines(filePath)).toEqual(['first', 'second']);
  });

  it('drops the rotation byte count, so the next flush reseeds it from the file', async () => {
    const filePath = path.join(tempDirectory, 'rot.jsonl');
    const cap = 30;
    queueAppendWithRotation(filePath, 'older-content\n', cap); // 14 bytes counted
    await flushAllForTest();
    // The drain ignores the cap for its one write: 14 + 16 = 30 on disk.
    queueAppendWithRotation(filePath, 'drained-line-xx\n', cap);
    drainQueuedAppendsSync();
    expect(readRaw(filePath)).toBe('older-content\ndrained-line-xx\n');
    await flushAllForTest();

    // A stale count of 14 would take this 2-byte line (16, under the cap).
    // Reseeded from the 30-byte file, 32 is over the cap, so it rotates first.
    queueAppendWithRotation(filePath, 'n\n', cap);
    await flushAllForTest();

    expect(readRaw(filePath)).toBe('n\n');
    expect(readRaw(filePath + '.1')).toBe('older-content\ndrained-line-xx\n');
  });

  it('does not rotate the file the drain just wrote when the claimed flush resumes from its mkdir', async () => {
    const filePath = path.join(tempDirectory, 'claimed-early', 'rot.jsonl');
    const cap = 30;
    // Park the flush at the per-directory mkdir, after it took 'first-line-xx'
    // (14 bytes) off the queue.
    let releaseMkdir: () => void = () => undefined;
    const mkdirGate = new Promise<void>((resolve) => { releaseMkdir = resolve; });
    const mkdirSpy = vi.spyOn(fs.promises, 'mkdir').mockImplementationOnce(async () => {
      await mkdirGate;
      return undefined;
    });
    const renameSpy = vi.spyOn(fs.promises, 'rename');
    const appendSpy = vi.spyOn(fs.promises, 'appendFile');

    queueAppendWithRotation(filePath, 'first-line-xx\n', cap);
    await nextImmediate();
    expect(mkdirSpy, 'the flush must be parked with its batch taken').toHaveBeenCalledTimes(1);
    queueAppendWithRotation(filePath, 'second-line\n', cap); // 12 bytes

    drainQueuedAppendsSync();

    // The drain put 26 bytes on disk, under the 30 byte cap. Counting the
    // claimed 14 byte batch again would make 40, which is over the cap.
    expect(readRaw(filePath)).toBe('first-line-xx\nsecond-line\n');

    releaseMkdir();
    await flushAllForTest();

    expect(renameSpy, 'a claimed batch must not trigger a rotation').not.toHaveBeenCalled();
    expect(fs.existsSync(filePath + '.1')).toBe(false);
    expect(appendSpy).not.toHaveBeenCalled();
    expect(readRaw(filePath)).toBe('first-line-xx\nsecond-line\n');
  });

  it('skips its own append when the drain claims the batch while the flush is parked inside the rotation', async () => {
    const filePath = path.join(tempDirectory, 'rot.jsonl');
    const cap = 20;
    queueAppendWithRotation(filePath, 'older-content\n', cap); // 14 bytes counted
    await flushAllForTest();

    // Park the next flush inside maybeRotate, on the rename. The stat and the
    // mkdir are behind it, so the claim check right after them has already
    // passed and only the check after the rotation can catch the drain.
    const realRename = fs.promises.rename;
    let releaseRename: () => void = () => undefined;
    const renameGate = new Promise<void>((resolve) => { releaseRename = resolve; });
    const renameSpy = vi.spyOn(fs.promises, 'rename').mockImplementationOnce(async (oldPath, newPath) => {
      await renameGate;
      return realRename(oldPath, newPath);
    });
    const appendSpy = vi.spyOn(fs.promises, 'appendFile');

    // 14 + 13 = 27 is over the 20 byte cap, so a rotation is due.
    queueAppendWithRotation(filePath, 'batch-two-xx\n', cap);
    await vi.waitFor(() => expect(renameSpy).toHaveBeenCalledTimes(1));
    queueAppendWithRotation(filePath, 'batch-three\n', cap);

    drainQueuedAppendsSync();

    const allLines = 'older-content\nbatch-two-xx\nbatch-three\n';
    expect(readRaw(filePath)).toBe(allLines);

    releaseRename();
    await flushAllForTest();

    // The released rename moves the drained file to .1 whole. The flush must
    // not append the claimed batch to the fresh primary a second time.
    expect(appendSpy, 'the flush must skip a batch the drain already wrote').not.toHaveBeenCalled();
    expect(readRaw(filePath + '.1')).toBe(allLines);
    expect(readRaw(filePath)).toBe('');
  });

  it('does not add a claimed batch back onto the rotation byte count after its append settles', async () => {
    const filePath = path.join(tempDirectory, 'rot.jsonl');
    const cap = 16;
    // Hold the first batch's append open so it is already dispatched when the
    // drain runs. This stand-in append never writes, so the file holds the
    // drain's copy alone.
    let releaseAppend: () => void = () => undefined;
    const appendGate = new Promise<void>((resolve) => { releaseAppend = resolve; });
    const appendSpy = vi.spyOn(fs.promises, 'appendFile').mockImplementationOnce(async () => {
      await appendGate;
    });

    queueAppendWithRotation(filePath, 'first\n', cap); // 6 bytes
    await vi.waitFor(() => expect(appendSpy).toHaveBeenCalledTimes(1));
    queueAppendWithRotation(filePath, 'second\n', cap); // 7 bytes

    drainQueuedAppendsSync();

    // The drain wrote 13 bytes and dropped the byte count.
    expect(readRaw(filePath)).toBe('first\nsecond\n');

    releaseAppend();
    await flushAllForTest();

    // Reseeded from the 13 byte file, 13 + 5 = 18 is over the 16 byte cap and
    // rotates first. A count of 6 re-added by the settled flush would make
    // 11, which fits, so the line would land on the old primary instead.
    queueAppendWithRotation(filePath, 'abcd\n', cap);
    await flushAllForTest();

    expect(readRaw(filePath + '.1')).toBe('first\nsecond\n');
    expect(readRaw(filePath)).toBe('abcd\n');
  });

  it('writes nothing for a batch whose flush resetForTest orphaned', async () => {
    const filePath = path.join(tempDirectory, 'orphaned.log');
    // The gated mkdir never creates a directory, so the file sits directly in
    // the temp directory that already exists.
    let releaseMkdir: () => void = () => undefined;
    const mkdirGate = new Promise<void>((resolve) => { releaseMkdir = resolve; });
    const mkdirSpy = vi.spyOn(fs.promises, 'mkdir').mockImplementationOnce(async () => {
      await mkdirGate;
      return undefined;
    });
    const appendSpy = vi.spyOn(fs.promises, 'appendFile');

    queueAppend(filePath, 'first\n');
    await nextImmediate();
    expect(mkdirSpy, 'the flush must be parked with its batch taken').toHaveBeenCalledTimes(1);

    try {
      // The reset forgets the parked batch, so it is no longer the drain's to write.
      resetForTest();
      drainQueuedAppendsSync();
      expect(readRaw(filePath)).toBe('');
    } finally {
      releaseMkdir();
    }

    // resetForTest also dropped the pending flush, so flushAllForTest cannot
    // wait for the orphan. Wait for its append to settle here, so its late write
    // cannot run into afterEach or the next test.
    await vi.waitFor(() => expect(appendSpy).toHaveBeenCalledTimes(1));
    await appendSpy.mock.results[0].value;
  });
});

describe('async-file-queue: resetForTest', () => {
  it('clears all module-scoped state', async () => {
    const filePath = path.join(tempDirectory, 'reset.log');

    queueAppend(filePath, 'first\n');
    await flushAllForTest();
    expect(readFileLines(filePath)).toEqual(['first']);

    // Wipe state. dirReady is now empty; next mkdir will fire.
    resetForTest();
    const mkdirSpy = vi.spyOn(fs.promises, 'mkdir');

    queueAppend(filePath, 'second\n');
    await flushAllForTest();

    // mkdir fires again because resetForTest cleared the dirReady cache.
    expect(mkdirSpy).toHaveBeenCalledTimes(1);
    expect(readFileLines(filePath)).toEqual(['first', 'second']);
  });
});
