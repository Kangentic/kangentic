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

  // ---------------------------------------------------------------------
  // useTerminal.ts wiring: shouldDrop: () => suppressDataRef.current,
  // shouldHold: () => isBoardDragActive() || scrollbackPendingRef.current.
  // A scrollback replay now HOLDS (not drops) live bytes, so a fullscreen
  // TUI's selection-highlight diff arriving during a replay is never
  // silently discarded - it applies strictly after the replayed frame.
  // ---------------------------------------------------------------------
  it('a scrollback replay holds live bytes and flushes them in order once it clears (no byte lost across the replay)', async () => {
    const { term, writes } = fakeTerminal();
    const ack = vi.fn();
    const scrollbackPendingRef = { current: true };
    const suppressDataRef = { current: false };
    const queue = createIncomingWriteQueue({
      getTerminal: () => term,
      shouldDrop: () => suppressDataRef.current,
      shouldHold: () => scrollbackPendingRef.current,
      ack,
      chunkSize: 4,
    });

    // A live diff frame arrives while the replay is still in flight.
    queue.push('diff-frame-1');
    await flush();
    expect(writes).toEqual([]);
    expect(ack).not.toHaveBeenCalled();

    // More live bytes arrive before the replay finishes.
    queue.push('-diff-frame-2');
    await flush();
    expect(writes).toEqual([]);
    expect(ack).not.toHaveBeenCalled();

    // The replay's afterWrite clears pending and kicks the queue.
    scrollbackPendingRef.current = false;
    queue.kick();
    await flush();

    // Every held byte was written, in order, strictly after the replay -
    // nothing pushed during the window was silently dropped.
    const expected = 'diff-frame-1-diff-frame-2';
    expect(writes.join('')).toBe(expected);
    const totalAcked = ack.mock.calls.reduce((sum, call) => sum + call[0], 0);
    expect(totalAcked).toBe(expected.length);
  });

  // useTerminal.ts wiring: shouldDrop also includes isTerminalParked(sessionId)
  // (parked-terminals.ts). A parked (off-view) terminal must ack-and-drop -
  // never hold - so an indefinitely-parked window cannot wedge the main-process
  // backpressure watermarks; the dropped bytes accumulate in main's scrollback
  // ring and the reveal-time reloadScrollback repaints them.
  it('a parked terminal acks-and-drops live bytes, then writes live bytes again once revealed', async () => {
    const { term, writes } = fakeTerminal();
    const ack = vi.fn();
    let parked = true;
    const queue = createIncomingWriteQueue({
      getTerminal: () => term,
      shouldDrop: () => parked,
      ack,
      chunkSize: 4,
    });

    queue.push('streamed-while-parked');
    await flush();
    expect(writes).toEqual([]);
    const ackedWhileParked = ack.mock.calls.reduce((sum, call) => sum + call[0], 0);
    expect(ackedWhileParked).toBe('streamed-while-parked'.length);

    // Reveal: the stale frame is repainted by reloadScrollback (not the queue);
    // new live bytes flow through normally again.
    parked = false;
    queue.push('live');
    await flush();
    expect(writes.join('')).toBe('live');
  });

  it('an overlay with no active replay still drops-and-acks immediately (unaffected by the replay-hold change)', async () => {
    const { term, writes } = fakeTerminal();
    const ack = vi.fn();
    const scrollbackPendingRef = { current: false };
    const suppressDataRef = { current: true };
    const queue = createIncomingWriteQueue({
      getTerminal: () => term,
      shouldDrop: () => suppressDataRef.current,
      shouldHold: () => scrollbackPendingRef.current,
      ack,
    });

    queue.push('startup noise');
    await flush();

    expect(writes).toEqual([]);
    expect(ack).toHaveBeenCalledWith('startup noise'.length);
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
