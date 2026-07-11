/**
 * Unit tests for src/renderer/stores/pop-out-store.ts: the renderer's mirror of which
 * pop-out windows are open, keyed by popOutInstanceKey. Guards the two behaviors this
 * store adds: isOpen() correctly discriminates the global 'stats' key from task-scoped
 * 'changes'/'browser' keys, and loadOpen() hydrates the map from the main-process source
 * of truth (electronAPI.popOut.listOpen()).
 *
 * window.electronAPI.popOut is stubbed globally before importing the store, mirroring
 * mobile-store.test.ts's pattern for a Node (non-jsdom) test environment. import.meta.hot
 * is undefined under vitest, so the store's Pattern E instance-pinning collapses to a
 * plain createPopOutStore() call -- no HMR runtime concerns here.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const listOpenMock = vi.fn<() => Promise<string[]>>();

(globalThis as Record<string, unknown>).window = {
  electronAPI: {
    popOut: {
      listOpen: listOpenMock,
    },
  },
};

import { usePopOutStore } from '../../src/renderer/stores/pop-out-store';

describe('pop-out-store', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    usePopOutStore.setState({ openInstanceKeys: {} });
  });

  describe('isOpen', () => {
    it('discriminates the global "stats" key and task-scoped keys after setOpen()', () => {
      usePopOutStore.getState().setOpen(['stats', 'changes:p1:t1']);

      expect(usePopOutStore.getState().isOpen('stats', {})).toBe(true);
      expect(usePopOutStore.getState().isOpen('changes', { taskId: 't1', projectId: 'p1' })).toBe(true);
      expect(usePopOutStore.getState().isOpen('browser', { taskId: 'x', projectId: 'y' })).toBe(false);
    });
  });

  describe('loadOpen', () => {
    it('hydrates the open-key map from electronAPI.popOut.listOpen()', async () => {
      listOpenMock.mockResolvedValue(['stats']);

      await usePopOutStore.getState().loadOpen();

      expect(usePopOutStore.getState().openInstanceKeys).toEqual({ stats: true });
      expect(usePopOutStore.getState().isOpen('stats', {})).toBe(true);
    });
  });
});
