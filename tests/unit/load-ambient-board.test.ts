/**
 * `loadAmbientBoard` starts a pop-out's board load only AFTER the open project
 * has arrived.
 *
 * A fresh pop-out renderer starts with no `currentProject`, and `loadBoard`
 * drops any load during which the open project changed. The bootstraps used to
 * fire `loadCurrent()` and `loadBoard()` in the same tick, so the board load
 * began under null, saw the project arrive, and published nothing: the Browser
 * and Changes windows sat on their empty states. The order is the whole fix,
 * so these tests pin it directly, with both stores replaced by call recorders.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const stores = vi.hoisted(() => ({
  loadCurrent: vi.fn<() => Promise<void>>(),
  loadBoard: vi.fn<() => Promise<void>>(),
}));

vi.mock('../../src/renderer/stores/project-store', () => ({
  useProjectStore: { getState: () => ({ loadCurrent: stores.loadCurrent }) },
}));

vi.mock('../../src/renderer/stores/board-store', () => ({
  useBoardStore: { getState: () => ({ loadBoard: stores.loadBoard }) },
}));

import { loadAmbientBoard } from '../../src/renderer/pop-out/load-ambient-board';

/** A promise the test settles by hand, so it decides when `loadCurrent` answers. */
function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve: () => void = () => {};
  const promise = new Promise<void>((resolvePromise) => { resolve = resolvePromise; });
  return { promise, resolve };
}

/** Let every queued microtask and one macrotask run, so a `.then` chain has fully drained. */
function drain(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

describe('loadAmbientBoard', () => {
  beforeEach(() => {
    stores.loadCurrent.mockReset();
    stores.loadBoard.mockReset();
    stores.loadBoard.mockResolvedValue(undefined);
  });

  it('does not start the board load until the open project has loaded', async () => {
    const currentLoad = deferred();
    stores.loadCurrent.mockReturnValue(currentLoad.promise);

    loadAmbientBoard(new AbortController().signal);

    // Same tick, and after every queued microtask: the board load must still be
    // waiting on the project, not racing it.
    expect(stores.loadCurrent).toHaveBeenCalledTimes(1);
    expect(stores.loadBoard).not.toHaveBeenCalled();
    await drain();
    expect(stores.loadBoard).not.toHaveBeenCalled();

    currentLoad.resolve();
    await drain();

    expect(stores.loadBoard).toHaveBeenCalledTimes(1);
    expect(stores.loadCurrent.mock.invocationCallOrder[0])
      .toBeLessThan(stores.loadBoard.mock.invocationCallOrder[0]);
  });

  it('never starts the board load when the window was torn down before the project answered', async () => {
    const currentLoad = deferred();
    stores.loadCurrent.mockReturnValue(currentLoad.promise);
    const controller = new AbortController();

    loadAmbientBoard(controller.signal);
    controller.abort();
    currentLoad.resolve();
    await drain();

    expect(stores.loadCurrent).toHaveBeenCalledTimes(1);
    expect(stores.loadBoard).not.toHaveBeenCalled();
  });
});
