import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  getCachedTaskTitle,
  resetTaskTitleCacheForTest,
} from '../../src/main/ipc/handlers/task-title-cache';

beforeEach(() => {
  resetTaskTitleCacheForTest();
});

describe('getCachedTaskTitle', () => {
  it('loads once and serves repeated reads within the TTL from cache', () => {
    const load = vi.fn(() => 'Build the thing');
    expect(getCachedTaskTitle('t1', 1000, load)).toBe('Build the thing');
    expect(getCachedTaskTitle('t1', 1500, load)).toBe('Build the thing');
    expect(getCachedTaskTitle('t1', 5999, load)).toBe('Build the thing');
    expect(load).toHaveBeenCalledTimes(1); // only one DB hit across three reads
  });

  it('reloads once the TTL has elapsed', () => {
    const load = vi.fn().mockReturnValueOnce('Old name').mockReturnValueOnce('New name');
    expect(getCachedTaskTitle('t1', 1000, load)).toBe('Old name');
    expect(getCachedTaskTitle('t1', 6001, load)).toBe('New name'); // 5001ms later -> reload
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('caches a per-task title independently', () => {
    const load1 = vi.fn(() => 'Task one');
    const load2 = vi.fn(() => 'Task two');
    expect(getCachedTaskTitle('t1', 1000, load1)).toBe('Task one');
    expect(getCachedTaskTitle('t2', 1000, load2)).toBe('Task two');
    expect(getCachedTaskTitle('t1', 1100, load1)).toBe('Task one');
    expect(load1).toHaveBeenCalledTimes(1);
    expect(load2).toHaveBeenCalledTimes(1);
  });

  it('caches an undefined result (a missing task) without re-querying', () => {
    const load = vi.fn(() => undefined);
    expect(getCachedTaskTitle('gone', 1000, load)).toBeUndefined();
    expect(getCachedTaskTitle('gone', 1200, load)).toBeUndefined();
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('clears the whole cache when size reaches MAX_ENTRIES, forcing misses on previously cached keys', () => {
    const now = 1000;

    // Fill cache to exactly MAX_ENTRIES (1000) distinct entries.
    for (let i = 0; i < 1000; i++) {
      getCachedTaskTitle(`task-evict-${i}`, now, () => `title-${i}`);
    }

    // Calling with a new taskId hits the size guard (1000 >= 1000) -> cache.clear().
    const loadNew = vi.fn(() => 'the new title');
    const result = getCachedTaskTitle('task-evict-new', now, loadNew);
    expect(loadNew).toHaveBeenCalledTimes(1);
    expect(result).toBe('the new title');

    // The clear wiped all 1000 prior entries. 'task-evict-0' was inserted at the
    // same `now` (TTL has not elapsed), so WITHOUT the clear it would be a cache
    // hit and the load below would NOT be called. With the clear it must be a miss.
    const reloadPrevious = vi.fn(() => 'reloaded');
    getCachedTaskTitle('task-evict-0', now, reloadPrevious);
    expect(reloadPrevious).toHaveBeenCalledTimes(1);
  });
});
