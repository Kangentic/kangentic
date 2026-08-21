import { describe, it, expect } from 'vitest';
import { touchBounded, heldBytes } from '../../src/main/agent/shared/bounded-lru';

/**
 * Pins the shared count+bytes LRU eviction used by the three transcript caches.
 *
 * The assertions that matter are on BYTES. The bug this module exists to
 * prevent - a cache capped by record count while retaining unbounded per-record
 * payloads - passes every count-based assertion while holding gigabytes, which
 * is precisely how it survived unnoticed until a main-process OOM. A test that
 * only counted records would have stayed green throughout.
 *
 * Budgets are parameters rather than module constants specifically so this runs
 * against a few hundred synthetic bytes instead of writing the real multi-MB
 * budgets to disk.
 */

interface SizedRecord {
  name: string;
  bytes: number;
}

const sizeOf = (record: SizedRecord): number => record.bytes;

function seed(entries: Array<[string, number]>): Map<string, SizedRecord> {
  return new Map(entries.map(([name, bytes]) => [name, { name, bytes }]));
}

describe('touchBounded', () => {
  it('evicts the least-recently-used record once the COUNT cap is exceeded', () => {
    const map = new Map<string, SizedRecord>();
    for (let index = 0; index < 5; index += 1) {
      touchBounded(map, `k${index}`, { name: `k${index}`, bytes: 1 }, {
        limit: 3, byteBudget: 1_000_000, sizeOf, minRetained: 1,
      });
    }
    expect([...map.keys()]).toEqual(['k2', 'k3', 'k4']);
  });

  it('evicts on the BYTE budget while the count cap is still satisfied', () => {
    // The regression guard. Four records is well under the count cap of 32, so
    // a count-only implementation retains all 400 bytes and reports success.
    const map = seed([['a', 100], ['b', 100], ['c', 100]]);
    touchBounded(map, 'd', { name: 'd', bytes: 100 }, {
      limit: 32, byteBudget: 250, sizeOf, minRetained: 1,
    });

    expect(map.size).toBeLessThan(4);
    expect(heldBytes(map, sizeOf)).toBeLessThanOrEqual(250);
    // The newest survives; the oldest went first.
    expect(map.has('d')).toBe(true);
    expect(map.has('a')).toBe(false);
  });

  it('re-inserts an existing key at the most-recently-used end', () => {
    const map = seed([['a', 1], ['b', 1], ['c', 1]]);
    // Touching 'a' must protect it from the next eviction, not leave it oldest.
    touchBounded(map, 'a', { name: 'a', bytes: 1 }, {
      limit: 3, byteBudget: 1_000_000, sizeOf, minRetained: 1,
    });
    expect([...map.keys()]).toEqual(['b', 'c', 'a']);

    touchBounded(map, 'd', { name: 'd', bytes: 1 }, {
      limit: 3, byteBudget: 1_000_000, sizeOf, minRetained: 1,
    });
    expect([...map.keys()]).toEqual(['c', 'a', 'd']);
  });

  it('retains a lone record that alone exceeds the budget when minRetained is 1', () => {
    // Documents the floor's real consequence: sustained over-budget retention
    // rather than evict-and-re-parse thrash. Callers avoid needing this by
    // capping how large any single record can be in the first place.
    const map = new Map<string, SizedRecord>();
    touchBounded(map, 'huge', { name: 'huge', bytes: 10_000 }, {
      limit: 32, byteBudget: 100, sizeOf, minRetained: 1,
    });
    expect(map.size).toBe(1);
    expect(heldBytes(map, sizeOf)).toBe(10_000);
  });

  it('evicts down to nothing when minRetained is 0', () => {
    const map = new Map<string, SizedRecord>();
    touchBounded(map, 'huge', { name: 'huge', bytes: 10_000 }, {
      limit: 32, byteBudget: 100, sizeOf, minRetained: 0,
    });
    expect(map.size).toBe(0);
  });

  it('keeps evicting until BOTH bounds hold, not just the first one checked', () => {
    const map = seed([['a', 500], ['b', 500], ['c', 500], ['d', 500]]);
    touchBounded(map, 'e', { name: 'e', bytes: 500 }, {
      limit: 4, byteBudget: 1200, sizeOf, minRetained: 1,
    });
    expect(map.size).toBeLessThanOrEqual(4);
    expect(heldBytes(map, sizeOf)).toBeLessThanOrEqual(1200);
  });

  it('accounts evicted bytes correctly rather than re-summing a stale total', () => {
    // Mixed sizes: an implementation that decremented by a constant, or forgot
    // to decrement at all, over-evicts and empties the map.
    const map = seed([['a', 10], ['b', 200], ['c', 30]]);
    touchBounded(map, 'd', { name: 'd', bytes: 40 }, {
      limit: 32, byteBudget: 100, sizeOf, minRetained: 1,
    });
    // Dropping 'a' (10) and 'b' (200) is enough; 'c' and 'd' total 70.
    expect([...map.keys()]).toEqual(['c', 'd']);
    expect(heldBytes(map, sizeOf)).toBe(70);
  });
});
