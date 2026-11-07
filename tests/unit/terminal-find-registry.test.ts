/**
 * The registry the find bar and the header icon share. A remount of the same session
 * registers the new bar before the old one cleans up, so the old cleanup must not
 * delete the new entry or the header icon would vanish while the bar is mounted.
 *
 * The vitest config has no DOM renderer, so React's two hooks the control uses are
 * replaced by their plain equivalents: the snapshot read is what the hook returns.
 * The registry's own code is the real one.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react')>();
  return {
    ...actual,
    useCallback: <T>(callback: T) => callback,
    useSyncExternalStore: <T>(_subscribe: unknown, getSnapshot: () => T) => getSnapshot(),
  };
});

import { registerTerminalFind, setTerminalFindOpen, useTerminalFindControl } from '../../src/renderer/utils/terminal-find-registry';

const cleanups: Array<() => void> = [];
function register(sessionId: string, toggle: () => void): () => void {
  const cleanup = registerTerminalFind(sessionId, toggle);
  cleanups.push(cleanup);
  return cleanup;
}

afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.();
});

describe('terminal find registry', () => {
  it('reports a session absent until a bar registers, and absent again after it cleans up', () => {
    expect(useTerminalFindControl('sess-a').available).toBe(false);
    const cleanup = register('sess-a', () => {});
    expect(useTerminalFindControl('sess-a').available).toBe(true);
    cleanup();
    expect(useTerminalFindControl('sess-a').available).toBe(false);
  });

  it('keeps the newer registration of a session when the older one cleans up late', () => {
    const toggleOld = vi.fn();
    const toggleNew = vi.fn();
    const cleanupOld = register('sess-b', toggleOld);
    const cleanupNew = register('sess-b', toggleNew);

    cleanupOld();
    const control = useTerminalFindControl('sess-b');
    expect(control.available).toBe(true);
    control.toggle();
    expect(toggleNew).toHaveBeenCalledTimes(1);
    expect(toggleOld).not.toHaveBeenCalled();

    cleanupNew();
    expect(useTerminalFindControl('sess-b').available).toBe(false);
  });

  it('applies the open state to the live entry, and a re-registration starts closed', () => {
    register('sess-c', () => {});
    setTerminalFindOpen('sess-c', true);
    expect(useTerminalFindControl('sess-c').open).toBe(true);

    register('sess-c', () => {});
    expect(useTerminalFindControl('sess-c').open).toBe(false);
  });

  it('ignores an open state for a session with no bar', () => {
    setTerminalFindOpen('sess-none', true);
    expect(useTerminalFindControl('sess-none')).toMatchObject({ available: false, open: false });
  });
});
