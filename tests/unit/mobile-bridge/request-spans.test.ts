import { describe, it, expect, beforeEach, afterEach, vi, type MockInstance } from 'vitest';
import { noteRequestSpan, takeRequestSpans, resetRequestSpansForTests, startMainLoopBlockProbe } from '../../../src/main/mobile-bridge/request-spans';

function spinFor(durationMs: number): void {
  const until = performance.now() + durationMs;
  while (performance.now() < until) {
    // Holds the event loop, the way a slow synchronous handler would.
  }
}

const wait = (durationMs: number) => new Promise<void>((resolve) => setTimeout(resolve, durationMs));

describe('main-loop block probe', () => {
  afterEach(() => {
    resetRequestSpansForTests();
    vi.useRealTimers();
  });

  it('reads a block in the middle of the window close to its length', async () => {
    const stopProbe = startMainLoopBlockProbe();
    await wait(60);
    spinFor(300);
    await wait(60);
    expect(stopProbe()).toBeGreaterThanOrEqual(250);
  });

  it('counts a block still running when the probe stops', () => {
    const stopProbe = startMainLoopBlockProbe();
    spinFor(300);
    expect(stopProbe()).toBeGreaterThanOrEqual(250);
  });

  // Fake timers fire every tick on time, so a free loop reads 0 here. On real
  // timers a loaded CI runner can stall a single tick past any fixed bound.
  it('stays at the timer floor while the loop is free', () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'performance'] });
    const stopProbe = startMainLoopBlockProbe();
    vi.advanceTimersByTime(200);
    expect(stopProbe()).toBe(0);
  });

  it('stops ticking on its own when nobody stops it', () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'performance'] });
    startMainLoopBlockProbe();
    expect(vi.getTimerCount()).toBe(1);
    vi.advanceTimersByTime(120_000);
    expect(vi.getTimerCount()).toBe(0);
  });
});

/**
 * Every in-flight request reads the same event loop, so the probe keeps ONE
 * interval for all of them. These cases count that interval through fake
 * timers, and drive the clock by hand wherever a block has to be simulated:
 * a fake clock cannot jump past a tick that was due, and a real spin would
 * need an upper bound on a runner that can stall for any length of time.
 */
describe('shared main-loop block probe', () => {
  let nowSpy: MockInstance<() => number> | null = null;

  afterEach(() => {
    nowSpy?.mockRestore();
    nowSpy = null;
    // Reset while the fake timers are still installed, so the interval it
    // clears is the fake one.
    resetRequestSpansForTests();
    vi.useRealTimers();
  });

  it('runs every in-flight request on one interval, keeps it until the last one stops, and starts a fresh one afterwards', () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'performance'] });
    const stopFirst = startMainLoopBlockProbe();
    expect(vi.getTimerCount()).toBe(1);
    const stopSecond = startMainLoopBlockProbe();
    expect(vi.getTimerCount()).toBe(1);

    stopFirst();
    expect(vi.getTimerCount()).toBe(1);
    stopSecond();
    expect(vi.getTimerCount()).toBe(0);

    const stopThird = startMainLoopBlockProbe();
    expect(vi.getTimerCount()).toBe(1);
    stopThird();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('does not charge a request for the part of a block that came before it arrived', () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    let clockMs = 0;
    nowSpy = vi.spyOn(performance, 'now').mockImplementation(() => clockMs);

    const stopEarlier = startMainLoopBlockProbe();
    // Main is blocked for 300 ms with the earlier request in flight: the
    // probe's tick, due at 20 ms, cannot run. The later request arrives the
    // instant the block ends, before that late tick fires.
    clockMs = 300;
    const stopLater = startMainLoopBlockProbe();
    clockMs = 301;
    vi.advanceTimersByTime(20);

    // The earlier request waited out the whole block, from the tick it was
    // due at (20 ms) to now. The later one saw only the 1 ms since it arrived.
    expect(stopEarlier()).toBe(281);
    expect(stopLater()).toBe(1);
  });

  it('charges a request stopped before any tick only from its arrival, even while an earlier request is still in flight', () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    let clockMs = 0;
    nowSpy = vi.spyOn(performance, 'now').mockImplementation(() => clockMs);

    const stopEarlier = startMainLoopBlockProbe();
    clockMs = 300;
    const stopLater = startMainLoopBlockProbe();
    // A synchronous handler answers inside the same turn: no tick ever ran,
    // so the stop call itself is what measures the block.
    clockMs = 305;
    expect(stopLater()).toBe(5);
    expect(stopEarlier()).toBe(285);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('drops a watcher that outlives the 120 s cap while a newer one keeps the shared interval alive', () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'performance'] });
    const stopExpiring = startMainLoopBlockProbe();
    vi.advanceTimersByTime(60_000);
    const stopNewer = startMainLoopBlockProbe();
    // The tick at 120 000 ms expires the first watcher and nothing else.
    vi.advanceTimersByTime(60_000);
    expect(vi.getTimerCount()).toBe(1);

    // The newer one is the only watcher left, so its stop clears the interval.
    // The first watcher is deliberately never stopped here: an expired watcher
    // that was not removed would keep the interval running past this point.
    stopNewer();
    expect(vi.getTimerCount()).toBe(0);
    expect(stopExpiring()).toBe(0);
  });

  it('lets an expired watcher be stopped later without touching the interval a newer one still needs', () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'performance'] });
    const stopExpiring = startMainLoopBlockProbe();
    vi.advanceTimersByTime(60_000);
    const stopNewer = startMainLoopBlockProbe();
    vi.advanceTimersByTime(60_000);

    // A handler that finally answers after its probe gave up still calls stop.
    expect(stopExpiring()).toBe(0);
    expect(vi.getTimerCount()).toBe(1);
    stopNewer();
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('request spans', () => {
  beforeEach(() => {
    resetRequestSpansForTests();
  });

  it('collects every span for one request in order, and forgets them once taken', () => {
    noteRequestSpan('device-1', 'req-1', 'seed 412 ms, 180k chars');
    noteRequestSpan('device-1', 'req-1', 'transcript 30 ms');
    expect(takeRequestSpans('device-1', 'req-1')).toEqual(['seed 412 ms, 180k chars', 'transcript 30 ms']);
    expect(takeRequestSpans('device-1', 'req-1')).toEqual([]);
  });

  it('keeps two devices that reuse a requestId apart', () => {
    noteRequestSpan('device-1', 'req-1', 'from one');
    noteRequestSpan('device-2', 'req-1', 'from two');
    expect(takeRequestSpans('device-2', 'req-1')).toEqual(['from two']);
    expect(takeRequestSpans('device-1', 'req-1')).toEqual(['from one']);
  });

  it('evicts the oldest request once 256 are held, so spans a dropped session never collects cannot grow the map', () => {
    for (let index = 0; index < 257; index++) noteRequestSpan('device-1', `req-${index}`, `span ${index}`);
    expect(takeRequestSpans('device-1', 'req-0')).toEqual([]);
    expect(takeRequestSpans('device-1', 'req-1')).toEqual(['span 1']);
    expect(takeRequestSpans('device-1', 'req-256')).toEqual(['span 256']);
  });
});
