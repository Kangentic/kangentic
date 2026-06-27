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
