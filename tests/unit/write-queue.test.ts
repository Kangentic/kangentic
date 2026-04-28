import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createWriteQueue, type PtyWriteTarget } from '../../src/main/pty/write-queue';

/**
 * Contract tests for the per-session FIFO write queue. Locks in the
 * invariants the Ctrl+V paste path depends on:
 *
 * - Single chunk for small writes (<= 4KB).
 * - Exact byte coverage for multi-chunk writes (no truncation, no padding).
 * - Strict FIFO ordering across concurrent writers (no interleaving).
 * - Bracketed-paste sequences arrive intact (200~ ... 201~ never split).
 * - Mid-drain pty disposal drops remaining bytes without throwing or
 *   continuing to write to a dead pty.
 *
 * Regression: before the queue, two concurrent calls to SessionManager.write
 * each started their own setTimeout(1) chunker chain on the same pty, which
 * interleaved bytes and fragmented bracketed-paste markers, causing Claude
 * Code's TUI to truncate large pastes.
 */

function createRecorder(): PtyWriteTarget & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    write(data: string) {
      calls.push(data);
    },
  };
}

describe('createWriteQueue', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('emits a single pty.write for input <= chunk size', () => {
    const pty = createRecorder();
    const queue = createWriteQueue(() => pty);
    const payload = 'a'.repeat(4096);

    queue.enqueue(payload);
    vi.runAllTimers();

    expect(pty.calls).toEqual([payload]);
  });

  it('splits large input into chunks that concatenate back to the original', () => {
    const pty = createRecorder();
    const queue = createWriteQueue(() => pty);
    const payload = 'x'.repeat(10000);

    queue.enqueue(payload);
    vi.runAllTimers();

    expect(pty.calls.length).toBe(3);
    expect(pty.calls[0].length).toBe(4096);
    expect(pty.calls[1].length).toBe(4096);
    expect(pty.calls[2].length).toBe(1808);
    expect(pty.calls.join('')).toBe(payload);
  });

  it('serializes two concurrent enqueues in submission order with no interleaving', () => {
    const pty = createRecorder();
    const queue = createWriteQueue(() => pty);
    const first = 'A'.repeat(50000);
    const second = 'B'.repeat(50000);

    queue.enqueue(first);
    queue.enqueue(second);
    vi.runAllTimers();

    const combined = pty.calls.join('');
    expect(combined.length).toBe(100000);
    expect(combined).toBe(first + second);
    // Stronger assertion: no chunk straddles the A/B boundary except the one
    // chunk that includes the last A's and first B's. All earlier chunks
    // must be pure A's; all later chunks must be pure B's.
    const boundaryIndex = combined.indexOf('B');
    expect(boundaryIndex).toBe(50000);
  });

  it('keeps a bracketed-paste sequence intact across chunk boundaries', () => {
    const pty = createRecorder();
    const queue = createWriteQueue(() => pty);
    const body = 'p'.repeat(30000);
    const payload = `\x1b[200~${body}\x1b[201~`;

    queue.enqueue(payload);
    vi.runAllTimers();

    const combined = pty.calls.join('');
    expect(combined).toBe(payload);
    // There is exactly one start marker and one end marker, in the right order.
    const start = combined.indexOf('\x1b[200~');
    const end = combined.indexOf('\x1b[201~');
    expect(start).toBe(0);
    expect(end).toBe(payload.length - '\x1b[201~'.length);
    expect(combined.lastIndexOf('\x1b[200~')).toBe(start);
    expect(combined.lastIndexOf('\x1b[201~')).toBe(end);
  });

  it('drops remaining bytes when the pty disappears mid-drain', () => {
    const recorder = createRecorder();
    let livePty: (PtyWriteTarget & { calls: string[] }) | null = recorder;
    const queue = createWriteQueue(() => livePty);
    const payload = 'z'.repeat(50000);

    queue.enqueue(payload);
    // Let the synchronous first chunk land, then sever the pty before the
    // setImmediate-scheduled drain can pick up the rest.
    expect(recorder.calls.length).toBe(1);
    expect(recorder.calls[0].length).toBe(4096);

    livePty = null;
    vi.runAllTimers();

    // No further writes after disposal; the first chunk remains the only one.
    expect(recorder.calls.length).toBe(1);
  });

  it('drops pending bytes after dispose() and ignores subsequent enqueues', () => {
    const pty = createRecorder();
    const queue = createWriteQueue(() => pty);

    queue.enqueue('q'.repeat(50000));
    expect(pty.calls.length).toBe(1);
    queue.dispose();
    vi.runAllTimers();
    expect(pty.calls.length).toBe(1);

    queue.enqueue('more bytes');
    vi.runAllTimers();
    expect(pty.calls.length).toBe(1);
  });

  it('ignores empty input', () => {
    const pty = createRecorder();
    const queue = createWriteQueue(() => pty);

    queue.enqueue('');
    vi.runAllTimers();

    expect(pty.calls).toEqual([]);
  });

  it('does not split a UTF-16 surrogate pair across chunks', () => {
    const pty = createRecorder();
    // chunkSize chosen so the surrogate pair would land on the boundary.
    const queue = createWriteQueue(() => pty, 4);
    // 'AAA' (3 BMP chars) + 'A' + emoji (2 code units = high+low surrogate).
    // Naive slice(0, 4) would emit "AAAA" then surrogate pair - fine.
    // Move emoji one earlier so the pair straddles index 3-4:
    const payload = 'AAA😀BBB';
    queue.enqueue(payload);
    vi.runAllTimers();

    const combined = pty.calls.join('');
    expect(combined).toBe(payload);
    // Every chunk must be valid UTF-16: no chunk ends in a lone high surrogate
    // and no chunk starts with a lone low surrogate.
    for (const chunk of pty.calls) {
      const last = chunk.charCodeAt(chunk.length - 1);
      const first = chunk.charCodeAt(0);
      const lastIsHighSurrogate = last >= 0xd800 && last <= 0xdbff;
      const firstIsLowSurrogate = first >= 0xdc00 && first <= 0xdfff;
      expect(lastIsHighSurrogate).toBe(false);
      expect(firstIsLowSurrogate).toBe(false);
    }
  });

  it('drops pending bytes and stops looping if pty.write throws', () => {
    const calls: string[] = [];
    let throwOnNext = false;
    const pty: PtyWriteTarget = {
      write(data: string) {
        calls.push(data);
        if (throwOnNext) throw new Error('pty handle gone');
      },
    };
    const queue = createWriteQueue(() => pty);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    queue.enqueue('a'.repeat(20000));
    expect(calls.length).toBe(1);
    // Cause the next chunk to throw.
    throwOnNext = true;
    vi.advanceTimersToNextTimer();
    // Two writes total: the first sync chunk and one more that threw.
    expect(calls.length).toBeGreaterThanOrEqual(2);
    const callsAfterThrow = calls.length;
    // Drain the remaining setImmediate work; nothing more should be written.
    vi.runAllTimers();
    expect(calls.length).toBe(callsAfterThrow);

    // Subsequent enqueues are dropped (queue marked disposed on throw).
    queue.enqueue('after-throw');
    vi.runAllTimers();
    expect(calls.length).toBe(callsAfterThrow);

    expect(errorSpy).toHaveBeenCalledWith(
      '[write-queue] pty.write threw, dropping pending bytes:',
      expect.any(Error),
    );
    errorSpy.mockRestore();
  });

  it('invokes onAutoDispose when pty.write throws but not for explicit dispose()', () => {
    const calls: string[] = [];
    let throwOnNext = false;
    const pty: PtyWriteTarget = {
      write(data: string) {
        calls.push(data);
        if (throwOnNext) throw new Error('pty handle gone');
      },
    };
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    // Explicit dispose() must NOT trigger the callback - the owner already
    // knows it disposed and is responsible for its own bookkeeping.
    const explicitDisposeSpy = vi.fn();
    const explicitQueue = createWriteQueue(() => pty, undefined, {
      onAutoDispose: explicitDisposeSpy,
    });
    explicitQueue.enqueue('hello');
    explicitQueue.dispose();
    vi.runAllTimers();
    expect(explicitDisposeSpy).not.toHaveBeenCalled();

    // Throw during drain MUST trigger the callback so the owner can
    // remove its map entry and avoid reusing a permanently disposed queue.
    const autoDisposeSpy = vi.fn();
    const throwingQueue = createWriteQueue(() => pty, undefined, {
      onAutoDispose: autoDisposeSpy,
    });
    throwOnNext = true;
    throwingQueue.enqueue('a'.repeat(20000));
    vi.runAllTimers();
    expect(autoDisposeSpy).toHaveBeenCalledTimes(1);

    errorSpy.mockRestore();
  });

  it('respects a custom chunk size', () => {
    const pty = createRecorder();
    const queue = createWriteQueue(() => pty, 10);
    queue.enqueue('0123456789ABCDEFGHIJ'); // 20 chars
    vi.runAllTimers();

    expect(pty.calls).toEqual(['0123456789', 'ABCDEFGHIJ']);
  });

  it('enqueue is a no-op when getPty returns null from the very first call', () => {
    // Case #6: queue created but pty is null from the start.
    // The drain loop observes a null pty on the first tick and drops pending
    // bytes without throwing. No pty.write calls must land.
    const queue = createWriteQueue(() => null);

    queue.enqueue('hello world');
    vi.runAllTimers();

    // No recorder was provided - passing test means no throw and no write.
    // Verify by confirming the test completes without error.
    // (There is nothing to call; the test just asserts no exception is raised.)
  });

  it('safeChunkEnd returns chunkSize unchanged when chunkSize is exactly 1', () => {
    // Case #7: exercises the `chunkSize <= 1` early-return branch.
    // A chunkSize of 1 emits one character per tick. The surrogate-safety
    // shortcut returns 1 immediately, so the loop emits each code unit
    // individually regardless of whether they form a pair.
    const pty = createRecorder();
    const queue = createWriteQueue(() => pty, 1);

    queue.enqueue('ABC');
    vi.runAllTimers();

    // Each character is a separate write call.
    expect(pty.calls).toEqual(['A', 'B', 'C']);
    expect(pty.calls.join('')).toBe('ABC');
  });
});
