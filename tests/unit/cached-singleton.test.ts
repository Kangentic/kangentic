/**
 * Unit tests for createCachedSingleton (src/main/shared/cached-singleton.ts).
 *
 * This helper backs the agents.list() and shell-enumeration caches. The
 * load-bearing behaviour is in-flight deduplication: at app bootstrap several
 * callers request the same expensive value within one tick, and they must
 * collapse onto a single build rather than each triggering a subprocess storm.
 * A pure counting builder exercises caching, dedup, invalidation, forceRefresh,
 * and rejection handling without any I/O or mocks.
 */
import { describe, it, expect, vi } from 'vitest';
import { createCachedSingleton } from '../../src/main/shared/cached-singleton';

/** A builder whose call count is observable and whose resolution is deferred
 *  until `release()` so concurrency can be controlled deterministically. */
function deferredBuilder<T>(value: T) {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const builder = vi.fn(async () => {
    await gate;
    return value;
  });
  return { builder, release };
}

describe('createCachedSingleton', () => {
  it('runs the builder once and caches the resolved value', async () => {
    const builder = vi.fn(async () => 42);
    const cache = createCachedSingleton<number>();

    const first = await cache.get(builder);
    const second = await cache.get(builder);

    expect(first).toBe(42);
    expect(second).toBe(42);
    expect(builder).toHaveBeenCalledTimes(1);
  });

  it('collapses concurrent cold calls onto a single in-flight build', async () => {
    const { builder, release } = deferredBuilder('value');
    const cache = createCachedSingleton<string>();

    // Three callers race before the build resolves.
    const calls = [cache.get(builder), cache.get(builder), cache.get(builder)];
    release();
    const results = await Promise.all(calls);

    expect(results).toEqual(['value', 'value', 'value']);
    expect(builder).toHaveBeenCalledTimes(1);
  });

  it('rebuilds after invalidate()', async () => {
    let counter = 0;
    const builder = vi.fn(async () => ++counter);
    const cache = createCachedSingleton<number>();

    expect(await cache.get(builder)).toBe(1);
    cache.invalidate();
    expect(await cache.get(builder)).toBe(2);
    expect(builder).toHaveBeenCalledTimes(2);
  });

  it('forceRefresh bypasses the cached value and rebuilds', async () => {
    let counter = 0;
    const builder = vi.fn(async () => ++counter);
    const cache = createCachedSingleton<number>();

    expect(await cache.get(builder)).toBe(1);
    expect(await cache.get(builder, true)).toBe(2);
    // A subsequent normal call serves the freshly cached value.
    expect(await cache.get(builder)).toBe(2);
    expect(builder).toHaveBeenCalledTimes(2);
  });

  it('does not strand future callers when a build rejects', async () => {
    const builder = vi
      .fn<() => Promise<number>>()
      .mockRejectedValueOnce(new Error('probe failed'))
      .mockResolvedValueOnce(7);
    const cache = createCachedSingleton<number>();

    await expect(cache.get(builder)).rejects.toThrow('probe failed');
    // The failed slot was cleared, so the next call retries and succeeds.
    expect(await cache.get(builder)).toBe(7);
    expect(builder).toHaveBeenCalledTimes(2);
  });

  it('a forceRefresh build wins even if the superseded cold build resolves later', async () => {
    // Race: a slow cold build (P1) is in flight when forceRefresh starts a new
    // build (P2). P2 resolves first and caches its fresh value; P1 resolves
    // afterward and must NOT clobber the cache with its now-stale value.
    const stale = deferredBuilder('stale');
    const fresh = deferredBuilder('fresh');
    const builder = vi
      .fn<() => Promise<string>>()
      .mockImplementationOnce(stale.builder)
      .mockImplementationOnce(fresh.builder);
    const cache = createCachedSingleton<string>();

    const first = cache.get(builder); // P1 (cold) starts
    const second = cache.get(builder, true); // forceRefresh starts P2, abandons P1

    fresh.release();
    expect(await second).toBe('fresh'); // P2 publishes first

    stale.release();
    expect(await first).toBe('stale'); // P1's own caller still gets its value...

    // ...but the cache keeps the fresher value P2 published; P1 must not win.
    expect(await cache.get(builder)).toBe('fresh');
    expect(builder).toHaveBeenCalledTimes(2);
  });

  it('invalidate() during a cold build prevents the build result from being cached', async () => {
    // The CONFIG_SET-during-cold-build path: a cold build (P1) is in-flight when
    // invalidate() fires (e.g. the user saves agent config). When P1 eventually
    // resolves, it must NOT publish its value to the cache because invalidate()
    // bumped buildSequence. A subsequent get() must trigger a fresh build.
    const coldDeferred = deferredBuilder('cold-result');
    const cache = createCachedSingleton<string>();

    // Step 1: start the cold build (P1 in-flight, builder called once).
    const coldPromise = cache.get(coldDeferred.builder);
    expect(coldDeferred.builder).toHaveBeenCalledTimes(1);

    // Step 2: invalidate() fires while P1 is still pending - bumps buildSequence.
    cache.invalidate();

    // Step 3: release the cold build so P1 resolves to 'cold-result'.
    coldDeferred.release();

    // Step 4: await P1 - the original caller still receives the value they were waiting for.
    const coldResult = await coldPromise;
    expect(coldResult).toBe('cold-result');

    // Step 5: a new get() must trigger a fresh build (P1's value was NOT published).
    const freshDeferred = deferredBuilder('fresh-result');
    freshDeferred.release();
    const freshResult = await cache.get(freshDeferred.builder);
    expect(freshResult).toBe('fresh-result');

    // Confirm each builder was invoked exactly once.
    expect(coldDeferred.builder).toHaveBeenCalledTimes(1);
    expect(freshDeferred.builder).toHaveBeenCalledTimes(1);
  });
});
