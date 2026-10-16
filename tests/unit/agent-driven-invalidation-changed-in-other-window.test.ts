/**
 * The `tasks.onChangedInOtherWindow` subscriber in `useAgentDrivenInvalidation`.
 *
 * Main pushes this when the DETACHED Agent Monitor writes a task, because that
 * window has stores of its own and the main window's board would otherwise keep
 * the card where it was. The policy is the one every sibling push uses, with
 * two differences this file pins:
 *   - the open project reloads the board AND the backlog (a Backlog demote
 *     moves a task off the board and into the backlog), each on the shared
 *     250ms debounce and through `enqueueReload` so a drag holds it;
 *   - it is quiet: the user made the change themselves, so no toast.
 *
 * The hook is a React `useEffect` and the unit tier has no DOM, so `react` is
 * replaced with a `useEffect` that runs its effect at once and keeps the
 * cleanup. Every store and the coalescer are replaced with stand-ins, which
 * also keeps config-store (it registers a `matchMedia` listener on load) and
 * the board's import graph out of this file.
 *
 * Every "did not reload" assertion first advances the fake clock past the
 * debounce. Asserting straight after the push passes even when a reload WAS
 * scheduled, because the timer has not fired yet.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  currentProjectId: 'proj-open' as string | null,
  loadBoard: vi.fn(),
  loadBacklog: vi.fn(),
  loadConfig: vi.fn(),
  addToast: vi.fn(),
  invalidateProject: vi.fn(),
  invalidateAllProjects: vi.fn(),
  enqueueReload: vi.fn((_key: string, thunk: () => void) => thunk()),
  unsubscribe: vi.fn(),
  onChangedInOtherWindow: vi.fn(),
  registeredCallback: { current: null as ((projectId?: string) => void) | null },
  effectCleanup: { current: null as (() => void) | null },
}));

vi.mock('react', () => ({
  useEffect: (effect: () => void | (() => void)) => {
    const cleanup = effect();
    mocks.effectCleanup.current = typeof cleanup === 'function' ? cleanup : null;
  },
}));
vi.mock('../../src/renderer/stores/board-store', () => ({
  useBoardStore: { getState: () => ({ loadBoard: mocks.loadBoard }) },
}));
vi.mock('../../src/renderer/stores/backlog-store', () => ({
  useBacklogStore: { getState: () => ({ loadBacklog: mocks.loadBacklog }) },
}));
vi.mock('../../src/renderer/stores/config-store', () => ({
  useConfigStore: { getState: () => ({ loadConfig: mocks.loadConfig }) },
}));
vi.mock('../../src/renderer/stores/project-store', () => ({
  useProjectStore: {
    getState: () => ({ currentProject: mocks.currentProjectId ? { id: mocks.currentProjectId } : null }),
  },
}));
vi.mock('../../src/renderer/stores/toast-store', () => ({
  useToastStore: { getState: () => ({ addToast: mocks.addToast }) },
}));
vi.mock('../../src/renderer/stores/project-cache', () => ({
  invalidateProject: mocks.invalidateProject,
  invalidateAllProjects: mocks.invalidateAllProjects,
}));
vi.mock('../../src/renderer/lib/session-update-coalescer', () => ({
  enqueueReload: mocks.enqueueReload,
}));

import { useAgentDrivenInvalidation } from '../../src/renderer/hooks/useAgentDrivenInvalidation';

const DEBOUNCE_MS = 250;

/** Fire the push the way main would, through the callback the hook registered. */
function pushChangedInOtherWindow(projectId?: string): void {
  const callback = mocks.registeredCallback.current;
  if (!callback) throw new Error('the hook never registered an onChangedInOtherWindow subscriber');
  callback(projectId);
}

function enqueuedReloadKeys(): string[] {
  return mocks.enqueueReload.mock.calls.map((call) => call[0]).sort();
}

describe('useAgentDrivenInvalidation: tasks.onChangedInOtherWindow', () => {
  let debugSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    mocks.currentProjectId = 'proj-open';
    mocks.registeredCallback.current = null;
    mocks.effectCleanup.current = null;
    mocks.onChangedInOtherWindow.mockImplementation((callback: (projectId?: string) => void) => {
      mocks.registeredCallback.current = callback;
      return mocks.unsubscribe;
    });
    // Only this subscription exists on the stub, so every sibling branch in the
    // hook (all behind `?.`) stays unregistered and cannot cross-talk.
    vi.stubGlobal('window', { electronAPI: { tasks: { onChangedInOtherWindow: mocks.onChangedInOtherWindow } } });
    debugSpy = vi.spyOn(console, 'debug').mockImplementation(() => undefined);
    useAgentDrivenInvalidation();
  });

  afterEach(() => {
    mocks.effectCleanup.current?.();
    debugSpy.mockRestore();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('registers exactly one subscriber', () => {
    // Red if the hook stops wiring the channel: the pop-out monitor's writes
    // would again never reach the main window's board.
    expect(mocks.onChangedInOtherWindow).toHaveBeenCalledTimes(1);
    expect(mocks.registeredCallback.current).not.toBeNull();
  });

  it('reloads the board and the backlog for the open project, after the debounce, and does not invalidate', () => {
    pushChangedInOtherWindow('proj-open');

    // Held for the debounce, not run inline.
    vi.advanceTimersByTime(DEBOUNCE_MS - 1);
    expect(mocks.enqueueReload).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);

    // Red if the backlog reload is dropped (a Backlog demote from the monitor
    // would leave the backlog view stale) or the board reload is dropped.
    expect(enqueuedReloadKeys()).toEqual(['backlog', 'board']);
    expect(mocks.loadBoard).toHaveBeenCalledTimes(1);
    expect(mocks.loadBacklog).toHaveBeenCalledTimes(1);
    // Red if the open project is treated as a background one.
    expect(mocks.invalidateProject).not.toHaveBeenCalled();
    // Red if the push is announced: the user made this change themselves.
    expect(mocks.addToast).not.toHaveBeenCalled();
  });

  it('coalesces a burst of pushes into one board reload and one backlog reload', () => {
    pushChangedInOtherWindow('proj-open');
    vi.advanceTimersByTime(100);
    pushChangedInOtherWindow('proj-open');

    // Red if a repeat push does not supersede the pending timer: the first push's
    // timer would fire here, at 250ms from the FIRST push.
    vi.advanceTimersByTime(DEBOUNCE_MS - 1);
    expect(mocks.enqueueReload).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    expect(enqueuedReloadKeys()).toEqual(['backlog', 'board']);
    expect(mocks.loadBoard).toHaveBeenCalledTimes(1);
    expect(mocks.loadBacklog).toHaveBeenCalledTimes(1);
  });

  it('drops the warm snapshot of another project and reloads nothing', () => {
    pushChangedInOtherWindow('proj-other');

    // Well past the debounce, so a reload that WAS scheduled would have fired.
    vi.advanceTimersByTime(DEBOUNCE_MS * 4);

    // Red if the invalidate branch is dropped: the next warm switch to that
    // project would restore a snapshot from before the monitor's write.
    expect(mocks.invalidateProject).toHaveBeenCalledTimes(1);
    expect(mocks.invalidateProject).toHaveBeenCalledWith('proj-other');
    // Red if another project's push reloads the board the user is looking at.
    expect(mocks.enqueueReload).not.toHaveBeenCalled();
    expect(mocks.loadBoard).not.toHaveBeenCalled();
    expect(mocks.loadBacklog).not.toHaveBeenCalled();
    expect(mocks.addToast).not.toHaveBeenCalled();
  });

  it('treats a push with no project id as the open project', () => {
    // The open project is a real id, so a strict `changedProjectId === activeProjectId`
    // would call invalidateProject(undefined) here instead of reloading.
    pushChangedInOtherWindow(undefined);

    vi.advanceTimersByTime(DEBOUNCE_MS);

    expect(enqueuedReloadKeys()).toEqual(['backlog', 'board']);
    expect(mocks.loadBoard).toHaveBeenCalledTimes(1);
    expect(mocks.loadBacklog).toHaveBeenCalledTimes(1);
    expect(mocks.invalidateProject).not.toHaveBeenCalled();
    expect(mocks.addToast).not.toHaveBeenCalled();
  });

  it('treats every id as another project while no project is open', () => {
    // Red if a missing open project reads as a match: the push names a project
    // the board is not showing, so there is nothing on screen to reload.
    mocks.currentProjectId = null;

    pushChangedInOtherWindow('proj-elsewhere');
    vi.advanceTimersByTime(DEBOUNCE_MS * 4);

    expect(mocks.invalidateProject).toHaveBeenCalledWith('proj-elsewhere');
    expect(mocks.enqueueReload).not.toHaveBeenCalled();
  });

  it('unsubscribes and cancels a pending reload on teardown', () => {
    pushChangedInOtherWindow('proj-open');

    mocks.effectCleanup.current?.();

    // Red if the subscription's unsubscribe is never pushed onto the cleanups: a
    // remounted hook would stack a second listener and reload twice per push.
    expect(mocks.unsubscribe).toHaveBeenCalledTimes(1);
    // Red if the debounce timers survive the teardown.
    vi.advanceTimersByTime(DEBOUNCE_MS * 4);
    expect(mocks.enqueueReload).not.toHaveBeenCalled();
  });
});
