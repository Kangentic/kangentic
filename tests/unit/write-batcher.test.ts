import { describe, it, expect, vi } from 'vitest';
import { createWriteBatcher } from '../../src/renderer/utils/write-batcher';

/** Wait for all pending microtasks to drain. */
const drainMicrotasks = () => new Promise<void>((resolve) => queueMicrotask(resolve));

describe('createWriteBatcher', () => {
  it('coalesces a synchronous burst into a single write with concatenated payload', async () => {
    const write = vi.fn<[string], void>();
    const batcher = createWriteBatcher(write);

    batcher.schedule('h');
    batcher.schedule('e');
    batcher.schedule('l');
    batcher.schedule('l');
    batcher.schedule('o');

    expect(write).not.toHaveBeenCalled();

    await drainMicrotasks();

    expect(write).toHaveBeenCalledTimes(1);
    expect(write).toHaveBeenCalledWith('hello');
  });

  it('skips the join step when only one chunk was queued', async () => {
    const write = vi.fn<[string], void>();
    const batcher = createWriteBatcher(write);

    batcher.schedule('x');
    await drainMicrotasks();

    expect(write).toHaveBeenCalledTimes(1);
    expect(write).toHaveBeenCalledWith('x');
  });

  it('emits one write per microtask burst (two bursts -> two writes)', async () => {
    const write = vi.fn<[string], void>();
    const batcher = createWriteBatcher(write);

    batcher.schedule('a');
    batcher.schedule('b');
    await drainMicrotasks();

    batcher.schedule('c');
    batcher.schedule('d');
    await drainMicrotasks();

    expect(write.mock.calls).toEqual([['ab'], ['cd']]);
  });

  it('flush() drains pending data synchronously without waiting for the microtask', () => {
    const write = vi.fn<[string], void>();
    const batcher = createWriteBatcher(write);

    batcher.schedule('pending');
    expect(write).not.toHaveBeenCalled();

    batcher.flush();
    expect(write).toHaveBeenCalledTimes(1);
    expect(write).toHaveBeenCalledWith('pending');
  });

  it('flush() is a no-op when queue is empty', () => {
    const write = vi.fn<[string], void>();
    const batcher = createWriteBatcher(write);

    batcher.flush();
    batcher.flush();

    expect(write).not.toHaveBeenCalled();
  });

  it('an already-scheduled microtask still flushes (no double-write) after manual flush', async () => {
    const write = vi.fn<[string], void>();
    const batcher = createWriteBatcher(write);

    batcher.schedule('foo');
    batcher.flush();

    expect(write).toHaveBeenCalledTimes(1);
    expect(write).toHaveBeenCalledWith('foo');

    await drainMicrotasks();

    // The scheduled microtask fires but finds an empty queue, so no second write.
    expect(write).toHaveBeenCalledTimes(1);
  });

  it('preserves chunk order across the concatenated payload', async () => {
    const write = vi.fn<[string], void>();
    const batcher = createWriteBatcher(write);

    batcher.schedule('first\r\n');
    batcher.schedule('second\r\n');
    batcher.schedule('third');

    await drainMicrotasks();

    expect(write).toHaveBeenCalledWith('first\r\nsecond\r\nthird');
  });
});
