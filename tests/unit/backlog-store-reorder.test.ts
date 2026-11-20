/**
 * `reorderItems(ids, movedId)` mirrors what main does for a backlog drag (task #1137): the moved
 * row's Updated time is stamped at once, so the list's Updated column and sort do not wait for the
 * round trip, and the rows it displaced keep their own. With no `movedId` nothing is stamped.
 * Both ids go to `window.electronAPI.backlog.reorder`. Stub shape follows
 * project-store-load-degradation.test.ts.
 */
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

const backlogApi = { reorder: vi.fn(), list: vi.fn() };

(globalThis as Record<string, unknown>).window = {
  electronAPI: { backlog: backlogApi },
};

import { useBacklogStore } from '../../src/renderer/stores/backlog-store';
import type { BacklogTask } from '../../src/shared/types';

const OLD_TIME = '2026-01-01T00:00:00.000Z';

function makeItem(id: string, position: number): BacklogTask {
  return { id, title: id, position, updated_at: OLD_TIME } as BacklogTask;
}

beforeEach(() => {
  backlogApi.reorder.mockReset();
  backlogApi.reorder.mockResolvedValue(undefined);
  useBacklogStore.setState({
    items: [makeItem('a', 0), makeItem('b', 1), makeItem('c', 2)],
  });
});

afterAll(() => {
  delete (globalThis as Record<string, unknown>).window;
});

describe('backlog store reorderItems', () => {
  it('stamps updated_at on only the moved row and sends both arguments to main', async () => {
    const before = Date.now();
    await useBacklogStore.getState().reorderItems(['c', 'a', 'b'], 'c');

    const items = useBacklogStore.getState().items;
    expect(items.map((item) => item.id)).toEqual(['c', 'a', 'b']);
    expect(items.map((item) => item.position)).toEqual([0, 1, 2]);
    const [moved, displacedFirst, displacedSecond] = items;
    expect(Date.parse(moved.updated_at)).toBeGreaterThanOrEqual(before);
    expect(displacedFirst.updated_at).toBe(OLD_TIME);
    expect(displacedSecond.updated_at).toBe(OLD_TIME);
    expect(backlogApi.reorder).toHaveBeenCalledWith(['c', 'a', 'b'], 'c');
  });

  it('stamps nothing when no row is named as moved', async () => {
    await useBacklogStore.getState().reorderItems(['b', 'a', 'c']);

    const items = useBacklogStore.getState().items;
    expect(items.map((item) => item.id)).toEqual(['b', 'a', 'c']);
    expect(items.every((item) => item.updated_at === OLD_TIME)).toBe(true);
    expect(backlogApi.reorder).toHaveBeenCalledWith(['b', 'a', 'c'], undefined);
  });
});
