import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
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

  it('stays near the timer floor while the loop is free', async () => {
    const stopProbe = startMainLoopBlockProbe();
    await wait(200);
    expect(stopProbe()).toBeLessThan(150);
  });

  it('stops ticking on its own when nobody stops it', () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'performance'] });
    startMainLoopBlockProbe();
    expect(vi.getTimerCount()).toBe(1);
    vi.advanceTimersByTime(120_000);
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
