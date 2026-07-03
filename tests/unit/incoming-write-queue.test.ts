import { describe, it, expect, vi } from 'vitest';
import type { Terminal } from '@xterm/xterm';
import {
  createIncomingWriteQueue,
  writeChunkedToTerminal,
} from '../../src/renderer/utils/incoming-write-queue';

/** Fake xterm: records writes and fires the completion callback on a microtask
 *  (matching xterm's async write-buffer processing). */
function fakeTerminal(): { term: Terminal; writes: string[] } {
  const writes: string[] = [];
  const term = {
    write(data: string, callback?: () => void): void {
      writes.push(data);
      if (callback) queueMicrotask(callback);
    },
  } as unknown as Terminal;
  return { term, writes };
}

/** Let all chained microtasks settle. */
function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

describe('createIncomingWriteQueue', () => {
  it('writes a small chunk through and acks its bytes', async () => {
    const { term, writes } = fakeTerminal();
    const ack = vi.fn();
    const queue = createIncomingWriteQueue({ getTerminal: () => term, shouldDrop: () => false, ack });
    queue.push('hello');
    await flush();
    expect(writes).toEqual(['hello']);
    expect(ack).toHaveBeenCalledWith(5);
  });

  it('splits a large input into capped slices in order, acking each', async () => {
    const { term, writes } = fakeTerminal();
    const ack = vi.fn();
    const queue = createIncomingWriteQueue({
      getTerminal: () => term,
      shouldDrop: () => false,
      ack,
      chunkSize: 4,
    });
    queue.push('abcdefghij'); // 10 chars, chunk 4 -> 4 + 4 + 2
    await flush();
    expect(writes).toEqual(['abcd', 'efgh', 'ij']);
    expect(ack.mock.calls.map((c) => c[0])).toEqual([4, 4, 2]);
    const totalAcked = ack.mock.calls.reduce((sum, c) => sum + c[0], 0);
    expect(totalAcked).toBe(10);
  });

  it('drops slices when shouldDrop is true but still acks them', async () => {
    const { term, writes } = fakeTerminal();
    const ack = vi.fn();
    const queue = createIncomingWriteQueue({
      getTerminal: () => term,
      shouldDrop: () => true,
      ack,
      chunkSize: 4,
    });
    queue.push('abcdef');
    await flush();
    expect(writes).toEqual([]); // nothing written
    const totalAcked = ack.mock.calls.reduce((sum, c) => sum + c[0], 0);
    expect(totalAcked).toBe(6); // but everything acked, so the PTY can resume
  });

  it('drops and acks everything when there is no terminal', async () => {
    const ack = vi.fn();
    const queue = createIncomingWriteQueue({ getTerminal: () => null, shouldDrop: () => false, ack });
    queue.push('orphaned');
    await flush();
    expect(ack).toHaveBeenCalledWith(8);
  });

  it('preserves a UTF-16 surrogate pair across a slice boundary', async () => {
    const { term, writes } = fakeTerminal();
    const ack = vi.fn();
    const queue = createIncomingWriteQueue({
      getTerminal: () => term,
      shouldDrop: () => false,
      ack,
      chunkSize: 4,
    });
    // 'abc' + emoji (2 code units): boundary at 4 would split the pair.
    queue.push('abc\u{1F600}');
    await flush();
    // First slice backs off to 'abc'; the emoji ships whole next.
    expect(writes).toEqual(['abc', '\u{1F600}']);
  });

  it('reset drops pending bytes and acks them', () => {
    const ack = vi.fn();
    // Never drains (no terminal callback fired synchronously); reset clears it.
    const term = { write: () => { /* never calls back */ } } as unknown as Terminal;
    const queue = createIncomingWriteQueue({ getTerminal: () => term, shouldDrop: () => false, ack, chunkSize: 4 });
    queue.push('abcdefgh'); // first slice 'abcd' written (no cb), remainder 'efgh' buffered
    queue.reset();
    // The buffered remainder is acked on reset.
    expect(ack).toHaveBeenCalledWith(4);
  });

  it('holds buffered bytes without writing or acking while shouldHold is true', async () => {
    const { term, writes } = fakeTerminal();
    const ack = vi.fn();
    let held = true;
    const queue = createIncomingWriteQueue({
      getTerminal: () => term,
      shouldDrop: () => false,
      shouldHold: () => held,
      ack,
      chunkSize: 4,
    });
    queue.push('abcdef');
    await flush();
    // Held: nothing written, nothing acked (so main backpressure throttles the PTY).
    expect(writes).toEqual([]);
    expect(ack).not.toHaveBeenCalled();

    // Bytes pushed while held just accumulate.
    queue.push('ghij');
    await flush();
    expect(writes).toEqual([]);

    // Release + kick: the whole retained buffer drains in order and is acked.
    held = false;
    queue.kick();
    await flush();
    expect(writes.join('')).toBe('abcdefghij');
    const totalAcked = ack.mock.calls.reduce((sum, call) => sum + call[0], 0);
    expect(totalAcked).toBe(10);
  });

  it('kick is a no-op when the queue is empty', () => {
    const { term, writes } = fakeTerminal();
    const ack = vi.fn();
    const queue = createIncomingWriteQueue({ getTerminal: () => term, shouldDrop: () => false, ack });
    queue.kick();
    expect(writes).toEqual([]);
    expect(ack).not.toHaveBeenCalled();
  });

  it('resumes into the drop path if shouldDrop is true when the hold clears', async () => {
    const { term, writes } = fakeTerminal();
    const ack = vi.fn();
    let held = true;
    const queue = createIncomingWriteQueue({
      getTerminal: () => term,
      shouldDrop: () => true, // e.g. a scrollback replay took over during the hold
      shouldHold: () => held,
      ack,
      chunkSize: 4,
    });
    queue.push('abcdef');
    await flush();
    expect(ack).not.toHaveBeenCalled(); // held, not dropped

    held = false;
    queue.kick();
    await flush();
    // Now drops-and-acks (no writes), releasing backpressure.
    expect(writes).toEqual([]);
    const totalAcked = ack.mock.calls.reduce((sum, call) => sum + call[0], 0);
    expect(totalAcked).toBe(6);
  });

  it('reset while held still acks the retained bytes', () => {
    const { term } = fakeTerminal();
    const ack = vi.fn();
    const queue = createIncomingWriteQueue({
      getTerminal: () => term,
      shouldDrop: () => false,
      shouldHold: () => true,
      ack,
      chunkSize: 4,
    });
    queue.push('abcdef');
    queue.reset();
    expect(ack).toHaveBeenCalledWith(6);
  });
});

describe('writeChunkedToTerminal', () => {
  it('writes a small string in one call and fires onDone', async () => {
    const { term, writes } = fakeTerminal();
    const onDone = vi.fn();
    writeChunkedToTerminal(term, 'short', onDone, 64);
    await flush();
    expect(writes).toEqual(['short']);
    expect(onDone).toHaveBeenCalledTimes(1);
  });

  it('splits a large string into slices and fires onDone once at the end', async () => {
    const { term, writes } = fakeTerminal();
    const onDone = vi.fn();
    writeChunkedToTerminal(term, 'abcdefghij', onDone, 4);
    await flush();
    expect(writes).toEqual(['abcd', 'efgh', 'ij']);
    expect(onDone).toHaveBeenCalledTimes(1);
    expect(writes.join('')).toBe('abcdefghij');
  });
});
