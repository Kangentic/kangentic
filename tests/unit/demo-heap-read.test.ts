/**
 * `readGcHeap` in demo/heap.mjs: the one read of "the JS heap after a forced GC" that the web demo's
 * budget guard (tests/demo/heap-budget.spec.ts) and `node demo/measure.mjs --heap` share.
 *
 * The page and the CDP session are stubs, so no browser starts. What this pins is the contract
 * around them: the figure is `usedSize + backingStorageSize` in MB to one decimal (what
 * `performance.memory.usedJSHeapSize` reads with precise memory info, which kangentic.com budgets),
 * the heap is read only after the settle pause that follows the GC, and a page launched without
 * `--expose-gc`, or a Chromium whose `Runtime.getHeapUsage` has no backing size, fails loudly
 * instead of reporting a number that leaves the backing stores out.
 *
 * The settle pause is a real `setTimeout`, so the tests run on fake timers.
 *
 * Tier: Unit.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { readGcHeap } from '../../demo/heap.mjs';

type Page = Parameters<typeof readGcHeap>[0];
type CdpSession = Parameters<typeof readGcHeap>[1];

const BYTES_PER_MB = 1024 * 1024;
const toBytes = (megabytes: number): number => Math.round(megabytes * BYTES_PER_MB);

function stubPage(collected: boolean) {
  const evaluate = vi.fn(async () => collected);
  return { evaluate, page: { evaluate } as unknown as Page };
}

function stubCdpSession(usage: { usedSize?: number; backingStorageSize?: number }) {
  const send = vi.fn(async () => usage);
  return { send, cdpSession: { send } as unknown as CdpSession };
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('readGcHeap', () => {
  it('reports the sum of used and backing size, rounded once to a decimal, with each part beside it', async () => {
    vi.useFakeTimers();
    // 10.04 MB and 5.04 MB: each part rounds to a whole 10.0 and 5.0, so a sum taken AFTER rounding
    // the parts reads 15.0, while the sum of the real sizes (15.08 MB) rounds to 15.1.
    const { page } = stubPage(true);
    const { cdpSession } = stubCdpSession({ usedSize: toBytes(10.04), backingStorageSize: toBytes(5.04) });

    const read = readGcHeap(page, cdpSession);
    await vi.runAllTimersAsync();

    expect(await read).toEqual({ heapMb: 15.1, usedMb: 10, backingMb: 5 });
  });

  it('asks the page for its gc and the isolate for Runtime.getHeapUsage', async () => {
    vi.useFakeTimers();
    const { page, evaluate } = stubPage(true);
    const { cdpSession, send } = stubCdpSession({ usedSize: toBytes(8), backingStorageSize: toBytes(2) });

    const read = readGcHeap(page, cdpSession);
    await vi.runAllTimersAsync();
    await read;

    expect(evaluate).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith('Runtime.getHeapUsage');
  });

  it('reads the heap only after the settle pause that follows the GC', async () => {
    vi.useFakeTimers();
    const { page } = stubPage(true);
    const { cdpSession, send } = stubCdpSession({ usedSize: toBytes(8), backingStorageSize: toBytes(2) });

    const read = readGcHeap(page, cdpSession);
    await vi.advanceTimersByTimeAsync(100);
    expect(send).not.toHaveBeenCalled();

    await vi.runAllTimersAsync();
    await read;
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('throws, naming HEAP_LAUNCH_ARGS, when the page has no gc(), and reads no heap', async () => {
    vi.useFakeTimers();
    const { page } = stubPage(false);
    const { cdpSession, send } = stubCdpSession({ usedSize: toBytes(8), backingStorageSize: toBytes(2) });

    // Timers are run too, so that if the guard goes the read finishes and this fails at once
    // instead of waiting on a settle pause the fake clock never advances.
    const settled = expect(readGcHeap(page, cdpSession)).rejects.toThrow(/HEAP_LAUNCH_ARGS/);
    await vi.runAllTimersAsync();
    await settled;
    expect(send).not.toHaveBeenCalled();
  });

  it('throws when Runtime.getHeapUsage reports no backingStorageSize, rather than reading used size alone', async () => {
    vi.useFakeTimers();
    const { page } = stubPage(true);
    const { cdpSession } = stubCdpSession({ usedSize: toBytes(8) });

    // The rejection handler goes on before the timers run, or Node reports it as unhandled.
    const settled = expect(readGcHeap(page, cdpSession)).rejects.toThrow(/backingStorageSize/);
    await vi.runAllTimersAsync();
    await settled;
  });

  it('runs the page function as two forced collections, and reports a page without gc() as not collected', async () => {
    vi.useFakeTimers();
    const { page, evaluate } = stubPage(true);
    const { cdpSession } = stubCdpSession({ usedSize: toBytes(8), backingStorageSize: toBytes(2) });
    const read = readGcHeap(page, cdpSession);
    await vi.runAllTimersAsync();
    await read;

    // The function readGcHeap hands to page.evaluate runs here, in place of the browser.
    const pageFunction = (evaluate.mock.calls[0] as unknown as [() => boolean])[0];
    const forceGc = vi.fn();
    vi.stubGlobal('gc', forceGc);
    expect(pageFunction()).toBe(true);
    expect(forceGc).toHaveBeenCalledTimes(2);

    vi.stubGlobal('gc', undefined);
    expect(pageFunction()).toBe(false);
  });
});
